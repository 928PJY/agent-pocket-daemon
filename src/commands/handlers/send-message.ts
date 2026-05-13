// Agent Pocket — send_message command handler
//
// The send_message handler has three branches:
//
//   1. Codex remote injection: forward the message to the right tmux pane,
//      tracking the in-flight injection so we can dedupe the matching user
//      message that surfaces in the rollout transcript a moment later.
//   2. SDK tracked session: forward to SessionManager.sendMessage, which
//      streams the assistant reply back through the existing event pipe.
//   3. Discovered-but-untracked session: spin up an observer (so we can
//      stream output) and inject the message via tmux.
//
// All three branches emit `message_ack` events so the phone can correlate
// the optimistic UI state with the eventual delivery state.

import type {
  PcEvent,
  SendMessageCommand,
  MessageAckEvent,
} from 'agent-pocket-protocol';
import { SessionStatus } from 'agent-pocket-protocol';
import type { CommandContext } from '../command-context.js';
import {
  isCodexSessionId,
} from '../../discovery/codex-discovery.js';
import {
  incrementInjectedMessageCount,
  consumeInjectedMessage,
} from '../../codex/codex-handler.js';
import type { TerminalTarget } from '../../pty/tmux-injector.js';
import type { RunningCliSession, DiscoveredSession } from '../../discovery/session-discovery.js';
import { logger } from '../../logger.js';

/**
 * Status the codex tmux pane reports for a session — the handler refuses to
 * inject a new message while the pane is still working a turn.
 */
export interface CodexObserverStatus {
  status: SessionStatus;
}

export interface SendMessageDeps {
  // ── Codex injection ────────────────────────────────────────────────────
  /** Resolve the tmux/term target for a codex session, if attached. */
  resolveCodexTerminalTarget(sessionId: string): { target?: TerminalTarget } | undefined;
  /** Tracked codex observers keyed by codex session id. */
  codexObservers: Map<string, CodexObserverStatus>;
  /** message-string -> in-flight injection count, keyed by codex session id. */
  codexInjectedMessages: Map<string, Map<string, number>>;
  /** Send a string of bytes to the codex tmux pane. */
  sendTerminalMessage(target: TerminalTarget, message: string): void;

  // ── Discovery + observe-and-inject path ───────────────────────────────
  /** Snapshot of running CLI sessions (used to find a PID for an untracked session). */
  getRunningCliSessions(): RunningCliSession[];
  /** Re-scan disk for sessions (used to find the JSONL file for an untracked session). */
  discoverSessions(): Promise<DiscoveredSession[]>;
  /**
   * Internal -> external session-id map. Set by the handler after it spins up
   * an observer for a previously-untracked session.
   */
  sessionIdMap: Map<string, string>;
}

// ---------------------------------------------------------------------------
// message_ack helper
// ---------------------------------------------------------------------------

function sendMessageAck(
  ctx: Pick<CommandContext, 'sendToPhone'>,
  clientMessageId: string,
  sessionId: string,
  status: 'received' | 'committed' | 'failed',
  error?: string,
  sdkUuid?: string,
): void {
  const ack: MessageAckEvent = {
    type: 'message_ack',
    client_message_id: clientMessageId,
    session_id: sessionId,
    status,
    ts: Date.now(),
    ...(error ? { error } : {}),
    ...(sdkUuid ? { sdk_uuid: sdkUuid } : {}),
  };
  logger.debug('daemon', 'message_ack send', {
    cid: clientMessageId.substring(0, 8),
    sessionId: sessionId.substring(0, 8),
    status,
    sdkUuid,
  });
  ctx.sendToPhone(ack as unknown as PcEvent);
}

// ---------------------------------------------------------------------------
// observer-mode sdk_uuid backfill
// ---------------------------------------------------------------------------

