'use strict';

// Lifetime counters for what Holdfast has actually done: requests forwarded,
// drops caught, sessions saved (successful replay after a hold), give-ups, and
// time spent holding — broken down per listener (provider) and per client tool
// (identified by the request's User-Agent, e.g. "claude-cli"). Persisted to
// ~/.holdfast/stats.json so the numbers survive restarts.

const fs = require('fs');
const path = require('path');
const config = require('./config');

const statsFile = path.join(path.dirname(config.logFile), 'stats.json');

function emptyBucket() {
  return { requests: 0, drops: 0, saves: 0, giveups: 0, heldSeconds: 0 };
}

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    if (s && typeof s === 'object' && s.listeners) return s;
  } catch (_) {}
  return { since: new Date().toISOString(), listeners: {}, agents: {} };
}

const stats = load();

function writeNow() {
  try {
    fs.mkdirSync(path.dirname(statsFile), { recursive: true });
    fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
  } catch (_) {}
}

let saveTimer = null;
function persist() {
  // Throttle disk writes: at most one per second.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, 1000);
  if (saveTimer.unref) saveTimer.unref();
}

// The throttle timer is unref'd, so a quick exit could drop the last events.
// Flush synchronously on the way out.
process.on('exit', () => {
  if (saveTimer) writeNow();
});

// "claude-cli/2.1.0 (external, cli)" -> "claude-cli". Unknown -> "unknown".
function agentName(userAgent) {
  if (!userAgent) return 'unknown';
  const first = String(userAgent).trim().split(/\s+/)[0];
  return (first.split('/')[0] || 'unknown').toLowerCase();
}

function bucketFor(map, key) {
  if (!map[key]) map[key] = emptyBucket();
  return map[key];
}

function record(listenerName, userAgent, event, detail = {}) {
  const buckets = [
    bucketFor(stats.listeners, listenerName),
    bucketFor(stats.agents, agentName(userAgent)),
  ];
  for (const b of buckets) {
    switch (event) {
      case 'request': b.requests += 1; break;
      case 'drop': b.drops += 1; break;
      case 'save':
        b.saves += 1;
        b.heldSeconds += detail.heldSec || 0;
        break;
      case 'giveup': b.giveups += 1; break;
    }
  }
  persist();
  return stats;
}

function snapshot() {
  return stats;
}

module.exports = { record, snapshot, agentName, statsFile };
