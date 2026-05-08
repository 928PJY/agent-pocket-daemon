// Agent Pocket — codex + permission_expired hook-server handlers
//
// Step 1.6a-ii of the wireHookServerEvents extraction. These five handlers
// share the codex session-tracking state (codexObservers Map, the stop-hook
// deduper) and the blocking-request bookkeeping that permission_expired
// drives. They go in one module so the deps interface only declares each
// piece of daemon state once.
//
// Each register* function attaches a single .on() listener to the
// HookGateway (narrowed HookServer surface) and is otherwise pure: all
// state lives on `deps`. messageSeq is exposed via a {peek, getAndIncrement}
// accessor because it's a primitive that needs read-then-write inside a
// single event — passing the number itself would lose the mutation.

import * as path from 'node:path';
import type {
  HookServer,
  HookPermissionExpired,
  CodexHookRequest,
} from '../hooks/hook-server.js';
import type { SessionManager } from '../sessions/session-manager.js';
import type { CodexSession } from '../discovery/codex-discovery.js';
import type { CodexStopHookDeduper } from '../codex/codex-handler.js';
import type {
  PcEvent,
  PermissionRequestEvent,
  SessionStartedEvent,
  WakeBlobPayload,
} from 'agent-pocket-protocol';
import {
  RISK_CLASSIFICATION,
  RiskLevel,
  HOOK_HOLD_TIMEOUT_SECONDS,
  SessionStatus,
} from 'agent-pocket-protocol';
import type { NotificationDeliveryEventType } from '../relay/phone-transport.js';
import { logger } from '../logger.js';
import { truncateUtf8 } from '../utils/truncate-utf8.js';

/** Narrowed HookServer surface used by these registrars. */
export type HookGateway = Pick<HookServer, 'on'>;

/** Codex observer record as tracked by the daemon. */
export interface CodexObserverEntry {
  session: CodexSession;
  status: SessionStatus;
  lastActivity: number;
}

/** Snapshot of the daemon's blocking-request bookkeeping. */
export interface PendingBlockingEntry {
  sessionId: string;
  type: 'permission_request' | 'user_question' | 'plan_review';
  expiredSystemMessageSent?: boolean;
}

/**
 * Read-then-increment accessor for the daemon's signed-message counter.
 * peek() returns the current value (used inside the signed payload so the
 * receiver sees the same seq as the wrapping event); getAndIncrement()
 * returns it and bumps so the next event gets the next number.
 */
export interface MessageSeqRef {
  peek(): number;
  getAndIncrement(): number;
}

/** Minimal CryptoEngine surface — just the sign call. */
export interface CryptoSigner {
  sign(message: string): string;
}

// ---------------------------------------------------------------------------
// permission_expired
// ---------------------------------------------------------------------------

export interface PermissionExpiredDeps {
  sessionManager: Pick<SessionManager, 'findByClaudeSessionId'>;
  resolveExternalSessionId(internalId: string): string;
  resolveCodexExternalSessionId(claudeSessionId: string): string | undefined;
  sendToPhone(event: PcEvent): void;
  /**
   * Live reference to the daemon's pending-blocking-request map. The handler
   * mutates this directly so the rest of the daemon (retry loop, list_sessions
   * overlay) sees the deletion immediately.
   */
  pendingBlockingRequests: Map<string, PendingBlockingEntry>;
  sendExpiredPendingSystemMessage(
    sessionId: string,
    requestId: string,
    toolName: string,
    actionType: 'permission_request' | 'user_question' | 'plan_review',
    entry?: PendingBlockingEntry,
  ): void;
  clearNotificationDelivery(eventType: string, sessionId: string, requestId: string): void;
}

