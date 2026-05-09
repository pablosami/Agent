const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = path.resolve(process.cwd(), 'runtime');
const FILE = path.join(RUNTIME_DIR, 'pending_questions.json');

function ensure() {
  if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ version: 1, items: [] }, null, 2), 'utf8');
  }
}

function load() {
  ensure();
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(parsed?.items)) parsed.items = [];
    return parsed;
  } catch (error) {
    return { version: 1, items: [] };
  }
}

function save(state) {
  ensure();
  const next = { version: 1, items: (state?.items || []).slice(0, 20) };
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function addQuestion({ text, focus = [], ttl_ms = 60000, user_id = null, channel = 'service' }) {
  const state = load();
  const id = `q_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
  const item = {
    id,
    text: String(text || '').slice(0, 300),
    focus,
    user_id,
    channel,
    asked_at: Date.now(),
    due_at: Date.now() + Math.max(1000, Number(ttl_ms || 60000)),
    status: 'pending',
    attempts: 0
  };
  state.items.push(item);
  save(state);
  return item;
}

function markAnsweredByUser(userText) {
  const state = load();
  const pending = [...state.items]
    .filter((item) => item.status === 'pending')
    .sort((a, b) => b.asked_at - a.asked_at)[0];
  if (!pending) return null;
  pending.status = 'answered';
  pending.answered_at = Date.now();
  pending.answer_preview = String(userText || '').slice(0, 200);
  save(state);
  return pending;
}

function dueQuestions(now = Date.now()) {
  const state = load();
  return state.items.filter((item) => item.status === 'pending' && item.due_at <= now);
}

function updateQuestion(id, patch) {
  const state = load();
  const target = state.items.find((item) => item.id === id);
  if (!target) return null;
  Object.assign(target, patch || {});
  save(state);
  return target;
}

module.exports = {
  load,
  addQuestion,
  markAnsweredByUser,
  dueQuestions,
  updateQuestion,
  FILE
};
