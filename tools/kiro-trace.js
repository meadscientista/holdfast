#!/usr/bin/env node
'use strict';

// kiro-trace.js — a READ-ONLY diagnostic to discover EXACTLY how an IDE
// (Kiro, Claude Code, anything) talks to its model API, so Holdfast can be
// pointed at the right port and protocol. It runs as a localhost proxy that:
//   • logs every request in full (method, target host, path, auth scheme,
//     headers, body preview) with secrets redacted, then
//   • forwards it faithfully so the IDE keeps working during the trace, and
//   • for HTTPS CONNECT tunnels, logs the destination host:port and pipes the
//     (encrypted) bytes straight through — so even TLS traffic reveals which
//     endpoints the IDE contacts.
//
// Nothing is stored or altered; output goes to the terminal (and optional file).
//
// Usage:
//   node tools/kiro-trace.js [--port 8899] [--out trace.log]
//
// Then EITHER:
//   A) run the IDE through it as a proxy, launched from THIS terminal:
//        HTTPS_PROXY=http://localhost:8899 HTTP_PROXY=http://localhost:8899 <launch IDE>
//   B) or point the IDE's endpoint/base-URL override at http://localhost:8899
// ...and send ONE message in the IDE's chat. Watch the lines it prints.

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const { URL } = require('url');

const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(getArg('--port', process.env.KIRO_TRACE_PORT || 8899));
const OUT = getArg('--out', null);
const outStream = OUT ? fs.createWriteStream(OUT, { flags: 'a' }) : null;
// When an IDE reaches us in origin-form (Host: localhost — e.g. via a base-URL
// or endpoint override), we don't learn the real destination from the request.
// --upstream tells us where to forward those so the IDE's turn can still
// succeed during the trace. For Kiro chat the real backend is the Kiro Runtime
// Service: e.g. https://runtime.us-east-1.kiro.dev
const UPSTREAM = getArg('--upstream', null); // e.g. https://runtime.us-east-1.kiro.dev

let n = 0;
function line(s) {
  const msg = `${new Date().toISOString()}  ${s}`;
  console.log(msg);
  if (outStream) outStream.write(msg + '\n');
}

// Header values that must never be printed in the clear.
const SENSITIVE = /^(authorization|proxy-authorization|x-api-key|cookie|set-cookie|x-amz-security-token|x-amz-content-sha256|.*session.?token.*)$/i;

function describeHeaders(headers) {
  const out = [];
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE.test(k)) {
      const val = String(v);
      const scheme = val.split(/\s+/)[0];
      const showScheme = scheme && scheme.length < val.length && /^[A-Za-z0-9]+$/.test(scheme);
      out.push(`      ${k}: ${showScheme ? scheme + ' ' : ''}<redacted ${val.length} chars>`);
    } else {
      out.push(`      ${k}: ${v}`);
    }
  }
  return out.join('\n');
}

// What kind of upstream is this, and which Holdfast listener would serve it?
function hintFor(host) {
  const h = (host || '').toLowerCase();
  if (h.includes('bedrock-runtime')) return 'AWS Bedrock runtime  →  Holdfast :8789 (SigV4 re-sign) ✓ supported';
  if (h.includes('api.anthropic.com')) return 'Anthropic API  →  Holdfast :8787 ✓ supported';
  if (h.includes('openai')) return 'OpenAI API  →  Holdfast :8788 ✓ supported';
  if (h.includes('kiro.dev')) return 'Kiro Runtime Service (bearer token)  →  Holdfast :8790 (on by default) ✓ supported';
  if (h.includes('codewhisperer') || h.includes('amazonq') || /(^|\.)q\./.test(h)) return 'Amazon Q / CodeWhisperer backend (bearer token)  →  Holdfast :8790 (on by default)';
  if (h.includes('amazonaws.com')) return 'Some AWS service (SigV4 likely)  →  needs a signing listener';
  return 'unknown upstream — paste this line back';
}

function bodyPreview(buf) {
  if (!buf || !buf.length) return '(no body)';
  const text = buf.toString('utf8', 0, Math.min(buf.length, 400)).replace(/\s+/g, ' ');
  return `body[${buf.length} bytes]: ${text}`;
}

const HOP_BY_HOP = ['proxy-connection', 'connection', 'keep-alive', 'transfer-encoding'];

const server = http.createServer((req, res) => {
  const id = ++n;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let target;
    let originForm = false;
    try {
      if (req.url.startsWith('http')) {
        target = new URL(req.url);                            // proxy-form (absolute URL)
      } else if (UPSTREAM) {
        // origin-form via AWS_ENDPOINT_URL: forward to the real service so the
        // IDE's turn can complete, but keep the client's path.
        target = new URL(UPSTREAM.replace(/\/$/, '') + req.url);
        originForm = true;
      } else {
        target = new URL(`http://${req.headers.host}${req.url}`);
        originForm = true;
      }
    } catch (e) {
      res.writeHead(400); res.end('kiro-trace: bad target'); return;
    }

    line(`#${id} ── HTTP ${req.method} ${req.url}${originForm ? '   (origin-form — IDE honored the endpoint override! ✓)' : ''}`);
    line(`#${id}    → host: ${target.host}    [${hintFor(target.host)}]`);
    line(`#${id}    headers:\n${describeHeaders(req.headers)}`);
    line(`#${id}    ${bodyPreview(body)}`);

    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const fwdHeaders = Object.assign({}, req.headers, { host: target.host });
    HOP_BY_HOP.forEach((h) => delete fwdHeaders[h]);

    const up = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      method: req.method,
      path: target.pathname + target.search,
      headers: fwdHeaders,
    }, (upRes) => {
      line(`#${id}    ← ${upRes.statusCode} from ${target.host}`);
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', (err) => {
      line(`#${id}    ✗ forward error: ${err.code || err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`kiro-trace forward error: ${err.message}`);
    });
    if (body.length) up.write(body);
    up.end();
  });
});

// HTTPS via a proxy arrives as a CONNECT tunnel. We can't read the encrypted
// payload, but the CONNECT line names the destination host — which is exactly
// what we need to know. Pipe the bytes through so the IDE keeps working.
server.on('connect', (req, clientSocket, head) => {
  const id = ++n;
  const [host, portStr] = req.url.split(':');
  const port = Number(portStr) || 443;
  line(`#${id} ══ CONNECT ${req.url}    [${hintFor(host)}]`);
  const serverSocket = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });
  serverSocket.on('error', (err) => {
    line(`#${id}    ✗ tunnel error to ${req.url}: ${err.code || err.message}`);
    clientSocket.end();
  });
  clientSocket.on('error', () => serverSocket.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  line(`kiro-trace listening on http://localhost:${PORT}  (read-only; secrets redacted)`);
  line(`Point the IDE at it, then send ONE chat message. Every request shows up below:`);
  line(`  A) as a proxy:   HTTPS_PROXY=http://localhost:${PORT} HTTP_PROXY=http://localhost:${PORT} <launch IDE from this terminal>`);
  line(`  B) as a base URL: set the IDE's endpoint override to http://localhost:${PORT}`);
});
