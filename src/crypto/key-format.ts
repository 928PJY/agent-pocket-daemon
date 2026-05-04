// Key format conversion helpers
// Convert between raw 32-byte keys (used by iOS CryptoKit) and SPKI/DER (used by Node.js crypto)

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function rawX25519ToSpki(rawBase64: string): string {
  const raw = Buffer.from(rawBase64, 'base64');
  if (raw.length !== 32) {
    throw new Error(`Expected 32-byte raw X25519 key, got ${raw.length}`);
  }
  return Buffer.concat([X25519_SPKI_PREFIX, raw]).toString('base64');
}

export function spkiX25519ToRaw(spkiBase64: string): string {
  const spki = Buffer.from(spkiBase64, 'base64');
  if (spki.length !== 44) {
    throw new Error(`Expected 44-byte SPKI X25519 key, got ${spki.length}`);
  }
  if (!spki.subarray(0, X25519_SPKI_PREFIX.length).equals(X25519_SPKI_PREFIX)) {
    throw new Error('Expected SPKI X25519 key prefix');
  }
  return spki.subarray(X25519_SPKI_PREFIX.length).toString('base64');
}

export function rawEd25519ToSpki(rawBase64: string): string {
  const raw = Buffer.from(rawBase64, 'base64');
  if (raw.length !== 32) {
    throw new Error(`Expected 32-byte raw Ed25519 key, got ${raw.length}`);
  }
  return Buffer.concat([ED25519_SPKI_PREFIX, raw]).toString('base64');
}

export function spkiEd25519ToRaw(spkiBase64: string): string {
  const spki = Buffer.from(spkiBase64, 'base64');
  if (spki.length !== 44) {
    throw new Error(`Expected 44-byte SPKI Ed25519 key, got ${spki.length}`);
  }
  if (!spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw new Error('Expected SPKI Ed25519 key prefix');
  }
  return spki.subarray(ED25519_SPKI_PREFIX.length).toString('base64');
}
