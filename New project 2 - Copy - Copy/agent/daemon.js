const { readNewCommands } = require('./command_queue');
const { emitEvent } = require('./telemetry');
const { buildSnapshot } = require('./memory_snapshot');
const { Scheduler } = require('./scheduler');
const { stripActionTags } = require('./action_tags');
const { loadState, saveState, getNextThinkAt, setNextThinkAt } = require('./autonomy_state');
const { runAutonomousThink: defaultRunAutonomousThink } = require('./autonomous_think');
const config = require('./config');
const { runReflection } = require('./reflection');
const { dueQuestions, updateQuestion } = require('./pending_questions');
const { selfAnswer } = require('./self_answer');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultProcessUserText(text, ctx) {
  const { processUserText } = require('./pipeline');
  return processUserText(text, ctx);
}

function emitAppliedEvents(runId, result) {
  const applied = result?.applied || {};
  const proposedCount = (applied.saves?.length || 0)
    + (applied.updates?.length || 0)
    + (applied.deletes?.length || 0)
    + (applied.pins?.length || 0)
    + (applied.promotions?.length || 0);

  if (proposedCount) {
    emitEvent({
      type: 'memory.plan.applied',
      run_id: runId,
      source: 'SYSTEM',
      channel: 'service',
      text: `Applied ${proposedCount} memory operation(s).`,
      meta: applied
    });
  }

  for (const blocked of applied.ignored || []) {
    emitEvent({
      type: 'policy.blocked_action',
      run_id: runId,
      source: 'SYSTEM',
      channel: 'service',
      text: blocked.reason || 'blocked',
      meta: blocked
    });
  }
}

function computeNextThinkInMs(thinkResult = {}) {
  const maxMs = Number(config.maxHeartbeatIntervalSec || 900) * 1000;
  const adaptiveMs = Number(thinkResult?.nextInMs || maxMs);
  return Math.max(1000, Math.min(adaptiveMs, maxMs));
}

