'use strict';

// Forwards a single buffered request to a given upstream API and buffers the
// full response before returning. Buffering guarantees that a mid-stream drop
// never leaves the client with a half-response — nothing is sent to the client
// until we hold the complete, successful upstream response, so a clean replay
// is always safe.

const https = require('https');
const http = require('http');
const { URL } = require('url');
const config = require('./config');

// Node network/connection error codes that mean "the line is down" rather than
// "the API rejected your request". Only these trigger the hold-and-retry loop.
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'EPIPE', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN',
  'EHOSTDOWN',
]);

class NetworkError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'NetworkError';
    this.code = code;
    this.isNetworkError = true;
  }
}

function isNetworkErrorCode(code) {
  return NETWORK_ERROR_CODES.has(code);
}

// Performs one attempt against `upstreamUrl`. Resolves with
// { statusCode, headers, body } on any completed HTTP response (including
// 4xx/5xx — those are real API answers and must pass through untouched).
// Rejects with a NetworkError only when the connection itself failed.
function forwardOnce(upstreamUrl, { method, path: reqPath, headers, body }) {
  const upstream = new URL(upstreamUrl);
  const isHttps = upstream.protocol === 'https:';
  const transport = isHttps ? https : http;

  // Copy headers untouched (auth included) but fix Host to match upstream.
  const outHeaders = Object.assign({}, headers);
  delete outHeaders.host;
  delete outHeaders.Host;
  outHeaders.host = upstream.host;

  const options = {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (isHttps ? 443 : 80),
    method,
    path: joinPath(upstream.pathname, reqPath),
    headers: outHeaders,
  };

  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
      res.on('error', (err) => {
        if (isNetworkErrorCode(err.code) || !err.code) {
          reject(new NetworkError(`upstream stream error: ${err.message}`, err.code || 'ESTREAM'));
        } else reject(err);
      });
    });

    req.setTimeout(config.upstreamTimeoutMs, () => {
      req.destroy(new NetworkError('upstream timeout', 'ETIMEDOUT'));
    });

    req.on('error', (err) => {
      if (isNetworkErrorCode(err.code) || err.isNetworkError) {
        reject(err.isNetworkError ? err : new NetworkError(err.message, err.code));
      } else {
        // Unknown error shape — treat conservatively as network so we hold
        // rather than kill the session.
        reject(new NetworkError(err.message, err.code || 'EUNKNOWN'));
      }
    });

    if (body && body.length) req.write(body);
    req.end();
  });
}

// If the upstream URL has a base path (rare), prefix it; otherwise pass the
// client path through unchanged.
function joinPath(basePath, reqPath) {
  if (!basePath || basePath === '/') return reqPath;
  return basePath.replace(/\/$/, '') + reqPath;
}

module.exports = { forwardOnce, NetworkError, isNetworkErrorCode };
