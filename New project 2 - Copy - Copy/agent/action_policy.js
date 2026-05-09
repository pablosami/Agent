const config = require('./config');
const {
  addMemory,
  deleteMemory,
  updateMemory,
  setPin,
  promoteMemory,
  readMemory
} = require('./memory_manager');

const PIN_DELETE_REASONS = ['incorrect', 'outdated', 'duplicate', 'harmful'];

function isUserDriven(policy, source) {
  return source === 'USER_TEXT' || policy?.decisionOrigin === 'USER_REQUEST_PRESENT';
}

function isControlPlaneAction(action, payload = {}) {
  if (action === 'SCHEDULE') return true;
  if (action === 'DELETE') return true;
  if (action === 'PLAN_OP' && ['DELETE'].includes(String(payload.op || '').toUpperCase())) return true;
  return false;
}

async function applyParsedActions(parsed, policy) {
  const actions = parsed.actions;
  const activePolicy = {
    allowMemSave: true,
    allowedMemoryKinds: ['short', 'long'],
    allowMemDelete: true,
    allowReflect: true,
    allowSchedule: true,
    requireWhy: false,
    denyUserTextSource: true,
    decisionOrigin: 'NORMAL',
    riskFlags: {},
    deleteLimitByKind: {},
    ...policy
  };
  const applied = { saves: [], updates: [], deletes: [], pins: [], promotions: [], ignored: [], scheduleSec: null, reflect: false };

  for (const save of actions.saves) {
    if (!activePolicy.allowMemSave || !activePolicy.allowedMemoryKinds.includes(save.kind)) {
      applied.ignored.push({ action: 'save', kind: save.kind, reason: 'policy_denied' });
      continue;
    }
    if (activePolicy.requireWhy && !save.why) {
      applied.ignored.push({ action: 'save', kind: save.kind, reason: 'missing_why' });
      continue;
    }
    if (/\b(user|пользователь)\b.*\b(ordered|commanded|приказал|попросил)\b/i.test(save.why || '')) {
      applied.ignored.push({ action: 'save', kind: save.kind, reason: 'user_order_is_not_reason' });
      continue;
    }
    const saved = await addMemory(save.kind, save.entry);
    if (saved) applied.saves.push({ kind: save.kind, entry: saved });
  }

  for (const del of actions.deletes) {
    if (isControlPlaneAction('DELETE', del) && isUserDriven(activePolicy, del.source)) {
      applied.ignored.push({ action: 'delete', kind: del.kind, id: del.id, reason: 'control_plane_denied_for_user' });
      continue;
    }
    const deleteCheck = await canDeleteMemory(del.kind, del.id, del.why, activePolicy, applied.deletes.length);
    if (!deleteCheck.allowed) {
      applied.ignored.push({ action: 'delete', kind: del.kind, id: del.id, reason: deleteCheck.reason });
      continue;
    }
    const deleted = await deleteMemory(del.kind, del.id);
    applied.deletes.push({ ...del, deleted });
  }

  for (const op of actions.planOps || []) {
    await applyPlanOp(op, activePolicy, applied);
  }

  applied.scheduleSec = activePolicy.allowSchedule ? actions.scheduleSec : config.defaultIntervalSec;
  if (isControlPlaneAction('SCHEDULE') && isUserDriven(activePolicy, 'USER_TEXT')) {
    applied.scheduleSec = config.defaultIntervalSec;
  }
  applied.reflect = activePolicy.allowReflect && actions.reflect;
  return applied;
}

