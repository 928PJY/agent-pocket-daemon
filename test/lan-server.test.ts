import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { LanServer } from '../src/lan/lan-server.js';

function makeLanServer(overrides: Record<string, unknown> = {}): LanServer {
  return new LanServer({
    port: 0,
    pairId: 'pair-1',
    phoneIdentityPublicKey: 'phone-key',
    cryptoEngine: {
      hasSessionKeys: () => false,
      getIdentityPublicKeyBase64: () => '',
      ...overrides,
    } as never,
  });
}

test('LanServer resets decrypt failure streak across connection boundaries', () => {
  const server = makeLanServer({
    hasSessionKeys: () => true,
    decrypt: () => {
      throw new Error('auth failed');
    },
  });
  const internals = server as unknown as {
    handleMessage(data: string): void;
    resetDecryptFailureCount(reason: string): void;
  };
  const decryptErrors: number[] = [];
  server.on('decrypt_error', (count) => decryptErrors.push(count));

  const failFrame = (nonce: number) => JSON.stringify({
    encrypted_payload: 'not-decryptable',
    nonce,
  });

  internals.handleMessage(failFrame(0));
  internals.handleMessage(failFrame(1));
  internals.resetDecryptFailureCount('reconnect');
  internals.handleMessage(failFrame(0));
  internals.handleMessage(failFrame(1));

  assert.deepEqual(decryptErrors, []);

  internals.handleMessage(failFrame(2));

  assert.deepEqual(decryptErrors, [3]);
});

test('LanServer resets decrypt failure streak after a good encrypted frame', () => {
  const server = makeLanServer({
    hasSessionKeys: () => true,
    decrypt: (_ciphertext: string, nonce: number) => {
      if (nonce === 2) return JSON.stringify({ type: 'pong' });
      throw new Error('auth failed');
    },
  });
  const internals = server as unknown as { handleMessage(data: string): void };
  const decryptErrors: number[] = [];
  const messages: unknown[] = [];
  server.on('decrypt_error', (count) => decryptErrors.push(count));
  server.on('message', (message) => messages.push(message));

  const frame = (nonce: number) => JSON.stringify({ encrypted_payload: 'ciphertext', nonce });
  internals.handleMessage(frame(0));
  internals.handleMessage(frame(1));
  internals.handleMessage(frame(2));
  internals.handleMessage(frame(3));
  internals.handleMessage(frame(4));

  assert.deepEqual(messages, [{ type: 'pong' }]);
  assert.deepEqual(decryptErrors, []);
});

test('LanServer replaces the active client and resets decrypt failures', () => {
  const server = makeLanServer({
    hasSessionKeys: () => true,
    decrypt: () => {
      throw new Error('auth failed');
    },
  });
  const internals = server as unknown as {
    handleMessage(data: string): void;
    handleNewConnection(ws: unknown): void;
    activeClient: unknown;
    isAuthenticated: boolean;
    runAuthHandshake(ws: unknown): void;
  };
  const closed: Array<{ code: number; reason: string }> = [];
  const disconnects: string[] = [];
  const decryptErrors: number[] = [];
  const oldClient = new EventEmitter() as EventEmitter & {
    readyState: number;
    send(data: string): void;
    close(code: number, reason: string): void;
  };
  oldClient.readyState = 1;
  oldClient.send = () => {};
  oldClient.close = (code, reason) => { closed.push({ code, reason }); };
  internals.activeClient = oldClient;
  internals.isAuthenticated = true;
  internals.runAuthHandshake = () => {};
  server.on('disconnected', (reason) => disconnects.push(reason));
  server.on('decrypt_error', (count) => decryptErrors.push(count));

  internals.handleMessage(JSON.stringify({ encrypted_payload: 'bad', nonce: 0 }));
  internals.handleMessage(JSON.stringify({ encrypted_payload: 'bad', nonce: 1 }));
  internals.handleNewConnection(oldClient);
  internals.handleMessage(JSON.stringify({ encrypted_payload: 'bad', nonce: 2 }));

  assert.deepEqual(closed, [{ code: 1000, reason: 'Replaced by new connection' }]);
  assert.deepEqual(disconnects, ['Replaced by new connection']);
  assert.deepEqual(decryptErrors, []);
});

