'use strict';

// The heart of Holdfast: forward a request to a given upstream, and if the line
// is down, hold it — probing connectivity every RETRY_INTERVAL and replaying
// the moment the network returns, for up to MAX_RETRIES (the hold window).
// Real API responses (2xx/4xx/5xx) are returned immediately and never retried,
// so a turn is never double-run.
//
// Two entry points, mirroring forward.js:
//   forwardWithHold  -> buffered; resolves with the full { statusCode, headers, body }
//   openWithHold     -> streaming; resolves with { statusCode, headers, res } the
//                       instant headers arrive, so tokens stream through live.
//                       Only PRE-FIRST-BYTE failures are held-and-replayed here;
//                       a drop mid-stream is the caller's to surface (not safely
//                       replayable — the client already holds a partial answer).

const config = require('./config');
const { forwardOnce, openUpstream } = require('./forward');
const { checkOnline } = require('./probe');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function upstreamOf(listener) {
  return typeof listener === 'string' ? listener : listener.upstream;
}

// Shared hold loop. `attemptFn` performs one attempt and either resolves with a
// value to hand back to the caller, or rejects with a NetworkError to keep
// holding. Any non-network error is re-thrown immediately (real API answer).
// Resolves with the successful value, or rejects (isHoldTimeout) if the hold
// window elapses with no network.
async function holdLoop(listener, attemptFn, onState, startedAt) {
  const upstreamUrl = upstreamOf(listener);
  let attempt = 0;

  // Try immediately.
  try {
    return await attemptFn();
  } catch (err) {
    if (!err.isNetworkError) throw err; // real error — pass through untouched
    onState('hold-enter', { code: err.code, message: err.message });
  }

  // Hold loop: probe, then replay when online.
  while (attempt < config.maxRetries) {
    attempt += 1;
    await sleep(config.retryIntervalMs);

    const online = await checkOnline(upstreamUrl);
    onState('probe', { attempt, max: config.maxRetries, online });
    if (!online) continue;

    try {
      const res = await attemptFn();
      onState('recovered', { attempt, heldSec: Math.round((Date.now() - startedAt) / 1000) });
      return res;
    } catch (err) {
      if (!err.isNetworkError) throw err; // real API answer now — return it
      onState('replay-failed', { attempt, code: err.code });
    }
  }

  const heldSec = Math.round((Date.now() - startedAt) / 1000);
  const giveUp = new Error(
    `Holdfast held for ${heldSec}s (${config.maxRetries} attempts) but the network never returned.`
  );
  giveUp.isHoldTimeout = true;
  onState('give-up', { heldSec, attempts: config.maxRetries });
  throw giveUp;
}

// Buffered forward with hold-and-retry. Resolves with { statusCode, headers, body }.
// AWS listeners get re-signed per attempt inside forwardOnce.
async function forwardWithHold(listener, request, onState = () => {}) {
  return holdLoop(listener, () => forwardOnce(listener, request), onState, Date.now());
}

// Streaming forward with hold-and-retry on pre-first-byte failures. Resolves
// with { statusCode, headers, res } — a LIVE stream — the moment headers arrive,
// so the caller can pipe tokens straight to the client.
async function openWithHold(listener, request, onState = () => {}) {
  return holdLoop(listener, () => openUpstream(listener, request), onState, Date.now());
}

module.exports = { forwardWithHold, openWithHold };
