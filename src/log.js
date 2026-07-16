'use strict';

// Timestamped state-transition logging to both a file and the console, so you
// can see exactly what happened during a network drop without watching the
// Claude Code screen.

const fs = require('fs');
const path = require('path');
const config = require('./config');

let stream = null;

function ensureStream() {
  if (stream) return stream;
  try {
    fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
    stream = fs.createWriteStream(config.logFile, { flags: 'a' });
  } catch (err) {
    // If we can't open the log file, fall back to console-only.
    stream = null;
  }
  return stream;
}

function ts() {
  // Local time HH:MM:SS for the human-facing prefix.
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function write(level, msg) {
  const line = `[${new Date().toISOString()}] ${level} ${msg}\n`;
  const s = ensureStream();
  if (s) s.write(line);
  if (config.logConsole) {
    const human = `  ↳ [${ts()}] ${msg}`;
    if (level === 'ERROR') process.stderr.write(human + '\n');
    else process.stdout.write(human + '\n');
  }
}

module.exports = {
  info: (msg) => write('INFO', msg),
  warn: (msg) => write('WARN', msg),
  error: (msg) => write('ERROR', msg),
  logFile: config.logFile,
};
