import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  rawEd25519ToSpki,
  rawX25519ToSpki,
  spkiEd25519ToRaw,
  spkiX25519ToRaw,
} from '../src/crypto/key-format.js';

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function rawKey(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64');
}

test('raw X25519 keys round-trip through SPKI with the X25519 DER prefix', () => {
  const raw = rawKey(0x11);
  const spki = Buffer.from(rawX25519ToSpki(raw), 'base64');

  assert.equal(spki.length, 44);
  assert.deepEqual(spki.subarray(0, X25519_SPKI_PREFIX.length), X25519_SPKI_PREFIX);
  assert.equal(spkiX25519ToRaw(spki.toString('base64')), raw);
});

test('raw Ed25519 keys round-trip through SPKI with the Ed25519 DER prefix', () => {
  const raw = rawKey(0x22);
  const spki = Buffer.from(rawEd25519ToSpki(raw), 'base64');

  assert.equal(spki.length, 44);
  assert.deepEqual(spki.subarray(0, ED25519_SPKI_PREFIX.length), ED25519_SPKI_PREFIX);
  assert.equal(spkiEd25519ToRaw(spki.toString('base64')), raw);
});

test('raw key conversion rejects non-32-byte inputs', () => {
  const shortRaw = Buffer.alloc(31).toString('base64');
  const longRaw = Buffer.alloc(33).toString('base64');

  assert.throws(() => rawX25519ToSpki(shortRaw), /Expected 32-byte raw X25519 key, got 31/);
  assert.throws(() => rawEd25519ToSpki(longRaw), /Expected 32-byte raw Ed25519 key, got 33/);
});

test('SPKI conversion rejects wrong length and wrong algorithm prefixes', () => {
  const raw = rawKey(0x33);
  const x25519Spki = rawX25519ToSpki(raw);
  const ed25519Spki = rawEd25519ToSpki(raw);

  assert.throws(
    () => spkiX25519ToRaw(Buffer.alloc(43).toString('base64')),
    /Expected 44-byte SPKI X25519 key, got 43/,
  );
  assert.throws(
    () => spkiEd25519ToRaw(Buffer.alloc(45).toString('base64')),
    /Expected 44-byte SPKI Ed25519 key, got 45/,
  );
  assert.throws(() => spkiX25519ToRaw(ed25519Spki), /Expected SPKI X25519 key prefix/);
  assert.throws(() => spkiEd25519ToRaw(x25519Spki), /Expected SPKI Ed25519 key prefix/);
});
