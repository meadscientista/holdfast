'use strict';

// The localhost servers that agent IDEs talk to. One HTTP listener per
// configured provider (Anthropic on :8787, OpenAI-compatible on :8788, ...).
// Each buffers an incoming request, hands it to the hold loop, and relays the
// response back — sending invisible keep-alive heartbeats to the client during
// a hold so even a 20-30 minute outage never idles the connection out.

const http = require('http');
const config = require('./config');
const log = require('./log');
const { forwardWithHold } = require('./holdloop');
const { targetFor } = require('./probe');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Does the client expect a streamed (SSE) response? Claude Code and most agent
// IDEs set `"stream": true` in the body and/or Accept: text/event-stream.
function wantsStream(headers, body) {
  const accept = String(headers['accept'] || '');
  if (accept.includes('text/event-stream')) return true;
  const text = body && body.length ? body.toString('utf8', 0, Math.min(body.length, 4096)) : '';
  return /"stream"\s*:\s*true/.test(text);
}

function sseError(message) {
  const payload = JSON.stringify({ type: 'error', error: { type: 'holdfast_error', message } });
  return `event: error\ndata: ${payload}\n\n`;
}

function makeHandler(listener) {
  const label = listener.name;

  return async function handle(req, res) {
    if (req.url === '/__holdfast/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, listener: label, upstream: listener.upstream, pid: process.pid }));
      return;
    }

    const body = await readBody(req).catch(() => Buffer.alloc(0));
    const streaming = wantsStream(req.headers, body);

    // Heartbeat state — only engaged if we actually enter a hold.
    let headersSent = false;
    let heartbeat = null;

    const startHeartbeat = () => {
      if (!streaming || headersSent) return;
      // Commit an SSE 200 so we can drip keep-alive comments during the outage.
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      headersSent = true;
      // SSE comment lines (":" prefix) are ignored by every SSE parser, so the
      // client stays connected but sees nothing until the real response lands.
      res.write(': holdfast waiting for network to return\n\n');
      heartbeat = setInterval(() => {
        res.write(': holdfast still holding\n\n');
      }, config.heartbeatMs);
      if (heartbeat.unref) heartbeat.unref();
    };
    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    };

    const onState = (event, detail) => {
      switch (event) {
        case 'hold-enter':
          log.warn(`[${label}] network error (${detail.code}) — entering hold` + (streaming ? ' (heartbeat on)' : ''));
          startHeartbeat();
          break;
        case 'probe':
          log.info(`[${label}] probe ${detail.attempt}/${detail.max} … ${detail.online ? 'BACK ONLINE — replaying' : 'no network'}`);
          break;
        case 'replay-failed':
          log.warn(`[${label}] probe passed but replay failed (${detail.code}) — still holding`);
          break;
        case 'recovered':
          log.info(`[${label}] response relayed ✓  (held ${detail.heldSec}s, session intact)`);
          break;
        case 'give-up':
          log.error(`[${label}] gave up after ${detail.heldSec}s / ${detail.attempts} attempts`);
          break;
      }
    };

    log.info(`[${label}] ${req.method} ${req.url} — request in-flight`);

    try {
      const up = await forwardWithHold(
        listener.upstream,
        { method: req.method, path: req.url, headers: req.headers, body },
        onState
      );
      stopHeartbeat();

      if (headersSent) {
        // We already committed a 200 SSE for heartbeats. Deliver the real body
        // as the continuation of that stream.
        if (up.statusCode >= 200 && up.statusCode < 300) {
          res.end(up.body);
        } else {
          // Rare: network came back but the replay got a real API rejection.
          // We can't change status now, so surface it as an SSE error event —
          // strictly better than a dead, silent turn.
          res.write(sseError(`upstream returned ${up.statusCode} after recovery: ${up.body.toString('utf8', 0, 500)}`));
          res.end();
        }
        return;
      }

      // Fast path (no hold happened, or non-streaming): relay verbatim.
      const outHeaders = Object.assign({}, up.headers);
      delete outHeaders['transfer-encoding'];
      delete outHeaders['connection'];
      res.writeHead(up.statusCode, outHeaders);
      res.end(up.body);
    } catch (err) {
      stopHeartbeat();
      log.error(`[${label}] request failed: ${err.message}`);
      const msg = err.isHoldTimeout ? err.message : `Holdfast internal error: ${err.message}`;
      if (headersSent) {
        res.write(sseError(msg));
        res.end();
      } else {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'holdfast_error', message: msg } }));
      }
    }
  };
}

function startListener(listener) {
  const server = http.createServer(makeHandler(listener));
  // No socket timeouts: a held request may legitimately take the full window.
  server.timeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;

  server.listen(listener.port, '127.0.0.1', () => {
    const t = targetFor(listener.upstream);
    log.info(`[${listener.name}] live on :${listener.port}  →  ${listener.upstream}  (probe ${t.host}:${t.port})`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`[${listener.name}] port ${listener.port} in use — already running? (override with config)`);
    } else {
      log.error(`[${listener.name}] server error: ${err.message}`);
    }
    process.exitCode = 1;
  });
  return server;
}

function start() {
  const mins = config.holdMinutes;
  log.info(`Holdfast starting — hold window ~${mins} min (${config.maxRetries}×${config.retryIntervalMs / 1000}s), heartbeat ${config.heartbeatMs / 1000}s`);
  const servers = config.listeners.map(startListener);
  log.info('point each IDE at the matching port (see README). Ctrl-C to stop.');
  return servers;
}

module.exports = { start };
