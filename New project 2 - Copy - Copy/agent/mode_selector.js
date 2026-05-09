function selectMode(analysis) {
  if (!analysis.shouldRespond || analysis.intent === 'noise') return 'IGNORE';
  if (analysis.intent === 'meta') return 'STATUS';
  if (analysis.user_directives?.asks_memory_delete || analysis.user_directives?.asks_memory_clear) return 'STATUS';
  if (analysis.risk_flags?.prompt_injection_like) return 'CHAT';
  if (analysis.intent === 'task' || analysis.intent === 'reminder') return 'TASK';
  if (analysis.intent === 'idea' || analysis.memoryAction !== 'none') return 'CHAT_WITH_MEMORY';
  return 'CHAT';
}

function policyForMode(mode, analysis = {}) {
  const userDirectives = analysis.user_directives || {};
  const userRequestPresent = Object.values(userDirectives).some(Boolean);
  const destructiveUserRequest = Boolean(userDirectives.asks_memory_delete || userDirectives.asks_memory_clear);
  const scheduleUserRequest = Boolean(userDirectives.asks_schedule_change);

  return {
    allowMemSave: true,
    allowedMemoryKinds: ['short', 'long'],
    allowMemDelete: mode === 'AUTONOMOUS_THINK' && !userRequestPresent && !destructiveUserRequest,
    allowReflect: true,
    allowSchedule: mode === 'AUTONOMOUS_THINK' && !scheduleUserRequest,
    requireWhy: true,
    denyUserTextSource: true,
    decisionOrigin: userRequestPresent ? 'USER_REQUEST_PRESENT' : 'NORMAL',
    riskFlags: analysis.risk_flags || {}
  };
}

module.exports = {
  selectMode,
  policyForMode
};
