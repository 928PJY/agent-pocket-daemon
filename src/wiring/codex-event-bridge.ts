// Agent Pocket — codex event bridge (Step 1.11)
//
// Extracted from attachCodexObserverHandlers + sendCodexCompletion +
// nextCompletionRequestId in src/index.ts. The three are tightly coupled:
//
//   attachCodexObserverHandlers — wires `on(...)` callbacks on a CodexObserver,
//   forwarding output / status_change / completed / error to the phone via the
//   notification bookkeeping layer.
//
//   sendCodexCompletion — produces the session_completed notification payload
//   when a codex turn finishes (either via observer.completed or the codex
//   stop hook).
//
//   createCompletionRequestIdGenerator — closure factory for the rolling
//   completion-request-id counter (was previously a private field +
//   nextCompletionRequestId method).
//
// The three are exposed as a single createCodexEventBridge factory so the
// observer-handler closure can read live counter state without callers
// having to thread the counter through every call.

import * as path from 'node:path';
import {
  PEER_CAPABILITIES,
  SessionStatus,
  type ClaudeEvent,
  type PcEvent,
  type WakeBlobPayload,
} from 'agent-pocket-protocol';
import type { CodexObserver } from '../observers/codex-observer.js';
import type { CodexSession } from '../discovery/codex-discovery.js';
import type { CodexStopHookDeduper } from '../codex/codex-handler.js';
import type { NotificationDeliveryEventType } from '../relay/phone-transport.js';
import { truncateUtf8 } from '../utils/truncate-utf8.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// nextCompletionRequestId — closure factory
// ---------------------------------------------------------------------------

export function createCompletionRequestIdGenerator(): (sessionId: string, timestamp?: number) => string {
  let counter = 0;
  return (sessionId: string, timestamp: number = Date.now()) => {
    counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
    return `completion_${sessionId}_${timestamp}_${counter}`;
  };
}

// ---------------------------------------------------------------------------
// sendCodexCompletion
// ---------------------------------------------------------------------------

export interface SendCodexCompletionDeps {
  isInitialDiscoveryDone(): boolean;
  getLastAssistantMessage(sessionId: string): string | undefined;
  nextCompletionRequestId(sessionId: string, timestamp?: number): string;
  getSessionName(sessionId: string): string;
  sendNotificationEventToPhone(
    event: PcEvent,
    eventType: NotificationDeliveryEventType,
    sessionId: string,
    requestId: string,
    wakePayload: WakeBlobPayload,
  ): void;
  hasPeerCapability(name: string): boolean;
  /** See SessionStopDeps.getSeqTail — same contract. */
  getSeqTail(sessionId: string): number | undefined;
}

export function sendCodexCompletion(
  deps: SendCodexCompletionDeps,
  sessionId: string,
  session?: CodexSession,
  summary?: string,
): void {
  if (!deps.isInitialDiscoveryDone()) return;
  const body = summary?.trim() || deps.getLastAssistantMessage(sessionId) || 'Codex turn finished';
  const completionRequestId = deps.nextCompletionRequestId(sessionId);
  const firedAt = Date.now();
  deps.sendNotificationEventToPhone({
    type: 'session_status',
    session_id: sessionId,
    status: SessionStatus.READY,
    is_completion: true,
    completion_request_id: completionRequestId,
    completion_body: body,
  } as unknown as PcEvent, 'session_completed', sessionId, completionRequestId, {
    type: 'session_completed',
    session_name: session?.title ?? (session?.cwd ? path.basename(session.cwd) : deps.getSessionName(sessionId)),
    body: truncateUtf8(body, 256),
    sound: 'completion.caf',
    category: 'SESSION_COMPLETED',
    session_id: sessionId,
    request_id: completionRequestId,
    ...(deps.hasPeerCapability(PEER_CAPABILITIES.MESSAGES_COMPLETION_BARRIER)
      ? { completion_seq: deps.getSeqTail(sessionId), completion_ms: firedAt }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// attachCodexObserverHandlers
// ---------------------------------------------------------------------------

export interface CodexObserverTracked {
  observer: CodexObserver;
  session: CodexSession;
  status: SessionStatus;
  lastActivity: number;
}

export interface AttachCodexObserverHandlersDeps {
  isInitialDiscoveryDone(): boolean;
  codexStopHookDeduper: Pick<CodexStopHookDeduper, 'consume'>;
  sendFlattenedSessionOutput(sessionId: string, agentEvent: ClaudeEvent, agentType: 'codex'): void;
  sendToPhone(event: PcEvent, wake?: boolean, wakePayload?: WakeBlobPayload): void;
  sendCodexCompletion(sessionId: string, session: CodexSession, summary?: string): void;
  nowFn?: () => number;
}

export function attachCodexObserverHandlers(
  deps: AttachCodexObserverHandlersDeps,
  tracked: CodexObserverTracked,
): void {
  const now = deps.nowFn ?? (() => Date.now());
  const { observer, session } = tracked;

  observer.on('output', (codexEvent: ClaudeEvent) => {
    tracked.lastActivity = now();
    deps.sendFlattenedSessionOutput(session.sessionId, codexEvent, 'codex');
  });

  observer.on('status_change', (status: 'running' | 'ready') => {
    const newStatus = status as SessionStatus;
    tracked.lastActivity = now();
    if (tracked.status === newStatus) return;
    tracked.status = newStatus;
    if (!deps.isInitialDiscoveryDone()) return;
    deps.sendToPhone({
      type: 'session_status',
      session_id: session.sessionId,
      status: tracked.status,
    } as unknown as PcEvent);
  });

  observer.on('completed', (summary?: string) => {
    tracked.status = SessionStatus.READY;
    tracked.lastActivity = now();
    if (!deps.isInitialDiscoveryDone()) return;
    if (deps.codexStopHookDeduper.consume(session.sessionId)) return;
    deps.sendCodexCompletion(session.sessionId, session, summary);
  });

  observer.on('error', (err: Error) => {
    tracked.status = SessionStatus.ERROR;
    tracked.lastActivity = now();
    logger.warn('codex-observer', `Observer error: ${err.message}`, { sessionId: session.sessionId });
    if (!deps.isInitialDiscoveryDone()) return;
    deps.sendToPhone({
      type: 'session_status',
      session_id: session.sessionId,
      status: SessionStatus.ERROR,
    } as unknown as PcEvent, true, {
      type: 'session_error',
      session_name: session.title ?? path.basename(session.cwd),
      body: truncateUtf8(err.message || 'Codex turn failed', 256),
      sound: 'default',
      category: 'SESSION_ERROR',
      session_id: session.sessionId,
    });
  });
}
