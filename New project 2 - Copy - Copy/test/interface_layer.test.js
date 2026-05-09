const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const { enqueueCommand, readNewCommands, COMMANDS_FILE } = require('../agent/command_queue');
const { emitEvent, EVENTS_FILE } = require('../agent/telemetry');
const { subscribe } = require('../agent/event_bus');
const { buildSnapshot } = require('../agent/memory_snapshot');
const { runDaemon } = require('../agent/daemon');
const { Scheduler } = require('../agent/scheduler');

async function preserveFile(filePath, fn) {
  const existed = await fs.pathExists(filePath);
  const original = existed ? await fs.readFile(filePath, 'utf8') : null;
  try {
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, '', 'utf8');
    return await fn();
  } finally {
    if (existed) await fs.writeFile(filePath, original, 'utf8');
    else await fs.remove(filePath);
  }
}

test('enqueue/readNewCommands works by byte offset', async () => {
  await preserveFile(COMMANDS_FILE, async () => {
    const first = enqueueCommand({ from: 'web', text: 'hello' });
    let result = readNewCommands(0);
    assert.equal(result.commands.length, 1);
    assert.equal(result.commands[0].id, first.id);

    enqueueCommand({ from: 'cli', text: 'second' });
    result = readNewCommands(result.nextOffset);
    assert.equal(result.commands.length, 1);
    assert.equal(result.commands[0].text, 'second');
  });
});

test('telemetry writes JSONL and publishes on bus', async () => {
  await preserveFile(EVENTS_FILE, async () => {
    const received = [];
    const unsubscribe = subscribe((event) => received.push(event));
    try {
      const event = emitEvent({ type: 'test.event', source: 'SYSTEM', channel: 'test', text: 'ok' });
      const lines = (await fs.readFile(EVENTS_FILE, 'utf8')).trim().split('\n');
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]).type, 'test.event');
      assert.equal(received[0].type, event.type);
    } finally {
      unsubscribe();
    }
  });
});

test('memory snapshot returns expected structure on empty arrays', async () => {
  const shortPath = path.resolve(process.cwd(), 'memory', 'short_mem.json');
  const longPath = path.resolve(process.cwd(), 'memory', 'long_mem.json');
  const shortOriginal = await fs.readFile(shortPath, 'utf8');
  const longOriginal = await fs.readFile(longPath, 'utf8');
  try {
    await fs.writeJson(shortPath, { version: 1, budget_chars: 1000, text: '', last_updated_at: new Date().toISOString() }, { spaces: 2 });
    await fs.writeJson(longPath, [], { spaces: 2 });
    const snapshot = buildSnapshot();
    assert.equal(typeof snapshot.short.summary, 'string');
    assert.deepEqual(snapshot.short.bullets, []);
    assert.equal(typeof snapshot.long.summary, 'string');
    assert.deepEqual(snapshot.long.bullets, []);
    assert.deepEqual(snapshot.top_tags, []);
  } finally {
    await fs.writeFile(shortPath, shortOriginal, 'utf8');
    await fs.writeFile(longPath, longOriginal, 'utf8');
  }
});

test('daemon emits memory snapshot in bounded loop', async () => {
  await preserveFile(EVENTS_FILE, async () => {
    const events = [];
    const unsubscribe = subscribe((event) => events.push(event));
    try {
      await runDaemon({
        pollMs: 1,
        snapshotMs: 0,
        maxLoops: 1,
        autonomyEnabled: false,
        processUserText: async (text) => ({ text, mode: 'CHAT' })
      });
      assert.equal(events.some((event) => event.type === 'service.started'), true);
      assert.equal(events.some((event) => event.type === 'memory.snapshot'), true);
    } finally {
      unsubscribe();
    }
  });
});

test('daemon scheduler emits clean notify outgoing on tick', async () => {
  await preserveFile(EVENTS_FILE, async () => {
    const events = [];
    const scheduler = new Scheduler({
      persist: false,
      maxDelayMs: 60000,
      onFire: (task) => {
        const { emitEvent } = require('../agent/telemetry');
        const { stripActionTags } = require('../agent/action_tags');
        emitEvent({
          type: 'agent.outgoing',
          run_id: task.meta.run_id,
          source: 'AUTONOMOUS',
          channel: task.payload.channel,
          text: stripActionTags(task.payload.text),
          meta: { scheduled: true, task_id: task.id }
        });
      }
    });
    scheduler.scheduleNotify({
      afterMs: 0,
      text: 'Hello [MEM_SAVE short] {"type":"task","content":"leak","why":"test"}',
      why: 'test notify',
      channel: 'web',
      run_id: 'run_test'
    });

    const unsubscribe = subscribe((event) => events.push(event));
    try {
      await runDaemon({
        pollMs: 1,
        snapshotMs: 100000,
        maxLoops: 1,
        autonomyEnabled: false,
        scheduler,
        processUserText: async (text) => ({ text, mode: 'CHAT' })
      });

      const outgoing = events.find((event) => event.type === 'agent.outgoing' && event.meta?.scheduled);
      assert.ok(outgoing);
      assert.equal(outgoing.text.includes('MEM_SAVE'), false);
      assert.equal(outgoing.text, 'Hello');
    } finally {
      unsubscribe();
    }
  });
});
