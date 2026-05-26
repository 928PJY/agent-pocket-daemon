// Agent Pocket — SessionManager event handlers (Step 1.6b)
//
// Extracted from wireSessionManagerEvents in src/index.ts. Each register*
// function attaches a single SessionManager listener and is otherwise pure:
// all state lives on `deps`. Live references (Maps, the prefs object, the
// initialDiscoveryDone getter) keep the handlers in sync with the daemon's
// runtime state.

import * as path from 'node:path';
import type { SessionManager } from '../sessions/session-manager.js';
import type {
  PcEvent,
  SessionStartedEvent,
  SessionEndedEvent,
  PermissionRequestEvent,
  ErrorEvent,
  ClaudeEvent,
  AgentType,
} from 'agent-pocket-protocol';
import {
  RISK_CLASSIFICATION,
  RiskLevel,
  PermissionDecision,
  SessionStatus,
} from 'agent-pocket-protocol';
import type { NotificationDeliveryEventType } from '../relay/phone-transport.js';
import { logger } from '../logger.js';
import { truncateUtf8 } from '../utils/truncate-utf8.js';
import type { CryptoSigner, MessageSeqRef, PendingBlockingEntry } from './hook-handlers-codex.js';

/** Narrowed SessionManager surface used by these registrars. */
export type SessionManagerGateway = Pick<SessionManager, 'on'>;

// Controller-mode permission events do not auto-expire on the daemon side
// (the SDK canUseTool promise blocks until the phone responds or the session
// is aborted). Use ttl=0 as a sentinel meaning "never expires" — iOS hides
// the countdown UI and never marks the card as expired.
const CONTROLLER_PERMISSION_TTL_SECONDS = 0;

// ---------------------------------------------------------------------------
// session_started
// ---------------------------------------------------------------------------

export interface SessionStartedDeps {
  sessionManager: Pick<SessionManager, 'getSession'>;
  resolveExternalSessionId(internalId: string): string;
  findRequestIdForSession(sessionId: string): string | undefined;
  /** Read live: claude version is detected during init, can be undefined early. */
  getClaudeAgentVersion(): string | undefined;
  isInitialDiscoveryDone(): boolean;
  sendToPhone(event: PcEvent): void;
}

export function registerSessionStartedHandler(
  sm: SessionManagerGateway,
  deps: SessionStartedDeps,
): void {
  sm.on('session_started', (sessionId: string, workingDirectory: string, customTitle?: string) => {
    if (!deps.isInitialDiscoveryDone()) return;

    const requestId = deps.findRequestIdForSession(sessionId);
    const externalId = deps.resolveExternalSessionId(sessionId);
    const state = deps.sessionManager.getSession(sessionId);

    const event: SessionStartedEvent = {
      type: 'session_started',
      session_id: externalId,
      request_id: requestId ?? externalId,
      working_directory: workingDirectory,
      project_name: customTitle ?? path.basename(workingDirectory),
      agent_type: 'claude_code',
      agent_display_name: 'Claude Code',
      agent_version: deps.getClaudeAgentVersion(),
      capabilities: ['observe', 'terminal_remote_message', 'terminal_interrupt', 'permissions', 'plan_review', 'user_question'],
      is_observed: state?.isObserved ?? true,
      ...(state && !state.isObserved
        ? {
            permission_mode: state.permissionMode ?? 'default',
            dangerously_skip_permissions: state.config?.dangerously_skip_permissions === true,
          }
        : {}),
    };

    deps.sendToPhone(event);
  });
}

// ---------------------------------------------------------------------------
// permission_mode_changed
// ---------------------------------------------------------------------------

export interface PermissionModeChangedDeps {
  resolveExternalSessionId(internalId: string): string;
  sendToPhone(event: PcEvent): void;
}

export function registerPermissionModeChangedHandler(
  sm: SessionManagerGateway,
  deps: PermissionModeChangedDeps,
): void {
  sm.on('permission_mode_changed', (sessionId: string, mode) => {
    const externalId = deps.resolveExternalSessionId(sessionId);
    deps.sendToPhone({
      type: 'session_permission_mode_changed',
      session_id: externalId,
      mode,
    } as unknown as PcEvent);
  });
}

