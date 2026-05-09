const fs = require('fs');
const path = require('path');
const { publish } = require('./event_bus');

const TELEMETRY_DIR = path.resolve(process.cwd(), 'telemetry');
const EVENTS_FILE = path.join(TELEMETRY_DIR, 'events.jsonl');

function ensureTelemetryDir() {
  if (!fs.existsSync(TELEMETRY_DIR)) fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
  if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, '');
}

function emitEvent(evt) {
  ensureTelemetryDir();
  const event = {
    ts: new Date().toISOString(),
    ...evt
  };
  fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`, 'utf8');
  publish(event);
  return event;
}

module.exports = {
  emitEvent,
  ensureTelemetryDir,
  EVENTS_FILE
};
