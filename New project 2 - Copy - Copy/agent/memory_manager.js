const fs = require('fs-extra');
const path = require('path');
const config = require('./config');
const { appendSystemLog } = require('./logger');

const STM_DEFAULT_BUDGET = 1000;
const LTM_ALLOWED_TYPES = ['preference', 'goal', 'task', 'fact', 'insight', 'reflection', 'knowledge'];

function nowISO() {
  return new Date().toISOString();
}

function defaultSTM() {
  return {
    version: 1,
    budget_chars: STM_DEFAULT_BUDGET,
    text: '',
    last_updated_at: nowISO()
  };
}

async function ensureMemoryFiles() {
  await fs.ensureDir(config.memoryDir);
  if (!(await fs.pathExists(config.shortMemPath))) {
    await fs.writeJson(config.shortMemPath, defaultSTM(), { spaces: 2 });
  }
  if (!(await fs.pathExists(config.longMemPath))) {
    await fs.writeJson(config.longMemPath, [], { spaces: 2 });
  }
}

async function backupCorruptFile(filePath, error) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.corrupt-${stamp}.bak`;
  if (await fs.pathExists(filePath)) {
    await fs.copy(filePath, backupPath);
  }
  const fallback = filePath === config.shortMemPath ? defaultSTM() : [];
  await fs.writeJson(filePath, fallback, { spaces: 2 });
  await appendSystemLog({
    level: 'warn',
    message: 'Corrupt JSON memory file was backed up and reset.',
    filePath,
    backupPath,
    error: error.message
  });
  return fallback;
}

async function loadSTM() {
  await ensureMemoryFiles();
  try {
    const value = await fs.readJson(config.shortMemPath);
    if (Array.isArray(value)) {
      // Compatibility migration from legacy short entries array.
      const text = value
        .map((entry) => String(entry?.content || entry?.text || '').trim())
        .filter(Boolean)
        .map((line) => `U: ${line}`)
        .join('\n');
      const migrated = {
        version: 1,
        budget_chars: STM_DEFAULT_BUDGET,
        text: trimToBudget(text, STM_DEFAULT_BUDGET),
        last_updated_at: nowISO()
      };
      await saveSTM(migrated);
      return migrated;
    }
    if (!value || typeof value !== 'object') {
      return backupCorruptFile(config.shortMemPath, new Error('STM root is not an object'));
    }
    return {
      version: Number(value.version || 1),
      budget_chars: Number(value.budget_chars || STM_DEFAULT_BUDGET),
      text: typeof value.text === 'string' ? value.text : '',
      last_updated_at: value.last_updated_at || nowISO()
    };
  } catch (error) {
    return backupCorruptFile(config.shortMemPath, error);
  }
}

async function saveSTM(stm) {
  await fs.ensureDir(path.dirname(config.shortMemPath));
  const tempPath = `${config.shortMemPath}.tmp`;
  await fs.writeJson(tempPath, { ...stm, last_updated_at: nowISO() }, { spaces: 2 });
  await fs.move(tempPath, config.shortMemPath, { overwrite: true });
}

async function loadLTM() {
  await ensureMemoryFiles();
  try {
    const value = await fs.readJson(config.longMemPath);
    return Array.isArray(value) ? value : backupCorruptFile(config.longMemPath, new Error('LTM root is not an array'));
  } catch (error) {
    return backupCorruptFile(config.longMemPath, error);
  }
}

async function saveLTM(entries) {
  await fs.ensureDir(path.dirname(config.longMemPath));
  const tempPath = `${config.longMemPath}.tmp`;
  await fs.writeJson(tempPath, entries, { spaces: 2 });
  await fs.move(tempPath, config.longMemPath, { overwrite: true });
}

function trimToBudget(text, budget) {
  if (text.length <= budget) return text;
  return text.slice(text.length - budget);
}

async function appendSTM({ role, text, budget_chars = STM_DEFAULT_BUDGET }) {
  const stm = await loadSTM();
  const roleMark = role === 'A' ? 'A' : 'U';
  const line = `${roleMark}: ${String(text || '').replace(/\s+/g, ' ').trim()}\n`;
  const nextBudget = Number(stm.budget_chars || budget_chars || STM_DEFAULT_BUDGET);
  const next = {
    ...stm,
    budget_chars: nextBudget,
    text: trimToBudget((stm.text || '') + line, nextBudget)
  };
  await saveSTM(next);
  return next;
}

function dateIdPrefix(date = new Date()) {
  return `m_${date.toISOString().slice(0, 10).replace(/-/g, '_')}`;
}

function nextId(entries) {
  const prefix = dateIdPrefix();
  const maxToday = entries.reduce((max, entry) => {
    const match = String(entry.id || '').match(new RegExp(`^${prefix}_(\\d+)$`));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix}_${String(maxToday + 1).padStart(4, '0')}`;
}