// ---------------------------------------------------------------------------
// session_output
// ---------------------------------------------------------------------------

export interface SessionOutputDeps {
  resolveExternalSessionId(internalId: string): string;
  sendToPhone(event: PcEvent): void;
  sendFlattenedSessionOutput(sessionId: string, agentEvent: ClaudeEvent, agentType: AgentType): void;
  /** Read live so a `set_preferences` toggle takes effect on the next event. */
  prefs: { showToolUse: boolean };
}

export function registerSessionOutputHandler(
  sm: SessionManagerGateway,
  deps: SessionOutputDeps,
): void {
  sm.on('session_output', (sessionId: string, claudeEvent: ClaudeEvent) => {
    // Skip tool_use/tool_result when the phone has disabled tool use messages.
    // For tool_use, send an empty is_complete=true assistant_message so the
    // currently streaming bubble is finalized and the next text starts a new one.
    if (!deps.prefs.showToolUse &&
        (claudeEvent.type === 'tool_use' || claudeEvent.type === 'tool_result')) {
      if (claudeEvent.type === 'tool_use') {
        const externalId = deps.resolveExternalSessionId(sessionId);
        deps.sendToPhone({
          type: 'session_output',
          session_id: externalId,
          timestamp: Date.now(),
          output_type: 'assistant_message',
          content: '',
          is_complete: true,
        } as unknown as PcEvent);
      }
      return;
    }

    deps.sendFlattenedSessionOutput(deps.resolveExternalSessionId(sessionId), claudeEvent, 'claude_code');
  });
}

// ---------------------------------------------------------------------------
// session_ended
// ---------------------------------------------------------------------------

export interface SessionEndedDeps {
  resolveExternalSessionId(internalId: string): string;
  getSessionName(sessionId: string): string;
  sendToPhone(event: PcEvent): void;
  sendNotificationEventToPhone(
    event: PcEvent,
    eventType: NotificationDeliveryEventType,
    sessionId: string,
    requestId: string,
    wakePayload: Record<string, unknown>,
  ): void;
  sessionIdMap: Map<string, string>;
  pendingBlockingRequests: Map<string, PendingBlockingEntry>;
  clearNotificationDeliveriesForSession(sessionId: string): void;
}

export function registerSessionEndedHandler(
  sm: SessionManagerGateway,
  deps: SessionEndedDeps,
): void {
  sm.on('session_ended', (sessionId: string, exitCode: number) => {
    const externalId = deps.resolveExternalSessionId(sessionId);
    const errorRequestId = exitCode !== 0 ? `session_error_${externalId}_${Date.now()}` : undefined;
    const event: SessionEndedEvent = {
      type: 'session_ended',
      session_id: externalId,
      exit_code: exitCode,
      end_reason: exitCode === 0 ? 'completed' : 'error',
      ...(errorRequestId ? { request_id: errorRequestId } : {}),
    };

    if (exitCode !== 0) {
      const sessionName = deps.getSessionName(externalId);
      deps.sendNotificationEventToPhone(event, 'session_error', externalId, errorRequestId!, {
        type: 'session_error',
        session_name: sessionName,
        body: `Session exited with code ${exitCode}`,
        subtitle: sessionName,
        sound: 'default',
        category: 'SESSION_ERROR',
        session_id: externalId,
        request_id: errorRequestId,
      });
    } else {
      deps.sendToPhone(event);
    }

    deps.sessionIdMap.delete(sessionId);

    for (const [reqId, entry] of deps.pendingBlockingRequests) {
      if (entry.sessionId === externalId) {
        deps.pendingBlockingRequests.delete(reqId);
      }
    }
    if (exitCode === 0) {
      deps.clearNotificationDeliveriesForSession(externalId);
    }
  });
}

// ---------------------------------------------------------------------------
// permission_request
// ---------------------------------------------------------------------------

