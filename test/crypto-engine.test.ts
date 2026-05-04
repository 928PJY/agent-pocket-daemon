import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as crypto from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

function tempKeyDir(): string {
  return path.join(os.tmpdir(), `agent-pocket-crypto-${process.pid}-${Math.random().toString(16).slice(2)}`);
}

test('identity keys persist, reload, sign, and verify peer signatures', () => {
  const keyDir = tempKeyDir();
  const engine = new CryptoEngine(keyDir);
  const generated = engine.generateIdentityKeyPair();
  const publicKey = engine.getIdentityPublicKeyBase64();
  const signature = engine.sign('hello');

  assert.equal(Buffer.from(publicKey, 'base64').equals(generated.publicKey), true);
  assert.equal(engine.verify('hello', signature, publicKey), true);
  assert.equal(engine.verify('tampered', signature, publicKey), false);
  assert.equal(engine.verify('hello', signature, 'not-a-public-key'), false);
  assert.throws(() => new CryptoEngine().sign('missing'), /Identity key pair not initialized/);

  const reloaded = new CryptoEngine(keyDir);
  reloaded.loadOrGenerateIdentityKeyPair();
  const reloadedPublicKey = reloaded.getIdentityPublicKeyBase64();
  assert.equal(reloadedPublicKey, publicKey);
  assert.equal(reloaded.verify('hello', signature, reloadedPublicKey), true);

  reloaded.setPeerIdentityPublicKey(publicKey);
  assert.equal(reloaded.verifyPeer('hello', signature), true);
  assert.throws(() => new CryptoEngine().verifyPeer('hello', signature), /Peer identity public key not set/);
});

test('loadOrGenerateIdentityKeyPair replaces malformed persisted identity files', () => {
  const keyDir = tempKeyDir();
  mkdirSync(keyDir, { recursive: true });
  writeFileSync(path.join(keyDir, 'identity_key.pem'), 'not a private key');
  writeFileSync(path.join(keyDir, 'identity_pub.pem'), 'not a public key');

  const engine = new CryptoEngine(keyDir);
  const generated = engine.loadOrGenerateIdentityKeyPair();

  assert.equal(generated.publicKey.length > 0, true);
  assert.equal(engine.getIdentityPublicKeyBase64(), generated.publicKey.toString('base64'));
});

test('ephemeral key exchange derives matching send and receive keys', () => {
  const pc = new CryptoEngine(tempKeyDir());
  const phone = new CryptoEngine(tempKeyDir());
  pc.generateEphemeralKeyPair();
  phone.generateEphemeralKeyPair();

  const pcSecret = pc.deriveSharedSecret(phone.getEphemeralPublicKeyBase64());
  const phoneSecret = phone.deriveSharedSecret(pc.getEphemeralPublicKeyBase64());
  assert.deepEqual(pcSecret, phoneSecret);

  const pcKeys = pc.deriveSessionKeys(pcSecret);
  const phoneKeys = phone.deriveSessionKeys(phoneSecret);
  assert.deepEqual(pcKeys.sendKey, phoneKeys.sendKey);
  assert.deepEqual(pcKeys.recvKey, phoneKeys.recvKey);
  assert.deepEqual(pcKeys.sasKey, phoneKeys.sasKey);
  assert.equal(pc.hasSessionKeys(), true);
  assert.equal(pc.computeSasCode(), phone.computeSasCode());
  assert.match(pc.computeSasCode(), /^\d{6}$/);
});

test('QR payload generation initializes ephemeral keys and honors expiry', () => {
  const engine = new CryptoEngine(tempKeyDir());
  const before = Date.now();
  const payload = engine.generateQrPayload('wss://relay.example', 'pair-1', 5);
  const after = Date.now();

  assert.equal(payload.relay_url, 'wss://relay.example');
  assert.equal(payload.pairing_id, 'pair-1');
  assert.equal(typeof payload.pc_ephemeral_pk, 'string');
  assert.match(payload.otp, /^[0-9a-f]{32}$/);
  assert.equal(payload.expires - payload.timestamp, 5000);
  assert.equal(payload.timestamp >= before && payload.timestamp <= after, true);
});

test('rekey detection, fingerprints, and bound crypto helpers reflect session state', () => {
  const sendKey = crypto.randomBytes(32);
  const recvKey = crypto.randomBytes(32);
  const sasKey = crypto.randomBytes(32);
  const sender = new CryptoEngine(tempKeyDir());
  const receiver = new CryptoEngine(tempKeyDir());

  assert.equal(sender.needsRekey(), false);
  assert.equal(sender.sendKeyFingerprint(), null);
  assert.equal(sender.recvKeyFingerprint(), null);
  assert.equal(sender.getSessionKeys(), null);
  assert.throws(() => sender.computeSasCode(), /Session keys not established/);

  sender.restoreSessionKeys(sendKey, recvKey, sasKey);
  receiver.restoreSessionKeys(recvKey, sendKey, sasKey);

  assert.equal(sender.sendKeyFingerprint(), crypto.createHash('sha256').update(sendKey).digest().subarray(0, 8).toString('hex'));
  assert.equal(sender.recvKeyFingerprint(), crypto.createHash('sha256').update(recvKey).digest().subarray(0, 8).toString('hex'));
  assert.equal(sender.needsRekey(), false);

  const encrypted = sender.createEncryptFn()('bound hello');
  assert.equal(receiver.createDecryptFn()(encrypted.ciphertext, encrypted.nonce), 'bound hello');
  const wakeBlob = sender.createWakeBlobEncryptFn()('wake hello');
  assert.equal(receiver.decryptWakeBlob(wakeBlob), 'wake hello');

  const internals = sender as unknown as { state: { messagesSinceRekey: number; lastRekeyTime: number } };
  internals.state.messagesSinceRekey = 500;
  assert.equal(sender.needsRekey(), true);
  sender.resetRekeyCounters();
  assert.equal(sender.needsRekey(), false);
  internals.state.lastRekeyTime = 0;
  assert.equal(sender.needsRekey(), true);
});
