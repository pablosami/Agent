const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = path.resolve(process.cwd(), 'runtime');
const STATE_FILE = path.join(RUNTIME_DIR, 'autonomy_state.json');

function ensureRuntime() {
  if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function loadState() {
  ensureRuntime();
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch (error) {
    return {};
  }
}

function saveState(state) {
  ensureRuntime();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state || {}, null, 2), 'utf8');
}

function getNextThinkAt(state) {
  const value = Number(state?.next_think_at || 0);
  return Number.isFinite(value) ? value : 0;
}

function setNextThinkAt(state, tsMs) {
  const next = { ...(state || {}) };
  next.next_think_at = tsMs;
  next.updated_at = new Date().toISOString();
  return next;
}

module.exports = {
  loadState,
  saveState,
  getNextThinkAt,
  setNextThinkAt,
  STATE_FILE
};
