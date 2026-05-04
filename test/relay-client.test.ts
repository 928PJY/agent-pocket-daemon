import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RelayClient } from '../src/relay/relay-client.js';
import type { WakeBlobPayload } from '../src/shared/index.js';

test('RelayClient does not serialize relay-visible push hints', () => {
  const client = new RelayClient({
    relayUrl: 'wss://relay.example',
    pairId: 'pair-1',
    authToken: 'token',
  });

  client.send({ type: 'permission_request', request_id: 'req-1' });

  const queue = client as unknown as { offlineQueue: unknown[] };
  assert.equal(queue.offlineQueue.length, 1);
  assert.equal(Object.hasOwn(queue.offlineQueue[0] as object, 'push_hint'), false);
});

test('RelayClient sets envelope wake bit only when caller requests it', () => {
  const client = new RelayClient({
    relayUrl: 'wss://relay.example',
    pairId: 'pair-1',
    authToken: 'token',
  });

  client.send({ type: 'session_output' });
  client.send({ type: 'permission_request', request_id: 'req-1' }, true);

  const queue = (client as unknown as { offlineQueue: Array<{ wake?: boolean }> }).offlineQueue;
  assert.equal(queue.length, 2);
  assert.equal(queue[0].wake, undefined);
  assert.equal(queue[1].wake, true);
});

test('RelayClient sets force_wake only on forced wake messages', () => {
  const client = new RelayClient({
    relayUrl: 'wss://relay.example',
    pairId: 'pair-1',
    authToken: 'token',
  });

  client.send({ type: 'permission_request', request_id: 'req-1' }, false, undefined, true);
  client.send({ type: 'permission_request', request_id: 'req-2' }, true);
  client.send({ type: 'permission_request', request_id: 'req-3' }, true, undefined, true);

  const queue = (client as unknown as { offlineQueue: Array<{ wake?: boolean; force_wake?: boolean }> }).offlineQueue;
  assert.equal(queue[0].wake, undefined);
  assert.equal(queue[0].force_wake, undefined);
  assert.equal(queue[1].wake, true);
  assert.equal(queue[1].force_wake, undefined);
  assert.equal(queue[2].wake, true);
  assert.equal(queue[2].force_wake, true);
});

test('RelayClient serializes encrypted wake blob only for wake messages', () => {
  const payload: WakeBlobPayload = {
    type: 'plan_review',
    session_name: 'Project',
    body: 'Plan ready',
    category: 'PLAN_REVIEW',
    session_id: 'session-1',
    request_id: 'request-1',
  };
  const client = new RelayClient({
    relayUrl: 'wss://relay.example',
    pairId: 'pair-1',
    authToken: 'token',
    encryptWakeBlob: (text) => `encrypted:${text}`,
  });

  client.send({ type: 'session_output' }, false, payload);
  client.send({ type: 'session_output' }, true, payload);

  const queue = (client as unknown as { offlineQueue: Array<{ wake_blob?: string }> }).offlineQueue;
  assert.equal(queue[0].wake_blob, undefined);
  assert.equal(queue[1].wake_blob, `encrypted:${JSON.stringify(payload)}`);
});

