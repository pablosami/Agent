const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const config = require('../agent/config');
const { parseActionTags, stripActionTags } = require('../agent/action_tags');
const { parseOutput } = require('../agent/output_parser');
const { applyParsedActions } = require('../agent/action_policy');

async function withShortMemory(contents, fn) {
  const original = await fs.readFile(config.shortMemPath, 'utf8');
  try {
    await fs.writeJson(config.shortMemPath, { version: 1, budget_chars: 1000, text: '', last_updated_at: new Date().toISOString() }, { spaces: 2 });
    return await fn();
  } finally {
    await fs.writeFile(config.shortMemPath, original, 'utf8');
  }
}

test('stripActionTags removes inline action tags from outgoing text', () => {
  const text = 'Привет! [MEM_SAVE short] {"type":"task","content":"X","why":"ok"} Конец [SCHEDULE 60]';
  assert.equal(stripActionTags(text), 'Привет! Конец');
});

test('parseActionTags extracts inline MEM_SAVE', () => {
  const parsed = parseActionTags('Текст [MEM_SAVE short] {"type":"task","content":"X","why":"ok"} конец');
  assert.equal(parsed.actions.memSaves.length, 1);
  assert.equal(parsed.actions.memSaves[0].kind, 'short');
  assert.equal(parsed.cleanText.includes('MEM_SAVE'), false);
});

test('inline MEM_SAVE is parsed by output parser and reaches executor', async () => {
  await withShortMemory([], async () => {
    const parsed = parseOutput('Ответ [MEM_SAVE short] {"type":"task","content":"Inline task","why":"Useful task"} конец');
    const applied = await applyParsedActions(parsed, {
      allowMemSave: true,
      allowedMemoryKinds: ['short'],
      requireWhy: true
    });

    assert.equal(applied.saves.length, 1);
    assert.equal(applied.saves[0].entry.content, 'Inline task');
    assert.equal(parsed.thought.includes('MEM_SAVE'), false);
  });
});
