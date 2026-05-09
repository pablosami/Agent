const config = require('./config');
const { parseActionTags, stripActionTags } = require('./action_tags');

function clampSchedule(seconds) {
  const parsed = Number.parseInt(seconds, 10);
  if (!Number.isFinite(parsed)) return config.defaultIntervalSec;
  return Math.min(config.maxIntervalSec, Math.max(config.minIntervalSec, parsed));
}

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function parseOutput(output) {
  const rawOutput = String(output || '');
  const tagged = parseActionTags(rawOutput);
  const lines = rawOutput.split(/\r?\n/);
  const tailStart = Math.max(0, lines.length - 30);
  const tail = lines.slice(tailStart).join('\n');
  const warnings = [...tagged.errors.map((error) => `${error.tag}: ${error.error}`)];
  const saves = [];
  const deletes = [];
  const planOps = [];
  const notifyAfters = [];
  let scheduleSec = config.defaultIntervalSec;
  let reflect = false;

  for (const memSave of tagged.actions.memSaves) {
    if (saves.length >= config.maxMemWritesPerStep) {
      warnings.push('Ignored extra MEM_SAVE over per-step limit.');
      continue;
    }
    saves.push({
      kind: memSave.kind,
      entry: memSave.data,
      source: 'AGENT_MODEL',
      why: typeof memSave.data.why === 'string' ? memSave.data.why.trim() : ''
    });
  }

  const deleteRegex = /^\s*\[MEM_DELETE\s+(short|long)\s+([^\]\s]+)(?:\s+(.+))?\]\s*$/gm;
  for (const match of tail.matchAll(deleteRegex)) {
    if (deletes.length >= config.maxDeletesPerStep) {
      warnings.push('Ignored extra MEM_DELETE over per-step limit.');
      continue;
    }
    deletes.push({ kind: match[1], id: match[2], source: 'AGENT_MODEL', why: match[3] ? match[3].trim() : '' });
  }

  for (const parsed of tagged.actions.memPlans) {
    const ops = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.ops) ? parsed.ops : [parsed];
    for (const op of ops) {
      if (!op || typeof op !== 'object') continue;
      const normalizedOp = String(op.op || '').toUpperCase();
      if (!['ADD', 'UPDATE', 'PROMOTE', 'DELETE', 'PIN', 'UNPIN'].includes(normalizedOp)) {
        warnings.push(`Ignored unsupported MEM_PLAN op: ${op.op}`);
        continue;
      }
      planOps.push({
        ...op,
        op: normalizedOp,
        kind: op.kind || 'short',
        source: 'AGENT_MODEL',
        why: typeof op.why === 'string' ? op.why.trim() : ''
      });
    }
  }

  for (const notify of tagged.actions.notifyAfters) {
    notifyAfters.push({
      entry: notify,
      source: 'AGENT_MODEL',
      why: typeof notify.why === 'string' ? notify.why.trim() : ''
    });
  }

  const scheduleMatch = tail.match(/^\s*\[SCHEDULE\s+(-?\d+)\]\s*$/m);
  if (scheduleMatch) {
    scheduleSec = clampSchedule(scheduleMatch[1]);
  } else {
    warnings.push('No SCHEDULE tag found; using default interval.');
  }

  reflect = /^\s*\[REFLECT\]\s*$/m.test(tail);

  const cleanOutput = stripActionTags(rawOutput);
  const cleanLines = cleanOutput.split(/\r?\n/);
  const firstActionLine = cleanLines.findIndex((line) => /^\s*\[(MEM_DELETE|SCHEDULE|REFLECT)\b/.test(line));
  const thought = (firstActionLine >= 0 ? cleanLines.slice(0, firstActionLine) : cleanLines).join('\n').trim();

  return {
    thought,
    actions: {
      saves,
      deletes,
      planOps,
      notifyAfters,
      scheduleSec,
      reflect
    },
    warnings
  };
}

module.exports = {
  parseOutput,
  clampSchedule
};