test('RelayClient resets decrypt failure streak across connection boundaries', () => {
  const client = new RelayClient({
    relayUrl: 'wss://relay.example',
    pairId: 'pair-1',
    authToken: 'token',
    decrypt: () => {
      throw new Error('auth failed');
    },
  });
  const internals = client as unknown as {
    handleMessage(data: string): void;
    resetDecryptFailureCount(reason: string): void;
  };
  const decryptErrors: number[] = [];
  client.on('decrypt_error', (count) => decryptErrors.push(count));

  const failFrame = (nonce: number) => JSON.stringify({
    sender: 'phone',
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

test('RelayClient resets decrypt failure streak after a good encrypted envelope', () => {
  const client = new RelayClient({
    relayUrl: 'wss://relay.example',
    pairId: 'pair-1',
    authToken: 'token',
    decrypt: (_ciphertext, nonce) => {
      if (nonce === 2) return JSON.stringify({ type: 'send_message', text: 'ok' });
      throw new Error('auth failed');
    },
  });
  const internals = client as unknown as { handleMessage(data: string): void };
  const decryptErrors: number[] = [];
  const messages: unknown[] = [];
  client.on('decrypt_error', (count) => decryptErrors.push(count));
  client.on('message', (message) => messages.push(message));

  const frame = (nonce: number) => JSON.stringify({
    pair_id: 'pair-1',
    sender: 'phone',
    encrypted_payload: 'ciphertext',
    nonce,
    timestamp: Date.now(),
  });
  internals.handleMessage(frame(0));
  internals.handleMessage(frame(1));
  internals.handleMessage(frame(2));
  internals.handleMessage(frame(3));
  internals.handleMessage(frame(4));

  assert.deepEqual(messages, [{ type: 'send_message', text: 'ok' }]);
  assert.deepEqual(decryptErrors, []);
});

test('RelayClient requeues envelope and emits error when connected socket send fails', () => {
  const client = new RelayClient({
    relayUrl: 'wss://relay.example',
    pairId: 'pair-1',
    authToken: 'token',
  });
  const internals = client as unknown as {
    isConnected: boolean;
    ws: { readyState: number; send(data: string): void };
    offlineQueue: Array<{ encrypted_payload: string }>;
  };
  const errors: Error[] = [];
  internals.isConnected = true;
  internals.ws = {
    readyState: 1,
    send: () => { throw new Error('socket closed mid-send'); },
  };
  client.on('error', (error) => errors.push(error));

  client.send({ type: 'permission_request', request_id: 'req-1' });

  assert.equal(internals.offlineQueue.length, 1);
  assert.match(errors[0].message, /socket closed mid-send/);
  assert.deepEqual(
    JSON.parse(Buffer.from(internals.offlineQueue[0].encrypted_payload, 'base64').toString('utf-8')),
    { type: 'permission_request', request_id: 'req-1' },
  );
});

test('RelayClient bounds offline queue by dropping oldest messages', () => {
  const client = new RelayClient({
    relayUrl: 'wss://relay.example',
    pairId: 'pair-1',
    authToken: 'token',
  });

  for (let i = 0; i < 105; i++) {
    client.send({ type: 'message', i });
  }

  const queue = (client as unknown as { offlineQueue: Array<{ encrypted_payload: string }> }).offlineQueue;
  const firstPayload = JSON.parse(Buffer.from(queue[0].encrypted_payload, 'base64').toString('utf-8')) as { i: number };
  const lastPayload = JSON.parse(Buffer.from(queue.at(-1)!.encrypted_payload, 'base64').toString('utf-8')) as { i: number };

  assert.equal(client.getOfflineQueueSize(), 100);
  assert.equal(firstPayload.i, 5);
  assert.equal(lastPayload.i, 104);
});

test('RelayClient processes relay hello and peer status control frames', () => {
  const client = new RelayClient({
    relayUrl: 'wss://relay.example',
    pairId: 'pair-1',
    authToken: 'token',
  });
  let phoneOnlineEvents = 0;
  client.on('phone_online', () => { phoneOnlineEvents++; });
  const privateClient = client as unknown as { handleMessage(data: string): void };

  privateClient.handleMessage(JSON.stringify({
    type: '__relay_control',
    action: 'hello',
    wire: { min: 1, max: 2, negotiated: 1 },
    features: ['peer_status'],
  }));
  privateClient.handleMessage(JSON.stringify({
    type: '__relay_control',
    action: 'peer_status',
    role: 'phone',
    online: true,
  }));
  privateClient.handleMessage(JSON.stringify({
    type: '__relay_control',
    action: 'peer_status',
    role: 'phone',
    online: true,
  }));

  assert.equal(client.getNegotiatedWireVersion(), 1);
  assert.deepEqual(client.getRelayFeatures(), ['peer_status']);
  assert.equal(client.getPhonePeerOnline(), true);
  assert.equal(phoneOnlineEvents, 1);
});

test('RelayClient processes peer status query responses and offline transitions', () => {
  const client = new RelayClient({
    relayUrl: 'wss://relay.example',
    pairId: 'pair-1',
    authToken: 'token',
  });
  let phoneOnlineEvents = 0;
  client.on('phone_online', () => { phoneOnlineEvents++; });
  const privateClient = client as unknown as { handleMessage(data: string): void };

  privateClient.handleMessage(JSON.stringify({
    type: '__relay_control',
    action: 'peer_status',
    online: true,
  }));
  privateClient.handleMessage(JSON.stringify({
    type: '__relay_control',
    action: 'peer_status',
    online: false,
  }));
  privateClient.handleMessage(JSON.stringify({
    type: '__relay_control',
    action: 'peer_status',
    role: 'pc',
    online: true,
  }));

  assert.equal(client.getPhonePeerOnline(), false);
  assert.equal(phoneOnlineEvents, 1);
});

test('RelayClient emits peer control frames without requiring envelope payloads', () => {
  const client = new RelayClient({
    relayUrl: 'wss://relay.example',
    pairId: 'pair-1',
    authToken: 'token',
    decrypt: () => {
      throw new Error('peer controls must bypass decrypt');
    },
  });
  const privateClient = client as unknown as { handleMessage(data: string): void };
  const fingerprints: string[] = [];
  const e2eErrors: string[] = [];
  client.on('key_verify', (fingerprint) => fingerprints.push(fingerprint));
  client.on('e2e_error_control', (message) => e2eErrors.push(message));

  privateClient.handleMessage(JSON.stringify({
    type: '__peer_control',
    action: 'key_verify',
    key_fingerprint: 'abc123',
  }));
  privateClient.handleMessage(JSON.stringify({
    type: '__peer_control',
    action: 'e2e_error',
    message: 'rekey required',
  }));

  assert.deepEqual(fingerprints, ['abc123']);
  assert.deepEqual(e2eErrors, ['rekey required']);
});

test('RelayClient emits parse errors for malformed relay frames without decrypt_error', () => {
  const client = new RelayClient({
    relayUrl: 'wss://relay.example',
    pairId: 'pair-1',
    authToken: 'token',
  });
  const privateClient = client as unknown as { handleMessage(data: string): void };
  const errors: Error[] = [];
  const decryptErrors: number[] = [];
  client.on('error', (error) => errors.push(error));
  client.on('decrypt_error', (count) => decryptErrors.push(count));

  privateClient.handleMessage('{bad');

  assert.match(errors[0].message, /Failed to parse relay message/);
  assert.deepEqual(decryptErrors, []);
});

test('RelayClient decodes plaintext envelopes and emits payload messages', () => {
  const client = new RelayClient({
    relayUrl: 'wss://relay.example',
    pairId: 'pair-1',
    authToken: 'token',
  });
  const messages: unknown[] = [];
  client.on('message', (message) => messages.push(message));

  (client as unknown as { handleMessage(data: string): void }).handleMessage(JSON.stringify({
    pair_id: 'pair-1',
    sender: 'phone',
    encrypted_payload: Buffer.from(JSON.stringify({ type: 'send_message', text: 'hi' })).toString('base64'),
    nonce: 1,
    timestamp: Date.now(),
  }));

  assert.deepEqual(messages, [{ type: 'send_message', text: 'hi' }]);
});

test('RelayClient emits decrypt_error after three consecutive decrypt failures', () => {
  const client = new RelayClient({
    relayUrl: 'wss://relay.example',
    pairId: 'pair-1',
    authToken: 'token',
    decrypt: () => { throw new Error('bad key'); },
  });
  const errors: number[] = [];
  client.on('decrypt_error', (count) => errors.push(count as number));
  const envelope = JSON.stringify({
    pair_id: 'pair-1',
    sender: 'phone',
    encrypted_payload: 'ciphertext',
    nonce: 1,
    timestamp: Date.now(),
  });

  const privateClient = client as unknown as { handleMessage(data: string): void };
  privateClient.handleMessage(envelope);
  privateClient.handleMessage(envelope);
  privateClient.handleMessage(envelope);

  assert.deepEqual(errors, [3]);
});
