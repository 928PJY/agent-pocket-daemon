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