function defaultDeletionGuard(entry = {}) {
  return {
    min_age_days: Number.isFinite(Number(entry.deletion_guard?.min_age_days)) ? Number(entry.deletion_guard.min_age_days) : 3,
    min_importance: Number.isFinite(Number(entry.deletion_guard?.min_importance)) ? Number(entry.deletion_guard.min_importance) : 0.35,
    requires_reason: entry.deletion_guard?.requires_reason !== false,
    requires_review: Boolean(entry.deletion_guard?.requires_review)
  };
}

function clamp01(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function appendHistory(entry, op, why, by = 'AGENT') {
  const history = Array.isArray(entry.history) ? entry.history : [];
  return [
    ...history.slice(-19),
    {
      ts: new Date().toISOString(),
      op,
      by,
      why: why || 'No reason recorded'
    }
  ];
}

function normalizeEntry(kind, entry) {
  const content = typeof entry.content === 'string'
    ? entry.content.trim()
    : typeof entry.text === 'string'
      ? entry.text.trim()
      : '';
  if (!content) return null;

  const type = LTM_ALLOWED_TYPES.includes(entry.type) ? entry.type : 'insight';
  const now = new Date().toISOString();
  const normalized = {
    id: undefined,
    type,
    content,
    text: content,
    tags: Array.isArray(entry.tags) ? entry.tags.map(String).slice(0, 12) : [],
    importance: clamp01(entry.importance, 0.6),
    created: entry.created || entry.created_at || now,
    created_at: entry.created_at || entry.created || now,
    last_used_at: entry.last_used_at || now,
    ttl_days: Number.isFinite(Number(entry.ttl_days)) ? Number(entry.ttl_days) : null,
    pin: Boolean(entry.pin),
    pin_reason: entry.pin ? String(entry.pin_reason || entry.why || 'Marked important by agent').trim() : null,
    deletion_guard: defaultDeletionGuard(entry),
    source: entry.source ? String(entry.source) : 'AGENT_INFERENCE',
    why_saved: String(entry.why_saved || entry.why || 'Useful for future context').trim()
  };

  normalized.source = entry.source ? String(entry.source) : 'AGENT_INFERENCE';

  if (entry.why) normalized.why = String(entry.why).trim();
  normalized.history = appendHistory(entry, 'ADD', normalized.why_saved);

  return normalized;
}

async function addMemory(kind, entry) {
  if (kind === 'short') {
    await appendSTM({ role: entry?.role || 'A', text: entry?.content || entry?.text || '' });
    return { id: `stm_${Date.now()}`, type: 'thought', content: String(entry?.content || entry?.text || '').trim(), text: String(entry?.content || entry?.text || '').trim() };
  }
  const entries = await loadLTM();
  const normalized = normalizeEntry(kind, entry);
  if (!normalized) return null;
  normalized.id = nextId(entries);
  entries.push(normalized);
  await saveLTM(entries);
  return normalized;
}

async function deleteMemory(kind, id) {
  if (kind === 'short') return false;
  const entries = await loadLTM();
  const targetId = String(id);
  const next = entries.filter((entry) => String(entry.id) !== targetId);
  if (next.length === entries.length) return false;
  await saveLTM(next);
  return true;
}

async function updateMemory(kind, id, patch = {}, why = 'Updated by memory plan') {
  if (kind === 'short') return null;
  const entries = await loadLTM();
  const targetId = String(id);
  let updated = null;
  const next = entries.map((entry) => {
    if (String(entry.id) !== targetId) return entry;
    const nextEntry = {
      ...entry,
      ...patch,
      id: entry.id,
      importance: patch.importance === undefined ? entry.importance : clamp01(patch.importance, entry.importance),
      tags: patch.tags === undefined ? entry.tags : (Array.isArray(patch.tags) ? patch.tags.map(String).slice(0, 12) : entry.tags),
      deletion_guard: patch.deletion_guard ? { ...defaultDeletionGuard(entry), ...patch.deletion_guard } : entry.deletion_guard,
      history: appendHistory(entry, 'UPDATE', why)
    };
    updated = nextEntry;
    return nextEntry;
  });
  if (!updated) return null;
  await saveLTM(next);
  return updated;
}

async function setPin(kind, id, pin, params = {}, why = 'Pin state changed') {
  return updateMemory(kind, id, {
    pin: Boolean(pin),
    pin_reason: pin ? String(params.pin_reason || why).trim() : null,
    deletion_guard: params.deletion_guard
  }, why);
}

async function promoteMemory(id, why = 'Promoted to long memory') {
  const ltm = await loadLTM();
  const target = ltm.find((entry) => String(entry.id) === String(id));
  if (!target) return null;
  return updateMemory('long', id, { importance: clamp01((target.importance || 0.6) + 0.1, 0.9) }, why);
}

function priorityScore(priority) {
  return { high: 3, normal: 2, low: 1 }[priority] || 0;
}

async function getContextMemory() {
  const [stm, longMem] = await Promise.all([loadSTM(), loadLTM()]);
  const shortContext = stm.text
    ? [{ type: 'rolling_stm', text: stm.text, content: stm.text, budget_chars: stm.budget_chars, updated_at: stm.last_updated_at }]
    : [];
  const longContext = [...longMem]
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
    .slice(0, config.maxLongMemInContext);
  return { shortContext, longContext, shortCount: stm.text ? 1 : 0, longCount: longMem.length };
}

function dedupKey(kind, text) {
  return `${String(kind || '').toLowerCase().trim()}::${String(text || '').toLowerCase().trim()}`;
}

async function applyReflectionResult(refRes, ctx = {}) {
  const ltm = await loadLTM();
  const promote = Array.isArray(refRes?.promote) ? refRes.promote : [];
  const updates = Array.isArray(refRes?.update) ? refRes.update : [];
  const applied = { add: 0, update: 0, skipped: 0 };
  const existing = new Map(ltm.map((item) => [dedupKey(item.kind, item.text), item]));

  for (const item of promote) {
    const text = String(item?.text || '').trim();
    if (!text) {
      applied.skipped += 1;
      continue;
    }
    const kind = String(item.kind || 'insight');
    const key = dedupKey(kind, text);
    const dup = existing.get(key);
    if (dup) {
      dup.importance = Math.max(Number(dup.importance || 0), clamp01(item.importance, 0.6));
      dup.last_used_at = nowISO();
      applied.update += 1;
      continue;
    }
    const entry = normalizeEntry('long', {
      kind,
      type: kind,
      content: text,
      text,
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 12) : [],
      importance: clamp01(item.importance, 0.6),
      pin: Boolean(item.pin),
      why: String(item.why || ''),
      why_saved: String(item.why || 'Saved by reflection'),
      source: 'REFLECTION',
      evidence: { from: 'reflection', stm_excerpt: String(ctx.stm_excerpt || '').slice(0, 240) }
    });
    entry.id = nextId(ltm);
    entry.kind = kind;
    entry.evidence = { from: 'reflection', stm_excerpt: String(ctx.stm_excerpt || '').slice(0, 240) };
    ltm.push(entry);
    existing.set(key, entry);
    applied.add += 1;
  }

  for (const update of updates) {
    const target = ltm.find((entry) => String(entry.id) === String(update.id || ''));
    if (!target) continue;
    const patch = update.patch || {};
    if (typeof patch.importance === 'number') target.importance = clamp01(patch.importance, target.importance);
    if (Array.isArray(patch.tags)) target.tags = patch.tags.map(String).slice(0, 12);
    target.last_used_at = nowISO();
    applied.update += 1;
  }

  await saveLTM(ltm);
  return applied;
}

