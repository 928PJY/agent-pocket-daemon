// Agent Pocket -- Relay Client
// WebSocket client that connects to the relay server with
// exponential backoff reconnection and offline message queuing.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { RelayEnvelope, WakeBlobPayload } from '../shared/index.js';
import { logger } from '../logger.js';
import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_MULTIPLIER,
  OFFLINE_MESSAGE_MAX_COUNT,
  WIRE_VERSION_MIN,
  WIRE_VERSION_CURRENT,
} from '../shared/index.js';

// ============================================================================
// Types
// ============================================================================

export type EncryptFn = (plaintext: string) => { ciphertext: string; nonce: number };
export type DecryptFn = (ciphertext: string, nonce: number) => string;
export type WakeBlobEncryptFn = (text: string) => string;

export interface RelayClientConfig {
  relayUrl: string;
  pairId: string;
  authToken: string;
  encrypt?: EncryptFn;
  decrypt?: DecryptFn;
  encryptWakeBlob?: WakeBlobEncryptFn;
}

export interface RelayClientEvents {
  connected: [];
  disconnected: [reason: string];
  message: [payload: unknown];
  error: [error: Error];
}

// ============================================================================
// RelayClient
// ============================================================================

export class RelayClient extends EventEmitter {
  private config: RelayClientConfig;
  private ws: WebSocket | null = null;
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private awaitingPong: boolean = false;
  private offlineQueue: RelayEnvelope[] = [];
  private isConnected: boolean = false;
  private isShuttingDown: boolean = false;
  private messageNonce: number = 0;
  private phonePeerOnline: boolean = false;
  private consecutiveDecryptFailures: number = 0;
  // Wire negotiation state, populated when the relay sends `hello`.
  private negotiatedWireVersion: number | null = null;
  private relayWireRange: { min: number; max: number } | null = null;
  private relayFeatures: string[] = [];

  private readonly PING_INTERVAL_MS = 30_000; // 30 seconds
  private readonly PONG_TIMEOUT_MS = 10_000; // 10 seconds to receive pong

  constructor(config: RelayClientConfig) {
    super();
    this.config = config;
    this.reconnectDelay = RECONNECT_BASE_DELAY_MS;
  }

  /**
   * Connect to the relay server.
   */
  connect(): void {
    if (this.isShuttingDown) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.createConnection();
  }

