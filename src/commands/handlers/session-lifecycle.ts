// Agent Pocket — session-lifecycle command handlers
//
// Handlers that create, resume, kill, interrupt, or rewind a session.
// Extracted from AgentPocketDaemon as part of Step 1.4c.
//
// Codex-specific deps live on a separate `CodexLifecycleDeps` object so the
// generic CommandContext stays free of Codex-only state.

import type {
  PcEvent,
  NewSessionCommand,
  ResumeSessionCommand,
  KillSessionCommand,
  InterruptSessionCommand,
  RewindSessionCommand,
} from 'agent-pocket-protocol';
import { SessionStatus } from 'agent-pocket-protocol';
import type { CommandContext } from '../command-context.js';
import type { SessionConfig } from '../../sessions/session-manager.js';
import { isCodexSessionId } from '../../discovery/codex-discovery.js';
import { cleanSessionMap } from '../../utils/session-map.js';
import { logger } from '../../logger.js';

/**
 * Codex-specific dependencies a few lifecycle handlers need. Pulled out of
 * CommandContext so non-Codex handlers don't have to mock these.
 */
export interface CodexLifecycleDeps {
  /** Tracked codex observers keyed by codex session id. */
  codexObservers: Map<string, { status: SessionStatus; observer: { stop(): void } }>;
  /** Resolve the tmux/term target for a codex session, if attached. */
  resolveCodexTerminalTarget(sessionId: string): { target?: unknown } | undefined;
  /** Send an interrupt (Ctrl-C) to the terminal target. */
  sendTerminalInterrupt(target: unknown): void;
}

// ---------------------------------------------------------------------------
// new_session
// ---------------------------------------------------------------------------

