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
import { PEER_CAPABILITIES } from 'agent-pocket-protocol';
import type { CommandContext } from '../command-context.js';
import { mergeSyncSessionIds } from '../../utils/session-map.js';
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
  const cursorMap = new Map<string, number>();
  for (const cursor of command.cursors ?? []) {
    cursorMap.set(cursor.session_id, cursor.last_seq);
  }

  // SYNC_SCOPED: when the phone announces it AND asks for `mode: 'recent'`,
  // honor cursors as a strict whitelist instead of unioning with all known
  // sessions. This caps fan-out at the phone's chosen N (typically the few
  // sessions it actually displays) and prevents the daemon from streaming
  // history for every project the user has ever opened.
  // (See agent-pocket #250 step 1.)
  const scoped =
    ctx.hasPeerCapability(PEER_CAPABILITIES.SYNC_SCOPED) && command.mode === 'recent';
  const known = scoped
    ? new Set<string>(cursorMap.keys())
    : mergeSyncSessionIds(
        cursorMap,
        ctx.sessionManager
          .getAllSessions()
          .map((s) => s.claudeSessionId)
          .filter((id): id is string => typeof id === 'string'),
      );

  logger.info('daemon', 'sync_request received', {
    requestId: command.request_id,
    cursors: cursorMap.size,
    knownSessions: known.size,
    mode: command.mode ?? 'all',
    scoped,
  });

  // SYNC_ACK: tell the phone immediately that the request landed and how many
  // sessions are about to be backfilled, so the phone can show a determinate
  // progress signal and shrink its sync_complete watchdog. Old phones (no
  // SYNC_ACK cap) still see the legacy single sync_complete terminator.
  const ackCapable = ctx.hasPeerCapability(PEER_CAPABILITIES.SYNC_ACK);
  if (ackCapable) {
    const ack: SyncAckEvent = {
      type: 'sync_ack',
      request_id: command.request_id,
      sessions: Array.from(known).map((session_id) => ({
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
  for (const sessionId of known) {
    const sessionStart = Date.now();
    const lastSeq = cursorMap.get(sessionId);
    const tail = ctx.sendSessionHistory(sessionId, {
      sinceSeq: lastSeq !== undefined && lastSeq >= 0 ? lastSeq : undefined,
    });
    perSessionMs[sessionId.slice(0, 8)] = Date.now() - sessionStart;
    if (tail !== undefined) {
      delivered.push({ session_id: sessionId, last_seq: tail });
      if (ackCapable) {
        const done: SessionHistoryDoneEvent = {
          type: 'session_history_done',
          request_id: command.request_id,
          session_id: sessionId,
          last_seq: tail,
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