export function registerPermissionExpiredHandler(
  hooks: HookGateway,
  deps: PermissionExpiredDeps,
): void {
  hooks.on('permission_expired', (expired: HookPermissionExpired) => {
    const session = deps.sessionManager.findByClaudeSessionId(expired.sessionId);
    const codexExternalId = deps.resolveCodexExternalSessionId(expired.sessionId);
    const externalId = codexExternalId
      ? codexExternalId
      : session
      ? deps.resolveExternalSessionId(session.sessionId)
      : expired.sessionId;

    const event = {
      type: 'permission_expired',
      session_id: externalId,
      request_id: expired.toolUseId,
      tool_name: expired.toolName,
    };

    deps.sendToPhone(event as unknown as PcEvent);

    // Timeout transfers the request back to the terminal. Keep the expired
    // banner in chat, but stop treating it as an app-blocking action so a
    // later permission can surface normally.
    const blocking = deps.pendingBlockingRequests.get(expired.toolUseId);
    if (blocking) {
      deps.sendExpiredPendingSystemMessage(externalId, expired.toolUseId, expired.toolName, blocking.type, blocking);
      deps.pendingBlockingRequests.delete(expired.toolUseId);
      deps.clearNotificationDelivery(blocking.type, externalId, expired.toolUseId);
    } else {
      deps.sendExpiredPendingSystemMessage(externalId, expired.toolUseId, expired.toolName, 'permission_request');
      deps.clearNotificationDelivery('permission_request', externalId, expired.toolUseId);
    }
    const hasOtherBlocking = Array.from(deps.pendingBlockingRequests.values()).some(
      entry => entry.sessionId === externalId,
    );
    if (!hasOtherBlocking) {
      deps.sendToPhone({
        type: 'session_status',
        session_id: externalId,
        status: SessionStatus.READY,
      } as unknown as PcEvent);
    }
    logger.debug('daemon', `Permission expired for ${expired.toolName} (${expired.toolUseId})`);
  });
}

// ---------------------------------------------------------------------------
// Shared codex deps
// ---------------------------------------------------------------------------

export interface CodexHandlerDeps {
  /** Live reference to the codexObservers Map; handlers mutate status/lastActivity in place. */
  codexObservers: Map<string, CodexObserverEntry>;
  recordCodexHookActivity(request: CodexHookRequest): string;
  sendToPhone(event: PcEvent): void;
}

// ---------------------------------------------------------------------------
// codex_session_start
// ---------------------------------------------------------------------------

export interface CodexSessionStartDeps extends CodexHandlerDeps {
  /**
   * Read live: the daemon flips this once after the initial discovery sweep.
   * We must not emit session_started events during the warm-up phase because
   * the phone is doing list_sessions instead.
   */
  isInitialDiscoveryDone(): boolean;
  getCodexCapabilities(sessionId: string): string[];
}

export function registerCodexSessionStartHandler(
  hooks: HookGateway,
  deps: CodexSessionStartDeps,
): void {
  hooks.on('codex_session_start', (request: CodexHookRequest) => {
    const sessionId = deps.recordCodexHookActivity(request);
    const tracked = deps.codexObservers.get(sessionId);
    if (tracked) {
      tracked.status = SessionStatus.READY;
      tracked.lastActivity = Date.now();
    }
    if (deps.isInitialDiscoveryDone()) {
      const cwd = request.cwd || tracked?.session.cwd || '';
      const event: SessionStartedEvent = {
        type: 'session_started',
        session_id: sessionId,
        request_id: sessionId,
        working_directory: cwd,
        project_name: tracked?.session.title ?? (cwd ? path.basename(cwd) : 'Codex'),
        agent_type: 'codex',
        agent_display_name: 'Codex',
        agent_version: tracked?.session.cliVersion,
        capabilities: deps.getCodexCapabilities(sessionId),
      };
      deps.sendToPhone(event);
    }
    logger.info('daemon', 'Codex SessionStart hook', { sessionId, source: request.source, pid: request.codexPid });
  });
}

// ---------------------------------------------------------------------------
// codex_user_prompt_submit
// ---------------------------------------------------------------------------

export function registerCodexUserPromptSubmitHandler(
  hooks: HookGateway,
  deps: CodexHandlerDeps,
): void {
  hooks.on('codex_user_prompt_submit', (request: CodexHookRequest) => {
    const sessionId = deps.recordCodexHookActivity(request);
    const tracked = deps.codexObservers.get(sessionId);
    if (tracked) {
      tracked.status = SessionStatus.RUNNING;
      tracked.lastActivity = Date.now();
    }
    deps.sendToPhone({
      type: 'session_status',
      session_id: sessionId,
      status: SessionStatus.RUNNING,
    } as unknown as PcEvent);
  });
}

