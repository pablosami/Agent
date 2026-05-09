const { loadSTM, loadLTM } = require('./memory_manager');
const { focusForPrompt, setFocusItems } = require('./focus_manager');
const { generate } = require('./ollama_client');

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

async function selfAnswer(questionText) {
  const stm = await loadSTM();
  const ltm = await loadLTM();
  const focus = focusForPrompt();

  const prompt = `Ты должен дать авто-ответ на вопрос, на который пользователь не ответил вовремя.
Верни строго JSON без markdown.

Вопрос:
${JSON.stringify(String(questionText || ''))}

STM:
${JSON.stringify(String(stm.text || ''))}

LTM:
${JSON.stringify(ltm.slice(-30), null, 2)}

Focus:
${JSON.stringify(focus, null, 2)}

Формат:
{
  "answer":"string",
  "confidence":0.0,
  "assumption":false,
  "followup_question":"string|null",
  "new_focus":[{"kind":"topic","label":"...","why":"...","weight":0.6}]
}

Правила:
- не выдумывай факты
- если данных мало, assumption=true и отметь, что это предположение`;

  const raw = String(await generate(prompt)).trim();
  const json = safeJsonParse(raw) || safeJsonParse(raw.replace(/```json|```/g, '').trim());
  if (!json) {
    return {
      answer: 'Предположение: сейчас недостаточно данных для уверенного вывода. Нужны уточнения по вопросу.',
      confidence: 0,
      assumption: true,
      followup_question: 'Можете уточнить детали вашего приоритета сейчас?'
    };
  }

  if (Array.isArray(json.new_focus) && json.new_focus.length) {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    setFocusItems(json.new_focus.slice(0, 3).map((item, index) => ({
      id: item.id || `focus_self_${Date.now()}_${index}`,
      kind: item.kind || 'topic',
      label: item.label,
      why: item.why,
      weight: item.weight,
      expires_at: expiresAt
    })));
  }

  const assumption = Boolean(json.assumption);
  const followup = json.followup_question ? String(json.followup_question).trim() : '';
  let answer = String(json.answer || '').trim();
  if (!answer) answer = 'Недостаточно данных для уверенного ответа.';
  if (assumption && !answer.toLowerCase().startsWith('предположение:')) {
    answer = `Предположение: ${answer}`;
  }
  if (followup) answer = `${answer}\n\nВопрос: ${followup}`;

  return {
    answer,
    confidence: Math.max(0, Math.min(1, Number(json.confidence ?? 0.4))),
    assumption,
    followup_question: followup || null
  };
}

module.exports = {
  selfAnswer
};
