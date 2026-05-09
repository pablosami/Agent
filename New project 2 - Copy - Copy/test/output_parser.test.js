const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOutput, clampSchedule } = require('../agent/output_parser');

test('parses memory tags, deletes, schedule, and reflection from tail', () => {
  const parsed = parseOutput(`thought

[MEM_SAVE short] {"type":"task","content":"Do work","priority":"high"}
[MEM_SAVE long] {"type":"insight","content":"Useful fact","tags":["x"]}
[MEM_DELETE short 7]
[SCHEDULE 120]
[REFLECT]`);

  assert.equal(parsed.actions.saves.length, 2);
  assert.equal(parsed.actions.saves[0].kind, 'short');
  assert.equal(parsed.actions.deletes[0].id, '7');
  assert.equal(parsed.actions.scheduleSec, 120);
  assert.equal(parsed.actions.reflect, true);
  assert.equal(parsed.thought, 'thought');
});

test('parses memory plan operations', () => {
  const parsed = parseOutput(`[MEM_PLAN] [{"op":"PIN","kind":"short","id":"m_2026_05_08_0001","params":{"pin_reason":"Important"},"why":"Stable goal"}]
[SCHEDULE 3600]`);

  assert.equal(parsed.actions.planOps.length, 1);
  assert.equal(parsed.actions.planOps[0].op, 'PIN');
  assert.equal(parsed.actions.planOps[0].source, 'AGENT_MODEL');
  assert.equal(parsed.actions.planOps[0].why, 'Stable goal');
});

test('clamps schedule limits', () => {
  assert.equal(clampSchedule(1), 60);
  assert.equal(clampSchedule(999999), 86400);
});

test('limits saves per step and ignores invalid JSON', () => {
  const parsed = parseOutput(`
[MEM_SAVE short] {"type":"task","content":"1"}
[MEM_SAVE short] {"type":"task","content":"2"}
[MEM_SAVE short] {"type":"task","content":"3"}
[MEM_SAVE short] {"type":"task","content":"4"}
[MEM_SAVE short] nope
[SCHEDULE 3600]`);

  assert.equal(parsed.actions.saves.length, 3);
  assert.ok(parsed.warnings.some((warning) => warning.includes('extra MEM_SAVE')));
});
