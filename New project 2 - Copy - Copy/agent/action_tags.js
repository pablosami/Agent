function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (error) {
    return null;
  }
}

function findJsonEnd(text, start) {
  const opener = text[start];
  const closer = opener === '{' ? '}' : opener === '[' ? ']' : null;
  if (!closer) return -1;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === opener) depth += 1;
    if (ch === closer) depth -= 1;
    if (depth === 0) return i + 1;
  }
  return -1;
}

function collectActionRanges(text) {
  const raw = String(text || '');
  const ranges = [];
  const errors = [];
  const actions = { memSaves: [], memPlans: [], notifyAfters: [] };
  const tagRe = /\[(MEM_SAVE\s+(short|long)|MEM_PLAN|NOTIFY_AFTER)\s*\]/g;
  let match;

  while ((match = tagRe.exec(raw)) !== null) {
    const tag = match[1];
    let cursor = tagRe.lastIndex;
    while (/\s/.test(raw[cursor])) cursor += 1;

    if (raw[cursor] !== '{' && raw[cursor] !== '[') {
      errors.push({ tag, error: 'missing_json' });
      ranges.push([match.index, tagRe.lastIndex]);
      continue;
    }

    const jsonEnd = findJsonEnd(raw, cursor);
    if (jsonEnd < 0) {
      errors.push({ tag, error: 'unterminated_json' });
      ranges.push([match.index, raw.length]);
      continue;
    }

    const jsonStr = raw.slice(cursor, jsonEnd);
    const obj = safeJsonParse(jsonStr);
    ranges.push([match.index, jsonEnd]);
    tagRe.lastIndex = jsonEnd;

    if (!obj) {
      errors.push({ tag, error: 'invalid_json', jsonStr });
      continue;
    }

    if (tag.startsWith('MEM_SAVE')) {
      actions.memSaves.push({ kind: match[2], data: obj });
    } else if (tag === 'MEM_PLAN') {
      actions.memPlans.push(obj);
    } else if (tag === 'NOTIFY_AFTER') {
      actions.notifyAfters.push(obj);
    }
  }

  return { ranges, actions, errors };
}

function stripActionTags(text) {
  const raw = String(text || '');
  const { ranges } = collectActionRanges(raw);

  let out = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    out += raw.slice(cursor, start);
    cursor = end;
  }
  out += raw.slice(cursor);
  out = out.replace(/\[MEM_DELETE[^\]]*\]/g, '');
  out = out.replace(/\[MEM_[^\]]*\]/g, '');
  out = out.replace(/\[MEM_PLAN[^\]]*\]/g, '');
  out = out.replace(/\[NOTIFY_AFTER[^\]]*\]/g, '');
  out = out.replace(/\[SCHEDULE[^\]]*\]/g, '');
  out = out.replace(/\[REFLECT\]/g, '');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function parseActionTags(text) {
  const raw = String(text || '');
  const { actions, errors } = collectActionRanges(raw);
  return {
    cleanText: stripActionTags(raw),
    actions,
    errors
  };
}

module.exports = {
  stripActionTags,
  parseActionTags,
  safeJsonParse
};