  /**
   * Disconnect gracefully from the relay server.
   */
  disconnect(): void {
    this.isShuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopPingTimer();

    if (this.ws) {
      try {
        this.ws.close(1000, 'Client shutting down');
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.isConnected = false;
  }

  /**
   * Send a message through the relay.
   * If not connected, message is queued (up to OFFLINE_MESSAGE_MAX_COUNT).
   * Set `wake` for events that should trigger an APNs wake push when the
   * peer is offline. `wakePayload` is encrypted into an opaque fixed-size blob
   * for iOS notification display; the relay only copies it through.
   */
  send(payload: unknown, wake?: boolean, wakePayload?: WakeBlobPayload): void {
    const serialized = JSON.stringify(payload);

    let encryptedPayload: string;
    let nonce: number;

    if (this.config.encrypt) {
      const encrypted = this.config.encrypt(serialized);
      encryptedPayload = encrypted.ciphertext;
      nonce = encrypted.nonce;
    } else {
      // No encryption configured -- send as base64 plaintext
      encryptedPayload = Buffer.from(serialized).toString('base64');
      nonce = this.messageNonce++;
    }

    const envelope: RelayEnvelope = {
      pair_id: this.config.pairId,
      sender: 'pc',
      encrypted_payload: encryptedPayload,
      nonce,
      timestamp: Date.now(),
    };
    if (wake) {
      envelope.wake = true;
      if (wakePayload && this.config.encryptWakeBlob) {
        envelope.wake_blob = this.config.encryptWakeBlob(JSON.stringify(wakePayload));
      }
    }

    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendEnvelope(envelope);
    } else {
      this.enqueueOffline(envelope);
    }
  }

  /**
   * Get the current connection state.
   */
  getConnectionState(): 'connected' | 'disconnected' | 'connecting' {
    if (this.isConnected) return 'connected';
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return 'connecting';
    return 'disconnected';
  }

  /**
   * Get the number of messages in the offline queue.
   */
  getOfflineQueueSize(): number {
    return this.offlineQueue.length;
  }

  getPhonePeerOnline(): boolean {
    return this.phonePeerOnline;
  }

  /** Negotiated wire version for the current session, null if not yet received. */
  getNegotiatedWireVersion(): number | null {
    return this.negotiatedWireVersion;
  }

  /** Relay feature flags advertised in the hello frame. */
  getRelayFeatures(): string[] {
    return this.relayFeatures;
  }

  /**
   * Update the encrypt/decrypt functions (e.g., after rekey).
   */
  setEncryptFn(encrypt: EncryptFn): void {
    this.config.encrypt = encrypt;
  }

  setDecryptFn(decrypt: DecryptFn): void {
    this.config.decrypt = decrypt;
  }

  setWakeBlobEncryptFn(encryptWakeBlob: WakeBlobEncryptFn): void {
    this.config.encryptWakeBlob = encryptWakeBlob;
  }

  sendControlFrame(frame: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: '__peer_control', ...frame }));
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private createConnection(): void {
    const url = new URL(this.config.relayUrl);
    url.pathname = url.pathname === '/' ? '/ws' : url.pathname;
    const wsUrl = url.toString();

    this.ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${this.config.authToken}`,
      },
    });

    logger.info('relay', `Connecting to ${url.host}${url.pathname}`);

    this.ws.on('open', () => {
      this.isConnected = true;
      this.reconnectDelay = RECONNECT_BASE_DELAY_MS;

      // Send routing header as first message (required by relay server)
      const routingHeader = JSON.stringify({
        protocol_version: WIRE_VERSION_CURRENT,
        min_supported_version: WIRE_VERSION_MIN,
        device_pair_id: this.config.pairId,
        device_role: 'pc',
      });
      this.ws!.send(routingHeader);

      this.startPingTimer();
      this.resetDecryptFailureCount('connected');
      logger.info('relay', 'Connected', { queuedOffline: this.offlineQueue.length });
      this.emit('connected');
      this.flushOfflineQueue();

      // Query current phone peer status
      this.ws!.send(JSON.stringify({
        type: '__relay_control',
        action: 'peer_status_query',
      }));
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('pong', () => {
      this.awaitingPong = false;
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      const wasConnected = this.isConnected;
      this.isConnected = false;
      this.ws = null;
      this.stopPingTimer();
      this.resetDecryptFailureCount('disconnected');

      const reasonStr = reason?.toString() || `code=${code}`;
      if (wasConnected) {
        logger.warn('relay', 'Disconnected', { code, reason: reasonStr });
        this.emit('disconnected', reasonStr);
      }

      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: Error) => {
      logger.error('relay', `Socket error: ${err.message}`);
      this.emit('error', err);
    });
  }

  private resetDecryptFailureCount(reason: string): void {
    if (this.consecutiveDecryptFailures === 0) return;
    logger.debug('relay', 'Resetting decrypt failure count', {
      reason,
      previousFailures: this.consecutiveDecryptFailures,
    });
    this.consecutiveDecryptFailures = 0;
  }

  private handleMessage(data: WebSocket.Data): void {
    let raw: string;
    if (Buffer.isBuffer(data)) {
      raw = data.toString('utf-8');
    } else if (typeof data === 'string') {
      raw = data;
    } else if (Array.isArray(data)) {
      raw = Buffer.concat(data).toString('utf-8');
    } else {
      raw = data.toString();
    }

    logger.trace('relay', `RX ${raw.length} bytes`);

    let envelope: RelayEnvelope;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      // Skip relay control messages (e.g. peer_status) — they aren't envelopes
      if (parsed.type === '__relay_control') {
        logger.trace('relay', 'Control frame', { payload: parsed });
        if (parsed.action === 'hello') {
          const wire = parsed.wire as { min?: number; max?: number; negotiated?: number } | undefined;
          if (wire) {
            this.relayWireRange = { min: wire.min ?? 1, max: wire.max ?? 1 };
            this.negotiatedWireVersion = wire.negotiated ?? wire.max ?? null;
          }
          this.relayFeatures = Array.isArray(parsed.features) ? (parsed.features as string[]) : [];
          logger.info('relay', 'Hello received', {
            wire: this.relayWireRange,
            negotiated: this.negotiatedWireVersion,
            features: this.relayFeatures,
          });
          return;
        }
        if (parsed.action === 'peer_status') {
          const role = parsed.role as string | undefined;
          // peer_status_query response has no role — it's always about our peer (phone)
          if (!role || role === 'phone') {
            const wasOnline = this.phonePeerOnline;
            this.phonePeerOnline = parsed.online === true;
            logger.info('relay', `Phone peer ${this.phonePeerOnline ? 'online' : 'offline'}`);
            if (!wasOnline && this.phonePeerOnline) {
              this.emit('phone_online');
            }
          }
        }
        return;
      }

      // Peer-to-peer control frames (forwarded by relay as opaque data)
      if (parsed.type === '__peer_control') {
        logger.trace('relay', 'Peer control frame', { payload: parsed });
        if (parsed.action === 'key_verify') {
          this.emit('key_verify', parsed.key_fingerprint as string);
        } else if (parsed.action === 'e2e_error') {
          this.emit('e2e_error_control', parsed.message as string);
        }
        return;
      }

      envelope = parsed as unknown as RelayEnvelope;
    } catch (err) {
      logger.warn('relay', 'Failed to parse frame', { preview: raw.slice(0, 120) });
      this.emit('error', new Error(`Failed to parse relay message: ${raw.substring(0, 200)}`));
      return;
    }

    // Guard: skip messages without encrypted_payload
    if (!envelope.encrypted_payload) {
      logger.warn('relay', 'Skipping envelope with no payload', { sender: envelope.sender });
      return;
    }

    // Decrypt the payload
    let decryptedPayload: string;
    try {
      if (this.config.decrypt) {
        decryptedPayload = this.config.decrypt(envelope.encrypted_payload, envelope.nonce);
      } else {
        // No decryption configured -- decode base64
        decryptedPayload = Buffer.from(envelope.encrypted_payload, 'base64').toString('utf-8');
      }
      this.consecutiveDecryptFailures = 0;
    } catch (err) {
      this.consecutiveDecryptFailures++;
      logger.error('relay', `Decrypt failed (${this.consecutiveDecryptFailures} consecutive): ${(err as Error).message}`, { envelope_nonce: envelope.nonce });
      if (this.consecutiveDecryptFailures >= 3) {
        this.emit('decrypt_error', this.consecutiveDecryptFailures);
      }
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(decryptedPayload);
    } catch (err) {
      logger.warn('relay', 'Failed to parse decrypted payload');
      this.emit('error', new Error(`Failed to parse decrypted payload: ${decryptedPayload.substring(0, 200)}`));
      return;
    }

    const cmdType = (payload as { type?: string })?.type;
    logger.trace('relay', `RX decoded`, { type: cmdType, envelope_nonce: envelope.nonce });
    this.emit('message', payload);
  }

  private sendEnvelope(envelope: RelayEnvelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      this.ws.send(JSON.stringify(envelope));
      logger.trace('relay', 'TX envelope', { envelope_nonce: envelope.nonce });
    } catch (err) {
      logger.error('relay', `Send failed: ${(err as Error).message}`);
      this.emit('error', new Error(`Failed to send message: ${(err as Error).message}`));
      this.enqueueOffline(envelope);
    }
  }

  private enqueueOffline(envelope: RelayEnvelope): void {
    if (this.offlineQueue.length >= OFFLINE_MESSAGE_MAX_COUNT) {
      // Drop oldest message to make room
      this.offlineQueue.shift();
      logger.warn('relay', 'Offline queue full — dropping oldest', { max: OFFLINE_MESSAGE_MAX_COUNT });
    }
    this.offlineQueue.push(envelope);
    logger.trace('relay', 'Queued offline', { size: this.offlineQueue.length });
  }

  private flushOfflineQueue(): void {
    while (this.offlineQueue.length > 0 && this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      const envelope = this.offlineQueue.shift()!;
      this.sendEnvelope(envelope);
    }
  }

  private startPingTimer(): void {
    this.stopPingTimer();
    this.awaitingPong = false;

    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      if (this.awaitingPong) {
        // No pong received since last ping — connection is stale
        logger.warn('relay', 'Pong timeout — terminating stale connection');
        this.ws.terminate();
        return;
      }

      this.awaitingPong = true;
      this.ws.ping();
    }, this.PING_INTERVAL_MS);
  }

  private stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.awaitingPong = false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const jitter = Math.random() * this.reconnectDelay * 0.1;
    const delay = Math.min(this.reconnectDelay + jitter, RECONNECT_MAX_DELAY_MS);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(
        this.reconnectDelay * RECONNECT_MULTIPLIER,
        RECONNECT_MAX_DELAY_MS,
      );
      logger.warn('relay', 'Reconnecting', { delayMs: Math.round(delay) });
      this.connect();
    }, delay);
  }
}
