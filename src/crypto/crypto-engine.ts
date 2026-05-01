// Agent Pocket -- Crypto Engine
// Handles all cryptographic operations: identity keys, key exchange,
// session key derivation, encryption/decryption, signing, and pairing.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  REKEY_INTERVAL_MESSAGES,
  REKEY_INTERVAL_MS,
} from 'agent-pocket-protocol';
import type { QrCodePayload } from 'agent-pocket-protocol';
import { logger } from '../logger.js';

// ============================================================================
// Types
// ============================================================================

export interface IdentityKeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

export interface EphemeralKeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

export interface SessionKeys {
  sendKey: Buffer;
  recvKey: Buffer;
  sasKey: Buffer;
  wakeSendKey: Buffer;
  wakeRecvKey: Buffer;
}

export interface EncryptedMessage {
  ciphertext: string; // base64
  nonce: number;
}

export interface CryptoState {
  sessionKeys: SessionKeys | null;
  sendNonce: number;
  recvNonce: number;
  messagesSinceRekey: number;
  lastRekeyTime: number;
  peerIdentityPk: Buffer | null;
}

// ============================================================================
// Constants
// ============================================================================

const KEY_DIR_NAME = '.agent-pocket';
const IDENTITY_KEY_FILE = 'identity_key.pem';
const IDENTITY_PUB_FILE = 'identity_pub.pem';
const CHACHA20_NONCE_LENGTH = 12;
const CHACHA20_AUTH_TAG_LENGTH = 16;
const HKDF_HASH = 'sha256';
const HKDF_INFO_SEND = Buffer.from('agent-pocket-send-key');
const HKDF_INFO_RECV = Buffer.from('agent-pocket-recv-key');
const HKDF_INFO_SAS = Buffer.from('agent-pocket-sas-key');
const HKDF_INFO_WAKE_BLOB = Buffer.from('agent-pocket-wake-blob-key');
const HKDF_SALT = Buffer.from('agent-pocket-v1');
const KEY_LENGTH = 32;
const WAKE_BLOB_PLAINTEXT_LENGTH = 1024;
const WAKE_BLOB_LENGTH_PREFIX_BYTES = 2;

// ============================================================================
// CryptoEngine
// ============================================================================

export class CryptoEngine {
  private keyDir: string;
  private identityKeyPair: IdentityKeyPair | null = null;
  private ephemeralKeyPair: EphemeralKeyPair | null = null;
  private state: CryptoState;

  constructor(keyDir?: string) {
    this.keyDir = keyDir ?? path.join(os.homedir(), KEY_DIR_NAME);
    this.state = {
      sessionKeys: null,
      sendNonce: 0,
      recvNonce: 0,
      messagesSinceRekey: 0,
      lastRekeyTime: 0,
      peerIdentityPk: null,
    };
  }

  // --------------------------------------------------------------------------
  // Identity Key Pair (Ed25519) -- long-term signing key
  // --------------------------------------------------------------------------

