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
  // Every listener is ON by default. A listener is passive — it is just a
  // localhost port that does nothing until a tool actually points its base URL
  // at it — so running all of them costs nothing and requires zero decisions
  // from the user: run one command and every supported IDE/tool is protected.
  // (A port already in use is skipped with a warning at startup; it never takes
  // down the others — see server.js.) Power users can still fully override the
  // set with HOLDFAST_LISTENERS.

  // KRS (Kiro's chat backend) is region-gated to a small set and is INDEPENDENT
  // of the AWS SDK region — Kiro itself falls back to the KRS default
  // (us-east-1) for any unsupported region, so we do NOT read AWS_REGION here
  // (that's Bedrock's region and is often unsupported by KRS, which would
  // forward to a non-existent runtime.<region>.kiro.dev host).
  const KRS_REGIONS = new Set(['us-east-1', 'eu-central-1', 'us-gov-west-1']);
  const krsRequested =
    process.env.HOLDFAST_KIRO_REGION || process.env.HOLDFAST_CODEWHISPERER_REGION;
  const krsRegion = KRS_REGIONS.has(krsRequested) ? krsRequested : 'us-east-1';

  const listeners = [
    {
      name: 'anthropic',
      port: intEnv('HOLDFAST_PORT', 8787),
      upstream: process.env.HOLDFAST_UPSTREAM || 'https://api.anthropic.com',
    },
    {
      name: 'openai',
      port: intEnv('HOLDFAST_OPENAI_PORT', 8788),
      upstream: process.env.HOLDFAST_OPENAI_UPSTREAM || 'https://api.openai.com',
    },
    {
      name: 'bedrock',
      port: intEnv('HOLDFAST_BEDROCK_PORT', 8789),
      upstream:
        process.env.HOLDFAST_BEDROCK_UPSTREAM ||
        `https://bedrock-runtime.${process.env.HOLDFAST_BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1'}.amazonaws.com`,
      // AWS endpoints need SigV4: Holdfast re-signs each attempt with this
      // machine's own AWS credentials (env or ~/.aws/credentials).
      aws: true,
    },
    {
      // Kiro's chat streams through the Kiro Runtime Service (KRS). The agent
      // extension builds ONE streaming client:
      //   new CodeWhispererStreaming({ ...getKrsConfig(), token: { token } })
      // whose endpoint defaults to https://runtime.<region>.kiro.dev (NOT
      // q.amazonaws.com and NOT codewhisperer.amazonaws.com — those are legacy /
      // unused-for-chat). Auth is an SSO Bearer token, NOT SigV4, so Holdfast
      // passes Authorization through untouched (aws:false).
      //
      // To route Kiro through this listener the client's endpoint must be set —
      // Kiro sets an EXPLICIT endpoint, so the AWS SDK ignores AWS_ENDPOINT_URL*;
      // the hook is Kiro's own trusted setting, in Kiro settings.json:
      //   "codewhisperer.config.krsEndpoints": [
      //     { "region": "us-east-1", "endpoint": "http://localhost:8790" }
      //   ]
      // That touches ONLY Kiro and cannot affect Claude Code or any other tool.
      name: 'kiro',
      port: intEnv('HOLDFAST_KIRO_PORT', 0) || intEnv('HOLDFAST_CODEWHISPERER_PORT', 8790),
      upstream:
        process.env.HOLDFAST_KIRO_UPSTREAM ||
        process.env.HOLDFAST_CODEWHISPERER_UPSTREAM ||
        `https://runtime.${krsRegion}.kiro.dev`,
      // Bearer-token auth, not SigV4 — pass Authorization through untouched.
      aws: false,
    },
  ];

  return listeners;
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
