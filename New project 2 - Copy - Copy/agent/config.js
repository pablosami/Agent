const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const rootDir = path.resolve(__dirname, '..');

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) ? value : fallback;
}

function pathEnv(name, fallback) {
  const value = process.env[name] || fallback;
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

const config = {
  rootDir,
  ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
  modelName: process.env.MODEL_NAME || 'gemma3:4b',
  defaultIntervalSec: intEnv('DEFAULT_INTERVAL_SEC', 3600),
  minIntervalSec: intEnv('MIN_INTERVAL_SEC', 60),
  maxIntervalSec: intEnv('MAX_INTERVAL_SEC', 86400),
  maxShortMemInContext: intEnv('MAX_SHORT_MEM_IN_CONTEXT', 5),
  maxLongMemInContext: intEnv('MAX_LONG_MEM_IN_CONTEXT', 5),
  maxTokens: intEnv('MAX_TOKENS', 768),
  logDir: pathEnv('LOG_DIR', './logs'),
  memoryDir: pathEnv('MEMORY_DIR', './memory'),
  maxMemWritesPerStep: intEnv('MAX_MEM_WRITES_PER_STEP', 3),
  maxDeletesPerStep: intEnv('MAX_DELETES_PER_STEP', 5),
  maxDeleteRatio: Number.isFinite(Number.parseFloat(process.env.MAX_DELETE_RATIO))
    ? Number.parseFloat(process.env.MAX_DELETE_RATIO)
    : 0.2,
  pinDeletionMinAgeDays: intEnv('PIN_DELETION_MIN_AGE_DAYS', 14),
  reflectShortMemThreshold: intEnv('REFLECT_SHORT_MEM_THRESHOLD', 10),
  requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 120000)
};
config.maxDelayMs = intEnv('MAX_DELAY_MS', 60000);
config.thinkEverySec = intEnv('THINK_EVERY_SEC', 60);
config.maxHeartbeatIntervalSec = intEnv('MAX_HEARTBEAT_INTERVAL_SEC', 900);

config.shortMemPath = path.join(config.memoryDir, 'short_mem.json');
config.longMemPath = path.join(config.memoryDir, 'long_mem.json');

module.exports = config;
