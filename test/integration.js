'use strict';

// End-to-end tests. Simulate real network drops and confirm Holdfast holds the
// request, keeps the client connection alive with heartbeats, and replays on
// recovery — with NO error surfaced to the client.

const http = require('http');

const MOCK_PORT = 9911;
const HF_PORT = 9910;

process.env.HOLDFAST_RETRY_INTERVAL_MS = '400';
process.env.HOLDFAST_HOLD_MINUTES = '5';
process.env.HOLDFAST_MAX_RETRIES = '50';
process.env.HOLDFAST_HEARTBEAT_MS = '300';
process.env.HOLDFAST_PROBE_HOST = '127.0.0.1';
process.env.HOLDFAST_PROBE_PORT = String(MOCK_PORT);
process.env.HOLDFAST_PROBE_TIMEOUT_MS = '400';
process.env.HOLDFAST_LOG_CONSOLE = '1';
process.env.HOLDFAST_LISTENERS = JSON.stringify([
  { name: 'anthropic', port: HF_PORT, upstream: `http://127.0.0.1:${MOCK_PORT}` },
]);

const { start } = require('../src/server');

function startMockUpstream(streaming) {
  const server = http.createServer((req, res) => {
    if (streaming) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message\ndata: {"ok":true,"streamed":true}\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echo: req.url }));
    }
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

function clientRequest(streaming) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port: HF_PORT, path: '/v1/messages', method: 'POST',
        headers: streaming ? { accept: 'text/event-stream', 'content-type': 'application/json' } : { 'content-type': 'application/json' },
      },
      (res) => {
        const chunks = [];
        let sawHeartbeat = false;
        res.on('data', (c) => {
          const s = c.toString();
          if (s.includes('holdfast still holding') || s.includes('holdfast waiting')) sawHeartbeat = true;
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), sawHeartbeat }));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify({ stream: streaming, hello: 'world' }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n=== Holdfast integration test ===\n');
  start();
  await sleep(300);

  // --- TEST 1: streaming request held through a long-ish outage w/ heartbeats.
  console.log('\n[T1] streaming client sends request while upstream is DOWN...');
  const pending = clientRequest(true);
  let settled = false;
  pending.then(() => (settled = true)).catch(() => (settled = true));

  await sleep(1500); // several probe + heartbeat cycles
  if (settled) { console.error('❌ T1 FAIL: settled while offline (should hold)'); process.exit(1); }
  console.log('[T1] ✓ request HELD while offline (not failed).');

  console.log('[T1] bringing upstream ONLINE...');
  const mock = await startMockUpstream(true);
  const r1 = await pending;
  mock.close();

  console.log(`[T1] status=${r1.status} sawHeartbeat=${r1.sawHeartbeat} body=${JSON.stringify(r1.body)}`);
  if (r1.status !== 200 || !r1.body.includes('"streamed":true')) { console.error('❌ T1 FAIL: bad response'); process.exit(1); }
  if (!r1.sawHeartbeat) { console.error('❌ T1 FAIL: no heartbeat seen (long outage would idle out)'); process.exit(1); }
  console.log('✅ T1 PASS: held with heartbeats, then delivered the real response.\n');

  // --- TEST 2: happy path still works instantly when online.
  console.log('[T2] non-streaming request while ONLINE...');
  const mock2 = await startMockUpstream(false);
  const r2 = await clientRequest(false);
  mock2.close();
  if (r2.status !== 200 || !r2.body.includes('"ok":true')) { console.error('❌ T2 FAIL'); process.exit(1); }
  console.log('✅ T2 PASS: online requests pass straight through.\n');

  console.log('=== ALL TESTS PASSED ===\n');
  process.exit(0);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(1); });
