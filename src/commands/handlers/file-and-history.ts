// Agent Pocket — File / history command handlers
//
// Handlers that read from disk or replay session history. Extracted from
// AgentPocketDaemon as part of Step 1.4b.
//
// All three only touch the small CommandContext surface:
//   - handleReadFile: sendToPhone, sendError (pure fs)
//   - handleGetHistory: sendSessionHistory
//   - handleSyncRequest: sendSessionHistory, sendToPhone, sessionManager

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ReadFileCommand,
  GetHistoryCommand,
  SyncRequestCommand,
  FileContentEvent,
  SyncCompleteEvent,
  SyncAckEvent,
  SessionHistoryDoneEvent,
} from 'agent-pocket-protocol';
import { PEER_CAPABILITIES, SessionStatus } from 'agent-pocket-protocol';
import type { CommandContext } from '../command-context.js';
import { logger } from '../../logger.js';

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

/** Maximum file size the daemon will return inline (1 MiB). */
export const READ_FILE_MAX_BYTES = 1024 * 1024;

/** Map common file extensions to a syntax-highlighting language tag. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.html': 'html',
  '.css': 'css',
  '.sh': 'bash',
  '.sql': 'sql',
};

/** Pure helper: extension -> language tag (or undefined). Exported for tests. */
export function detectLanguageFromExtension(filePath: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

export async function handleReadFile(
  ctx: Pick<CommandContext, 'sendToPhone' | 'sendError'>,
  command: ReadFileCommand,
): Promise<void> {
  try {
    // Security: resolve to prevent path traversal in error messages /
    // language detection — fs APIs already canonicalize.
    const resolvedPath = path.resolve(command.path);

    await fs.promises.access(resolvedPath, fs.constants.R_OK);

    const stat = await fs.promises.stat(resolvedPath);
    if (stat.size > READ_FILE_MAX_BYTES) {
      ctx.sendError(
        command.request_id,
        `File too large: ${stat.size} bytes (max ${READ_FILE_MAX_BYTES})`,
        'FILE_TOO_LARGE',
      );
      return;
    }

    const content = await fs.promises.readFile(resolvedPath, 'utf-8');
    const event: FileContentEvent = {
      type: 'file_content',
      request_id: command.request_id,
      path: resolvedPath,
      content,
      language: detectLanguageFromExtension(resolvedPath),
    };
    ctx.sendToPhone(event);
  } catch (err) {
    ctx.sendError(
      command.request_id,
      `Failed to read file ${command.path}: ${(err as Error).message}`,
      'READ_FILE_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// get_history
// ---------------------------------------------------------------------------

export function handleGetHistory(
  ctx: Pick<CommandContext, 'sendSessionHistory'>,
  command: GetHistoryCommand,
): void {
  ctx.sendSessionHistory(command.session_id, {
    since: command.since,
    sinceSeq: command.since_seq,
    sinceMs: command.since_ms,
    offset: command.offset,
    limit: command.limit,
  });
}

// ---------------------------------------------------------------------------
// sync_request
// ---------------------------------------------------------------------------

export function handleSyncRequest(
  ctx: Pick<
    CommandContext,
    'sendSessionHistory' | 'sendToPhone' | 'sessionManager' | 'hasPeerCapability'
  >,
  command: SyncRequestCommand,
): void {
  const t0 = Date.now();
  const knownSeqs = command.known_seqs ?? {};
  const knownMs = command.known_ms ?? {};

  // The daemon, not the phone, decides which sessions to backfill: every
  // active session (status != history) currently tracked by SessionManager.
  // The phone's `known_seqs` map is a *hint* — it tells us which messages
  // to skip — not a scope filter. This closes the agent-pocket #250 round-2
  // gap where phones using stale local `lastActivity` rankings missed
  // sessions newly active during phone-offline windows.
  const activeSessionIds = ctx.sessionManager
    .getAllSessions()
    .filter((s) => s.status !== SessionStatus.HISTORY)
    .map((s) => s.claudeSessionId)
    .filter((id): id is string => typeof id === 'string');
  const targets = new Set<string>(activeSessionIds);

  logger.info('daemon', 'sync_request received', {
    requestId: command.request_id,
    knownSessions: Object.keys(knownSeqs).length,
    activeSessions: targets.size,
  });

  // SYNC_ACK: tell the phone immediately that the request landed and how
  // many sessions are about to be backfilled so the phone can show a
  // determinate progress signal and shrink its sync_complete watchdog.
  // Old phones (no SYNC_ACK cap) still see the legacy single sync_complete
  // terminator.
  const ackCapable = ctx.hasPeerCapability(PEER_CAPABILITIES.SYNC_ACK);
  if (ackCapable) {
    const ack: SyncAckEvent = {
      type: 'sync_ack',
      request_id: command.request_id,
      sessions: Array.from(targets).map((session_id) => ({
        session_id,
        // SessionManager doesn't expose per-session message counts cheaply;
        // 0 is a placeholder that signals "unknown — daemon will still
        // stream". The phone treats 0 as "no estimate".
        estimated_messages: 0,
      })),
    };
    ctx.sendToPhone(ack);
  }

  const delivered: SyncCompleteEvent['delivered'] = [];
  const perSessionMs: Record<string, number> = {};
  for (const sessionId of targets) {
    const sessionStart = Date.now();
    const lastSeq = knownSeqs[sessionId];
    const lastMs = knownMs[sessionId];
    // Phone has seen this session before → ship only the increment.
    // Phone has never seen it → ship the most-recent tail window
    // (sendSessionHistory's DEFAULT_SESSION_HISTORY_LIMIT). Older history
    // is reachable via paginated `get_history` once the user opens the chat.
    // Under HISTORY_CURSOR_MS, prefer `last_ms` over `last_seq`.
    const result = ctx.sendSessionHistory(sessionId, {
      sinceMs: typeof lastMs === 'number' && lastMs >= 0 ? lastMs : undefined,
      sinceSeq: typeof lastSeq === 'number' && lastSeq >= 0 ? lastSeq : undefined,
    });
    perSessionMs[sessionId.slice(0, 8)] = Date.now() - sessionStart;
    if (result.tailSeq !== undefined || result.tailMs !== undefined) {
      // Always populate `last_seq` (required by SyncCompleteEvent shape);
      // fall back to 0 when daemon has no seq for this session (rare).
      delivered.push({
        session_id: sessionId,
        last_seq: result.tailSeq ?? 0,
        last_ms: result.tailMs,
      });
      if (ackCapable) {
        const done: SessionHistoryDoneEvent = {
          type: 'session_history_done',
          request_id: command.request_id,
          session_id: sessionId,
          last_seq: result.tailSeq ?? 0,
          last_ms: result.tailMs,
        };
        ctx.sendToPhone(done);
      }
    }
  }

  const event: SyncCompleteEvent = {
    type: 'sync_complete',
    request_id: command.request_id,
    delivered,
  };
  logger.info('daemon', 'sync_complete', {
    requestId: command.request_id,
    sessions: delivered.length,
    totalMs: Date.now() - t0,
    perSessionMs,
  });
  ctx.sendToPhone(event);
}
