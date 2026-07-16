'use strict';

// Holdfast configuration. Every value has a sane default and can be overridden
// with an environment variable (or CLI flag, which sets the env var) so no code
// edits are ever needed.

const os = require('os');
const path = require('path');

function intEnv(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// --- Hold window -----------------------------------------------------------
// How long to keep holding a request while the network is down. Expressed in
// friendly minutes; converted to a retry count against the probe interval.
const holdMinutes = intEnv('HOLDFAST_HOLD_MINUTES', 60);
const retryIntervalMs = intEnv('HOLDFAST_RETRY_INTERVAL_MS', 30_000);
const maxRetries =
  intEnv('HOLDFAST_MAX_RETRIES', 0) ||
  Math.max(1, Math.ceil((holdMinutes * 60_000) / retryIntervalMs));

// --- Listeners -------------------------------------------------------------
// Each listener is one local port mapped to one upstream API. A single
// Holdfast process can protect many tools/providers at once. Route by port:
// each IDE points its base-URL setting at the matching port.
//
// Advanced: set HOLDFAST_LISTENERS to a JSON array, e.g.
//   [{"name":"anthropic","port":8787,"upstream":"https://api.anthropic.com"},
//    {"name":"openai","port":8788,"upstream":"https://api.openai.com"}]
function parseListeners() {
  if (process.env.HOLDFAST_LISTENERS) {
    try {
      const arr = JSON.parse(process.env.HOLDFAST_LISTENERS);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (_) {
      // fall through to default
    }
  }
  return [
    {
      name: 'anthropic',
      port: intEnv('HOLDFAST_PORT', 8787),
      upstream: process.env.HOLDFAST_UPSTREAM || 'https://api.anthropic.com',
    },
  ];
}

const config = {
  holdMinutes,
  retryIntervalMs,
  maxRetries,

  listeners: parseListeners(),

  // Invisible SSE keep-alive pings sent to the client while holding, so the
  // client's socket never idles out during a long outage. THIS is what lets a
  // 20-30 minute outage survive without the turn dying.
  heartbeatMs: intEnv('HOLDFAST_HEARTBEAT_MS', 15_000),

  // Connectivity probe.
  probeTimeoutMs: intEnv('HOLDFAST_PROBE_TIMEOUT_MS', 5_000),
  probeHost: process.env.HOLDFAST_PROBE_HOST || null, // resolved from upstream if null
  probePort: intEnv('HOLDFAST_PROBE_PORT', 443),

  // Max time for a single upstream attempt before it counts as a network
  // failure. Generous — model responses can take minutes.
  upstreamTimeoutMs: intEnv('HOLDFAST_UPSTREAM_TIMEOUT_MS', 600_000),

  logFile:
    process.env.HOLDFAST_LOG_FILE ||
    path.join(os.homedir(), '.holdfast', 'holdfast.log'),
  logConsole: process.env.HOLDFAST_LOG_CONSOLE !== '0',
};

module.exports = config;
