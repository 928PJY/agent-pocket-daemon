// Agent Pocket — notification + blocking-request bookkeeping (Step 1.7)
//
// Extracted from sendToPhone, sendNotificationEventToPhone,
// trackNotificationDelivery, resendTrackedBlockingEvent,
// clearNotificationDelivery(/ForSession), retryPendingNotificationDeliveries,
// sendExpiredPendingSystemMessage, trackBlockingRequest,
// untrackBlockingRequest, retryPendingBlockingRequests in src/index.ts.
//
// These methods cross-reference each other (sendNotificationEventToPhone calls
// sendToPhone + trackNotificationDelivery; resendTrackedBlockingEvent calls
// sendToPhone; retry loops call sendToPhone) so they are bundled into a single
// factory that returns the complete closure set, sharing live Map references
// and a small dep surface (transports, crypto, capability lookup).

import type {
  PcEvent,
  SessionOutputEvent,
  WakeBlobPayload,
} from 'agent-pocket-protocol';
import { SessionStatus } from 'agent-pocket-protocol';
import {
  NOTIFICATION_DELIVERY_ACK_TIMEOUT_MS,
  type NotificationDeliveryEventType,
} from '../relay/phone-transport.js';
import {
  PEER_CAPABILITIES,
  BLOCKING_RETRY_INTERVAL_MS,
} from 'agent-pocket-protocol';
import { notificationDeliveryKey as buildNotificationDeliveryKey } from '../commands/handlers/acks.js';
import { logger } from '../logger.js';
import type { HookServer } from '../hooks/hook-server.js';
import type { SessionManager } from '../sessions/session-manager.js';

// ---------------------------------------------------------------------------
// Live entry shapes (mirror the in-class Map values in src/index.ts)
// ---------------------------------------------------------------------------

export interface PendingBlockingRequestEntry {
  requestId: string;
  sessionId: string;
  event: PcEvent;
  sentAt: number;
  type: 'permission_request' | 'user_question' | 'plan_review';
  toolName?: string;
  expiredToTerminal?: boolean;
  expiredSystemMessageSent?: boolean;
}

export interface PendingNotificationDeliveryEntry {
  requestId: string;
  sessionId: string;
  eventType: NotificationDeliveryEventType;
  event: PcEvent;
  wakePayload?: WakeBlobPayload;
  sentAt: number;
  attempts: number;
}

// ---------------------------------------------------------------------------
// Narrowed surfaces for the two transports + crypto rekey check
// ---------------------------------------------------------------------------

/** What sendToPhone needs from RelayClient. */
export interface RelaySink {
  send(event: PcEvent, wake?: boolean, wakePayload?: WakeBlobPayload, forceWake?: boolean): void;
  getPhonePeerOnline?(): boolean;
}

/** What sendToPhone needs from LanServer. */
export interface LanSink {
  send(event: PcEvent): void;
}

/** Just the rekey-control surface of CryptoEngine that sendToPhone touches. */
export interface RekeyController {
  needsRekey(): boolean;
  resetRekeyCounters(): void;
}

// ---------------------------------------------------------------------------
// Factory deps
// ---------------------------------------------------------------------------

export interface NotificationBookkeepingDeps {
  /** Live reference to the daemon's per-session monotonic seq map. */
  sessionSeqCounters: Map<string, number>;
  /** Live reference to the daemon's pending blocking-request map. */
  pendingBlockingRequests: Map<string, PendingBlockingRequestEntry>;
  /** Live reference to the daemon's pending notification-delivery map. */
  pendingNotificationDeliveries: Map<string, PendingNotificationDeliveryEntry>;

  /** Read-live current connection mode ('relay' | 'lan' | undefined). */
  getConnectionMode(): 'relay' | 'lan' | undefined;
  /** Read-live LAN sink — null when not in LAN mode. */
  getLanServer(): LanSink | null;
  /** Read-live relay sink — null before relay connects. */
  getRelayClient(): RelaySink | null;

  cryptoEngine: RekeyController;

  /** True if the most recent peer_hello announced this capability. */
  hasPeerCapability(name: string): boolean;

  sessionManager: Pick<SessionManager, 'getAllSessions'>;
  hookServer: Pick<HookServer, 'hasPendingPermission'>;

  /** Resolve daemon-internal sessionId → external id known to the phone. */
  resolveExternalSessionId(internalId: string): string;
}

// ---------------------------------------------------------------------------
// Returned closure set
// ---------------------------------------------------------------------------

