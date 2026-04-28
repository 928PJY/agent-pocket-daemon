import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LanServer } from '../src/lan/lan-server.js';

test('LanServer resets decrypt failure streak across connection boundaries', () => {
  const server = new LanServer({
    port: 0,
    pairId: 'pair-1',
    phoneIdentityPublicKey: 'phone-key',
    cryptoEngine: {
      hasSessionKeys: () => true,
      decrypt: () => {
        throw new Error('auth failed');
      },
      getIdentityPublicKeyBase64: () => '',
    } as never,
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