// ---------------------------------------------------------------------------
// codex_stop
// ---------------------------------------------------------------------------

export interface CodexStopDeps extends CodexHandlerDeps {
  codexStopHookDeduper: Pick<CodexStopHookDeduper, 'record'>;
  sendCodexCompletion(sessionId: string, session?: CodexSession, summary?: string): void;
}

export function registerCodexStopHandler(
  hooks: HookGateway,
  deps: CodexStopDeps,
): void {
  hooks.on('codex_stop', (request: CodexHookRequest) => {
    const sessionId = deps.recordCodexHookActivity(request);
    const tracked = deps.codexObservers.get(sessionId);
    if (tracked) {
      tracked.status = SessionStatus.READY;
      tracked.lastActivity = Date.now();
    }
    deps.codexStopHookDeduper.record(sessionId);
    deps.sendCodexCompletion(sessionId, tracked?.session);
  });
}

// ---------------------------------------------------------------------------
// codex_permission_request
// ---------------------------------------------------------------------------

export interface CodexPermissionRequestDeps {
  recordCodexHookActivity(request: CodexHookRequest): string;
  cryptoEngine: CryptoSigner;
  messageSeq: MessageSeqRef;
  buildPermissionContext(toolName: string, toolInput: Record<string, unknown>): string;
  getSessionName(sessionId: string): string;
  sendNotificationEventToPhone(
    event: PcEvent,
    eventType: NotificationDeliveryEventType,
    sessionId: string,
    requestId: string,
    wakePayload: WakeBlobPayload,
  ): void;
  trackBlockingRequest(
    requestId: string,
    sessionId: string,
    event: PcEvent,
    type: 'permission_request' | 'user_question' | 'plan_review',
  ): void;
}

export function registerCodexPermissionRequestHandler(
  hooks: HookGateway,
  deps: CodexPermissionRequestDeps,
): void {
  hooks.on('codex_permission_request', (request: CodexHookRequest) => {
    const sessionId = deps.recordCodexHookActivity(request);
    const requestId = request.toolUseId ?? `codex_hook_${Date.now()}`;
    const toolName = request.toolName ?? 'unknown';
    const toolInput = request.toolInput ?? {};
    const riskLevel = (RISK_CLASSIFICATION[toolName] ?? RiskLevel.MEDIUM).toLowerCase();
    const context = deps.buildPermissionContext(toolName, toolInput);

    let pcSignature: string;
    try {
      pcSignature = deps.cryptoEngine.sign(JSON.stringify({
        session_id: sessionId,
        request_id: requestId,
        tool_name: toolName,
        seq: deps.messageSeq.peek(),
        timestamp: Date.now(),
      }));
    } catch {
      pcSignature = '';
    }

    const event: PermissionRequestEvent = {
      type: 'permission_request',
      session_id: sessionId,
      request_id: requestId,
      tool_name: toolName,
      tool_input: toolInput,
      risk_level: riskLevel as unknown as RiskLevel,
      context,
      pc_signature: pcSignature,
      seq: deps.messageSeq.getAndIncrement(),
      timestamp: new Date().toISOString() as unknown as number,
      ttl: HOOK_HOLD_TIMEOUT_SECONDS,
      // Codex PermissionRequest hook payloads do not expose always-allow suggestions yet.
      has_always_allow: false,
    };

    deps.sendNotificationEventToPhone(event, 'permission_request', sessionId, requestId, {
      type: 'permission_request',
      session_name: deps.getSessionName(sessionId),
      body: truncateUtf8(`${toolName}: ${context}`, 256),
      sound: 'default',
      category: 'PERMISSION_REQUEST',
      session_id: sessionId,
      request_id: requestId,
    });
    deps.trackBlockingRequest(requestId, sessionId, event, 'permission_request');
    logger.debug('daemon', 'Forwarded Codex PermissionRequest', { tool: toolName, requestId, sessionId });
  });
}