// In observer mode, sendMessage returns synchronously without an sdkUuid —
// the JSONL echo is what carries the row's uuid, and SessionManager fires a
// `phone_origin_committed` event when the echo arrives. Wait once for that
// event (matched by cid), then emit a second message_ack(committed) carrying
// the sdk_uuid so iOS can backfill its phone-origin row's stable id.
// iOS handleMessageAck is idempotent for committed, and only backfills
// sdkUuid the first time it sees one — so this second ack is safe.
//
// Falls back silently if the event never fires (Claude refused the input,
// terminal hung, etc). The optimistic in-memory row remains without a stable
// sdk_uuid, which means cold-start may still show a duplicate for that one
// message. Acceptable; the alternative is hanging the original ack.
function attachPhoneOriginBackfill(
  ctx: Pick<CommandContext, 'sessionManager' | 'sendToPhone'>,
  clientMessageId: string,
  publicSessionId: string,
  internalSessionId: string,
): void {
  const TIMEOUT_MS = 30_000;
  const onCommitted = (sid: string, cid: string, sdkUuid: string): void => {
    if (sid !== internalSessionId || cid !== clientMessageId) return;
    cleanup();
    sendMessageAck(ctx, clientMessageId, publicSessionId, 'committed', undefined, sdkUuid);
  };
  const cleanup = (): void => {
    ctx.sessionManager.off('phone_origin_committed', onCommitted);
    clearTimeout(timer);
  };
  const timer = setTimeout(() => {
    ctx.sessionManager.off('phone_origin_committed', onCommitted);
    logger.debug('daemon', 'phone_origin_committed timeout', {
      cid: clientMessageId.substring(0, 8),
      sessionId: publicSessionId.substring(0, 8),
    });
  }, TIMEOUT_MS);
  timer.unref();
  ctx.sessionManager.on('phone_origin_committed', onCommitted);
}

// ---------------------------------------------------------------------------
// send_message
// ---------------------------------------------------------------------------

