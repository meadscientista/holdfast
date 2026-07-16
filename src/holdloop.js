'use strict';

// The heart of Holdfast: forward a request to a given upstream, and if the line
// is down, hold it — probing connectivity every RETRY_INTERVAL and replaying
// the moment the network returns, for up to MAX_RETRIES (the hold window).
// Real API responses (2xx/4xx/5xx) are returned immediately and never retried,
// so a turn is never double-run.

const config = require('./config');
const { forwardOnce } = require('./forward');
const { checkOnline } = require('./probe');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Forwards with hold-and-retry against `upstreamUrl`. Resolves with the
// upstream response, or rejects (isHoldTimeout) if the hold window elapses with
// no network. `onState(event, detail)` is an optional callback for logging.
async function forwardWithHold(upstreamUrl, request, onState = () => {}) {
  const startedAt = Date.now();
  let attempt = 0;

  // Try immediately.
  try {
    return await forwardOnce(upstreamUrl, request);
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
      const res = await forwardOnce(upstreamUrl, request);
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

module.exports = { forwardWithHold };