  /**
   * Generate a new Ed25519 identity key pair and save to disk.
   */
  generateIdentityKeyPair(): IdentityKeyPair {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });

    this.identityKeyPair = {
      publicKey: Buffer.from(publicKey),
      privateKey: Buffer.from(privateKey),
    };

    this.saveIdentityKeys();
    return this.identityKeyPair;
  }

  /**
   * Load existing identity key pair from disk, or generate if not found.
   */
  loadOrGenerateIdentityKeyPair(): IdentityKeyPair {
    const loaded = this.loadIdentityKeys();
    if (loaded) {
      this.identityKeyPair = loaded;
      return loaded;
    }
    return this.generateIdentityKeyPair();
  }

  /**
   * Get the identity public key as a base64 string.
   */
  getIdentityPublicKeyBase64(): string {
    if (!this.identityKeyPair) {
      throw new Error('Identity key pair not initialized');
    }
    return this.identityKeyPair.publicKey.toString('base64');
  }

  // --------------------------------------------------------------------------
  // X25519 Ephemeral Key Pair -- for key exchange
  // --------------------------------------------------------------------------

  /**
   * Generate a new X25519 ephemeral key pair for key exchange.
   */
  generateEphemeralKeyPair(): EphemeralKeyPair {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });

    this.ephemeralKeyPair = {
      publicKey: Buffer.from(publicKey),
      privateKey: Buffer.from(privateKey),
    };

    return this.ephemeralKeyPair;
  }

  /**
   * Get the ephemeral public key as a base64 string.
   */
  getEphemeralPublicKeyBase64(): string {
    if (!this.ephemeralKeyPair) {
      throw new Error('Ephemeral key pair not initialized');
    }
    return this.ephemeralKeyPair.publicKey.toString('base64');
  }

  // --------------------------------------------------------------------------
  // Key Exchange (X25519 ECDH)
  // --------------------------------------------------------------------------

  /**
   * Derive a shared secret from our X25519 private key and the peer's X25519 public key.
   */
  deriveSharedSecret(peerPublicKeyBase64: string): Buffer {
    if (!this.ephemeralKeyPair) {
      throw new Error('Ephemeral key pair not initialized');
    }

    const peerPublicKeyDer = Buffer.from(peerPublicKeyBase64, 'base64');

    const peerKeyObject = crypto.createPublicKey({
      key: peerPublicKeyDer,
      format: 'der',
      type: 'spki',
    });

    const ourPrivateKeyObject = crypto.createPrivateKey({
      key: this.ephemeralKeyPair.privateKey,
      format: 'der',
      type: 'pkcs8',
    });

    const sharedSecret = crypto.diffieHellman({
      publicKey: peerKeyObject,
      privateKey: ourPrivateKeyObject,
    });

    return Buffer.from(sharedSecret);
  }

  /**
   * Derive session keys from the shared secret using HKDF-SHA256.
   * Returns send_key, recv_key, and sas_key.
   */
  deriveSessionKeys(sharedSecret: Buffer): SessionKeys {
    const sendKey = crypto.hkdfSync(
      HKDF_HASH,
      sharedSecret,
      HKDF_SALT,
      HKDF_INFO_SEND,
      KEY_LENGTH,
    );

    const recvKey = crypto.hkdfSync(
      HKDF_HASH,
      sharedSecret,
      HKDF_SALT,
      HKDF_INFO_RECV,
      KEY_LENGTH,
    );

    const sasKey = crypto.hkdfSync(
      HKDF_HASH,
      sharedSecret,
      HKDF_SALT,
      HKDF_INFO_SAS,
      KEY_LENGTH,
    );

    const keys: SessionKeys = {
      sendKey: Buffer.from(sendKey),
      recvKey: Buffer.from(recvKey),
      sasKey: Buffer.from(sasKey),
      wakeSendKey: this.deriveWakeBlobKey(Buffer.from(sendKey)),
      wakeRecvKey: this.deriveWakeBlobKey(Buffer.from(recvKey)),
    };

    this.state.sessionKeys = keys;
    this.state.sendNonce = 0;
    this.state.recvNonce = 0;
    this.state.messagesSinceRekey = 0;
    this.state.lastRekeyTime = Date.now();

    return keys;
  }

  /**
   * Restore session keys from raw buffers (e.g. loaded from saved config).
   * Resets nonce counters.
   */
  restoreSessionKeys(sendKey: Buffer, recvKey: Buffer, sasKey?: Buffer): void {
    this.state.sessionKeys = {
      sendKey,
      recvKey,
      sasKey: sasKey ?? Buffer.alloc(32),
      wakeSendKey: this.deriveWakeBlobKey(sendKey),
      wakeRecvKey: this.deriveWakeBlobKey(recvKey),
    };
    this.state.sendNonce = 0;
    this.state.recvNonce = 0;
    this.state.messagesSinceRekey = 0;
    this.state.lastRekeyTime = Date.now();
  }

  // --------------------------------------------------------------------------
  // ChaCha20-Poly1305 Encryption/Decryption
  // --------------------------------------------------------------------------

  /**
   * Encrypt a plaintext message using ChaCha20-Poly1305.
   * Returns base64-encoded: nonce(12) + ciphertext + authTag(16)
   */
  encrypt(plaintext: string): EncryptedMessage {
    if (!this.state.sessionKeys) {
      throw new Error('Session keys not established');
    }

    const nonce = this.state.sendNonce++;
    this.state.messagesSinceRekey++;

    const nonceBuffer = crypto.randomBytes(CHACHA20_NONCE_LENGTH);

    const cipher = crypto.createCipheriv(
      'chacha20-poly1305' as string,
      this.state.sessionKeys.sendKey,
      nonceBuffer,
      { authTagLength: CHACHA20_AUTH_TAG_LENGTH } as crypto.CipherGCMOptions,
    ) as crypto.CipherGCM;

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf-8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    // Format: nonce(12) + ciphertext + authTag(16)
    const combined = Buffer.concat([nonceBuffer, encrypted, authTag]);

    logger.trace('crypto', 'encrypt', { envelope_nonce: nonce, plaintextBytes: plaintext.length });

    return {
      ciphertext: combined.toString('base64'),
      nonce,
    };
  }

  encryptWakeBlob(text: string): string {
    if (!this.state.sessionKeys) {
      throw new Error('Session keys not established');
    }

    const plaintext = this.encodeWakePlaintext(text);
    return this.encryptWithKey(plaintext, this.state.sessionKeys.wakeSendKey);
  }

  decryptWakeBlob(blob: string): string {
    if (!this.state.sessionKeys) {
      throw new Error('Session keys not established');
    }

    const plaintext = this.decryptWithKey(blob, this.state.sessionKeys.wakeRecvKey);
    return this.decodeWakePlaintext(plaintext);
  }

  private deriveWakeBlobKey(baseKey: Buffer): Buffer {
    return Buffer.from(crypto.hkdfSync(
      HKDF_HASH,
      baseKey,
      HKDF_SALT,
      HKDF_INFO_WAKE_BLOB,
      KEY_LENGTH,
    ));
  }

  private encodeWakePlaintext(text: string): Buffer {
    const data = Buffer.from(text, 'utf-8');
    const maxPayloadLength = WAKE_BLOB_PLAINTEXT_LENGTH - WAKE_BLOB_LENGTH_PREFIX_BYTES;
    if (data.length > maxPayloadLength) {
      throw new Error('Wake blob text too long');
    }
    const plaintext = Buffer.alloc(WAKE_BLOB_PLAINTEXT_LENGTH);
    plaintext.writeUInt16BE(data.length, 0);
    data.copy(plaintext, WAKE_BLOB_LENGTH_PREFIX_BYTES);
    return plaintext;
  }

  private decodeWakePlaintext(plaintext: Buffer): string {
    if (plaintext.length !== WAKE_BLOB_PLAINTEXT_LENGTH) {
      throw new Error('Invalid wake blob plaintext length');
    }
    const length = plaintext.readUInt16BE(0);
    if (length === 0 || length > WAKE_BLOB_PLAINTEXT_LENGTH - WAKE_BLOB_LENGTH_PREFIX_BYTES) {
      throw new Error('Invalid wake blob text length');
    }
    return plaintext.subarray(WAKE_BLOB_LENGTH_PREFIX_BYTES, WAKE_BLOB_LENGTH_PREFIX_BYTES + length).toString('utf-8');
  }

  private encryptWithKey(plaintext: Buffer, key: Buffer): string {
    const nonceBuffer = crypto.randomBytes(CHACHA20_NONCE_LENGTH);
    const cipher = crypto.createCipheriv(
      'chacha20-poly1305' as string,
      key,
      nonceBuffer,
      { authTagLength: CHACHA20_AUTH_TAG_LENGTH } as crypto.CipherGCMOptions,
    ) as crypto.CipherGCM;
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([nonceBuffer, encrypted, cipher.getAuthTag()]).toString('base64');
  }

  private decryptWithKey(ciphertextBase64: string, key: Buffer): Buffer {
    const combined = Buffer.from(ciphertextBase64, 'base64');
    if (combined.length < CHACHA20_NONCE_LENGTH + CHACHA20_AUTH_TAG_LENGTH) {
      throw new Error('Ciphertext too short');
    }

    const nonceBuffer = combined.subarray(0, CHACHA20_NONCE_LENGTH);
    const authTag = combined.subarray(combined.length - CHACHA20_AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(CHACHA20_NONCE_LENGTH, combined.length - CHACHA20_AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(
      'chacha20-poly1305' as string,
      key,
      nonceBuffer,
      { authTagLength: CHACHA20_AUTH_TAG_LENGTH } as crypto.CipherGCMOptions,
    ) as crypto.DecipherGCM;
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  /**
   * Decrypt a ciphertext message using ChaCha20-Poly1305.
   * Input: base64-encoded nonce(12) + ciphertext + authTag(16)
   */
  decrypt(ciphertextBase64: string, _nonce: number): string {
    if (!this.state.sessionKeys) {
      throw new Error('Session keys not established');
    }

    const combined = Buffer.from(ciphertextBase64, 'base64');

    if (combined.length < CHACHA20_NONCE_LENGTH + CHACHA20_AUTH_TAG_LENGTH) {
      throw new Error('Ciphertext too short');
    }

    const nonceBuffer = combined.subarray(0, CHACHA20_NONCE_LENGTH);
    const authTag = combined.subarray(combined.length - CHACHA20_AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(CHACHA20_NONCE_LENGTH, combined.length - CHACHA20_AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(
      'chacha20-poly1305' as string,
      this.state.sessionKeys.recvKey,
      nonceBuffer,
      { authTagLength: CHACHA20_AUTH_TAG_LENGTH } as crypto.CipherGCMOptions,
    ) as crypto.DecipherGCM;

    decipher.setAuthTag(authTag);

    let decrypted: Buffer;
    try {
      decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
    } catch (err) {
      logger.error('crypto', `decrypt failed: ${(err as Error).message}`, { envelope_nonce: _nonce });
      throw err;
    }

    this.state.recvNonce = Math.max(this.state.recvNonce, _nonce + 1);

    logger.trace('crypto', 'decrypt', { envelope_nonce: _nonce, plaintextBytes: decrypted.length });

    return decrypted.toString('utf-8');
  }

  /**
   * Create bound encrypt/decrypt functions for use with RelayClient.
   */
  createEncryptFn(): (plaintext: string) => EncryptedMessage {
    return (plaintext: string) => this.encrypt(plaintext);
  }

  createDecryptFn(): (ciphertext: string, nonce: number) => string {
    return (ciphertext: string, nonce: number) => this.decrypt(ciphertext, nonce);
  }

  createWakeBlobEncryptFn(): (text: string) => string {
    return (text: string) => this.encryptWakeBlob(text);
  }

  // --------------------------------------------------------------------------
  // Ed25519 Signing and Verification
  // --------------------------------------------------------------------------

  /**
   * Sign a message using our Ed25519 identity private key.
   */
  sign(message: string | Buffer): string {
    if (!this.identityKeyPair) {
      throw new Error('Identity key pair not initialized');
    }

    const keyObject = crypto.createPrivateKey({
      key: this.identityKeyPair.privateKey,
      format: 'der',
      type: 'pkcs8',
    });

    const msgBuffer = typeof message === 'string' ? Buffer.from(message) : message;
    const signature = crypto.sign(null, msgBuffer, keyObject);

    return signature.toString('base64');
  }

  /**
   * Verify an Ed25519 signature against a peer's public key.
   */
  verify(
    message: string | Buffer,
    signatureBase64: string,
    peerPublicKeyBase64: string,
  ): boolean {
    const peerPublicKeyDer = Buffer.from(peerPublicKeyBase64, 'base64');

    let keyObject: crypto.KeyObject;
    try {
      keyObject = crypto.createPublicKey({
        key: peerPublicKeyDer,
        format: 'der',
        type: 'spki',
      });
    } catch {
      return false;
    }

    const msgBuffer = typeof message === 'string' ? Buffer.from(message) : message;
    const signature = Buffer.from(signatureBase64, 'base64');

    try {
      return crypto.verify(null, msgBuffer, keyObject, signature);
    } catch {
      return false;
    }
  }

  /**
   * Set the peer's identity public key (received during pairing).
   */
  setPeerIdentityPublicKey(peerPublicKeyBase64: string): void {
    this.state.peerIdentityPk = Buffer.from(peerPublicKeyBase64, 'base64');
  }

  /**
   * Verify a signature using the stored peer identity public key.
   */
  verifyPeer(message: string | Buffer, signatureBase64: string): boolean {
    if (!this.state.peerIdentityPk) {
      throw new Error('Peer identity public key not set');
    }
    return this.verify(message, signatureBase64, this.state.peerIdentityPk.toString('base64'));
  }

  // --------------------------------------------------------------------------
  // QR Payload Generation
  // --------------------------------------------------------------------------

  /**
   * Generate a QR code payload for pairing.
   */
  generateQrPayload(relayUrl: string, pairingId: string, expiresInSeconds: number = 120): QrCodePayload {
    if (!this.ephemeralKeyPair) {
      this.generateEphemeralKeyPair();
    }

    const now = Date.now();
    const otp = crypto.randomBytes(16).toString('hex');

    return {
      relay_url: relayUrl,
      pairing_id: pairingId,
      pc_ephemeral_pk: this.getEphemeralPublicKeyBase64(),
      otp,
      timestamp: now,
      expires: now + expiresInSeconds * 1000,
    };
  }

  // --------------------------------------------------------------------------
  // SAS (Short Authentication String) Code
  // --------------------------------------------------------------------------

  /**
   * Compute a 6-digit SAS code from the sas_key for visual verification.
   */
  computeSasCode(): string {
    if (!this.state.sessionKeys) {
      throw new Error('Session keys not established');
    }

    // Use first 4 bytes of SHA-256(sas_key) to generate a 6-digit code
    const hash = crypto.createHash('sha256').update(this.state.sessionKeys.sasKey).digest();
    const value = hash.readUInt32BE(0);
    const sixDigit = (value % 1000000).toString().padStart(6, '0');

    return sixDigit;
  }

  // --------------------------------------------------------------------------
  // Rekey Detection
  // --------------------------------------------------------------------------

  /**
   * Check whether a rekey is needed (every 500 messages or 1 hour).
   */
  needsRekey(): boolean {
    if (!this.state.sessionKeys) return false;

    if (this.state.messagesSinceRekey >= REKEY_INTERVAL_MESSAGES) {
      return true;
    }

    const elapsed = Date.now() - this.state.lastRekeyTime;
    if (elapsed >= REKEY_INTERVAL_MS) {
      return true;
    }

    return false;
  }

  /**
   * Reset rekey counters after a successful rekey.
   */
  resetRekeyCounters(): void {
    this.state.messagesSinceRekey = 0;
    this.state.lastRekeyTime = Date.now();
  }

  /**
   * Get the current crypto state (for debugging/status).
   */
  getState(): Readonly<CryptoState> {
    return { ...this.state };
  }

  /**
   * Check if session keys have been established.
   */
  hasSessionKeys(): boolean {
    return this.state.sessionKeys !== null;
  }

  /**
   * Get the raw session keys (for persistence).
   */
  getSessionKeys(): SessionKeys | null {
    return this.state.sessionKeys;
  }

  sendKeyFingerprint(): string | null {
    if (!this.state.sessionKeys) return null;
    const hash = crypto.createHash('sha256').update(this.state.sessionKeys.sendKey).digest();
    return hash.subarray(0, 8).toString('hex');
  }

  recvKeyFingerprint(): string | null {
    if (!this.state.sessionKeys) return null;
    const hash = crypto.createHash('sha256').update(this.state.sessionKeys.recvKey).digest();
    return hash.subarray(0, 8).toString('hex');
  }

  // --------------------------------------------------------------------------
  // Key Persistence
  // --------------------------------------------------------------------------

  private ensureKeyDir(): void {
    if (!fs.existsSync(this.keyDir)) {
      fs.mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
    }
  }

  private saveIdentityKeys(): void {
    if (!this.identityKeyPair) return;
    this.ensureKeyDir();

    const privPath = path.join(this.keyDir, IDENTITY_KEY_FILE);
    const pubPath = path.join(this.keyDir, IDENTITY_PUB_FILE);

    // Export as PEM for standard interoperability
    const privateKeyObject = crypto.createPrivateKey({
      key: this.identityKeyPair.privateKey,
      format: 'der',
      type: 'pkcs8',
    });

    const publicKeyObject = crypto.createPublicKey({
      key: this.identityKeyPair.publicKey,
      format: 'der',
      type: 'spki',
    });

    const privPem = privateKeyObject.export({ type: 'pkcs8', format: 'pem' });
    const pubPem = publicKeyObject.export({ type: 'spki', format: 'pem' });

    fs.writeFileSync(privPath, privPem, { mode: 0o600 });
    fs.writeFileSync(pubPath, pubPem, { mode: 0o644 });
  }

  private loadIdentityKeys(): IdentityKeyPair | null {
    const privPath = path.join(this.keyDir, IDENTITY_KEY_FILE);
    const pubPath = path.join(this.keyDir, IDENTITY_PUB_FILE);

    if (!fs.existsSync(privPath) || !fs.existsSync(pubPath)) {
      return null;
    }

    try {
      const privPem = fs.readFileSync(privPath, 'utf-8');
      const pubPem = fs.readFileSync(pubPath, 'utf-8');

      const privateKeyObject = crypto.createPrivateKey(privPem);
      const publicKeyObject = crypto.createPublicKey(pubPem);

      const privateKey = Buffer.from(
        privateKeyObject.export({ type: 'pkcs8', format: 'der' }),
      );
      const publicKey = Buffer.from(
        publicKeyObject.export({ type: 'spki', format: 'der' }),
      );

      return { publicKey, privateKey };
    } catch (err) {
      logger.error('crypto', `Failed to load identity keys: ${(err as Error).message}`);
      return null;
    }
  }
}
