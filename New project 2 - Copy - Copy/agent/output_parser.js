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
const RE_MEM_SAVE  = /^\s*\[MEM_SAVE\s+(short|long)\]\s*([\s\S]*?)(?=\n\s*\[|$)/gm;
const RE_MEM_DEL   = /^\s*\[MEM_DELETE\s+(short|long)\s+(\d+)(?:\s+[^\]]*)?\]/gm;
const RE_MEM_FOCUS = /^\s*\[MEM_FOCUS([^\]]*)\]\s*([\s\S]*?)(?=\n\s*\[|$)/gm;
const RE_MEM_ADAPT = /^\s*\[MEM_ADAPT\]\s*([\s\S]*?)(?=\n\s*\[|$)/gm;
const RE_MEM_ADAPT_CHALLENGE = /^\s*\[MEM_ADAPT_CHALLENGE\]\s*([\s\S]*?)(?=\n\s*\[|$)/gm;
const RE_MEM_ADAPT_WEAKEN = /^\s*\[MEM_ADAPT_WEAKEN\]\s*([\s\S]*?)(?=\n\s*\[|$)/gm;
const RE_SCHEDULE  = /^\s*\[SCHEDULE\s+(\d+)\]/m;
const RE_REFLECT   = /^\s*\[REFLECT\]/m;
const RE_SEND_MSG  = /^\s*\[SEND_MESSAGE\]\s*([\s\S]*?)(?=\n\s*\[|$)/gm;
const RE_HELP_ACTIONS = /^\s*\[HELP_ACTIONS\]/m;
const RE_HELP_ACTION = /^\s*\[HELP_ACTION\s+"([^"]+)"\]/gm;

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
    try {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const extracted = raw.substring(start, end + 1);
        return { ok: true, value: JSON.parse(extracted) };
      }
    } catch(e2) {
      // ignore
    }
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

function normalizeModelOutput(text) {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’`]/g, "'")
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

/**
 * Парсер вывода агента.
 * Вытаскивает все команды из конца (или любой части) текста.
 * Поддерживает множественные действия за один ответ.
 */
function parseOutput(text) {
  const normalizedFull = normalizeModelOutput(text);
  const lines = normalizedFull.split('\n');
  
  // Берём только последние 40 строк для поиска тегов
  const tailStart = Math.max(0, lines.length - 40);
  const tail = lines.slice(tailStart).join('\n');
  const normalized = tail; // already normalized by normalizeModelOutput

  const actions = {
    thought: '',
    saves: [],
    deletes: [],
    adapts: [],
    adaptChallenges: [],
    adaptWeakens: [],
    messages: [],
    helpRequests: [],
    focusIds: [],
    focusTopics: [],
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

  // MEM_FOCUS
  RE_MEM_FOCUS.lastIndex = 0;
  while ((match = RE_MEM_FOCUS.exec(normalized)) !== null) {
    const rawIds = match[1];
    const rawJson = match[2].trim();
    
    // Check for IDs in brackets like [MEM_FOCUS #61 #38]
    if (rawIds) {
      const ids = [...rawIds.matchAll(/#(\d+)/g)].map(m => Number.parseInt(m[1], 10));
      if (ids.length > 0) {
        actions.focusIds.push(...ids);
      }
    }
    
    // Check for JSON payload like [MEM_FOCUS] {"topic":"..."}
    if (rawJson) {
      const parsed = safeParseJson(rawJson);
      if (parsed.ok && parsed.value.topic) {
        actions.focusTopics.push({ topic: parsed.value.topic, limit: parsed.value.limit || 3 });
      } else {
        if (!rawJson.startsWith('{')) {
          // just trailing text
        } else {
          logParseError('MEM_FOCUS', `invalid_json`);
          actions.parseErrorCount++;
        }
      }
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

  // HELP_ACTIONS
  if (RE_HELP_ACTIONS.test(normalized)) {
    actions.helpRequests.push("ALL");
  } else {
    RE_HELP_ACTION.lastIndex = 0;
    while ((match = RE_HELP_ACTION.exec(normalized)) !== null) {
      actions.helpRequests.push(match[1].trim());
    }
  }

  // Bare tag -> help injection
  const expectedCounts = {
    'MEM_SAVE': actions.saves.length,
    'MEM_DELETE': actions.deletes.length,
    'MEM_ADAPT': actions.adapts.length,
    'MEM_ADAPT_CHALLENGE': actions.adaptChallenges.length,
    'MEM_ADAPT_WEAKEN': actions.adaptWeakens.length,
    'SEND_MESSAGE': actions.messages.length,
    'MEM_FOCUS': actions.focusIds.length + actions.focusTopics.length // approximate
  };

  for (const [tag, count] of Object.entries(expectedCounts)) {
    const rawCount = (normalized.match(new RegExp(`\\[${tag}(?=[\\s\\]])`, 'g')) || []).length;
    if (rawCount > count) {
      if (tag === 'MEM_SAVE' && /\[MEM_SAVE\s+#\d+/.test(normalized)) {
         logParseError('MEM_SAVE', 'Detected [MEM_SAVE #ID], probably intended MEM_FOCUS.');
         if (!actions.helpRequests.includes('MEM_FOCUS')) actions.helpRequests.push('MEM_FOCUS');
      } else {
         if (!actions.helpRequests.includes(tag)) {
           actions.helpRequests.push(tag);
         }
      }
    }
  }

  // Очищаем оригинальный текст от тегов
  actions.thought = lines
    .filter(line => !/^\s*\[(MEM_SAVE|MEM_DELETE|MEM_FOCUS|MEM_ADAPT|MEM_ADAPT_CHALLENGE|MEM_ADAPT_WEAKEN|SCHEDULE|REFLECT|SEND_MESSAGE|HELP_ACTIONS|HELP_ACTION)\b/.test(line))
    .join('\n')
    .trim();

  return actions;
}

module.exports = {
  parseOutput,
  logParseError
};
