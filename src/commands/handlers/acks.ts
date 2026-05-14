// Agent Pocket — ack / abort / verify command handlers
//
// Small leaf handlers extracted from AgentPocketDaemon as part of Step 1.4e:
//
// - handleEmergencyAbort:        verify phone signature, then nuke all sessions
// - handleSessionOutputAck:      bump per-session "last seq the phone has seen"
// - handleNotificationDeliveryAck: cancel a pending APNs/relay re-push
// - handleVerifyHistory:         compare phone's count/tail against on-disk truth,
//                                 emit `history_divergence` when off
//
// To keep CommandContext small, dependencies that only these handlers need
// (cryptoEngine, history readers, the mutable bookkeeping maps) are passed
// via dedicated dep interfaces rather than added to CommandContext.

import type {
  PcEvent,
  EmergencyAbortCommand,
  SessionOutputAckCommand,
  NotificationDeliveryAckCommand,
  VerifyHistoryCommand,
  ErrorEvent,
  HistoryDivergenceEvent,
} from 'agent-pocket-protocol';
import type { CommandContext } from '../command-context.js';
import { isCodexSessionId } from '../../discovery/codex-discovery.js';
import type { HistoryPage } from '../../discovery/session-discovery.js';
import { logger } from '../../logger.js';

// ---------------------------------------------------------------------------
// emergency_abort
// ---------------------------------------------------------------------------

/** Minimal view of the crypto engine needed to verify a phone-signed payload. */
export interface CryptoVerifier {
  hasSessionKeys(): boolean;
  verifyPeer(payload: string, signature: string): boolean;
}

export function handleEmergencyAbort(
  ctx: Pick<CommandContext, 'sessionManager' | 'sendToPhone' | 'sendError'>,
  crypto: CryptoVerifier,
  command: EmergencyAbortCommand,
): void {
  if (command.phone_signature && crypto.hasSessionKeys()) {
    const signaturePayload = JSON.stringify({ type: 'emergency_abort' });
    const valid = crypto.verifyPeer(signaturePayload, command.phone_signature);
    if (!valid) {
      ctx.sendError(undefined, 'Invalid emergency abort signature', 'SIGNATURE_INVALID');
      return;
    }
  }

  ctx.sessionManager.emergencyAbort();

  const event: ErrorEvent = {
    type: 'error',
    message: 'Emergency abort completed -- all sessions terminated',
    code: 'EMERGENCY_ABORT_COMPLETE',
  };
  ctx.sendToPhone(event);
}

// ---------------------------------------------------------------------------
// session_output_ack
// ---------------------------------------------------------------------------

export function handleSessionOutputAck(
  lastAckedSeqs: Map<string, number>,
  command: SessionOutputAckCommand,
): void {
  const prev = lastAckedSeqs.get(command.session_id) ?? 0;
  if (command.last_seq > prev) {
    lastAckedSeqs.set(command.session_id, command.last_seq);
  }
  logger.trace('daemon', 'session_output_ack', { sessionId: command.session_id, lastSeq: command.last_seq });
}

// ---------------------------------------------------------------------------
// notification_delivery_ack
// ---------------------------------------------------------------------------

/** Key format used for the in-flight notification map. Exported for tests + reuse. */
export function notificationDeliveryKey(eventType: string, sessionId: string, requestId: string): string {
  return `${eventType}|${sessionId}|${requestId}`;
}

export function handleNotificationDeliveryAck(
  pendingDeliveries: Map<string, { attempts: number }>,
  command: NotificationDeliveryAckCommand,
): void {
  const key = notificationDeliveryKey(command.event_type, command.session_id, command.request_id);
  const pending = pendingDeliveries.get(key);
  if (pending) {
    pendingDeliveries.delete(key);
    logger.debug('daemon', 'notification_delivery_ack received', {
      eventType: command.event_type,
      sessionId: command.session_id,
      requestId: command.request_id,
      attempts: pending.attempts,
    });
  } else {
    logger.trace('daemon', 'notification_delivery_ack for untracked event', {
      eventType: command.event_type,
      sessionId: command.session_id,
      requestId: command.request_id,
    });
  }
}

