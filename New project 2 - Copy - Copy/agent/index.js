const config = require('./config');
const { buildPrompt } = require('./context_builder');
const { generate } = require('./ollama_client');
const { parseOutput } = require('./output_parser');
const { maybeReflect } = require('./reflection');
const { writeRunLog } = require('./logger');
const { scheduleNext, runSafely } = require('./scheduler');
const { policyForMode } = require('./mode_selector');
const { applyParsedActions } = require('./action_policy');
const { ensureProjectDirs, processUserText } = require('./pipeline');

async function runAgent() {
  await ensureProjectDirs();
  const prompt = await buildPrompt();
  let rawResponse = '';
  let parsed = null;
  let applied = null;
  let reflection = null;
  let nextScheduleSec = config.defaultIntervalSec;
  let error = null;

  try {
    rawResponse = await generate(prompt);
    parsed = parseOutput(rawResponse);
    applied = await applyParsedActions(parsed, policyForMode('AUTONOMOUS_THINK'));
    reflection = await maybeReflect(applied.reflect);
    nextScheduleSec = applied.scheduleSec;
    console.log('Agent run completed.');
  } catch (caught) {
    error = caught.message;
    console.error(error);
  }

  const logFile = await writeRunLog({
    prompt,
    response: rawResponse,
    parsed,
    applied,
    reflection,
    error,
    nextScheduleSec
  });
  console.log(`Log written: ${logFile}`);

  if (process.env.RUN_ONCE === '1') {
    console.log(`Run once mode: next schedule would be ${nextScheduleSec}s.`);
  } else {
    scheduleNext(runAgent, nextScheduleSec);
  }
}

async function handleUserInput(input) {
  return processUserText(input, { from: 'cli' });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--daemon')) {
    if (args.includes('--web')) {
      const portIndex = args.indexOf('--web') + 1;
      const port = args[portIndex] && !args[portIndex].startsWith('--') ? args[portIndex] : undefined;
      const { startWeb } = require('../server/web');
      startWeb({ port });
    }
    const { runDaemon } = require('./daemon');
    return runDaemon();
  }

  if (args.includes('--web')) {
    const portIndex = args.indexOf('--web') + 1;
    const port = args[portIndex] && !args[portIndex].startsWith('--') ? args[portIndex] : undefined;
    const { startWeb } = require('../server/web');
    startWeb({ port });
    return undefined;
  }

  const input = args.join(' ').trim();
  if (input) return handleUserInput(input);
  return runSafely(runAgent);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  runAgent,
  handleUserInput,
  processUserText,
  applyParsedActions,
  main
};
