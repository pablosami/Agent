const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const { FOCUS_FILE, setFocusItems, focusForPrompt } = require('../agent/focus_manager');
const {
  FILE: PENDING_FILE,
  addQuestion,
  markAnsweredByUser,
  dueQuestions,
  updateQuestion
} = require('../agent/pending_questions');

async function preserveFile(filePath, fallback, fn) {
  const existed = await fs.pathExists(filePath);
  const original = existed ? await fs.readFile(filePath, 'utf8') : null;
  try {
    await fs.ensureDir(require('path').dirname(filePath));
    await fs.writeFile(filePath, fallback, 'utf8');
    return await fn();
  } finally {
    if (existed) await fs.writeFile(filePath, original, 'utf8');
    else await fs.remove(filePath);
  }
}

test('focus manager keeps at most three prompt items', async () => {
  await preserveFile(FOCUS_FILE, JSON.stringify({ version: 1, items: [] }, null, 2), async () => {
    setFocusItems([
      { kind: 'topic', label: 'A', why: 'x', weight: 0.5 },
      { kind: 'topic', label: 'B', why: 'x', weight: 0.5 },
      { kind: 'topic', label: 'C', why: 'x', weight: 0.5 },
      { kind: 'topic', label: 'D', why: 'x', weight: 0.5 }
    ]);
    const focus = focusForPrompt();
    assert.equal(focus.length, 3);
    assert.deepEqual(focus.map((item) => item.label), ['A', 'B', 'C']);
  });
});

test('pending questions lifecycle works', async () => {
  await preserveFile(PENDING_FILE, JSON.stringify({ version: 1, items: [] }, null, 2), async () => {
    const q = addQuestion({ text: 'Уточнить цель?', ttl_ms: 1000 });
    assert.equal(typeof q.id, 'string');
    const due = dueQuestions(Date.now() + 2000);
    assert.equal(due.length, 1);
    assert.equal(due[0].id, q.id);

    updateQuestion(q.id, { status: 'self_answered' });
    const noDue = dueQuestions(Date.now() + 30);
    assert.equal(noDue.length, 0);

    const q2 = addQuestion({ text: 'Второй вопрос', ttl_ms: 1000 });
    const answered = markAnsweredByUser('Мой ответ');
    assert.equal(answered.id, q2.id);
    assert.equal(answered.status, 'answered');
  });
});