test('LanServer emits parse failures after three malformed plaintext frames', () => {
  const server = makeLanServer();
  const internals = server as unknown as { handleMessage(data: string): void };
  const decryptErrors: number[] = [];
  const errors: Error[] = [];
  server.on('decrypt_error', (count) => decryptErrors.push(count));
  server.on('error', (error) => errors.push(error));

  internals.handleMessage('{bad');
  internals.handleMessage('{bad');
  internals.handleMessage('{bad');

  assert.deepEqual(decryptErrors, [3]);
  assert.deepEqual(errors, []);
});

test('LanServer handles pairing HTTP routes, body limits, health, and 404s', () => {
  const server = makeLanServer();
  const internals = server as unknown as {
    handleHttpRequest(req: EventEmitter & { method?: string; url?: string; destroy(): void }, res: FakeResponse): void;
    setPairCompleteHandler(handler: ((req: unknown) => unknown) | null): void;
    isAuthenticated: boolean;
    activeClient: { readyState: number } | null;
  };

  internals.setPairCompleteHandler((req) => ({ success: true, pair_id: (req as { pair_id: string }).pair_id }));
  const complete = request(internals, 'POST', '/pair/complete', JSON.stringify({ pair_id: 'pair-1' }));
  assert.equal(complete.statusCode, 200);
  assert.deepEqual(JSON.parse(complete.body), { success: true, pair_id: 'pair-1' });

  internals.setPairCompleteHandler(null);
  const notPairing = request(internals, 'POST', '/pair/complete', JSON.stringify({ pair_id: 'pair-1' }));
  assert.equal(notPairing.statusCode, 503);
  assert.deepEqual(JSON.parse(notPairing.body), { success: false, error: 'Not in pairing mode' });

  const invalidJson = request(internals, 'POST', '/pair/complete', '{bad');
  assert.equal(invalidJson.statusCode, 400);
  assert.equal(JSON.parse(invalidJson.body).success, false);

  internals.isAuthenticated = true;
  internals.activeClient = { readyState: 1 };
  const health = request(internals, 'GET', '/health');
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok', connected: true });

  const missing = request(internals, 'GET', '/missing');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body, 'Not Found');

  const tooLarge = request(internals, 'POST', '/pair/complete', 'x'.repeat(16 * 1024 + 1));
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.destroyed, true);
});

