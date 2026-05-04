import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CryptoEngine } from '../src/crypto/crypto-engine.js';

function ciphertextNonce(ciphertext: string): Buffer {
  return Buffer.from(ciphertext, 'base64').subarray(0, 12);
}

test('AEAD nonce does not repeat after restoring the same session keys', () => {
  const sendKey = crypto.randomBytes(32);
  const recvKey = crypto.randomBytes(32);
  const sasKey = crypto.randomBytes(32);

  const firstEngine = new CryptoEngine();
  firstEngine.restoreSessionKeys(sendKey, recvKey, sasKey);
  const first = firstEngine.encrypt('before restart');

  const restoredEngine = new CryptoEngine();
  restoredEngine.restoreSessionKeys(sendKey, recvKey, sasKey);
  const afterRestore = restoredEngine.encrypt('after restart');

  assert.equal(first.nonce, 0);
  assert.equal(afterRestore.nonce, 0);
  assert.notDeepEqual(
    ciphertextNonce(first.ciphertext),
    ciphertextNonce(afterRestore.ciphertext),
  );
});

test('encrypted payload includes a decryptable random AEAD nonce', () => {
  const sendKey = crypto.randomBytes(32);
  const sasKey = crypto.randomBytes(32);
  const sender = new CryptoEngine();
  const receiver = new CryptoEngine();

  sender.restoreSessionKeys(sendKey, crypto.randomBytes(32), sasKey);
  receiver.restoreSessionKeys(crypto.randomBytes(32), sendKey, sasKey);

  const encrypted = sender.encrypt('hello');

  assert.equal(ciphertextNonce(encrypted.ciphertext).length, 12);
  assert.equal(receiver.decrypt(encrypted.ciphertext, encrypted.nonce), 'hello');
});

test('wake blob encrypts fixed-size length-prefixed notification payload', () => {
  const sendKey = crypto.randomBytes(32);
  const sasKey = crypto.randomBytes(32);
  const sender = new CryptoEngine();
  const receiver = new CryptoEngine();

  sender.restoreSessionKeys(sendKey, crypto.randomBytes(32), sasKey);
  receiver.restoreSessionKeys(crypto.randomBytes(32), sendKey, sasKey);

  const shortPayload = JSON.stringify({ type: 'plan_review', body: 'Plan ready' });
  const longPayload = JSON.stringify({
    type: 'permission_request',
    session_name: 'Project',
    body: 'Bash command needs approval',
    category: 'PERMISSION_REQUEST',
    session_id: 'session-1',
    request_id: 'request-1',
  });
  const shortBlob = sender.encryptWakeBlob(shortPayload);
  const longBlob = sender.encryptWakeBlob(longPayload);

  assert.equal(Buffer.from(shortBlob, 'base64').length, Buffer.from(longBlob, 'base64').length);
  assert.equal(Buffer.from(shortBlob, 'base64').length, 12 + 1024 + 16);
  assert.equal(receiver.decryptWakeBlob(shortBlob), shortPayload);
  assert.equal(receiver.decryptWakeBlob(longBlob), longPayload);
});

test('wake blob rejects payloads larger than the padded envelope', () => {
  const sendKey = crypto.randomBytes(32);
  const sasKey = crypto.randomBytes(32);
  const sender = new CryptoEngine();

  sender.restoreSessionKeys(sendKey, crypto.randomBytes(32), sasKey);

  assert.throws(() => sender.encryptWakeBlob('x'.repeat(1023)), /Wake blob text too long/);
});

test('wake blob decrypts the shared cross-language fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/wake-blob-fixture.json', import.meta.url), 'utf-8')) as {
    sessionRecvKey: string;
    payload: string;
    blob: string;
  };
  const receiver = new CryptoEngine();

  receiver.restoreSessionKeys(
    crypto.randomBytes(32),
    Buffer.from(fixture.sessionRecvKey, 'base64'),
    crypto.randomBytes(32),
  );

  assert.equal(receiver.decryptWakeBlob(fixture.blob), fixture.payload);
});

test('message encryption and decryption reject missing keys and invalid ciphertext', () => {
  const engine = new CryptoEngine();

  assert.throws(() => engine.encrypt('hello'), /Session keys not established/);
  assert.throws(() => engine.decrypt('', 0), /Session keys not established/);

  engine.restoreSessionKeys(crypto.randomBytes(32), crypto.randomBytes(32), crypto.randomBytes(32));

  assert.throws(() => engine.decrypt(Buffer.alloc(27).toString('base64'), 0), /Ciphertext too short/);

  const encrypted = engine.encrypt('signed text');
  const tampered = Buffer.from(encrypted.ciphertext, 'base64');
  tampered[tampered.length - 1] ^= 0xff;

  assert.throws(() => engine.decrypt(tampered.toString('base64'), encrypted.nonce));
});

test('wake blob decryption rejects unauthenticated or malformed plaintext', () => {
  const sendKey = crypto.randomBytes(32);
  const sasKey = crypto.randomBytes(32);
  const engine = new CryptoEngine();
  const receiver = new CryptoEngine();

  assert.throws(() => engine.encryptWakeBlob('hello'), /Session keys not established/);
  assert.throws(() => engine.decryptWakeBlob(''), /Session keys not established/);

  engine.restoreSessionKeys(sendKey, crypto.randomBytes(32), sasKey);
  receiver.restoreSessionKeys(crypto.randomBytes(32), sendKey, sasKey);

  const blob = engine.encryptWakeBlob('hello');
  const tampered = Buffer.from(blob, 'base64');
  tampered[tampered.length - 1] ^= 0xff;

  assert.throws(() => receiver.decryptWakeBlob(Buffer.alloc(27).toString('base64')), /Ciphertext too short/);
  assert.throws(() => receiver.decryptWakeBlob(tampered.toString('base64')));

  const privateEngine = engine as unknown as { encryptWithKey(plaintext: Buffer, key: Buffer): string };
  const wakeKey = engine.getSessionKeys()!.wakeSendKey;

  assert.throws(
    () => receiver.decryptWakeBlob(privateEngine.encryptWithKey(Buffer.alloc(10), wakeKey)),
    /Invalid wake blob plaintext length/,
  );
  assert.throws(
    () => receiver.decryptWakeBlob(privateEngine.encryptWithKey(Buffer.alloc(1024), wakeKey)),
    /Invalid wake blob text length/,
  );
});
