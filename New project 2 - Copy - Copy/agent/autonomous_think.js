const config = require('./config');
const { buildPrompt } = require('./context_builder');
const { generate } = require('./ollama_client');
const { parseOutput } = require('./output_parser');
const { stripActionTags } = require('./action_tags');
const { applyParsedActions } = require('./action_policy');
const { buildSnapshot } = require('./memory_snapshot');
const { focusForPrompt, setFocusItems } = require('./focus_manager');
const { addQuestion } = require('./pending_questions');

function jitter(ms, pct = 0.2) {
  const spread = ms * pct;
  return Math.max(1000, Math.floor(ms + (Math.random() * 2 - 1) * spread));
}

function decideAdaptiveNextMs({ appliedTotal, rejectedTotal, stmChanged }) {
  if (rejectedTotal > 0) return jitter(10000, 0.2);
  if (appliedTotal > 0) return jitter(20000, 0.2);
  if (stmChanged) return jitter(45000, 0.2);
  return jitter(5 * 60 * 1000, 0.2);
}

function emit(ctx, event) {
  const emitEvent = ctx.emitEvent || require('./telemetry').emitEvent;
  return emitEvent(event);
}

async function runAutonomousThink(ctx = {}) {
  const runId = ctx.run_id;
  emit(ctx, {
    type: 'task.started',
    run_id: runId,
    source: 'SYSTEM',
    channel: 'service',
    text: 'autonomous_think started',
    meta: { kind: 'autonomous_think' }
  });

  let applied = null;
  let parsed = null;
  let rawResponse = '';
  let error = null;

  try {
    const basePrompt = await buildPrompt();
    const focus = focusForPrompt();
    const prompt = `${basePrompt}

=== AUTONOMOUS THINK PULSE ===
Capabilities:
- can_read_memory: true
- can_apply_mem_plan: true
- can_pin_unpin: true
- can_schedule_notify_after: true
- max_delay_ms: ${config.maxDelayMs}

Do exactly this:
1. Produce one short useful observation about current memory/project state.
2. If useful, propose MEM_SAVE or MEM_PLAN with why.
3. Do not promise future messages unless you also use NOTIFY_AFTER.
4. The daemon will deterministically schedule the next autonomous think.
Current focus:
${JSON.stringify(focus, null, 2)}

Additionally return one JSON line at the end:
[FOCUS_PLAN] {"focus":[{"kind":"topic","label":"...","why":"...","weight":0.6}],"questions":["..."],"publish":true}`;

    rawResponse = await generate(prompt);
    const focusMatch = String(rawResponse).match(/\[FOCUS_PLAN\]\s*(\{[\s\S]*\})/);
    if (focusMatch) {
      try {
        const plan = JSON.parse(focusMatch[1]);
        const focusItems = Array.isArray(plan?.focus) ? plan.focus.slice(0, 3) : [];
        if (focusItems.length) {
          const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          setFocusItems(focusItems.map((item, index) => ({
            id: item.id || `focus_auto_${Date.now()}_${index}`,
            kind: item.kind || 'topic',
            label: item.label,
            why: item.why,
            weight: item.weight,
            expires_at: expiresAt
          })));
        }
        ctx.focusQuestions = Array.isArray(plan?.questions) ? plan.questions.slice(0, 2).map((q) => String(q || '').trim()).filter(Boolean) : [];
        ctx.focusPublish = plan?.publish === true;
      } catch (error) {
        // Ignore malformed focus payload.
      }
    }
    const cleanedRawResponse = String(rawResponse).replace(/\n?\[FOCUS_PLAN\]\s*\{[\s\S]*\}\s*$/m, '').trim();
    parsed = parseOutput(cleanedRawResponse);

    const actionCount = parsed.actions.saves.length
      + parsed.actions.deletes.length
      + parsed.actions.planOps.length
      + parsed.actions.notifyAfters.length;
    if (actionCount) {
      emit(ctx, {
        type: 'memory.plan.proposed',
        run_id: runId,
        source: 'SYSTEM',
        channel: 'service',
        text: `proposed ${actionCount} autonomous action(s)`,
        meta: { origin: 'AUTONOMOUS', actions: parsed.actions }
      });
    }

    applied = await applyParsedActions(parsed, {
      allowMemSave: true,
      allowedMemoryKinds: ['short', 'long'],
      allowMemDelete: true,
      allowReflect: true,
      allowSchedule: true,
      requireWhy: true,
      denyUserTextSource: true,
      decisionOrigin: 'AUTONOMOUS',
      origin: 'AUTONOMOUS',
      source: 'AUTONOMOUS'
    });

    const outgoing = stripActionTags(parsed.thought || cleanedRawResponse);
    const shouldSpeak = Boolean(outgoing && (applied?.saves?.length || applied?.updates?.length || applied?.deletes?.length || applied?.pins?.length || applied?.promotions?.length));
    if (shouldSpeak) {
      emit(ctx, {
        type: 'agent.outgoing',
        run_id: runId,
        source: 'AUTONOMOUS',
        channel: 'service',
        text: outgoing,
        meta: { kind: 'autonomous_think', snapshot: buildSnapshot() }
      });
    }
    if (ctx.focusPublish && Array.isArray(ctx.focusQuestions) && ctx.focusQuestions.length) {
      const questionsText = ctx.focusQuestions.join('\n');
      for (const question of ctx.focusQuestions) {
        addQuestion({
          text: question,
          focus: focusForPrompt(),
          ttl_ms: Number(process.env.QUESTION_TTL_MS || 60000),
          channel: 'service'
        });
      }
      emit(ctx, {
        type: 'agent.outgoing',
        run_id: runId,
        source: 'AUTONOMOUS',
        channel: 'service',
        text: questionsText,
        meta: { kind: 'autonomous_questions' }
      });
    }

    const appliedCount = (applied.saves?.length || 0)
      + (applied.updates?.length || 0)
      + (applied.deletes?.length || 0)
      + (applied.pins?.length || 0)
      + (applied.promotions?.length || 0);
    if (appliedCount) {
      emit(ctx, {
        type: 'memory.plan.applied',
        run_id: runId,
        source: 'SYSTEM',
        channel: 'service',
        text: `applied ${appliedCount}`,
        meta: { origin: 'AUTONOMOUS', applied }
      });
    }
    for (const blocked of applied.ignored || []) {
      emit(ctx, {
        type: 'memory.plan.rejected',
        run_id: runId,
        source: 'SYSTEM',
        channel: 'service',
        text: blocked.reason || 'rejected',
        meta: { origin: 'AUTONOMOUS', blocked }
      });
    }
  } catch (caught) {
    error = caught.message;
    emit(ctx, {
      type: 'task.failed',
      run_id: runId,
      source: 'SYSTEM',
      channel: 'service',
      text: error,
      meta: { kind: 'autonomous_think' }
    });
  }

  const appliedTotal = (applied?.saves?.length || 0)
    + (applied?.updates?.length || 0)
    + (applied?.deletes?.length || 0)
    + (applied?.pins?.length || 0)
    + (applied?.promotions?.length || 0);
  const rejectedTotal = applied?.ignored?.length || 0;
  emit(ctx, {
    type: 'task.finished',
    run_id: runId,
    source: 'SYSTEM',
    channel: 'service',
    text: 'autonomous_think finished',
    meta: { kind: 'autonomous_think', applied: appliedTotal, rejected: rejectedTotal, error }
  });

  return {
    applied: appliedTotal,
    rejected: rejectedTotal,
    nextInMs: decideAdaptiveNextMs({ appliedTotal, rejectedTotal, stmChanged: false }),
    error
  };
}

module.exports = {
  runAutonomousThink,
  jitter
};
