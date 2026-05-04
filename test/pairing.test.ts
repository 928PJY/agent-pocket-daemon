import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import { CryptoEngine } from '../src/crypto/crypto-engine.js';
import { runPairing } from '../src/pairing.js';

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function makeCryptoEngine(): CryptoEngine {
  return new CryptoEngine(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pocket-pairing-')));
}

afterEach(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

async function withHttpServer(
  handler: http.RequestListener,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  let data = '';
  for await (const chunk of req) data += chunk;
  return JSON.parse(data);
}

test('runPairing posts identity keys and returns completed relay pairing result', async () => {
  console.log = () => {};
  console.error = () => {};
  const seenRequests: Array<{ method?: string; url?: string; body?: unknown }> = [];

  await withHttpServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/pair/initiate') {
      const body = await readJsonBody(req);
      seenRequests.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pairing_token: 'token-1', expires_at: '2026-05-04T00:00:00Z' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/pair/status/token-1') {
      seenRequests.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        device_pair_id: 'pair-1',
        jwt_pc: 'jwt-pc',
        jwt_phone: 'jwt-phone',
        phone_public_key: 'phone-ephemeral',
        phone_identity_public_key: 'phone-identity',
      }));
      return;
    }

    res.writeHead(404);
    res.end('not found');
  }, async (relayUrl) => {
    const result = await runPairing(
      { relay_url: relayUrl.replace('http://', 'ws://'), device_name: 'Mac Studio' },
      makeCryptoEngine(),
    );

    assert.deepEqual(result, {
      device_pair_id: 'pair-1',
      jwt_pc: 'jwt-pc',
      phone_public_key: 'phone-ephemeral',
      phone_identity_public_key: 'phone-identity',
    });
  });

  assert.equal(seenRequests.length, 2);
  const initiateBody = seenRequests[0].body as Record<string, unknown>;
  assert.equal(initiateBody.pc_name, 'Mac Studio');
  assert.equal(typeof initiateBody.pc_public_key, 'string');
  assert.equal(typeof initiateBody.pc_identity_public_key, 'string');
  assert.equal(seenRequests[1].url, '/pair/status/token-1');
});

test('runPairing returns null when relay initiate fails', async () => {
  const errors: unknown[] = [];
  console.log = () => {};
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };

  await withHttpServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('maintenance');
  }, async (relayUrl) => {
    const result = await runPairing(
      { relay_url: relayUrl, device_name: 'Mac Studio' },
      makeCryptoEngine(),
    );

    assert.equal(result, null);
  });

  assert.match(errors.join('\n'), /Could not reach relay server/);
  assert.match(errors.join('\n'), /HTTP 503: maintenance/);
});

test('runPairing returns null when relay initiate response is not JSON', async () => {
  console.log = () => {};
  console.error = () => {};

  await withHttpServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('not-json');
  }, async (relayUrl) => {
    const result = await runPairing(
      { relay_url: relayUrl, device_name: 'Mac Studio' },
      makeCryptoEngine(),
    );

    assert.equal(result, null);
  });
});
