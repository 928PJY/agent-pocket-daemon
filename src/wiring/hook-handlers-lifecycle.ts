// Agent Pocket — claude session-lifecycle hook handlers
//
// Step 1.6a-iii: the remaining six handlers from wireHookServerEvents +
// wirePermissionPromptEvents:
//
//   - session_stop          (async — reads end-of-turn summary)
//   - session_stop_failure  (turn ended via API error)
//   - session_end           (/clear: tear down old session)
//   - session_start         (/clear: stand up new session)
//   - permission_dismissed  (terminal won the race)
//   - permission_prompt     (Claude's own permission system asks for approval)
//
// These all share the same set of daemon-state mutations (the four maps
// pendingClearInfo / sessionIdMap / replacedSessionIds / pendingBlockingRequests
// plus phonePreferences and messageSeq) so they live in one module.

import * as path from 'node:path';
import type {
  HookServer,
  HookPermissionPrompt,
} from '../hooks/hook-server.js';
import type { SessionManager } from '../sessions/session-manager.js';
import type { TerminalTarget } from '../pty/tmux-injector.js';
import type {
  PcEvent,
  PermissionRequestEvent,
  SessionEndedEvent,
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
import { formatCompletionSubtitle } from '../utils/completion-subtitle.js';
import { readLastTurnSummary } from '../utils/transcript-reader.js';
import { readSessionMap } from '../utils/session-map.js';
import { PREFETCH_CWD } from '../sessions/observer-commands.js';
import type { CryptoSigner, MessageSeqRef, PendingBlockingEntry } from './hook-handlers-codex.js';

/** Narrowed HookServer surface used by these registrars. */
export type HookGateway = Pick<HookServer, 'on'>;

/** Stored terminal info between SessionEnd and SessionStart during /clear. */
export interface PendingClearInfo {
  pid: number;
  cwd: string;
  target: TerminalTarget | undefined;
  entrypoint?: string;
}

// ---------------------------------------------------------------------------
// session_stop (async — reads transcript, fires session_completed notification)
// ---------------------------------------------------------------------------

export interface SessionStopDeps {
  sessionManager: Pick<
    SessionManager,
    'findByClaudeSessionId' | 'clearPendingActions'
  >;
  resolveExternalSessionId(internalId: string): string;
  /** Live reference to the daemon's pending-blocking-request map. */
  pendingBlockingRequests: Map<string, PendingBlockingEntry>;
  /**
   * Live reference to the set of Claude session ids the daemon spun up
   * internally as SDK-prefetch sessions. Stop hooks for these must be
   * suppressed — otherwise phone gets a noop session_completed
   * notification with no chat content behind it.
   */
  prefetchClaudeSessionIds: Set<string>;
  clearNotificationDelivery(eventType: string, sessionId: string, requestId: string): void;
  nextCompletionRequestId(sessionId: string, timestamp: number): string;
  sendNotificationEventToPhone(
    event: PcEvent,
    eventType: NotificationDeliveryEventType,
    sessionId: string,
    requestId: string,
    wakePayload: WakeBlobPayload,
  ): void;
  sendToPhone(event: PcEvent): void;
  /** Read live so a `set_preferences` toggle takes effect on the next stop. */
  prefs: { showCompletionMetrics: boolean };
  /** Test seam: defaults to setTimeout. */
  setTimeoutFn?: typeof setTimeout;
  /** Test seam: defaults to readLastTurnSummary from utils. */
  readLastTurnSummaryFn?: typeof readLastTurnSummary;
}

export function registerSessionStopHandler(
  hooks: HookGateway,
  deps: SessionStopDeps,
): void {
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const readSummaryFn = deps.readLastTurnSummaryFn ?? readLastTurnSummary;
  hooks.on('session_stop', async (claudeSessionId: string, transcriptPath?: string) => {
    // Daemon's own SDK-prefetch session (used to fetch supportedCommands once
    // at startup) reuses the real Claude SDK and therefore fires real Stop
    // hooks. Suppress before any logging or downstream emit — phone would
    // otherwise surface a noop notification with no chat content behind it.
    if (deps.prefetchClaudeSessionIds.has(claudeSessionId)) {
      deps.prefetchClaudeSessionIds.delete(claudeSessionId);
      logger.debug('daemon', 'Suppressing Stop hook for SDK-prefetch session', {
        claudeSessionId: claudeSessionId?.substring(0, 8),
      });
      return;
    }

    const firedAt = Date.now();
    const session = deps.sessionManager.findByClaudeSessionId(claudeSessionId);
    const externalId = session
      ? deps.resolveExternalSessionId(session.sessionId)
      : claudeSessionId;

    const projectName = session?.customTitle ?? (session ? path.basename(session.workingDirectory) : 'Session');

    logger.info('daemon', 'Stop hook fired', {
      sessionId: externalId,
      claudeSessionId: claudeSessionId?.substring(0, 8),
      internalSessionId: session?.sessionId,
      hasTranscriptPath: !!transcriptPath,
      firedAt,
    });

    // Claude finished this turn — any pending blocking requests we were still
    // tracking for this session are stale (resolved, expired, or interrupted).
    let cleared = 0;
    for (const [reqId, entry] of deps.pendingBlockingRequests) {
      if (entry.sessionId === externalId) {
        deps.pendingBlockingRequests.delete(reqId);
        deps.clearNotificationDelivery(entry.type, entry.sessionId, reqId);
        cleared++;
      }
    }
    if (cleared > 0) {
      logger.info('daemon', `Stop hook cleared ${cleared} stale pending blocking request(s)`, { sessionId: externalId });
    }
    if (session) {
      deps.sessionManager.clearPendingActions(session.sessionId);
    }

    const event: Record<string, unknown> = {
      type: 'session_status',
      session_id: externalId,
      status: 'ready',
    };

    let completionBody = '';
    let subtitle: string | undefined;
    if (transcriptPath) {
      try {
        const summary = await readSummaryFn(transcriptPath);
        if (summary) {
          completionBody = summary.text;
          subtitle = formatCompletionSubtitle(summary);
          logger.debug('daemon', 'readLastTurnSummary ok', {
            sessionId: externalId,
            textLen: summary.text.length,
            tokens: summary.totalTokens,
            tools: summary.toolUseCount,
            durSec: summary.durationSec,
          });
        } else {
          logger.warn('daemon', 'readLastTurnSummary returned null', {
            sessionId: externalId,
            transcriptPath,
            firedAt,
          });
        }
      } catch (err) {
        logger.warn('daemon', 'readLastTurnSummary threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logger.warn('daemon', 'Stop hook has no transcriptPath', { sessionId: externalId });
    }

    const completionRequestId = deps.nextCompletionRequestId(externalId, firedAt);
    event.is_completion = true;
    event.completion_request_id = completionRequestId;
    event.completion_body = completionBody;
    if (subtitle) event.completion_subtitle = subtitle;

    deps.sendNotificationEventToPhone(event as unknown as PcEvent, 'session_completed', externalId, completionRequestId, {
      type: 'session_completed',
      session_name: projectName,
      body: truncateUtf8(completionBody.trim() || 'Session finished', 256),
      subtitle,
      sound: 'completion.caf',
      category: 'SESSION_COMPLETED',
      session_id: externalId,
      request_id: completionRequestId,
    });

    // Delay the chat-side metrics chip slightly so the SDK-stream path has
    // time to flush the final assistant_message first; otherwise the chip
    // appears above the message it's summarising.
    if (subtitle && deps.prefs.showCompletionMetrics) {
      setTimeoutFn(() => {
        deps.sendToPhone({
          type: 'session_output',
          session_id: externalId,
          output_type: 'completion_metrics',
          content: subtitle,
          timestamp: Date.now(),
        } as unknown as PcEvent);
      }, 500);
    }
  });
}

// ---------------------------------------------------------------------------
// session_stop_failure
// ---------------------------------------------------------------------------

export interface SessionStopFailureDeps {
  sessionManager: Pick<SessionManager, 'findByClaudeSessionId' | 'clearPendingActions'>;
  resolveExternalSessionId(internalId: string): string;
  pendingBlockingRequests: Map<string, PendingBlockingEntry>;
  sendToPhone(event: PcEvent): void;
}

export function registerSessionStopFailureHandler(
  hooks: HookGateway,
  deps: SessionStopFailureDeps,
): void {
  hooks.on('session_stop_failure', (claudeSessionId: string, error: string) => {
    const session = deps.sessionManager.findByClaudeSessionId(claudeSessionId);
    const externalId = session
      ? deps.resolveExternalSessionId(session.sessionId)
      : claudeSessionId;

    logger.warn('daemon', 'StopFailure hook', { sessionId: externalId, error });

    let cleared = 0;
    for (const [reqId, entry] of deps.pendingBlockingRequests) {
      if (entry.sessionId === externalId) {
        deps.pendingBlockingRequests.delete(reqId);
        cleared++;
      }
    }
    if (cleared > 0) {
      logger.info('daemon', `StopFailure cleared ${cleared} stale pending blocking request(s)`, { sessionId: externalId });
    }
    if (session) {
      deps.sessionManager.clearPendingActions(session.sessionId);
    }

    deps.sendToPhone({
      type: 'session_status',
      session_id: externalId,
      status: SessionStatus.READY,
    } as unknown as PcEvent);
  });
}

// ---------------------------------------------------------------------------
// session_end (only acts on /clear)
// ---------------------------------------------------------------------------

export interface SessionEndDeps {
  sessionManager: Pick<
    SessionManager,
    'findByClaudeSessionId' | 'markObservedSessionHistory' | 'removeSession'
  >;
  resolveExternalSessionId(internalId: string): string;
  /** Live reference: receives the terminal info that SessionStart will read. */
  pendingClearInfo: Map<string, PendingClearInfo>;
  sessionIdMap: Map<string, string>;
  replacedSessionIds: Set<string>;
  sendToPhone(event: PcEvent): void;
  /** Test seam: defaults to setTimeout. */
  setTimeoutFn?: typeof setTimeout;
}

export function registerSessionEndHandler(
  hooks: HookGateway,
  deps: SessionEndDeps,
): void {
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  hooks.on('session_end', (claudeSessionId: string, reason: string, cwd: string) => {
    logger.info('daemon', 'SessionEnd hook', { claudeSessionId, reason });

    if (reason !== 'clear') return;

    const session = deps.sessionManager.findByClaudeSessionId(claudeSessionId);
    if (!session) {
      logger.debug('daemon', `SessionEnd(clear): session ${claudeSessionId} not found, ignoring`);
      return;
    }

    const oldInternalId = session.sessionId;
    const externalId = deps.resolveExternalSessionId(oldInternalId);

    if (session.terminalPid) {
      deps.pendingClearInfo.set(cwd, {
        pid: session.terminalPid,
        cwd: session.workingDirectory,
        target: session.terminalTarget,
        entrypoint: session.entrypoint,
      });
      // Auto-clean after 30s in case SessionStart never arrives
      setTimeoutFn(() => deps.pendingClearInfo.delete(cwd), 30_000);
    }

    const endEvent: SessionEndedEvent = {
      type: 'session_ended',
      session_id: externalId,
      exit_code: 0,
      end_reason: 'completed',
    };
    deps.sendToPhone(endEvent);

    deps.sessionManager.markObservedSessionHistory(oldInternalId);
    deps.sessionIdMap.delete(oldInternalId);
    deps.sessionManager.removeSession(oldInternalId);
    deps.replacedSessionIds.add(claudeSessionId);

    logger.debug('daemon', `SessionEnd(clear): ended old session ${externalId}, awaiting SessionStart`);
  });
}

// ---------------------------------------------------------------------------
// session_start (only acts on /clear)
// ---------------------------------------------------------------------------

export interface SessionStartDeps {
  sessionManager: Pick<
    SessionManager,
    'findByClaudeSessionId' | 'findByTerminalPid' | 'observeSession' | 'markObservedSessionHistory' | 'removeSession'
  >;
  resolveExternalSessionId(internalId: string): string;
  pendingClearInfo: Map<string, PendingClearInfo>;
  sessionIdMap: Map<string, string>;
  replacedSessionIds: Set<string>;
  /** Shared with SessionStopDeps. Populated when SessionStart hook fires for
   *  the daemon's own SDK-prefetch cwd; consumed by Stop hook to suppress. */
  prefetchClaudeSessionIds: Set<string>;
  sendToPhone(event: PcEvent): void;
  /** Read live so the discovery warm-up phase still suppresses replays. */
  isInitialDiscoveryDone(): boolean;
  sendSessionHistory(claudeSessionId: string): number | undefined;
  /** Test seam: defaults to readSessionMap. */
  readSessionMapFn?: typeof readSessionMap;
}

export function registerSessionStartHandler(
  hooks: HookGateway,
  deps: SessionStartDeps,
): void {
  const readSessionMapFn = deps.readSessionMapFn ?? readSessionMap;
  hooks.on('session_start', (claudeSessionId: string, source: string, cwd: string, transcriptPath: string) => {
    if (cwd === PREFETCH_CWD) {
      deps.prefetchClaudeSessionIds.add(claudeSessionId);
      logger.debug('daemon', 'Tagged SDK-prefetch session for Stop suppression', {
        claudeSessionId: claudeSessionId?.substring(0, 8),
      });
      return;
    }

    logger.info('daemon', 'SessionStart hook', { claudeSessionId, source });

    if (source !== 'clear') return;

    if (deps.sessionManager.findByClaudeSessionId(claudeSessionId)) return;

    let clearInfo = deps.pendingClearInfo.get(cwd);
    if (clearInfo) {
      deps.pendingClearInfo.delete(cwd);
    } else {
      // SessionEnd may not have fired yet, or daemon restarted. Use
      // session-map.json to find the PID, then look up terminal info from
      // the currently observed session for that PID.
      const mapped = readSessionMapFn();
      const mapEntry = mapped[claudeSessionId];
      if (mapEntry?.pid) {
        const existing = deps.sessionManager.findByTerminalPid(mapEntry.pid);
        if (existing) {
          clearInfo = {
            pid: mapEntry.pid,
            cwd: existing.workingDirectory,
            target: existing.terminalTarget,
            entrypoint: existing.entrypoint,
          };
          const oldInternalId = existing.sessionId;
          const oldClaudeId = existing.claudeSessionId;
          const externalId = deps.resolveExternalSessionId(oldInternalId);
          const endEvent: SessionEndedEvent = {
            type: 'session_ended',
            session_id: externalId,
            exit_code: 0,
            end_reason: 'completed',
          };
          deps.sendToPhone(endEvent);
          deps.sessionManager.markObservedSessionHistory(oldInternalId);
          deps.sessionIdMap.delete(oldInternalId);
          deps.sessionManager.removeSession(oldInternalId);
          if (oldClaudeId) deps.replacedSessionIds.add(oldClaudeId);
          logger.info('daemon', 'SessionStart(clear): replaced old session via session-map PID', { oldClaudeId, newClaudeId: claudeSessionId, pid: mapEntry.pid });
        }
      }
    }

    if (!clearInfo) {
      logger.debug('daemon', `SessionStart(clear): no pending clear info for cwd=${cwd}, will be picked up by polling`);
      return;
    }

    const jsonlPath = transcriptPath || path.join(path.dirname(cwd), `${claudeSessionId}.jsonl`);

    const newInternalId = deps.sessionManager.observeSession(
      claudeSessionId,
      jsonlPath,
      clearInfo.cwd,
      clearInfo.pid,
      undefined,
      clearInfo.target,
      clearInfo.entrypoint,
    );
    deps.sessionIdMap.set(newInternalId, claudeSessionId);

    if (deps.isInitialDiscoveryDone()) {
      deps.sendSessionHistory(claudeSessionId);
    }

    logger.debug('daemon', `SessionStart(clear): now observing ${claudeSessionId} (PID ${clearInfo.pid})`);
  });
}

// ---------------------------------------------------------------------------
// permission_dismissed
// ---------------------------------------------------------------------------

export interface PermissionDismissedDeps {
  sessionManager: Pick<SessionManager, 'findByClaudeSessionId'>;
  resolveExternalSessionId(internalId: string): string;
  untrackBlockingRequest(requestId: string): void;
  sendToPhone(event: PcEvent): void;
}

export function registerPermissionDismissedHandler(
  hooks: HookGateway,
  deps: PermissionDismissedDeps,
): void {
  hooks.on('permission_dismissed', (toolUseId: string, toolName: string, claudeSessionId: string, toolResponse?: unknown) => {
    logger.trace('daemon', 'permission_dismissed event', { toolName, toolUseId });
    deps.untrackBlockingRequest(toolUseId);

    const session = deps.sessionManager.findByClaudeSessionId(claudeSessionId);
    const externalId = session
      ? deps.resolveExternalSessionId(session.sessionId)
      : claudeSessionId;

    const event: Record<string, unknown> = {
      type: 'permission_dismissed',
      request_id: toolUseId,
      tool_name: toolName,
      session_id: externalId,
    };
    if (toolName === 'AskUserQuestion' && toolResponse) {
      const resp = toolResponse as Record<string, unknown>;
      event.answers = resp.answers ?? resp;
    }
    deps.sendToPhone(event as unknown as PcEvent);
    logger.debug('daemon', `Sent permission_dismissed for ${toolName} (${toolUseId})`);
  });
}

// ---------------------------------------------------------------------------
// permission_prompt (Claude's permission system asks for user approval)
// ---------------------------------------------------------------------------

export interface PermissionPromptDeps {
  sessionManager: Pick<SessionManager, 'findByClaudeSessionId'>;
  resolveExternalSessionId(internalId: string): string;
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

export function registerPermissionPromptHandler(
  hooks: HookGateway,
  deps: PermissionPromptDeps,
): void {
  hooks.on('permission_prompt', (request: HookPermissionPrompt) => {
    const session = deps.sessionManager.findByClaudeSessionId(request.sessionId);
    const externalId = session
      ? deps.resolveExternalSessionId(session.sessionId)
      : request.sessionId;

    // ExitPlanMode: send plan to phone for review (sendPlanForReview tracks
    // its own blocking request so the reconnect replay carries the plan body).
    if (request.toolName === 'ExitPlanMode') {
      deps.sendPlanForReview(externalId, request.toolUseId, request.toolInput, request.cwd);
      logger.debug('daemon', `ExitPlanMode PermissionRequest: sent plan to phone for review (${request.toolUseId})`);
      return;
    }

    // AskUserQuestion: forward as interactive question to the phone. The
    // terminal also shows the question (PreToolUse passed through).
    // Whichever answers first wins the race.
    if (request.toolName === 'AskUserQuestion') {
      const hookQuestions = (request.toolInput.questions as Array<{ question?: string }>) ?? [];
      const hookQuestionPreview = hookQuestions[0]?.question ?? 'Claude has a question';
      const flat: Record<string, unknown> = {
        type: 'session_output',
        session_id: externalId,
        output_type: 'user_question',
        request_id: request.toolUseId,
        tool_input: request.toolInput,
        timestamp: new Date().toISOString(),
        ttl: HOOK_HOLD_TIMEOUT_SECONDS,
      };
      deps.sendNotificationEventToPhone(flat as unknown as PcEvent, 'user_question', externalId, request.toolUseId, {
        type: 'user_question',
        session_name: deps.getSessionName(externalId),
        body: truncateUtf8(hookQuestionPreview, 256),
        sound: 'default',
        category: 'USER_QUESTION',
        session_id: externalId,
        request_id: request.toolUseId,
      });
      deps.trackBlockingRequest(request.toolUseId, externalId, flat as unknown as PcEvent, 'user_question');
      logger.debug('daemon', `AskUserQuestion PermissionRequest: forwarded to phone (${request.toolUseId})`);
      return;
    }

    // All other tools: Claude decided this needs user approval. Forward to phone.
    const riskLevel = (RISK_CLASSIFICATION[request.toolName] ?? RiskLevel.MEDIUM).toLowerCase();
    const context = deps.buildPermissionContext(request.toolName, request.toolInput);

    const signaturePayload = JSON.stringify({
      session_id: externalId,
      request_id: request.toolUseId,
      tool_name: request.toolName,
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
      request_id: request.toolUseId,
      tool_name: request.toolName,
      tool_input: request.toolInput,
      risk_level: riskLevel as unknown as RiskLevel,
      context,
      pc_signature: pcSignature,
      seq: deps.messageSeq.getAndIncrement(),
      timestamp: new Date().toISOString() as unknown as number,
      ttl: HOOK_HOLD_TIMEOUT_SECONDS,
      has_always_allow: Array.isArray(request.permissionSuggestions) && request.permissionSuggestions.length > 0,
    };

    deps.sendNotificationEventToPhone(event, 'permission_request', externalId, request.toolUseId, {
      type: 'permission_request',
      session_name: deps.getSessionName(externalId),
      body: truncateUtf8(`${request.toolName}: ${context}`, 256),
      sound: 'default',
      category: 'PERMISSION_REQUEST',
      session_id: externalId,
      request_id: request.toolUseId,
    });
    deps.trackBlockingRequest(request.toolUseId, externalId, event, 'permission_request');
    logger.debug('daemon', 'Forwarded PermissionRequest', { tool: request.toolName, toolUseId: request.toolUseId, sessionId: request.sessionId });
  });
}