async function runDaemon(options = {}) {
  const {
    pollMs = 600,
    snapshotMs = 3000,
    maxLoops = Infinity,
    processUserText = defaultProcessUserText,
    runAutonomousThink = defaultRunAutonomousThink,
    autonomyEnabled = true,
    bootstrapDelayMs = 2000,
    scheduler = new Scheduler({
      persist: false,
      maxDelayMs: Number(process.env.MAX_DELAY_MS || 60000),
      onFire: (task) => {
        if (task?.type !== 'notify') return;
        emitEvent({
          type: 'task.finished',
          run_id: task?.meta?.run_id,
          source: 'SYSTEM',
          channel: 'service',
          text: 'notify fired',
          meta: { task_id: task.id }
        });
        emitEvent({
          type: 'agent.outgoing',
          run_id: task?.meta?.run_id,
          source: 'AUTONOMOUS',
          channel: task?.payload?.channel || 'scheduled',
          text: stripActionTags(task?.payload?.text || ''),
          meta: { scheduled: true, task_id: task.id }
        });
        if (task?.payload?.text) console.log(stripActionTags(task.payload.text));
      }
    })
  } = options;
  let offset = 0;
  let lastSnapshotAt = 0;
  let loops = 0;
  const runId = `run_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let state = loadState();
  let reflectionPending = false;

  const scheduleReflectionDebounced = (ms = 5000) => {
    if (reflectionPending) return;
    reflectionPending = true;
    scheduler.seq += 1;
    scheduler.queue.push({
      id: `tsk_reflection_${String(scheduler.seq).padStart(6, '0')}`,
      type: 'reflection',
      created_at: new Date().toISOString(),
      runAt: Date.now() + Math.max(0, Number(ms) || 0),
      payload: {},
      meta: { source: 'SYSTEM', why: 'debounced reflection', run_id: runId }
    });
    scheduler.queue.sort((a, b) => a.runAt - b.runAt);
  };

  emitEvent({
    type: 'service.started',
    run_id: runId,
    source: 'SYSTEM',
    channel: 'service',
    text: 'daemon started'
  });

  if (autonomyEnabled && !state.bootstrap_done) {
    emitEvent({
      type: 'agent.outgoing',
      run_id: runId,
      source: 'AUTONOMOUS',
      channel: 'service',
      text: 'Я могу мыслить автономно. Запущу первую мысль и затем буду планировать следующие шаги.',
      meta: { kind: 'bootstrap' }
    });
    state.bootstrap_done = true;
    state = setNextThinkAt(state, Date.now() + bootstrapDelayMs);
    saveState(state);
  } else if (autonomyEnabled && !getNextThinkAt(state)) {
    state = setNextThinkAt(state, Date.now() + bootstrapDelayMs);
    saveState(state);
  }

  while (loops < maxLoops) {
    loops += 1;
    const { commands, nextOffset } = readNewCommands(offset);
    offset = nextOffset;

    for (const cmd of commands) {
      emitEvent({
        type: 'agent.incoming',
        run_id: runId,
        source: 'USER',
        channel: cmd.from,
        text: cmd.text,
        meta: { cmd_id: cmd.id, user_id: cmd.user_id }
      });

      try {
        const result = await processUserText(cmd.text, {
          run_id: runId,
          from: cmd.from,
          user_id: cmd.user_id,
          cmd_id: cmd.id,
          isDaemon: true,
          scheduler,
          emitEvent,
          scheduleReflectionDebounced,
          MAX_DELAY_MS: Number(process.env.MAX_DELAY_MS || 60000),
          source: 'USER'
        });

        emitEvent({
          type: 'agent.outgoing',
          run_id: runId,
          source: cmd.from === 'AUTONOMOUS' ? 'AUTONOMOUS' : 'USER',
          channel: cmd.from,
          text: stripActionTags(result?.text || ''),
          meta: {
            mode: result?.mode || 'CHAT',
            cmd_id: cmd.id
          }
        });
        emitAppliedEvents(runId, result);
      } catch (error) {
        emitEvent({
          type: 'task.failed',
          run_id: runId,
          source: 'SYSTEM',
          channel: 'service',
          text: error.message || String(error),
          meta: { cmd_id: cmd.id }
        });
        emitEvent({
          type: 'agent.outgoing',
          run_id: runId,
          source: 'SYSTEM',
          channel: cmd.from,
          text: stripActionTags(`Ошибка обработки команды: ${error.message || String(error)}`),
          meta: { cmd_id: cmd.id }
        });
      }
    }

    const now = Date.now();
    if (now - lastSnapshotAt >= snapshotMs) {
      lastSnapshotAt = now;
      emitEvent({
        type: 'memory.snapshot',
        run_id: runId,
        source: 'SYSTEM',
        channel: 'service',
        text: 'snapshot',
        meta: buildSnapshot()
      });
    }

    const due = scheduler.tick(Date.now());
    for (const task of due) {
      if (task.type === 'reflection') {
        reflectionPending = false;
        await runReflection({ run_id: runId, emitEvent });
      }
    }

    const overdueQuestions = dueQuestions(Date.now()).slice(0, 1);
    for (const question of overdueQuestions) {
      updateQuestion(question.id, { status: 'self_answering', attempts: Number(question.attempts || 0) + 1 });
      const result = await selfAnswer(question.text);
      emitEvent({
        type: 'agent.outgoing',
        run_id: runId,
        source: 'AUTONOMOUS',
        channel: question.channel || 'service',
        text: stripActionTags(result.answer),
        meta: {
          kind: 'self_answer',
          qid: question.id,
          confidence: result.confidence,
          assumption: result.assumption
        }
      });
      updateQuestion(question.id, {
        status: 'self_answered',
        self_answered_at: Date.now(),
        confidence: result.confidence,
        assumption: result.assumption
      });
    }

    if (autonomyEnabled) {
      state = loadState();
      const nextThinkAt = getNextThinkAt(state);
      if (!nextThinkAt || Date.now() >= nextThinkAt) {
        const result = await runAutonomousThink({
          run_id: runId,
          isDaemon: true,
          scheduler,
          emitEvent,
          origin: 'AUTONOMOUS',
          source: 'AUTONOMOUS'
        });
        const nextInMs = computeNextThinkInMs(result);
        state = setNextThinkAt(state, Date.now() + nextInMs);
        saveState(state);
        emitEvent({
          type: 'task.created',
          run_id: runId,
          source: 'SYSTEM',
          channel: 'service',
          text: 'next autonomous_think scheduled',
          meta: { kind: 'autonomous_think', next_think_at: state.next_think_at }
        });
      }
    }

    if (loops < maxLoops) await sleep(pollMs);
  }
}

module.exports = {
  runDaemon,
  emitAppliedEvents
};
