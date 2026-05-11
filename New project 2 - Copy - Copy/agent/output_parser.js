const fs = require('fs');
const path = require('path');
const config = require('./config');

const PARSE_ERRORS_LOG = path.join(config.logDir, 'parse_errors.log');

function logParseError(tag, message) {
  try {
    const dir = path.dirname(PARSE_ERRORS_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] [${tag}] ${message}\n`;
    fs.appendFileSync(PARSE_ERRORS_LOG, line, 'utf8');
    console.log(`[PARSER] warning: ${message}`);
  } catch (_) {
    // ignore
  }
}

// Regex to capture technical tags. \s*[^\]]* allows trailing prose before the closing bracket.
const RE_MEM_SAVE  = /^\s*\[MEM_SAVE\s+(short|long)\]\s*(.+)$/gm;
const RE_MEM_DEL   = /^\s*\[MEM_DELETE\s+(short|long)\s+(\d+)(?:\s+[^\]]*)?\]/gm;
const RE_MEM_ADAPT = /^\s*\[MEM_ADAPT\]\s*(.+)$/gm;
const RE_MEM_ADAPT_CHALLENGE = /^\s*\[MEM_ADAPT_CHALLENGE\]\s*(.+)$/gm;
const RE_MEM_ADAPT_WEAKEN = /^\s*\[MEM_ADAPT_WEAKEN\]\s*(.+)$/gm;
const RE_SCHEDULE  = /^\s*\[SCHEDULE\s+(\d+)\]/m;
const RE_REFLECT   = /^\s*\[REFLECT\]/m;
const RE_SEND_MSG  = /^\s*\[SEND_MESSAGE\]\s*(.+)$/gm;

function normalizeModelOutput(text) {
  return String(text || "")
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

function safeParseJson(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function fallbackSaveMalformedTag(tag, raw, thought) {
  return {
    type: "thought",
    content: `Malformed ${tag} was ignored. Related thought: ${thought.slice(0, 300)}...`,
    priority: "normal",
    why: "Model attempted an action but formatting failed; preserving semantic content."
  };
}

/**
 * Основной парсер ответа модели.
 */
function parseOutput(text) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/);
  
  // Берём только последние 40 строк для поиска тегов
  const tailStart = Math.max(0, lines.length - 40);
  const tail = lines.slice(tailStart).join('\n');

  const normalized = normalizeModelOutput(tail);

  const actions = {
    thought: '',
    saves: [],
    deletes: [],
    adapts: [],
    adaptChallenges: [],
    adaptWeakens: [],
    messages: [],
    scheduleSec: config.defaultIntervalSec,
    reflect: false,
    parseErrorCount: 0
  };

  let match;
  // MEM_SAVE
  RE_MEM_SAVE.lastIndex = 0;
  while ((match = RE_MEM_SAVE.exec(normalized)) !== null) {
    const kind = match[1];
    const rawJson = match[2].trim();
    const parsed = safeParseJson(rawJson);
    if (parsed.ok) {
      const obj = parsed.value;
      if (!obj.type || !obj.content) {
        logParseError('MEM_SAVE', `invalid_json_schema in MEM_SAVE, action ignored, thought preserved`);
        actions.parseErrorCount++;
        actions.saves.push({ kind: 'short', entry: fallbackSaveMalformedTag('MEM_SAVE', rawJson, raw) });
      } else {
        actions.saves.push({ kind, entry: obj });
      }
    } else {
      logParseError('MEM_SAVE', `invalid_json in MEM_SAVE, action ignored, thought preserved`);
      actions.parseErrorCount++;
      actions.saves.push({ kind: 'short', entry: fallbackSaveMalformedTag('MEM_SAVE', rawJson, raw) });
    }
  }

  // MEM_DELETE
  RE_MEM_DEL.lastIndex = 0;
  while ((match = RE_MEM_DEL.exec(normalized)) !== null) {
    const kind = match[1];
    const id = Number.parseInt(match[2], 10);
    if (Number.isFinite(id)) {
      actions.deletes.push({ kind, id });
    }
  }

  // MEM_ADAPT
  RE_MEM_ADAPT.lastIndex = 0;
  while ((match = RE_MEM_ADAPT.exec(normalized)) !== null) {
    const rawJson = match[1].trim();
    const parsed = safeParseJson(rawJson);
    if (parsed.ok && parsed.value.type && parsed.value.target && parsed.value.rule) {
      actions.adapts.push(parsed.value);
    } else {
      logParseError('MEM_ADAPT', `invalid_json or schema in MEM_ADAPT`);
      actions.parseErrorCount++;
    }
  }

  // MEM_ADAPT_CHALLENGE
  RE_MEM_ADAPT_CHALLENGE.lastIndex = 0;
  while ((match = RE_MEM_ADAPT_CHALLENGE.exec(normalized)) !== null) {
    const rawJson = match[1].trim();
    const parsed = safeParseJson(rawJson);
    if (parsed.ok && parsed.value.id) {
      actions.adaptChallenges.push(parsed.value);
    } else {
      logParseError('MEM_ADAPT_CHALLENGE', `invalid_json or schema`);
      actions.parseErrorCount++;
    }
  }

  // MEM_ADAPT_WEAKEN
  RE_MEM_ADAPT_WEAKEN.lastIndex = 0;
  while ((match = RE_MEM_ADAPT_WEAKEN.exec(normalized)) !== null) {
    const rawJson = match[1].trim();
    const parsed = safeParseJson(rawJson);
    if (parsed.ok && parsed.value.id && typeof parsed.value.amount === 'number') {
      actions.adaptWeakens.push(parsed.value);
    } else {
      logParseError('MEM_ADAPT_WEAKEN', `invalid_json or schema`);
      actions.parseErrorCount++;
    }
  }

  // SCHEDULE
  const schedMatch = RE_SCHEDULE.exec(normalized);
  if (schedMatch) {
    let seconds = Number.parseInt(schedMatch[1], 10);
    if (Number.isFinite(seconds)) {
      actions.scheduleSec = Math.min(Math.max(seconds, 10), 900);
    }
  }

  // REFLECT
  if (RE_REFLECT.test(normalized)) {
    actions.reflect = true;
  }

  // SEND_MESSAGE (Now parses JSON)
  RE_SEND_MSG.lastIndex = 0;
  while ((match = RE_SEND_MSG.exec(normalized)) !== null) {
    const rawJson = match[1].trim();
    const parsed = safeParseJson(rawJson);
    if (parsed.ok && parsed.value.text) {
      actions.messages.push(parsed.value.text);
    } else {
      // Fallback if not json
      if (!rawJson.startsWith('{')) {
         actions.messages.push(rawJson);
      } else {
         logParseError('SEND_MESSAGE', `invalid_json`);
         actions.parseErrorCount++;
      }
    }
  }

  // Очищаем оригинальный текст от тегов
  actions.thought = lines
    .filter(line => !/^\s*\[(MEM_SAVE|MEM_DELETE|MEM_ADAPT|MEM_ADAPT_CHALLENGE|MEM_ADAPT_WEAKEN|SCHEDULE|REFLECT|SEND_MESSAGE)\b/.test(line))
    .join('\n')
    .trim();

  return actions;
}

module.exports = {
  parseOutput,
  logParseError
};