export interface PermissionRequestDeps {
  sessionManager: Pick<SessionManager, 'getSession' | 'respondPermission'>;
  resolveExternalSessionId(internalId: string): string;
  isPlanModeTool(toolName: string, toolInput: Record<string, unknown>): boolean;
  sendPlanForReview(
    sessionId: string,
    requestId: string,
    toolInput: Record<string, unknown>,
    cwd: string,
  ): void;
  buildPermissionContext(toolName: string, toolInput: Record<string, unknown>): string;
  getSessionName(sessionId: string): string;
  cryptoEngine: CryptoSigner;
  messageSeq: MessageSeqRef;
  sendToPhone(event: PcEvent): void;
  sendNotificationEventToPhone(
    event: PcEvent,
    eventType: NotificationDeliveryEventType,
    sessionId: string,
    requestId: string,
    wakePayload: Record<string, unknown>,
  ): void;
  trackBlockingRequest(
    requestId: string,
    sessionId: string,
    event: PcEvent,
    type: 'permission_request' | 'user_question' | 'plan_review',
  ): void;
}

export function registerPermissionRequestHandler(
  sm: SessionManagerGateway,
  deps: PermissionRequestDeps,
): void {
  sm.on(
    'permission_request',
    (sessionId: string, requestId: string, toolName: string, toolInput: Record<string, unknown>) => {
      const externalId = deps.resolveExternalSessionId(sessionId);

      if (toolName === 'AskUserQuestion') {
        const questions = (toolInput.questions as Array<{ question?: string }>) ?? [];
        const questionPreview = questions[0]?.question ?? 'Claude has a question';
        const flat: Record<string, unknown> = {
          type: 'session_output',
          session_id: externalId,
          output_type: 'user_question',
          request_id: requestId,
          tool_input: toolInput,
          timestamp: new Date().toISOString(),
          ttl: CONTROLLER_PERMISSION_TTL_SECONDS,
        };
        deps.sendNotificationEventToPhone(flat as unknown as PcEvent, 'user_question', externalId, requestId, {
          type: 'user_question',
          session_name: deps.getSessionName(externalId),
          body: truncateUtf8(questionPreview, 256),
          sound: 'default',
          category: 'USER_QUESTION',
          session_id: externalId,
          request_id: requestId,
        });
        deps.trackBlockingRequest(requestId, externalId, flat as unknown as PcEvent, 'user_question');
        logger.debug('daemon', `Forwarded SDK AskUserQuestion as user_question for session ${externalId}`);
        return;
      }

      if (deps.isPlanModeTool(toolName, toolInput)) {
        if (toolName === 'ExitPlanMode') {
          const session = deps.sessionManager.getSession(sessionId);
          const cwd = session?.workingDirectory ?? '';
          deps.sendPlanForReview(externalId, requestId, toolInput, cwd);
          logger.debug('daemon', `SDK ExitPlanMode: sent plan to phone for review (${requestId})`);
          return;
        }
        deps.sessionManager.respondPermission(sessionId, requestId, PermissionDecision.APPROVE);
        logger.debug('daemon', `SDK auto-approved plan mode tool: ${toolName} (${requestId})`);
        return;
      }

      const riskLevel = (RISK_CLASSIFICATION[toolName] ?? RiskLevel.MEDIUM).toLowerCase();
      const context = deps.buildPermissionContext(toolName, toolInput);

      const signaturePayload = JSON.stringify({
        session_id: sessionId,
        request_id: requestId,
        tool_name: toolName,
        seq: deps.messageSeq.peek(),
        timestamp: Date.now(),
      });

      let pcSignature: string;
      try {
        pcSignature = deps.cryptoEngine.sign(signaturePayload);
      } catch {
        pcSignature = '';
      }

      const event: PermissionRequestEvent = {
        type: 'permission_request',
        session_id: externalId,
        request_id: requestId,
        tool_name: toolName,
        tool_input: toolInput,
        risk_level: riskLevel as unknown as RiskLevel,
        context,
        pc_signature: pcSignature,
        seq: deps.messageSeq.getAndIncrement(),
        timestamp: new Date().toISOString() as unknown as number,
        ttl: CONTROLLER_PERMISSION_TTL_SECONDS,
      };

      deps.sendToPhone(event);
      deps.trackBlockingRequest(requestId, externalId, event, 'permission_request');
    },
  );
}

// ---------------------------------------------------------------------------
// error
// ---------------------------------------------------------------------------

export interface SessionErrorDeps {
  sendToPhone(event: PcEvent): void;
}

