const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = path.resolve(process.cwd(), 'runtime');
const COMMANDS_FILE = path.join(RUNTIME_DIR, 'commands.jsonl');

function ensureRuntime() {
  if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  if (!fs.existsSync(COMMANDS_FILE)) fs.writeFileSync(COMMANDS_FILE, '');
}

function makeId() {
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function enqueueCommand({ from, text, user_id = null }) {
  ensureRuntime();
  const cmd = {
    id: makeId(),
    ts: new Date().toISOString(),
    from: from || 'cli',
    user_id,
    text: String(text || '')
  };
  fs.appendFileSync(COMMANDS_FILE, `${JSON.stringify(cmd)}\n`, 'utf8');
  return cmd;
}

function readNewCommands(offset = 0) {
  ensureRuntime();
  const buf = fs.readFileSync(COMMANDS_FILE);
  if (offset >= buf.length) return { commands: [], nextOffset: buf.length };

  const chunk = buf.slice(offset).toString('utf8');
  const lines = chunk.split('\n').filter(Boolean);
  const commands = [];
  for (const line of lines) {
    try {
      commands.push(JSON.parse(line));
    } catch (error) {
      // Ignore partially written or broken JSONL lines.
    }
  }
  return { commands, nextOffset: buf.length };
}

module.exports = {
  enqueueCommand,
  readNewCommands,
  ensureRuntime,
  COMMANDS_FILE
};
