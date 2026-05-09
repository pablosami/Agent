const test = require('node:test');
const assert = require('node:assert/strict');
const { Scheduler } = require('../agent/scheduler');

test('scheduler fires notify after tick', () => {
  const fired = [];
  const scheduler = new Scheduler({ persist: false, maxDelayMs: 60000, onFire: (task) => fired.push(task) });
  const scheduled = scheduler.scheduleNotify({ afterMs: 10, text: 'hi', why: 'test notify', source: 'AGENT_MODEL' });

  assert.equal(scheduled.ok, true);
  scheduler.tick(Date.now() + 20);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].payload.text, 'hi');
});

test('scheduler rejects notify without why', () => {
  const scheduler = new Scheduler({ persist: false });
  const scheduled = scheduler.scheduleNotify({ afterMs: 10, text: 'hi', why: '' });
  assert.equal(scheduled.ok, false);
  assert.equal(scheduled.error, 'missing_why');
});