export function registerSessionErrorHandler(
  sm: SessionManagerGateway,
  deps: SessionErrorDeps,
): void {
  sm.on('error', (sessionId: string, error: Error) => {
    const event: ErrorEvent = {
      type: 'error',
      message: `Session ${sessionId}: ${error.message}`,
      code: 'SESSION_ERROR',
    };
    deps.sendToPhone(event);
  });
}

// ---------------------------------------------------------------------------
// session_status
// ---------------------------------------------------------------------------

export interface SessionStatusDeps {
  sessionManager: Pick<SessionManager, 'getAllSessions' | 'clearPendingActions'>;
  resolveExternalSessionId(internalId: string): string;
  isInitialDiscoveryDone(): boolean;
  pendingBlockingRequests: Map<string, PendingBlockingEntry>;
  sendToPhone(event: PcEvent): void;
}

export function registerSessionStatusHandler(
  sm: SessionManagerGateway,
  deps: SessionStatusDeps,
): void {
  // Per-session dedupe of the last (effectiveStatus, actionType) tuple we
  // shipped to the phone. The Stop hook + observer cascade can produce
  // several identical READY/RUNNING transitions in one CLI turn (each
  // local_command_invoke/output entry toggles status). Without dedupe the
  // wire stream carries multiple running/ready pairs per turn, which makes
  // the phone-side SessionInfo flip visibly. We only dedupe the plain
  // status stream — completion frames (which carry is_completion=true)
  // never come through this handler; they go through sendNotificationEventToPhone
  // directly from the Stop hook with their own completion_request_id.
  const lastSent = new Map<string, { status: SessionStatus; actionType?: string }>();
  sm.on('session_status', (sessionId: string, status: SessionStatus) => {
    if (!deps.isInitialDiscoveryDone()) return;

    const externalId = deps.resolveExternalSessionId(sessionId);

    if (status === SessionStatus.RUNNING || status === SessionStatus.READY) {
      const syntheticId = `startup_pending_${externalId}`;
      if (deps.pendingBlockingRequests.has(syntheticId)) {
        deps.pendingBlockingRequests.delete(syntheticId);
        const session = deps.sessionManager.getAllSessions().find(
          s => deps.resolveExternalSessionId(s.sessionId) === externalId
            || s.claudeSessionId === externalId,
        );
        if (session) {
          deps.sessionManager.clearPendingActions(session.sessionId);
        }
        logger.debug('daemon', `Cleaned up startup synthetic pending for session ${externalId.slice(0, 8)} (observer=${status})`);
      }
    }

    const hasPending = Array.from(deps.pendingBlockingRequests.values()).some(
      e => e.sessionId === externalId,
    );
    const effectiveStatus = hasPending ? SessionStatus.PENDING_ACTIONS : status;

    logger.debug('daemon', `session_status: observer=${status} effective=${effectiveStatus}`, { sessionId: externalId, hasPending, pendingCount: deps.pendingBlockingRequests.size });

    const event: Record<string, unknown> = {
      type: 'session_status',
      session_id: externalId,
      status: effectiveStatus,
    };

    if (hasPending) {
      const pendingEntry = Array.from(deps.pendingBlockingRequests.values()).find(
        e => e.sessionId === externalId,
      );
      if (pendingEntry) {
        event.action_type = pendingEntry.type;
      }
    }

    const prev = lastSent.get(externalId);
    const currActionType = event.action_type as string | undefined;
    if (prev && prev.status === effectiveStatus && prev.actionType === currActionType) {
      logger.debug('daemon', 'session_status dedupe', { sessionId: externalId, status: effectiveStatus });
      return;
    }
    lastSent.set(externalId, { status: effectiveStatus, actionType: currActionType });

    deps.sendToPhone(event as unknown as PcEvent);
  });

  sm.on('session_ended', (sessionId: string) => {
    const externalId = deps.resolveExternalSessionId(sessionId);
    lastSent.delete(externalId);
  });
}

// ---------------------------------------------------------------------------
// pending_action_detected (untyped event)
// ---------------------------------------------------------------------------

export interface PendingActionDetectedDeps {
  resolveExternalSessionId(internalId: string): string;
  pendingBlockingRequests: Map<string, PendingBlockingEntry>;
}

