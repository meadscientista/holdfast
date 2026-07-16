'use strict';

// Cheap connectivity probe: open a TCP connection to the target and close it
// immediately. We do NOT fire a full API request each poll — that would be
// expensive and could have side effects. Only when this passes do we replay
// the real request.

const net = require('net');
const { URL } = require('url');
const config = require('./config');

// Given an upstream URL, decide what host:port to probe for connectivity.
function targetFor(upstreamUrl) {
  if (config.probeHost) {
    return { host: config.probeHost, port: config.probePort };
  }
  const u = new URL(upstreamUrl);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
  };
}

// Resolves true if a TCP connection succeeds within the timeout, false otherwise.
function checkOnline(upstreamUrl) {
  const { host, port } = targetFor(upstreamUrl);
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(config.probeTimeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect(port, host);
    } catch (_) {
      done(false);
    }
  });
}

module.exports = { checkOnline, targetFor };
