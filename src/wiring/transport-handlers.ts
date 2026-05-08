// Agent Pocket — relay + LAN transport event handlers (Step 1.6c)
//
// Extracted from wireRelayClientEvents + wireLanServerEvents in
// src/index.ts. The two transports share the same 'message' fan-out
// (peer_hello vs PhoneCommand) plus 'connected'/'disconnected'/'error'
// shapes, so the message handler is unified into one helper. The
// reconnect-time pending-request resend (relay 'phone_online') and the
// E2E key-fingerprint exchange (relay 'key_verify') are relay-only.

import type { EventEmitter } from 'node:events';
import type {
  PcEvent,
  PeerHello,
  PhoneCommand,
  ErrorEvent,
} from 'agent-pocket-protocol';
import { SessionStatus } from 'agent-pocket-protocol';
import type { HookServer } from '../hooks/hook-server.js';
import type { SessionManager } from '../sessions/session-manager.js';
import { logger } from '../logger.js';
import type { PendingBlockingEntry } from './hook-handlers-codex.js';

/** Narrowed surface — both RelayClient and LanServer satisfy this. */
export type TransportGateway = Pick<EventEmitter, 'on'>;

/** What sendControlFrame / send() expects on each transport. */
export interface TransportSink {
  /** Used by relay (control frame) and lan (typed event). */
  sendControlEvent(payload: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Shared 'message' handler — peer_hello fanout vs PhoneCommand dispatch
// ---------------------------------------------------------------------------

export interface CommandMessageDeps {
  /** Tag used in trace + error logs ("relay" or "lan"). */
  source: 'relay' | 'lan';
  handlePeerHello(payload: PeerHello): void;
  handleCommand(command: PhoneCommand): Promise<void>;
  sendToPhone(event: PcEvent): void;
}

export function registerCommandMessageHandler(
  transport: TransportGateway,
  deps: CommandMessageDeps,
): void {
  transport.on('message', (payload: unknown) => {
    const cmdType = (payload as { type?: string })?.type;
    const reqId = (payload as { request_id?: string })?.request_id;
    logger.trace('daemon', `IN ${deps.source} command`, { type: cmdType, requestId: reqId, preview: JSON.stringify(payload).slice(0, 100) });

    if (cmdType === 'peer_hello') {
      deps.handlePeerHello(payload as PeerHello);
      return;
    }

    const command = payload as PhoneCommand;
    deps.handleCommand(command).catch((err) => {
      const msg = (err as Error).message;
      const tag = deps.source === 'lan' ? ' (lan)' : '';
      logger.error('daemon', `Command handler error${tag}: ${msg}`, { type: cmdType, requestId: reqId });
      const errorEvent: ErrorEvent = {
        type: 'error',
        request_id: (command as { request_id?: string }).request_id,
        message: `Command handler error: ${msg}`,
        code: 'COMMAND_ERROR',
      } as ErrorEvent;
      deps.sendToPhone(errorEvent);
    });
  });
}

// ---------------------------------------------------------------------------
// 'error' handler — same shape on both transports modulo source tag
// ---------------------------------------------------------------------------

export function registerTransportErrorHandler(
  transport: TransportGateway,
  source: 'relay' | 'lan',
): void {
  transport.on('error', (error: Error) => {
    const tag = source === 'lan' ? 'LAN' : 'Relay';
    logger.error('daemon', `${tag} error: ${error.message}`);
  });
}

// ---------------------------------------------------------------------------
// 'decrypt_error' handler — same logic, different sink shape per transport
// ---------------------------------------------------------------------------

export interface DecryptErrorDeps {
  source: 'relay' | 'lan';
  /** Triggered exactly when count === 3 to ask the phone to re-pair. */
  sendE2EError(message: string): void;
}

export function registerDecryptErrorHandler(
  transport: TransportGateway,
  deps: DecryptErrorDeps,
): void {
  transport.on('decrypt_error', (count: number) => {
    const tag = deps.source === 'lan' ? ' (LAN)' : '';
    logger.warn('daemon', `E2E decrypt failed ${count} times${tag} — phone may need to re-pair`);
    if (count === 3) {
      deps.sendE2EError('Decryption failed. Please re-pair the device.');
    }
  });
}

// ---------------------------------------------------------------------------
// Relay-only: 'connected' (no peer_hello — relay waits for 'phone_online')
// ---------------------------------------------------------------------------

export interface RelayConnectedDeps {
  emitConnected(): void;
}

export function registerRelayConnectedHandler(
  transport: TransportGateway,
  deps: RelayConnectedDeps,
): void {
  transport.on('connected', () => {
    logger.debug('daemon', '=== CONNECTED to relay ===');
    logger.info('daemon', 'Connected to relay');
    deps.emitConnected();
  });
}

// ---------------------------------------------------------------------------
// LAN-only: 'connected' (sends peer_hello immediately — LAN is auth'd already)
// ---------------------------------------------------------------------------

export interface LanConnectedDeps {
  sendPeerHello(): void;
  emitConnected(): void;
}

export function registerLanConnectedHandler(
  transport: TransportGateway,
  deps: LanConnectedDeps,
): void {
  transport.on('connected', () => {
    logger.debug('daemon', '=== CONNECTED via LAN ===');
    logger.info('daemon', 'Connected via LAN');
    deps.sendPeerHello();
    deps.emitConnected();
  });
}

// ---------------------------------------------------------------------------
// Shared 'disconnected' handler
// ---------------------------------------------------------------------------

export interface DisconnectedDeps {
  source: 'relay' | 'lan';
  emitDisconnected(reason: string): void;
}

export function registerDisconnectedHandler(
  transport: TransportGateway,
  deps: DisconnectedDeps,
): void {
  transport.on('disconnected', (reason: string) => {
    const tag = deps.source === 'lan' ? 'LAN' : 'relay';
    logger.warn('daemon', `Disconnected from ${tag}: ${reason}`);
    deps.emitDisconnected(reason);
  });
}

// ---------------------------------------------------------------------------
// Relay-only: 'phone_online' — reconnect-time pending-request resend
// ---------------------------------------------------------------------------

export interface PhoneOnlineDeps {
  hookServer: Pick<HookServer, 'hasPendingPermission'>;
  sessionManager: Pick<SessionManager, 'getAllSessions'>;
  sendPeerHello(): void;
  /** CryptoEngine.sendKeyFingerprint() — returns a fingerprint or null. */
  getKeyFingerprint(): string | null | undefined;
  /** Send a control frame on the relay (key_verify). */
  sendControlFrame(frame: Record<string, unknown>): void;
  /** Live reference to the daemon's pending-blocking-request map. */
  pendingBlockingRequests: Map<string, PendingBlockingEntry>;
  resendTrackedBlockingEvent(
    type: 'permission_request' | 'user_question' | 'plan_review',
    sessionId: string,
    requestId: string,
    event: PcEvent,
  ): void;
  sendToPhone(event: PcEvent): void;
  sendExpiredPendingSystemMessage(
    sessionId: string,
    requestId: string,
    toolName: string,
    actionType: 'permission_request' | 'user_question' | 'plan_review',
    entry?: PendingBlockingEntry,
  ): void;
  clearNotificationDelivery(eventType: string, sessionId: string, requestId: string): void;
}

export function registerPhoneOnlineHandler(
  transport: TransportGateway,
  deps: PhoneOnlineDeps,
): void {
  transport.on('phone_online', () => {
    logger.debug('daemon', 'Phone online, resending pending requests', { count: deps.pendingBlockingRequests.size });

    deps.sendPeerHello();

    const fp = deps.getKeyFingerprint();
    if (fp) {
      deps.sendControlFrame({ action: 'key_verify', key_fingerprint: fp });
    }

    let resent = 0;
    for (const [requestId, entry] of deps.pendingBlockingRequests) {
      const e = entry as unknown as {
        sessionId: string;
        type: 'permission_request' | 'user_question' | 'plan_review';
        event: PcEvent & { type?: string; tool_name?: string };
        sentAt?: number;
        expiredToTerminal?: boolean;
        toolName?: string;
      };
      logger.debug('daemon', 'reconnect resend candidate', {
        requestId,
        sessionId: e.sessionId,
        eventType: e.event?.type,
        actionType: e.type,
        expiredToTerminal: !!e.expiredToTerminal,
      });

      if (e.expiredToTerminal) {
        deps.resendTrackedBlockingEvent(e.type, e.sessionId, requestId, e.event);
        const expiredToolName = e.event?.tool_name ?? e.toolName ?? e.type;
        deps.sendToPhone({
          type: 'permission_expired',
          session_id: e.sessionId,
          request_id: requestId,
          tool_name: expiredToolName,
        } as unknown as PcEvent);
        logger.info('daemon', 'Resent expired pending action to phone', {
          sessionId: e.sessionId,
          requestId,
          toolName: expiredToolName,
          actionType: e.type,
        });
        deps.sendExpiredPendingSystemMessage(e.sessionId, requestId, expiredToolName, e.type, entry);
        deps.clearNotificationDelivery(e.type, e.sessionId, requestId);
        deps.sendToPhone({
          type: 'session_status',
          session_id: e.sessionId,
          status: SessionStatus.PENDING_ACTIONS,
          action_type: e.type,
        } as unknown as PcEvent);
        resent++;
        continue;
      }

      const hookPending = deps.hookServer.hasPendingPermission(requestId);
      const sdkPending = deps.sessionManager.getAllSessions().some(
        s => (s as unknown as { pendingPermissions?: Map<string, unknown> }).pendingPermissions?.has(requestId),
      );
      if (hookPending || sdkPending) {
        deps.resendTrackedBlockingEvent(e.type, e.sessionId, requestId, e.event);
        e.sentAt = Date.now();
        resent++;
      } else {
        deps.pendingBlockingRequests.delete(requestId);
        deps.clearNotificationDelivery(e.type, e.sessionId, requestId);
      }
    }
    logger.debug('daemon', `Resent ${resent} pending blocking requests`);
  });
}

// ---------------------------------------------------------------------------
// Relay-only: 'key_verify'
// ---------------------------------------------------------------------------

export interface KeyVerifyDeps {
  /** CryptoEngine.recvKeyFingerprint() — returns expected fp or null. */
  getExpectedFingerprint(): string | null | undefined;
  sendControlFrame(frame: Record<string, unknown>): void;
}

export function registerKeyVerifyHandler(
  transport: TransportGateway,
  deps: KeyVerifyDeps,
): void {
  transport.on('key_verify', (peerFingerprint: string) => {
    const expected = deps.getExpectedFingerprint();
    if (!expected) return;
    if (peerFingerprint === expected) {
      logger.info('daemon', 'E2E key verification passed');
    } else {
      logger.error('daemon', 'E2E key mismatch — phone has stale keys', { expected, received: peerFingerprint });
      deps.sendControlFrame({
        action: 'e2e_error',
        message: 'E2E key mismatch. Please re-pair the device.',
      });
    }
  });
}