export function registerPendingActionDetectedHandler(
  sm: SessionManagerGateway,
  deps: PendingActionDetectedDeps,
): void {
  // Untyped event — emitted via this.emit('pending_action_detected', ...).
  (sm as unknown as { on(e: string, cb: (...args: unknown[]) => void): void }).on(
    'pending_action_detected',
    (...args: unknown[]) => {
      const sessionId = args[0] as string;
      const toolName = args[1] as string | undefined;
      const externalId = deps.resolveExternalSessionId(sessionId);
      const syntheticId = `startup_pending_${externalId}`;

      let actionType: 'permission_request' | 'user_question' | 'plan_review' = 'permission_request';
      if (toolName === 'AskUserQuestion') actionType = 'user_question';
      else if (toolName === 'ExitPlanMode') actionType = 'plan_review';

      const entry: PendingBlockingEntry & {
        requestId: string;
        event: PcEvent;
        sentAt: number;
        toolName?: string;
        expiredToTerminal: boolean;
      } = {
        requestId: syntheticId,
        sessionId: externalId,
        event: { type: 'session_status', session_id: externalId, status: SessionStatus.PENDING_ACTIONS } as unknown as PcEvent,
        sentAt: Date.now(),
        type: actionType,
        toolName,
        expiredToTerminal: true,
      };
      deps.pendingBlockingRequests.set(syntheticId, entry);
      logger.info('daemon', `Startup pending action detected for session ${externalId.slice(0, 8)}, tool=${toolName}`);
    },
  );
}

// ---------------------------------------------------------------------------
// session_title (untyped event)
// ---------------------------------------------------------------------------

export interface SessionTitleDeps {
  resolveExternalSessionId(internalId: string): string;
  sendToPhone(event: PcEvent): void;
}

export function registerSessionTitleHandler(
  sm: SessionManagerGateway,
  deps: SessionTitleDeps,
): void {
  (sm as unknown as { on(e: string, cb: (...args: unknown[]) => void): void }).on(
    'session_title',
    (...args: unknown[]) => {
      const sessionId = args[0] as string;
      const title = args[1] as string;
      const externalId = deps.resolveExternalSessionId(sessionId);
      deps.sendToPhone({
        type: 'session_title',
        session_id: externalId,
        title,
      } as unknown as PcEvent);
    },
  );
}

// ---------------------------------------------------------------------------
// session_interrupted
// ---------------------------------------------------------------------------

export interface SessionInterruptedDeps {
  sessionManager: Pick<SessionManager, 'getAllSessions' | 'clearPendingActions'>;
  resolveExternalSessionId(internalId: string): string;
  pendingBlockingRequests: Map<string, PendingBlockingEntry>;
  sendToPhone(event: PcEvent): void;
  sendFlattenedSessionOutput(sessionId: string, agentEvent: ClaudeEvent, agentType: AgentType): void;
}

export function registerSessionInterruptedHandler(
  sm: SessionManagerGateway,
  deps: SessionInterruptedDeps,
): void {
  sm.on('session_interrupted', (sessionId: string, reason: 'streaming' | 'tool_use', source: 'sdk' | 'observer') => {
    const externalId = deps.resolveExternalSessionId(sessionId);
    const session = deps.sessionManager.getAllSessions().find(s => s.sessionId === sessionId);

    logger.info('daemon', `session_interrupted (${reason}, ${source}) for ${externalId.slice(0, 8)}`);

    for (const [reqId, entry] of deps.pendingBlockingRequests) {
      if (entry.sessionId === externalId) {
        deps.pendingBlockingRequests.delete(reqId);
        const ev = entry as unknown as { event?: { tool_name?: string } };
        const toolName = ev.event?.tool_name ?? '';
        deps.sendToPhone({
          type: 'permission_dismissed',
          request_id: reqId,
          tool_name: toolName,
          session_id: externalId,
          cancelled: true,
        } as unknown as PcEvent);
      }
    }
    if (session) {
      deps.sessionManager.clearPendingActions(session.sessionId);
    }

    if (source === 'sdk') {
      deps.sendFlattenedSessionOutput(externalId, {
        type: 'system_message',
        message: 'Session interrupted by user',
      } as unknown as ClaudeEvent, 'claude_code');
    }

    deps.sendToPhone({
      type: 'session_status',
      session_id: externalId,
      status: SessionStatus.READY,
    } as unknown as PcEvent);
  });
}
