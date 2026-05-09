const fs = require('fs-extra');
const config = require('./config');
const { ensureMemoryFiles, getContextMemory, appendSTM } = require('./memory_manager');
const { generate } = require('./ollama_client');
const { parseOutput } = require('./output_parser');
const { maybeReflect } = require('./reflection');
const { writeRunLog } = require('./logger');
const { analyzeInput } = require('./request_analyzer');
const { selectMode, policyForMode } = require('./mode_selector');
const { buildResponsePrompt } = require('./response_builder');
const { applyParsedActions } = require('./action_policy');
const { stripActionTags } = require('./action_tags');
const { normalizeNotify } = require('./notify_action');
const { markAnsweredByUser } = require('./pending_questions');

async function ensureProjectDirs() {
  await fs.ensureDir(config.logDir);
  await ensureMemoryFiles();
}

async function processUserText(input, ctx = {}) {
  await ensureProjectDirs();
  markAnsweredByUser(input);
  await appendSTM({ role: 'U', text: input });
  const context = await getContextMemory();
  const analysis = await analyzeInput(input, {
    shortCount: context.shortCount,
    longCount: context.longCount,
    run_id: ctx.run_id,
    from: ctx.from
  });
  const mode = selectMode(analysis);
  const policy = policyForMode(mode, analysis);
  let prompt = '';
  let rawResponse = '';
  let parsed = null;
  let applied = null;
  let reflection = null;
  let error = null;

  try {
    if (mode === 'IGNORE' && !analysis.shouldRespond) {
      rawResponse = '';
      parsed = parseOutput('');
      applied = await applyParsedActions(parsed, policy);
    } else {
      prompt = await buildResponsePrompt(input, analysis, mode);
      rawResponse = await generate(prompt);
      parsed = parseOutput(rawResponse);
      emitActionTelemetry(ctx, 'memory.plan.proposed', parsed);
      applied = await applyParsedActions(parsed, policy);
      emitAppliedTelemetry(ctx, applied);
      const notifyApplied = applyNotifyActions(parsed.actions.notifyAfters || [], ctx);
      applied.notify = notifyApplied.applied;
      applied.ignored.push(...notifyApplied.blocked);
      reflection = await maybeReflect(applied.reflect, { run_id: ctx.run_id, emitEvent: ctx.emitEvent });
    }
  } catch (caught) {
    error = caught.message;
    console.error(error);
  }

  const userResponse = stripActionTags(parsed?.thought || rawResponse.replace(/^\s*\[(MEM_SAVE|MEM_DELETE|SCHEDULE|REFLECT|NOTIFY_AFTER)\b.*$/gm, '').trim());
  await appendSTM({ role: 'A', text: userResponse });
  if (ctx?.scheduleReflectionDebounced) ctx.scheduleReflectionDebounced(5000);
  if (userResponse && !ctx.silent) console.log(userResponse);

  const logFile = await writeRunLog({
    userInput: input,
    ctx,
    analysis,
    mode,
    policy,
    prompt,
    response: rawResponse,
    parsed,
    applied,
    reflection,
    error
  });
  if (!ctx.silent) console.log(`Log written: ${logFile}`);

  return {
    text: userResponse,
    mode,
    analysis,
    applied,
    policy_blocked: applied?.ignored || [],
    error,
    logFile
  };
}

function emitActionTelemetry(ctx, type, parsed) {
  if (typeof ctx.emitEvent !== 'function') return;
  const actions = parsed?.actions || {};
  const proposed = {
    saves: actions.saves || [],
    deletes: actions.deletes || [],
    planOps: actions.planOps || [],
    notifyAfters: actions.notifyAfters || []
  };
  const count = proposed.saves.length + proposed.deletes.length + proposed.planOps.length + proposed.notifyAfters.length;
  if (!count) return;
  ctx.emitEvent({
    type,
    run_id: ctx.run_id,
    source: 'SYSTEM',
    channel: 'service',
    text: `proposed ${count} action(s)`,
    meta: proposed
  });
}

function emitAppliedTelemetry(ctx, applied) {
  if (typeof ctx.emitEvent !== 'function') return;
  const appliedCount = (applied?.saves?.length || 0)
    + (applied?.updates?.length || 0)
    + (applied?.deletes?.length || 0)
    + (applied?.pins?.length || 0)
    + (applied?.promotions?.length || 0);
  if (appliedCount) {
    ctx.emitEvent({
      type: 'memory.plan.applied',
      run_id: ctx.run_id,
      source: 'SYSTEM',
      channel: 'service',
      text: `applied ${appliedCount} memory action(s)`,
      meta: applied
    });
  }
  for (const blocked of applied?.ignored || []) {
    ctx.emitEvent({
      type: 'memory.plan.rejected',
      run_id: ctx.run_id,
      source: 'SYSTEM',
      channel: 'service',
      text: blocked.reason || 'rejected',
      meta: blocked
    });
    ctx.emitEvent({
      type: 'policy.blocked_action',
      run_id: ctx.run_id,
      source: 'SYSTEM',
      channel: 'service',
      text: blocked.reason || 'blocked',
      meta: blocked
    });
  }
}

function applyNotifyActions(notifyAfters, ctx) {
  const applied = [];
  const blocked = [];

  for (const notify of notifyAfters) {
    const request = normalizeNotify(notify.entry);
    if (typeof ctx.emitEvent === 'function') {
      ctx.emitEvent({
        type: 'task.created',
        run_id: ctx.run_id,
        source: 'SYSTEM',
        channel: 'service',
        text: 'notify proposed',
        meta: request
      });
    }

    const maxDelay = Number(ctx.MAX_DELAY_MS || process.env.MAX_DELAY_MS || 60000);
    const okDaemon = Boolean(ctx.isDaemon);
    const okDelay = request.afterMs >= 0 && request.afterMs <= maxDelay;
    const okWhy = request.why && request.why.trim().length >= 3;
    const okSource = ctx.source !== 'USER_TEXT';
    const okScheduler = Boolean(ctx.scheduler);

    if (!(okDaemon && okDelay && okWhy && okSource && okScheduler)) {
      const reason = !okDaemon ? 'not_daemon'
        : !okDelay ? 'delay_out_of_range'
          : !okWhy ? 'missing_why'
            : !okSource ? 'user_text_source'
              : 'missing_scheduler';
      const blockedAction = { action: 'NOTIFY_AFTER', reason, meta: request };
      blocked.push(blockedAction);
      if (typeof ctx.emitEvent === 'function') {
        ctx.emitEvent({
          type: 'policy.blocked_action',
          run_id: ctx.run_id,
          source: 'SYSTEM',
          channel: 'service',
          text: reason,
          meta: blockedAction
        });
      }
      continue;
    }

    const scheduled = ctx.scheduler.scheduleNotify({
      afterMs: request.afterMs,
      text: stripActionTags(request.text),
      channel: ctx.from || 'web',
      user_id: ctx.user_id || null,
      why: request.why,
      source: 'AGENT_MODEL',
      run_id: ctx.run_id
    });

    if (!scheduled.ok) {
      const blockedAction = { action: 'NOTIFY_AFTER', reason: scheduled.error, meta: request };
      blocked.push(blockedAction);
      if (typeof ctx.emitEvent === 'function') {
        ctx.emitEvent({
          type: 'policy.blocked_action',
          run_id: ctx.run_id,
          source: 'SYSTEM',
          channel: 'service',
          text: scheduled.error,
          meta: blockedAction
        });
      }
    } else {
      applied.push(scheduled.task);
      if (typeof ctx.emitEvent === 'function') {
        ctx.emitEvent({
          type: 'task.created',
          run_id: ctx.run_id,
          source: 'SYSTEM',
          channel: 'service',
          text: 'notify scheduled',
          meta: scheduled.task
        });
      }
    }
  }

  return { applied, blocked };
}

module.exports = {
  ensureProjectDirs,
  processUserText,
  applyNotifyActions
};