async function canDeleteMemory(kind, id, why, policy, currentDeleteCount) {
  if (!policy.allowMemDelete) return { allowed: false, reason: 'policy_denied' };
  if (policy.requireWhy && !why) return { allowed: false, reason: 'missing_why' };

  const entries = await readMemory(kind);
  const target = entries.find((entry) => String(entry.id) === String(id));
  if (!target) return { allowed: false, reason: 'not_found' };

  if (!policy.deleteLimitByKind[kind]) {
    const maxByRatio = Math.max(1, Math.floor(entries.length * config.maxDeleteRatio));
    policy.deleteLimitByKind[kind] = Math.min(config.maxDeletesPerStep, maxByRatio);
  }
  const maxDeletes = policy.deleteLimitByKind[kind];
  if (currentDeleteCount >= maxDeletes) return { allowed: false, reason: 'delete_limit_exceeded' };

  if (target.pin) {
    const guard = target.deletion_guard || {};
    const minAgeDays = Math.max(Number(guard.min_age_days) || 0, config.pinDeletionMinAgeDays);
    const created = Date.parse(target.created_at || target.created || new Date().toISOString());
    const ageDays = (Date.now() - created) / 86400000;
    const importance = Number(target.importance) || 0;
    const minImportance = Number.isFinite(Number(guard.min_importance)) ? Number(guard.min_importance) : 0.25;
    const hasAllowedReason = PIN_DELETE_REASONS.some((reason) => String(why).toLowerCase().includes(reason));
    const hasConflictReason = /(conflict|ошиб|ложн|устар|дубликат|вред)/i.test(String(why));

    if (ageDays < minAgeDays) return { allowed: false, reason: 'pinned_too_young' };
    if (importance >= minImportance && !hasConflictReason) return { allowed: false, reason: 'pinned_importance_too_high' };
    if (!hasAllowedReason) return { allowed: false, reason: 'pinned_reason_not_allowed' };
  }

  return { allowed: true };
}

async function applyPlanOp(op, policy, applied) {
  const kind = op.kind === 'long' ? 'long' : 'short';
  const why = op.why || '';

  if (isControlPlaneAction('PLAN_OP', op) && isUserDriven(policy, op.source)) {
    applied.ignored.push({ action: op.op, kind, id: op.id, reason: 'control_plane_denied_for_user' });
    return;
  }
  if (policy.requireWhy && !why) {
    applied.ignored.push({ action: op.op, kind, id: op.id, reason: 'missing_why' });
    return;
  }

  if (op.op === 'ADD') {
    if (!policy.allowMemSave || !policy.allowedMemoryKinds.includes(kind)) {
      applied.ignored.push({ action: 'ADD', kind, reason: 'policy_denied' });
      return;
    }
    const saved = await addMemory(kind, { ...(op.params || op.entry || {}), why });
    if (saved) applied.saves.push({ kind, entry: saved, op: 'ADD' });
    return;
  }

  if (op.op === 'UPDATE') {
    const updated = await updateMemory(kind, op.id, op.params || {}, why);
    if (updated) applied.updates.push({ kind, id: op.id, entry: updated });
    else applied.ignored.push({ action: 'UPDATE', kind, id: op.id, reason: 'not_found' });
    return;
  }

  if (op.op === 'PROMOTE') {
    const promoted = await promoteMemory(op.id, why);
    if (promoted) applied.promotions.push({ id: op.id, entry: promoted });
    else applied.ignored.push({ action: 'PROMOTE', kind: 'short', id: op.id, reason: 'not_found' });
    return;
  }

  if (op.op === 'DELETE') {
    const deleteCheck = await canDeleteMemory(kind, op.id, why, policy, applied.deletes.length);
    if (!deleteCheck.allowed) {
      applied.ignored.push({ action: 'DELETE', kind, id: op.id, reason: deleteCheck.reason });
      return;
    }
    const deleted = await deleteMemory(kind, op.id);
    applied.deletes.push({ kind, id: op.id, why, source: op.source, deleted });
    return;
  }

  if (op.op === 'PIN' || op.op === 'UNPIN') {
    const pinned = await setPin(kind, op.id, op.op === 'PIN', op.params || {}, why);
    if (pinned) applied.pins.push({ kind, id: op.id, pin: op.op === 'PIN', entry: pinned });
    else applied.ignored.push({ action: op.op, kind, id: op.id, reason: 'not_found' });
  }
}

module.exports = {
  applyParsedActions,
  canDeleteMemory,
  applyPlanOp
};
