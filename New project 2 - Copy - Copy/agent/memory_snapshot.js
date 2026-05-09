const fs = require('fs');
const path = require('path');

const SHORT_PATH = path.resolve(process.cwd(), 'memory', 'short_mem.json');
const LONG_PATH = path.resolve(process.cwd(), 'memory', 'long_mem.json');

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

function safeReadArray(filePath) {
  const value = safeReadJson(filePath, []);
  return Array.isArray(value) ? value : [];
}

function safeReadSTM(filePath) {
  const value = safeReadJson(filePath, { text: '' });
  if (Array.isArray(value)) {
    return { text: value.map((it) => String(it?.content || it?.text || '').trim()).filter(Boolean).join('\n') };
  }
  if (!value || typeof value !== 'object') return { text: '' };
  return { text: String(value.text || ''), budget_chars: Number(value.budget_chars || 1000) };
}

function avg(arr, key) {
  if (!arr.length) return 0;
  const total = arr.reduce((sum, item) => sum + (Number(item?.[key]) || 0), 0);
  return total / arr.length;
}

function countPinned(arr) {
  return arr.filter((item) => item && item.pin === true).length;
}

function expiringSoon(arr, days = 3) {
  const now = Date.now();
  const windowMs = days * 86400000;
  return arr.filter((item) => {
    const created = Date.parse(item?.created_at || item?.created || '') || 0;
    const ttlDays = Number(item?.ttl_days);
    if (!created || !ttlDays) return false;
    const expiresAt = created + ttlDays * 86400000;
    return expiresAt - now <= windowMs;
  }).length;
}

function topTags(arr, limit = 10) {
  const counts = new Map();
  for (const item of arr) {
    const tags = Array.isArray(item?.tags) ? item.tags : [];
    for (const tag of tags) counts.set(String(tag), (counts.get(String(tag)) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function summarizeSTM(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.replace(/^[AU]:\s*/, '').trim())
    .filter(Boolean);
  return {
    summary: lines.length ? `Зафиксировано ${lines.length} последних реплик.` : 'Недавних реплик пока нет.',
    bullets: lines.slice(-7)
  };
}

function summarizeLTM(entries) {
  const sorted = [...entries]
    .sort((a, b) => (Number(b.importance || 0) - Number(a.importance || 0)))
    .slice(0, 7);
  const bullets = sorted.map((item) => String(item?.text || item?.content || '').trim()).filter(Boolean);
  return {
    summary: bullets.length ? `Выделено ${bullets.length} ключевых долговременных пунктов.` : 'Ключевые долгосрочные выводы пока не выделены.',
    bullets
  };
}

function buildSnapshot() {
  const short = safeReadSTM(SHORT_PATH);
  const long = safeReadArray(LONG_PATH);
  const combined = long;
  const shortView = summarizeSTM(short.text);
  const longView = summarizeLTM(long);

  return {
    short: {
      summary: shortView.summary,
      bullets: shortView.bullets
    },
    long: {
      summary: longView.summary,
      bullets: longView.bullets
    },
    top_tags: topTags(combined, 6),
    counts: {
      short_lines: shortView.bullets.length,
      long_items: long.length,
      pinned_long: countPinned(long),
      avg_importance_long: avg(long, 'importance'),
      expiring_soon_long: expiringSoon(long, 3)
    }
  };
}

module.exports = {
  buildSnapshot,
  safeReadArray
};
