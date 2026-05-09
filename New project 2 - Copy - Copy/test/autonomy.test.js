const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const { loadState, saveState, getNextThinkAt, setNextThinkAt, STATE_FILE } = require('../agent/autonomy_state');
const { runDaemon } = require('../agent/daemon');
const { subscribe } = require('../agent/event_bus');
const { EVENTS_FILE } = require('../agent/telemetry');

async function preserveFile(filePath, fn) {
  const existed = await fs.pathExists(filePath);
  const original = existed ? await fs.readFile(filePath, 'utf8') : null;
  try {
    await fs.ensureDir(require('path').dirname(filePath));
    await fs.writeFile(filePath, '', 'utf8');
    return await fn();
  } finally {
    if (existed) await fs.writeFile(filePath, original, 'utf8');
    else await fs.remove(filePath);
  }
}

test('autonomy state persists next_think_at', async () => {
  await preserveFile(STATE_FILE, async () => {
    const state = setNextThinkAt({}, 12345);
    saveState(state);
    const loaded = loadState();
    assert.equal(getNextThinkAt(loaded), 12345);
  });
});

test('bounded daemon loop triggers autonomous think once', async () => {
  await preserveFile(STATE_FILE, async () => {
    await preserveFile(EVENTS_FILE, async () => {
      const events = [];
      const unsubscribe = subscribe((event) => events.push(event));
      try {
        await runDaemon({
          pollMs: 1,
          snapshotMs: 100000,
          maxLoops: 1,
          bootstrapDelayMs: 0,
          processUserText: async (text) => ({ text, mode: 'CHAT' }),
          runAutonomousThink: async (ctx) => {
            ctx.emitEvent({
              type: 'task.started',
              run_id: ctx.run_id,
              source: 'SYSTEM',
              channel: 'service',
              text: 'autonomous_think started',
              meta: { kind: 'autonomous_think' }
            });
            ctx.emitEvent({
              type: 'agent.outgoing',
              run_id: ctx.run_id,
              source: 'AUTONOMOUS',
              channel: 'service',
              text: 'autonomous thought',
              meta: { kind: 'autonomous_think' }
            });
            ctx.emitEvent({
              type: 'task.finished',
              run_id: ctx.run_id,
              source: 'SYSTEM',
              channel: 'service',
              text: 'autonomous_think finished',
              meta: { kind: 'autonomous_think' }
            });
            return { nextInMs: 60000, applied: 0, rejected: 0 };
          }
        });

        assert.equal(events.some((event) => event.type === 'agent.outgoing' && event.source === 'AUTONOMOUS' && event.meta?.kind === 'bootstrap'), true);
        assert.equal(events.some((event) => event.type === 'task.started' && event.meta?.kind === 'autonomous_think'), true);
        assert.equal(events.some((event) => event.type === 'agent.outgoing' && event.source === 'AUTONOMOUS' && event.meta?.kind === 'autonomous_think'), true);
        assert.equal(events.some((event) => event.type === 'task.created' && event.meta?.kind === 'autonomous_think'), true);
      } finally {
        unsubscribe();
      }
    });
  });
});
