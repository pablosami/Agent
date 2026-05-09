const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = path.resolve(process.cwd(), 'runtime');
const FOCUS_FILE = path.join(RUNTIME_DIR, 'focus.json');

function nowISO() {
  return new Date().toISOString();
}

function ensure() {
  if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function loadFocus() {
  ensure();
  try {
    if (!fs.existsSync(FOCUS_FILE)) return { version: 1, updated_at: nowISO(), items: [] };
    const parsed = JSON.parse(fs.readFileSync(FOCUS_FILE, 'utf8'));
    if (!Array.isArray(parsed?.items)) parsed.items = [];
    return parsed;
  } catch (error) {
    return { version: 1, updated_at: nowISO(), items: [] };
  }
}

function normalizeItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: String(item?.id || ''),
      kind: String(item?.kind || 'topic'),
      label: String(item?.label || '').slice(0, 120).trim(),
      why: String(item?.why || '').slice(0, 200).trim(),
      weight: Math.max(0, Math.min(1, Number(item?.weight ?? 0.5))),
      expires_at: item?.expires_at || null
    }))
    .filter((item) => item.label.length > 0)
    .slice(0, 3);
}

function saveFocus(focus) {
  ensure();
  const next = {
    version: 1,
    updated_at: nowISO(),
    items: normalizeItems(focus?.items)
  };
  fs.writeFileSync(FOCUS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function setFocusItems(items) {
  return saveFocus({ items });
}

function clearExpired() {
  const focus = loadFocus();
  const now = Date.now();
  const kept = (focus.items || []).filter((item) => {
    const expiresAt = Date.parse(item?.expires_at || '');
    return !expiresAt || expiresAt > now;
  });
  if (kept.length !== (focus.items || []).length) {
    return saveFocus({ items: kept });
  }
  return focus;
}

function focusForPrompt() {
  const focus = clearExpired();
  return (focus.items || []).map((item) => ({
    kind: item.kind,
    label: item.label,
    why: item.why,
    weight: item.weight
  }));
}

module.exports = {
  loadFocus,
  saveFocus,
  setFocusItems,
  clearExpired,
  focusForPrompt,
  FOCUS_FILE
};