export interface NotificationBookkeeping {
  sendToPhone(event: PcEvent, wake?: boolean, wakePayload?: WakeBlobPayload, forceWake?: boolean): void;
  sendNotificationEventToPhone(
    event: PcEvent,
    eventType: NotificationDeliveryEventType,
    sessionId: string,
    requestId: string,
    wakePayload: WakeBlobPayload,
  ): void;
  trackNotificationDelivery(
    eventType: NotificationDeliveryEventType,
    sessionId: string,
    requestId: string,
    event: PcEvent,
    wakePayload: WakeBlobPayload,
  ): void;
  notificationDeliveryKey(eventType: string, sessionId: string, requestId: string): string;
  resendTrackedBlockingEvent(
    eventType: 'permission_request' | 'user_question' | 'plan_review',
    sessionId: string,
    requestId: string,
    event: PcEvent,
    forceWake?: boolean,
  ): void;
  clearNotificationDelivery(eventType: string, sessionId: string, requestId: string): void;
  clearNotificationDeliveriesForSession(sessionId: string): void;
  retryPendingNotificationDeliveries(): void;
  sendExpiredPendingSystemMessage(
    sessionId: string,
    requestId: string,
    toolName: string,
    actionType: 'permission_request' | 'user_question' | 'plan_review',
    entry?: { expiredSystemMessageSent?: boolean },
  ): void;
  trackBlockingRequest(
    requestId: string,
    sessionId: string,
    event: PcEvent,
    type: 'permission_request' | 'user_question' | 'plan_review',
  ): void;
  untrackBlockingRequest(requestId: string): void;
  retryPendingBlockingRequests(): void;
}