export async function handleSendMessage(
  ctx: Pick<
    CommandContext,
    'sessionManager' | 'resolveInternalSessionId' | 'sendSessionHistory' | 'sendToPhone' | 'sendError'
  >,
  deps: SendMessageDeps,
  command: SendMessageCommand,
): Promise<void> {
  const clientMessageId = command.client_message_id;
  const cidShort = clientMessageId ? clientMessageId.substring(0, 8) : 'none';
  const sidShort = command.session_id.substring(0, 8);
  logger.debug('daemon', 'send_message received', {
    cid: cidShort,
    sessionId: sidShort,
    len: command.message.length,
  });

  if (clientMessageId) {
    sendMessageAck(ctx, clientMessageId, command.session_id, 'received');
  }

  if (isCodexSessionId(command.session_id)) {
    await sendCodexMessage(ctx, deps, command, clientMessageId, cidShort, sidShort);
    return;
  }

  try {
    const internalId = ctx.resolveInternalSessionId(command.session_id);
    if (internalId) {
      if (clientMessageId) {
        attachPhoneOriginBackfill(ctx, clientMessageId, command.session_id, internalId);
      }
      const result = await ctx.sessionManager.sendMessage(internalId, command.message, clientMessageId);
      if (clientMessageId) {
        sendMessageAck(ctx, clientMessageId, command.session_id, 'committed', undefined, result.sdkUuid);
      }
      logger.debug('daemon', 'send_message committed (tracked)', { cid: cidShort, sessionId: sidShort, sdkUuid: result.sdkUuid });
      return;
    }

    // Session not tracked — it's a discovered session from disk. Try to
    // observe it and inject the message via tmux.
    logger.debug('daemon', `Session ${command.session_id} not tracked, attempting to observe and inject`);

    const runningCli = deps.getRunningCliSessions();
    const pidInfo = runningCli.find((s) => s.sessionId === command.session_id);
    if (!pidInfo) {
      const msg = `Session ${command.session_id} has no running terminal. Please restart Claude in the terminal.`;
      if (clientMessageId) sendMessageAck(ctx, clientMessageId, command.session_id, 'failed', msg);
      ctx.sendError(undefined, msg, 'SESSION_NOT_RUNNING');
      return;
    }

    const discovered = await deps.discoverSessions();
    const match = discovered.find((s) => s.sessionId === command.session_id);
    if (!match) {
      const msg = `Cannot find session file for ${command.session_id}`;
      if (clientMessageId) sendMessageAck(ctx, clientMessageId, command.session_id, 'failed', msg);
      ctx.sendError(undefined, msg, 'SESSION_FILE_NOT_FOUND');
      return;
    }

    const sessionId = ctx.sessionManager.observeSession(
      pidInfo.sessionId,
      match.filePath,
      pidInfo.cwd,
      pidInfo.pid,
      match.customTitle,
      pidInfo.terminalTarget,
      pidInfo.entrypoint,
    );
    deps.sessionIdMap.set(sessionId, pidInfo.sessionId);

    ctx.sendSessionHistory(command.session_id);

    if (clientMessageId) {
      attachPhoneOriginBackfill(ctx, clientMessageId, command.session_id, sessionId);
    }
    const result = await ctx.sessionManager.sendMessage(sessionId, command.message, clientMessageId);
    if (clientMessageId) {
      sendMessageAck(ctx, clientMessageId, command.session_id, 'committed', undefined, result.sdkUuid);
    }
    logger.debug('daemon', 'send_message committed (observed)', { cid: cidShort, sessionId: sidShort });
  } catch (err) {
    const msg = (err as Error).message;
    if (clientMessageId) sendMessageAck(ctx, clientMessageId, command.session_id, 'failed', msg);
    logger.error('daemon', 'send_message failed', { cid: cidShort, sessionId: sidShort, error: msg });
    ctx.sendError(
      undefined,
      `Failed to send message to session ${command.session_id}: ${msg}`,
      'SEND_MESSAGE_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// codex branch
// ---------------------------------------------------------------------------

async function sendCodexMessage(
  ctx: Pick<CommandContext, 'sendToPhone' | 'sendError'>,
  deps: SendMessageDeps,
  command: SendMessageCommand,
  clientMessageId: string | undefined,
  cidShort: string,
  sidShort: string,
): Promise<void> {
  const target = deps.resolveCodexTerminalTarget(command.session_id)?.target;
  if (!target) {
    const msg = 'Codex remote message is not available until a terminal target is attached for this Codex session.';
    if (clientMessageId) sendMessageAck(ctx, clientMessageId, command.session_id, 'failed', msg);
    ctx.sendError(undefined, msg, 'CODEX_TERMINAL_NOT_ATTACHED');
    return;
  }
  const observed = deps.codexObservers.get(command.session_id);
  if (observed?.status === SessionStatus.RUNNING || observed?.status === SessionStatus.PENDING_ACTIONS) {
    const msg = 'Codex session is busy. Wait until the current turn is ready before sending a new message.';
    if (clientMessageId) sendMessageAck(ctx, clientMessageId, command.session_id, 'failed', msg);
    ctx.sendError(undefined, msg, 'SESSION_NOT_READY');
    return;
  }
  try {
    let injected = deps.codexInjectedMessages.get(command.session_id);
    if (!injected) {
      injected = new Map<string, number>();
      deps.codexInjectedMessages.set(command.session_id, injected);
    }
    incrementInjectedMessageCount(injected, command.message);
    deps.sendTerminalMessage(target, command.message);
    if (clientMessageId) sendMessageAck(ctx, clientMessageId, command.session_id, 'committed');
    logger.debug('daemon', 'send_message committed (codex terminal)', { cid: cidShort, sessionId: sidShort });
  } catch (err) {
    consumeInjectedMessage(deps.codexInjectedMessages.get(command.session_id), command.message);
    const msg = (err as Error).message;
    if (clientMessageId) sendMessageAck(ctx, clientMessageId, command.session_id, 'failed', msg);
    ctx.sendError(undefined, `Failed to send message to Codex session ${command.session_id}: ${msg}`, 'SEND_MESSAGE_ERROR');
  }
}