// ---------------------------------------------------------------------------
// verify_history
// ---------------------------------------------------------------------------

/**
 * History readers + phone-side preferences. Pulled out so verify-history can
 * be tested without instantiating SessionDiscovery / CodexDiscovery.
 */
export interface VerifyHistoryDeps {
  /** Read on-disk SDK/Claude session history. */
  getSdkHistory(sessionId: string, options: { offset: number; limit: number }): HistoryPage;
  /** Read on-disk Codex rollout history. */
  getCodexHistory(sessionId: string, options: { offset: number; limit: number }): HistoryPage;
  /** Phone-side display preferences (mirror of the daemon's `phonePreferences`). */
  phonePreferences: { showToolUse: boolean };
}

export function handleVerifyHistory(
  ctx: Pick<CommandContext, 'sendToPhone'>,
  deps: VerifyHistoryDeps,
  command: VerifyHistoryCommand,
): void {
  const result = isCodexSessionId(command.session_id)
    ? deps.getCodexHistory(command.session_id, { offset: 0, limit: 100_000 })
    : deps.getSdkHistory(command.session_id, { offset: 0, limit: 100_000 });

  // Apply the same phone-side filter (tool_use/tool_result hidden when pref is off).
  const visible = deps.phonePreferences.showToolUse
    ? result.messages
    : result.messages.filter((m) => m.role !== 'tool_use' && m.role !== 'tool_result');

  // Match phone-side parsing: skip empty user messages, blank assistant
  // messages, and unrecognized roles (phone only handles
  // user/assistant/tool_use/subagent).
  const phoneVisible = visible.filter((m) => {
    if (m.role === 'user') return m.content.length > 0;
    if (m.role === 'assistant') return m.content.trim().length > 0;
    if (m.role === 'tool_use' || m.role === 'subagent') return true;
    return false;
  });

  const expectedCount = phoneVisible.length;
  const expectedTailSeq = result.tailSeq;

  let reason: 'count_mismatch' | 'tail_seq_mismatch' | 'head_seq_mismatch' | null = null;
  if (
    command.tail_seq !== undefined
    && expectedTailSeq !== undefined
    && command.tail_seq !== expectedTailSeq
  ) {
    reason = 'tail_seq_mismatch';
  } else if (command.count !== expectedCount) {
    // If the phone reports max_count and its count equals that max, it's
    // trimming older messages — only tail_seq matters, count divergence is
    // expected.
    const maxCount = (command as unknown as Record<string, unknown>).max_count;
    const phoneAtMax = maxCount !== undefined && command.count === maxCount;

    // Phone holds a partial window (e.g. after scoped sync only delivered
    // messages after some after_seq cursor). When phone's head_seq is
    // strictly greater than the earliest seq we'd expect it to see, phone
    // is intentionally missing the prefix. tail_seq match above already
    // proved the window is in sync, so count divergence is expected.
    const expectedHeadSeq = phoneVisible[0]?.seq;
    const phoneHoldsPartialWindow =
      typeof command.head_seq === 'number'
      && typeof expectedHeadSeq === 'number'
      && command.head_seq > expectedHeadSeq;

    if (!phoneAtMax && !phoneHoldsPartialWindow) {
      reason = 'count_mismatch';
    }
  }

  if (!reason) {
    logger.trace('daemon', 'verify_history match', { sessionId: command.session_id, count: expectedCount });
    return;
  }

  const event: HistoryDivergenceEvent = {
    type: 'history_divergence',
    session_id: command.session_id,
    expected_count: expectedCount,
    expected_tail_seq: expectedTailSeq,
    reason,
  };
  logger.info('daemon', 'history_divergence', {
    sessionId: command.session_id,
    reason,
    expectedCount,
    expectedTailSeq,
    phoneCount: command.count,
    phoneTail: command.tail_seq,
  });
  ctx.sendToPhone(event as unknown as PcEvent);
}