async function readMemory(kind) {
  if (kind === 'short') {
    const stm = await loadSTM();
    return String(stm.text || '')
      .split('\n')
      .map((line, idx) => ({ id: `stm_${idx + 1}`, type: 'thought', content: line.replace(/^[AU]:\s*/, '').trim(), text: line.replace(/^[AU]:\s*/, '').trim(), created_at: stm.last_updated_at }))
      .filter((entry) => entry.content);
  }
  return loadLTM();
}

async function writeMemory(kind, entries) {
  if (kind === 'short') {
    const stmText = Array.isArray(entries)
      ? entries.map((item) => `U: ${String(item?.content || item?.text || '').trim()}`).join('\n')
      : '';
    const stm = await loadSTM();
    await saveSTM({ ...stm, text: trimToBudget(stmText, Number(stm.budget_chars || STM_DEFAULT_BUDGET)) });
    return;
  }
  await saveLTM(Array.isArray(entries) ? entries : []);
}

module.exports = {
  ensureMemoryFiles,
  appendSTM,
  loadSTM,
  saveSTM,
  loadLTM,
  saveLTM,
  applyReflectionResult,
  readMemory,
  writeMemory,
  addMemory,
  deleteMemory,
  updateMemory,
  setPin,
  promoteMemory,
  defaultDeletionGuard,
  getContextMemory,
  normalizeEntry
};