export function handleNewSession(
  ctx: Pick<CommandContext, 'sessionManager' | 'pendingSessionRequests' | 'sendError'>,
  command: NewSessionCommand,
): void {
  try {
    if (command.config.agent_type !== 'claude_code') {
      throw new Error(`agent_type '${command.config.agent_type}' is not yet supported by the controller`);
    }
    const sessionConfig: SessionConfig = {
      name: command.config.name,
      agent_type: command.config.agent_type,
      working_directory: command.config.working_directory,
      model: command.config.model,
      system_prompt: command.config.system_prompt,
      allowed_tools: command.config.allowed_tools,
      dangerously_skip_permissions: command.config.dangerously_skip_permissions,
    };

    const sessionId = ctx.sessionManager.createSession(sessionConfig);
    ctx.pendingSessionRequests.set(command.request_id, sessionId);
  } catch (err) {
    ctx.sendError(
      command.request_id,
      `Failed to create session: ${(err as Error).message}`,
      'SESSION_CREATE_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// resume_session
// ---------------------------------------------------------------------------

export function handleResumeSession(
  ctx: Pick<CommandContext, 'sessionManager' | 'sessionIdMap' | 'pendingSessionRequests' | 'sendError'>,
  command: ResumeSessionCommand,
): void {
  try {
    // If an observer already exists for this Claude session ID, stop and remove
    // it to prevent duplicate message emission when switching from observe to
    // SDK control.
    const existing = ctx.sessionManager.findByClaudeSessionId(command.session_id);
    if (existing) {
      logger.debug('daemon', `Stopping existing observer ${existing.sessionId} before resuming session ${command.session_id}`);
      ctx.sessionManager.markObservedSessionHistory(existing.sessionId);
      cleanSessionMap([existing.terminalPid ?? -1]);
    }

    const sessionId = ctx.sessionManager.resumeSession(command.session_id, {});
    ctx.sessionIdMap.set(sessionId, command.session_id);
    ctx.pendingSessionRequests.set(command.request_id, sessionId);
  } catch (err) {
    ctx.sendError(
      command.request_id,
      `Failed to resume session: ${(err as Error).message}`,
      'SESSION_RESUME_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// kill_session
// ---------------------------------------------------------------------------

export async function handleKillSession(
  ctx: Pick<CommandContext, 'sessionManager' | 'resolveInternalSessionId' | 'sendToPhone' | 'sendError'>,
  codex: Pick<CodexLifecycleDeps, 'codexObservers'>,
  command: KillSessionCommand,
): Promise<void> {
  if (isCodexSessionId(command.session_id)) {
    const observed = codex.codexObservers.get(command.session_id);
    if (observed) {
      observed.observer.stop();
      observed.status = SessionStatus.HISTORY;
      ctx.sendToPhone({
        type: 'session_status',
        session_id: command.session_id,
        status: SessionStatus.HISTORY,
      } as unknown as PcEvent);
    }
    return;
  }
  try {
    const internalId = ctx.resolveInternalSessionId(command.session_id) ?? command.session_id;
    await ctx.sessionManager.killSession(internalId);
  } catch (err) {
    ctx.sendError(
      undefined,
      `Failed to kill session ${command.session_id}: ${(err as Error).message}`,
      'KILL_SESSION_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// interrupt_session
// ---------------------------------------------------------------------------

export async function handleInterruptSession(
  ctx: Pick<CommandContext, 'sessionManager' | 'resolveInternalSessionId' | 'sendError'>,
  codex: CodexLifecycleDeps,
  command: InterruptSessionCommand,
): Promise<void> {
  if (isCodexSessionId(command.session_id)) {
    const target = codex.resolveCodexTerminalTarget(command.session_id)?.target;
    if (!target) {
      ctx.sendError(
        undefined,
        'Codex interrupt is not available until a terminal target is attached for this Codex session.',
        'CODEX_TERMINAL_NOT_ATTACHED',
      );
      return;
    }
    try {
      codex.sendTerminalInterrupt(target);
      logger.debug('daemon', `Interrupted Codex session ${command.session_id}`);
    } catch (err) {
      ctx.sendError(
        undefined,
        `Failed to interrupt Codex session ${command.session_id}: ${(err as Error).message}`,
        'INTERRUPT_SESSION_ERROR',
      );
    }
    return;
  }
  try {
    const internalId = ctx.resolveInternalSessionId(command.session_id) ?? command.session_id;
    await ctx.sessionManager.interruptSession(internalId);
    logger.debug('daemon', `Interrupted session ${command.session_id}`);
  } catch (err) {
    ctx.sendError(
      undefined,
      `Failed to interrupt session ${command.session_id}: ${(err as Error).message}`,
      'INTERRUPT_SESSION_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// rewind_session
// ---------------------------------------------------------------------------

export async function handleRewindSession(
  ctx: Pick<
    CommandContext,
    'sessionManager' | 'resolveInternalSessionId' | 'resolveExternalSessionId' | 'sendToPhone' | 'sendError'
  >,
  command: RewindSessionCommand,
): Promise<void> {
  if (isCodexSessionId(command.session_id)) {
    ctx.sendError(command.request_id, 'rewind_session is not supported for Codex sessions', 'NOT_SUPPORTED');
    return;
  }
  const dryRun = command.dry_run ?? false;
  try {
    const internalId = ctx.resolveInternalSessionId(command.session_id) ?? command.session_id;
    const result = await ctx.sessionManager.rewindSession(internalId, command.user_message_id, dryRun);
    const externalNewId = result.newSessionId
      ? ctx.resolveExternalSessionId(result.newSessionId)
      : undefined;
    ctx.sendToPhone({
      type: 'rewind_session_response',
      request_id: command.request_id,
      session_id: command.session_id,
      can_rewind: result.canRewind,
      dry_run: dryRun,
      error: result.error,
      files_changed: result.filesChanged,
      insertions: result.insertions,
      deletions: result.deletions,
      new_session_id: externalNewId,
    } as unknown as PcEvent);
  } catch (err) {
    const message = (err as Error).message;
    logger.warn('daemon', 'rewind_session failed', {
      sessionId: command.session_id,
      userMessageId: command.user_message_id,
      dryRun,
      error: message,
    });
    // Reply on the rewind_session_response channel rather than the generic
    // error channel so the phone's pending resolver fires instead of timing
    // out. The phone surfaces `error` directly to the user.
    ctx.sendToPhone({
      type: 'rewind_session_response',
      request_id: command.request_id,
      session_id: command.session_id,
      can_rewind: false,
      dry_run: dryRun,
      error: message,
    } as unknown as PcEvent);
  }
}
