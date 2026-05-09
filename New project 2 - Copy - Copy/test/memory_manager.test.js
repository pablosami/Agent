const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const config = require('../agent/config');
const { loadSTM, appendSTM, loadLTM, applyReflectionResult } = require('../agent/memory_manager');

test('memory manager backs up corrupt STM JSON and continues', async () => {
  const original = await fs.pathExists(config.shortMemPath) ? await fs.readFile(config.shortMemPath, 'utf8') : null;
  const beforeBackups = new Set((await fs.readdir(config.memoryDir)).filter((name) => name.includes('short_mem.json.corrupt-')));

  try {
    await fs.writeFile(config.shortMemPath, '{broken', 'utf8');
    const stm = await loadSTM();
    assert.equal(typeof stm.text, 'string');
    assert.equal(stm.budget_chars, 1000);

    const afterBackups = (await fs.readdir(config.memoryDir)).filter((name) => name.includes('short_mem.json.corrupt-'));
    assert.ok(afterBackups.some((name) => !beforeBackups.has(name)));
  } finally {
    await fs.writeFile(config.shortMemPath, original || '{}', 'utf8');
  }
});

test('STM rolling window is trimmed to 1000 chars', async () => {
  const original = await fs.readFile(config.shortMemPath, 'utf8');

  try {
    await fs.writeJson(config.shortMemPath, { version: 1, budget_chars: 1000, text: '', last_updated_at: new Date().toISOString() }, { spaces: 2 });
    await appendSTM({ role: 'U', text: 'x'.repeat(900) });
    await appendSTM({ role: 'A', text: 'y'.repeat(900) });
    const stm = await loadSTM();
    assert.equal(stm.text.length <= 1000, true);
    assert.equal(stm.text.includes('A:'), true);
  } finally {
    await fs.writeFile(config.shortMemPath, original, 'utf8');
  }
});

test('reflection apply adds and deduplicates long memory', async () => {
  const original = await fs.readFile(config.longMemPath, 'utf8');
  try {
    await fs.writeJson(config.longMemPath, [], { spaces: 2 });
    const first = await applyReflectionResult({
      promote: [{ kind: 'goal', text: 'Сделать heartbeat', tags: ['autonomy'], importance: 0.7, why: 'Повторяется' }]
    }, { stm_excerpt: 'U: heartbeat' });
    assert.equal(first.add, 1);

    const second = await applyReflectionResult({
      promote: [{ kind: 'goal', text: 'Сделать heartbeat', tags: ['autonomy'], importance: 0.8, why: 'Повторяется снова' }]
    }, { stm_excerpt: 'U: heartbeat again' });
    assert.equal(second.update >= 1, true);
    const ltm = await loadLTM();
    assert.equal(ltm.length, 1);
  } finally {
    await fs.writeFile(config.longMemPath, original, 'utf8');
  }
});
