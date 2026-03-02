'use strict';

function createSSEBus() {
  const clients = {};
  const logs = {};

  function getLog(runId) {
    if (!logs[runId]) logs[runId] = [];
    return logs[runId];
  }

  function emit(runId, type, data) {
    const ev = { type, data, ts: Date.now() };
    getLog(runId).push(ev);
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    (clients[runId] || new Set()).forEach(res => {
      try { res.write(payload); } catch (_) {}
    });
  }

  function attach(runId, req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    for (const ev of getLog(runId)) {
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    }

    if (!clients[runId]) clients[runId] = new Set();
    clients[runId].add(res);

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); }
    }, 15000);

    req.on('close', () => {
      clearInterval(ping);
      clients[runId]?.delete(res);
    });
  }

  function clearLog(runId) {
    logs[runId] = [];
  }

  return {
    emit,
    attach,
    getLog,
    clearLog,
  };
}

module.exports = {
  createSSEBus,
};
