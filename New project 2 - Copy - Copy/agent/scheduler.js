const config = require('./config');
const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = path.resolve(process.cwd(), 'runtime');
const SCHEDULE_FILE = path.join(RUNTIME_DIR, 'scheduled.json');

let timer = null;
let isRunning = false;

function ensureRuntime() {
  if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

class Scheduler {
  constructor({ persist = false, onFire = null, maxDelayMs = 60000, maxQueue = 200 } = {}) {
    this.persist = persist;
    this.onFire = onFire;
    this.maxDelayMs = maxDelayMs;
    this.maxQueue = maxQueue;
    this.queue = [];
    this.seq = 0;
    if (this.persist) this.load();
  }

  load() {
    try {
      ensureRuntime();
      if (!fs.existsSync(SCHEDULE_FILE)) return;
      const state = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
      if (Array.isArray(state?.queue)) this.queue = state.queue;
      this.seq = Number(state?.seq || 0);
    } catch (error) {
      // Ignore broken scheduler state.
    }
  }

  save() {
    if (!this.persist) return;
    try {
      ensureRuntime();
      fs.writeFileSync(SCHEDULE_FILE, JSON.stringify({ seq: this.seq, queue: this.queue }, null, 2), 'utf8');
    } catch (error) {
      // Ignore persistence errors; daemon keeps in-memory queue.
    }
  }

  scheduleNotify({ afterMs, text, channel = 'scheduled', user_id = null, why = '', source = 'AGENT_MODEL', run_id = null } = {}) {
    const delay = clamp(Number(afterMs || 0), 0, this.maxDelayMs);
    if (!text || typeof text !== 'string') return { ok: false, error: 'missing_text' };
    if (!why || typeof why !== 'string' || why.trim().length < 3) return { ok: false, error: 'missing_why' };
    if (this.queue.length >= this.maxQueue) return { ok: false, error: 'queue_full' };

    this.seq += 1;
    const task = {
      id: `tsk_notify_${String(this.seq).padStart(6, '0')}`,
      type: 'notify',
      created_at: new Date().toISOString(),
      runAt: Date.now() + delay,
      payload: { text, channel, user_id },
      meta: { why, source, run_id }
    };

    this.queue.push(task);
    this.queue.sort((a, b) => a.runAt - b.runAt);
    this.save();
    return { ok: true, task };
  }

  tick(nowMs = Date.now()) {
    const fired = [];
    while (this.queue.length && this.queue[0].runAt <= nowMs) {
      const task = this.queue.shift();
      fired.push(task);
      try {
        if (typeof this.onFire === 'function') this.onFire(task);
      } catch (error) {
        // Keep ticking even if a subscriber fails.
      }
    }
    if (fired.length) this.save();
    return fired;
  }
}

function clearScheduledRun() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function scheduleNext(runAgent, seconds) {
  clearScheduledRun();
  const delaySec = Math.min(config.maxIntervalSec, Math.max(config.minIntervalSec, Number(seconds) || config.defaultIntervalSec));
  const nextAt = new Date(Date.now() + delaySec * 1000);
  timer = setTimeout(() => {
    runSafely(runAgent);
  }, delaySec * 1000);
  console.log(`Next run scheduled at ${nextAt.toLocaleString()} (${delaySec}s).`);
  return { delaySec, nextAt };
}

async function runSafely(runAgent) {
  if (isRunning) {
    console.warn('Previous run is still active; skipping overlapping run.');
    return;
  }
  isRunning = true;
  try {
    await runAgent();
  } catch (error) {
    console.error(error.message);
    scheduleNext(runAgent, config.defaultIntervalSec);
  } finally {
    isRunning = false;
  }
}

module.exports = {
  Scheduler,
  SCHEDULE_FILE,
  scheduleNext,
  runSafely,
  clearScheduledRun
};