test('LanServer auth handshake rejects invalid response shapes', () => {
  const phoneRawKey = Buffer.alloc(32, 4).toString('base64');
  const server = new LanServer({
    port: 0,
    pairId: 'pair-1',
    phoneIdentityPublicKey: phoneRawKey,
    cryptoEngine: {
      hasSessionKeys: () => false,
      getIdentityPublicKeyBase64: () => Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.alloc(32, 1),
      ]).toString('base64'),
      verify: () => false,
    } as never,
  });
  const internals = server as unknown as { runAuthHandshake(ws: FakeWebSocket): void; activeClient: FakeWebSocket };

  const wrongType = new FakeWebSocket();
  internals.activeClient = wrongType;
  internals.runAuthHandshake(wrongType);
  wrongType.emit('message', JSON.stringify({ type: 'wrong' }));
  assert.deepEqual(JSON.parse(wrongType.sent[1]), {
    type: 'lan_auth_result',
    success: false,
    error: 'Expected lan_auth_response',
  });
  assert.deepEqual(wrongType.closed, { code: 4002, reason: 'Invalid auth response type' });

  const wrongPair = new FakeWebSocket();
  internals.activeClient = wrongPair;
  internals.runAuthHandshake(wrongPair);
  wrongPair.emit('message', JSON.stringify({ type: 'lan_auth_response', pair_id: 'other' }));
  assert.equal(JSON.parse(wrongPair.sent[1]).error, 'Pair ID mismatch');
  assert.deepEqual(wrongPair.closed, { code: 4003, reason: 'Pair ID mismatch' });

  const wrongIdentity = new FakeWebSocket();
  internals.activeClient = wrongIdentity;
  internals.runAuthHandshake(wrongIdentity);
  wrongIdentity.emit('message', JSON.stringify({
    type: 'lan_auth_response',
    pair_id: 'pair-1',
    client_identity_pk: Buffer.alloc(32, 9).toString('base64'),
    challenge_signature: 'sig',
  }));
  assert.equal(JSON.parse(wrongIdentity.sent[1]).error, 'Unknown client identity');
  assert.deepEqual(wrongIdentity.closed, { code: 4004, reason: 'Unknown client' });

  const badSignature = new FakeWebSocket();
  internals.activeClient = badSignature;
  internals.runAuthHandshake(badSignature);
  badSignature.emit('message', JSON.stringify({
    type: 'lan_auth_response',
    pair_id: 'pair-1',
    client_identity_pk: phoneRawKey,
    challenge_signature: 'sig',
  }));
  assert.equal(JSON.parse(badSignature.sent[1]).error, 'Invalid challenge signature');
  assert.deepEqual(badSignature.closed, { code: 4005, reason: 'Invalid signature' });
});

test('LanServer auth handshake accepts valid response and wires post-auth messages', () => {
  const phoneRawKey = Buffer.alloc(32, 4).toString('base64');
  const server = new LanServer({
    port: 0,
    pairId: 'pair-1',
    phoneIdentityPublicKey: phoneRawKey,
    cryptoEngine: {
      hasSessionKeys: () => false,
      getIdentityPublicKeyBase64: () => Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.alloc(32, 1),
      ]).toString('base64'),
      verify: () => true,
    } as never,
  });
  const internals = server as unknown as { runAuthHandshake(ws: FakeWebSocket): void; activeClient: FakeWebSocket; isAuthenticated: boolean };
  const ws = new FakeWebSocket();
  const connected: string[] = [];
  const messages: unknown[] = [];
  server.on('connected', () => connected.push('connected'));
  server.on('message', (message) => messages.push(message));

  internals.activeClient = ws;
  internals.runAuthHandshake(ws);
  ws.emit('message', JSON.stringify({
    type: 'lan_auth_response',
    pair_id: 'pair-1',
    client_identity_pk: phoneRawKey,
    challenge_signature: 'sig',
    wire_version: 2,
    min_supported_version: 1,
  }));
  ws.emit('message', JSON.stringify({ type: 'ping' }));

  assert.equal(internals.isAuthenticated, true);
  assert.deepEqual(connected, ['connected']);
  assert.equal(JSON.parse(ws.sent[1]).success, true);
  assert.equal(JSON.parse(ws.sent[1]).negotiated_wire_version, 1);
  assert.deepEqual(messages, [{ type: 'ping' }]);
});

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';

  writeHead(statusCode: number, headers: Record<string, string> = {}): void {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(data = ''): void {
    this.body += data;
  }
}

class FakeWebSocket extends EventEmitter {
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  readyState = 1;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

function request(
  internals: { handleHttpRequest(req: EventEmitter & { method?: string; url?: string; destroy(): void }, res: FakeResponse): void },
  method: string,
  url: string,
  body = '',
): FakeResponse & { destroyed: boolean } {
  const req = new EventEmitter() as EventEmitter & { method?: string; url?: string; destroy(): void; destroyed: boolean };
  const res = new FakeResponse() as FakeResponse & { destroyed: boolean };
  req.method = method;
  req.url = url;
  req.destroyed = false;
  req.destroy = () => { req.destroyed = true; res.destroyed = true; };
  internals.handleHttpRequest(req, res);
  if (body) req.emit('data', Buffer.from(body));
  if (!req.destroyed) req.emit('end');
  return res;
}
