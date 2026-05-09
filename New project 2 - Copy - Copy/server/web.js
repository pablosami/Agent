const express = require('express');
const path = require('path');
const { subscribe } = require('../agent/event_bus');
const { enqueueCommand } = require('../agent/command_queue');
const { buildSnapshot } = require('../agent/memory_snapshot');

function startWeb(options = {}) {
  const port = Number(options.port ?? process.env.WEB_PORT ?? 3000);
  const host = options.host || process.env.WEB_HOST || '127.0.0.1';
  const token = options.token || process.env.AGENT_WEB_TOKEN || null;
  const app = express();

  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(path.resolve(process.cwd(), 'public')));

  app.get('/api/status', (req, res) => {
    res.json({ ok: true, pid: process.pid, now: new Date().toISOString() });
  });

  app.get('/api/memory-snapshot', (req, res) => {
    res.json({ ok: true, snapshot: buildSnapshot() });
  });

  app.post('/api/command', (req, res) => {
    if (token && req.headers['x-agent-token'] !== token) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'text_required' });
    const cmd = enqueueCommand({ from: 'web', text });
    return res.json({ ok: true, cmd });
  });

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (evt) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    };
    send({ type: 'sse.connected', ts: new Date().toISOString() });

    const unsubscribe = subscribe(send);
    req.on('close', unsubscribe);
  });

  const server = app.listen(port, host, () => {
    console.log(`Web dashboard: http://${host}:${port}`);
  });
  return { app, server };
}

if (require.main === module) {
  startWeb({
    port: process.argv[2] || process.env.WEB_PORT || 3000
  });
}

module.exports = {
  startWeb
};