export function createNotificationBookkeeping(
  deps: NotificationBookkeepingDeps,
): NotificationBookkeeping {
  function sendToPhone(
    event: PcEvent,
    wake = false,
    wakePayload?: WakeBlobPayload,
    forceWake = false,
  ): void {
    if ((event as { type?: string })?.type === 'session_output') {
      const out = event as SessionOutputEvent;
      if (out.session_id && out.session_seq === undefined) {
        const next = (deps.sessionSeqCounters.get(out.session_id) ?? 0) + 1;
        deps.sessionSeqCounters.set(out.session_id, next);
        out.session_seq = next;
      }
    }

    logger.trace('daemon', 'OUT event', {
      type: (event as { type?: string })?.type,
      requestId: (event as { request_id?: string })?.request_id,
      preview: JSON.stringify(event).slice(0, 100),
    });
    if ((event as { type?: string })?.type === 'session_list') {
      const sl = event as unknown as { sessions: Array<{ session_id: string; project_name?: string; status?: string }> };
      logger.info('daemon', `[debug] session_list -> phone: ${sl.sessions.length} sessions: ${sl.sessions.map(s => `${s.session_id.slice(0,12)}(${s.project_name ?? '?'},${s.status ?? '?'})`).join(' | ')}`);
    }

    const mode = deps.getConnectionMode() ?? 'relay';
    const lan = deps.getLanServer();
    const relay = deps.getRelayClient();

    if (mode === 'lan' && lan) {
      lan.send(event);
    } else if (relay) {
      if (deps.cryptoEngine.needsRekey()) {
        deps.cryptoEngine.resetRekeyCounters();
      }
      relay.send(event, wake, wakePayload, forceWake);
    }
  }

  function notificationDeliveryKey(eventType: string, sessionId: string, requestId: string): string {
    return buildNotificationDeliveryKey(eventType, sessionId, requestId);
  }

  function trackNotificationDelivery(
    eventType: NotificationDeliveryEventType,
    sessionId: string,
    requestId: string,
    event: PcEvent,
    wakePayload: WakeBlobPayload,
  ): void {
    if (!deps.hasPeerCapability(PEER_CAPABILITIES.NOTIFICATION_DELIVERY_ACKS)) return;
    const key = notificationDeliveryKey(eventType, sessionId, requestId);
    deps.pendingNotificationDeliveries.set(key, {
      requestId,
      sessionId,
      eventType,
      event,
      wakePayload,
      sentAt: Date.now(),
      attempts: 1,
    });
    logger.debug('daemon', 'Tracking notification delivery', { eventType, sessionId, requestId });
  }

  function sendNotificationEventToPhone(
    event: PcEvent,
    eventType: NotificationDeliveryEventType,
    sessionId: string,
    requestId: string,
    wakePayload: WakeBlobPayload,
  ): void {
    const relay = deps.getRelayClient();
    const phoneOnline = relay?.getPhonePeerOnline?.() === true;
    logger.debug('daemon', 'notification emit', { eventType, sessionId, requestId, phoneOnline });
    sendToPhone(event, true, wakePayload);
    if (phoneOnline) {
      trackNotificationDelivery(eventType, sessionId, requestId, event, wakePayload);
    }
  }

  function resendTrackedBlockingEvent(
    eventType: 'permission_request' | 'user_question' | 'plan_review',
    sessionId: string,
    requestId: string,
    event: PcEvent,
    forceWake = false,
  ): void {
    const pending = deps.pendingNotificationDeliveries.get(notificationDeliveryKey(eventType, sessionId, requestId));
    if (pending?.wakePayload) {
      sendToPhone(event, true, pending.wakePayload, forceWake);
    } else {
      sendToPhone(event);
    }
  }

  function clearNotificationDelivery(eventType: string, sessionId: string, requestId: string): void {
    deps.pendingNotificationDeliveries.delete(notificationDeliveryKey(eventType, sessionId, requestId));
  }

  function clearNotificationDeliveriesForSession(sessionId: string): void {
    for (const [key, entry] of deps.pendingNotificationDeliveries) {
      if (entry.sessionId === sessionId) {
        deps.pendingNotificationDeliveries.delete(key);
      }
    }
  }

  function retryPendingNotificationDeliveries(): void {
    if (!deps.hasPeerCapability(PEER_CAPABILITIES.NOTIFICATION_DELIVERY_ACKS)) return;
    const now = Date.now();
    for (const [key, entry] of deps.pendingNotificationDeliveries) {
      if (now - entry.sentAt < NOTIFICATION_DELIVERY_ACK_TIMEOUT_MS) continue;
      deps.pendingNotificationDeliveries.delete(key);
      logger.warn('daemon', 'notification ack timeout — sending forceWake APNs fallback', {
        eventType: entry.eventType,
        sessionId: entry.sessionId,
        requestId: entry.requestId,
        elapsedMs: now - entry.sentAt,
      });
      sendToPhone(entry.event, true, entry.wakePayload, true);
    }
  }

  function sendExpiredPendingSystemMessage(
    sessionId: string,
    requestId: string,
    toolName: string,
    actionType: 'permission_request' | 'user_question' | 'plan_review',
    entry?: { expiredSystemMessageSent?: boolean },
  ): void {
    if (entry?.expiredSystemMessageSent) return;
    const actionLabel = actionType === 'user_question'
      ? 'question'
      : actionType === 'plan_review'
      ? 'plan review'
      : 'permission request';
    const content = "This " + actionLabel + " has expired. Handle it in the terminal, or interrupt this session from the app and continue it to trigger a new request.";
    sendToPhone({
      type: 'session_output',
      session_id: sessionId,
      output_type: 'system',
      content,
      timestamp: Date.now(),
      request_id: requestId,
      tool_name: toolName,
    } as unknown as PcEvent);
    if (entry) entry.expiredSystemMessageSent = true;
  }

  function trackBlockingRequest(
    requestId: string,
    sessionId: string,
    event: PcEvent,
    type: 'permission_request' | 'user_question' | 'plan_review',
  ): void {
    deps.pendingBlockingRequests.set(requestId, {
      requestId,
      sessionId,
      event,
      sentAt: Date.now(),
      type,
    });

    logger.debug('daemon', `trackBlockingRequest: ${type} ${requestId.slice(0,8)}`, {
      sessionId,
      totalPending: deps.pendingBlockingRequests.size,
    });

    sendToPhone({
      type: 'session_status',
      session_id: sessionId,
      status: SessionStatus.PENDING_ACTIONS,
      action_type: type,
    } as unknown as PcEvent);
  }

  function untrackBlockingRequest(requestId: string): void {
    const entry = deps.pendingBlockingRequests.get(requestId);
    deps.pendingBlockingRequests.delete(requestId);

    if (entry) {
      const hasOtherBlocking = Array.from(deps.pendingBlockingRequests.values()).some(
        e => e.sessionId === entry.sessionId,
      );
      if (!hasOtherBlocking) {
        const session = deps.sessionManager.getAllSessions().find(
          s => deps.resolveExternalSessionId(s.sessionId) === entry.sessionId
            || s.claudeSessionId === entry.sessionId,
        );
        const status = session?.status ?? SessionStatus.READY;
        sendToPhone({
          type: 'session_status',
          session_id: entry.sessionId,
          status,
        } as unknown as PcEvent);
      }
    }
  }

  function retryPendingBlockingRequests(): void {
    const now = Date.now();
    for (const [requestId, entry] of deps.pendingBlockingRequests) {
      if ((entry as { expiredToTerminal?: boolean }).expiredToTerminal) continue;

      const isStillPending =
        deps.hookServer.hasPendingPermission(requestId) ||
        deps.sessionManager.getAllSessions().some(
          s => (s as unknown as { pendingPermissions?: Map<string, unknown> }).pendingPermissions?.has(requestId),
        );

      if (!isStillPending) {
        deps.pendingBlockingRequests.delete(requestId);
        clearNotificationDelivery(entry.type, entry.sessionId, requestId);
        continue;
      }

      if (now - entry.sentAt >= BLOCKING_RETRY_INTERVAL_MS) {
        logger.warn('daemon', `Retrying blocking request`, {
          type: entry.type,
          requestId,
          waitedMs: now - entry.sentAt,
        });
        sendToPhone(entry.event);
        entry.sentAt = now;
      }
    }
  }

  return {
    sendToPhone,
    sendNotificationEventToPhone,
    trackNotificationDelivery,
    notificationDeliveryKey,
    resendTrackedBlockingEvent,
    clearNotificationDelivery,
    clearNotificationDeliveriesForSession,
    retryPendingNotificationDeliveries,
    sendExpiredPendingSystemMessage,
    trackBlockingRequest,
    untrackBlockingRequest,
    retryPendingBlockingRequests,
  };
}
