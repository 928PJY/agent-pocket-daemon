// Agent Pocket -- Session Discovery
// Scans ~/.claude/projects/ for .jsonl session files to discover
// existing Claude Code sessions that can be resumed.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { TerminalTarget } from '../pty/tmux-injector.js';
import { detectInterruptText } from '../utils/interrupt-messages.js';
import { logger } from '../logger.js';
import { parseHistoryEntry } from './jsonl-parser.js';
import { getSubagentHistory } from './subagent-history.js';
import { PREFETCH_CWD } from '../sessions/observer-commands.js';
import { SessionSeqAllocatorManager } from './seq-allocator.js';
import {
  getRunningCliSessions as scanRunningCliSessions,
  getRunningAllSessions as scanRunningAllSessions,
  getRunningSessionEntrypoints as scanRunningSessionEntrypoints,
} from './pid-scanner.js';
export { isProcessSuspendedOrZombie } from './pid-scanner.js';

// Cap individual tool_output strings when shipping history to the phone.
const HISTORY_TOOL_OUTPUT_CAP = 5000;

// ============================================================================
// Types
// ============================================================================

export interface DiscoveredSession {
  sessionId: string;
  projectDir: string;
  lastModified: number;
  filePath: string;
  customTitle?: string;
}

export interface HistoryMessage {
  role:
    | 'user'
    | 'assistant'
    | 'tool_use'
    | 'tool_result'
    | 'subagent'
    | 'system'
    | 'local_command_invoke'
    | 'local_command_output'
    | 'compact_boundary'
    | 'compact_summary';
  content: string;
  /**
   * For role='user' entries: the SDK transcript UUID from the JSONL row's
   * top-level `uuid` field. The phone needs this verbatim to call
   * `rewind_files { user_message_id }` — `Query.rewindFiles()` only accepts
   * the SDK uuid, not our app-side ChatMessage.id (which is locally generated).
   * Older daemons won't set this; phone treats absence as "rewind unavailable
   * for this turn".
   *
   * Beyond rewind: when PEER_CAPABILITIES.STABLE_SDK_UUID is in effect this
   * is the row's primary key for every replayed event (assistant, tool_use,
   * tool_result, system, local_command_*, compact_*) so the phone keys
   * `ChatMessage.id` off it and live + history collapse without fingerprint.
   */
  sdkUuid?: string;
  /**
   * Block index inside the source assistant row's `message.content[]`.
   * Set on `assistant` and `tool_use` history rows produced from a multi-
   * block JSONL entry; lets the phone disambiguate sibling blocks that
   * share one `sdkUuid`.
   */
  sdkBlockIndex?: number;
  toolName?: string;
  toolId?: string;
  toolStatus?: 'success' | 'error';
  /** Raw tool_input for selected tools (ExitPlanMode, AskUserQuestion) so the
   *  phone can rebuild plan/question cards from history after cache loss. */
  toolInput?: Record<string, unknown>;
  /** Raw tool_result content (string) so the phone can show tool output in
   *  history. Truncated to HISTORY_TOOL_OUTPUT_CAP. */
  toolResultContent?: string;
  timestamp?: string;
  agentId?: string;
  agentName?: string;
  agentType?: string;
  innerEventType?: string;
  /** Final lifecycle from agent-*.archive.json (running / idle / done). */
  agentStatus?: string;
  /** Final tool_use count from archive (only set when archive exists). */
  subagentToolUseCount?: number;
  /** Final cumulative token count from archive (only set when archive exists). */
  subagentTokenCount?: number;
  /** local_command_invoke: command name without leading slash. */
  localCommandName?: string;
  /** local_command_invoke: raw `<command-args>` body if present. */
  localCommandArgs?: string;
  /** local_command_output: true when sourced from `<local-command-stderr>`. */
  localCommandIsStderr?: boolean;
  /** local_command_output: source row's `parentUuid` — points at the
   *  matching `<command-name>` row's `uuid`. Lets the phone pair invoke
   *  + output deterministically across non-monotonic ordering paths
   *  (history backfill, multiple outputs interleaved). */
  parentInvokeSdkUuid?: string;
  /**
   * Per-session monotonic seq assigned by the SessionSeqAllocator. Legacy
   * field name kept for back-compat with old phones; new code should use
   * `session_seq` (mirrored value). Always populated when the daemon has
   * a non-empty seq allocator for this session.
   */
  seq?: number;
  /**
   * Same value as `seq` but with the seq-authoritative contract attached:
   * stable across daemon restarts and JSONL re-parses, shared with the
   * live `SessionOutputEvent.session_seq` allocator. Always set when the
   * daemon announces PEER_CAPABILITIES.MESSAGES_SEQ_AUTHORITATIVE.
   */
  session_seq?: number;
}

export interface HistoryPage {
  messages: HistoryMessage[];
  totalCount: number;
  offset: number;
  hasMore: boolean;
  /** Max seq across the entire on-disk history (independent of pagination/filter). */
  tailSeq?: number;
}

export interface RunningCliSession {
  pid: number;
  sessionId: string;
  cwd: string;
  terminalTarget?: TerminalTarget;
  entrypoint: string;
  /** Friendly name written by Claude Code 4.x into the PID JSON (e.g. "Research"). */
  name?: string;
}

export interface SessionPidInfo {
  pid: number;
  sessionId: string;
  cwd: string;
  entrypoint: string;
  isAlive: boolean;
  /** Friendly name written by Claude Code 4.x into the PID JSON (e.g. "Research"). */
  name?: string;
}

// ============================================================================
// Process State Helpers
// ============================================================================
// (isProcessSuspendedOrZombie now lives in ./pid-scanner.ts and is re-exported
// from the top of this module to keep the public import path stable.)

// ============================================================================
// SessionDiscovery
// ============================================================================

export class SessionDiscovery {
  private claudeDir: string;
  private cachedSessions: DiscoveredSession[] | null = null;
  private historyCache: Map<string, { messages: HistoryMessage[]; mtime: number }> = new Map();
  private readonly seqAllocators: SessionSeqAllocatorManager;

  constructor(claudeDir?: string, seqAllocators?: SessionSeqAllocatorManager) {
    this.claudeDir = claudeDir ?? path.join(os.homedir(), '.claude');
    this.seqAllocators = seqAllocators ?? new SessionSeqAllocatorManager(
      path.join(this.claudeDir, 'sessions'),
    );
  }

  /** Expose the allocator manager so live wire paths (notification-bookkeeping)
   *  can share the same per-session allocators used during history parse. */
  getSeqAllocators(): SessionSeqAllocatorManager {
    return this.seqAllocators;
  }

  /**
   * Scan the Claude projects directory for session files.
   * Returns a sorted list of discovered sessions (most recent first).
   */
  async discoverSessions(): Promise<DiscoveredSession[]> {
    const projectsDir = path.join(this.claudeDir, 'projects');

    if (!fs.existsSync(projectsDir)) {
      return [];
    }

    const sessions: DiscoveredSession[] = [];

    try {
      await this.scanDirectory(projectsDir, sessions);
    } catch (err) {
      // If scanning fails (permissions, etc.), return whatever we found
      logger.error('discovery', `Scan failed at ${projectsDir}: ${(err as Error).message}`);
    }

    // Sort by last modified, most recent first
    sessions.sort((a, b) => b.lastModified - a.lastModified);

    this.cachedSessions = sessions;
    logger.trace('discovery', 'Scanned sessions', { count: sessions.length });
    return sessions;
  }

  /**
   * Return the last result from discoverSessions(), or null if never called.
   */
  getCachedSessions(): DiscoveredSession[] | null {
    return this.cachedSessions;
  }

  /**
   * Get the Claude projects directory path.
   */
  getProjectsDir(): string {
    return path.join(this.claudeDir, 'projects');
  }

  /**
   * Look up PID info for a session by checking ~/.claude/sessions/*.json.
   * Returns info about the process running this session, or null if not found.
   */
  getSessionPidInfo(sessionId: string): SessionPidInfo | null {
    const sessionsDir = path.join(this.claudeDir, 'sessions');
    if (!fs.existsSync(sessionsDir)) return null;

    try {
      const entries = fs.readdirSync(sessionsDir);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          const filePath = path.join(sessionsDir, entry);
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
          if (data.sessionId !== sessionId) continue;

          const pid = data.pid as number;
          let isAlive = false;
          if (pid) {
            try { process.kill(pid, 0); isAlive = true; } catch { /* dead */ }
          }

          return {
            pid,
            sessionId: data.sessionId as string,
            cwd: (data.cwd as string) ?? '',
            entrypoint: (data.entrypoint as string) ?? 'unknown',
            isAlive,
            name: typeof data.name === 'string' ? (data.name as string) : undefined,
          };
        } catch {
          // Skip unparseable files
        }
      }
    } catch {
      // Permission error
    }
    return null;
  }

  /**
   * Read messages from a session's JSONL file with pagination support.
   * `offset` counts from the end (0 = most recent page).
   * `limit` is the page size (default 30).
   */
  getSessionHistory(sessionId: string, options?: { offset?: number; limit?: number; since?: string; sinceSeq?: number }): HistoryPage {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 30;
    const since = options?.since;
    const sinceSeq = options?.sinceSeq;

    // Find the JSONL file for this session
    const cached = this.cachedSessions;
    let filePath: string | null = null;

    if (cached) {
      const match = cached.find((s) => s.sessionId === sessionId);
      if (match) filePath = match.filePath;
    }

    if (!filePath) {
      // Scan all project dirs for the session file
      const projectsDir = path.join(this.claudeDir, 'projects');
      filePath = this.findSessionFile(projectsDir, sessionId);
    }

    if (!filePath || !fs.existsSync(filePath)) {
      return { messages: [], totalCount: 0, offset, hasMore: false };
    }

    try {
      const stat = fs.statSync(filePath);
      let mtime = stat.mtimeMs;

      // Also check subagent file mtimes for cache invalidation
      const subagentsDir = path.join(
        path.dirname(filePath),
        path.basename(filePath, '.jsonl'),
        'subagents',
      );
      try {
        if (fs.existsSync(subagentsDir)) {
          for (const entry of fs.readdirSync(subagentsDir)) {
            if (entry.endsWith('.jsonl') || entry.endsWith('.archive.json')) {
              const subStat = fs.statSync(path.join(subagentsDir, entry));
              if (subStat.mtimeMs > mtime) mtime = subStat.mtimeMs;
            }
          }
        }
      } catch {
        // Ignore errors reading subagent dir
      }

      // Return cached history if files haven't changed
      const cachedHistory = this.historyCache.get(sessionId);
      let allMessages: HistoryMessage[];

      if (cachedHistory && cachedHistory.mtime === mtime) {
        allMessages = cachedHistory.messages;
      } else {
        // Read up to 20MB to cover long sessions.
        // Most sessions are under this limit; very long ones get tail-truncated.
        const MAX_READ_BYTES = 20 * 1024 * 1024;
        let raw: string;
        if (stat.size > MAX_READ_BYTES) {
          const fd = fs.openSync(filePath, 'r');
          const buf = Buffer.alloc(MAX_READ_BYTES);
          fs.readSync(fd, buf, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
          fs.closeSync(fd);
          raw = buf.toString('utf-8');
          // Drop the first (likely partial) line
          const firstNewline = raw.indexOf('\n');
          if (firstNewline >= 0) {
            raw = raw.slice(firstNewline + 1);
          }
        } else {
          raw = fs.readFileSync(filePath, 'utf-8');
        }

        const lines = raw.split('\n').filter((l) => l.trim().length > 0);
        allMessages = [];

        const toolStatusById = new Map<string, 'success' | 'error'>();
        const toolResultContentById = new Map<string, string>();

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            const msgs = this.parseHistoryEntry(entry);
            if (msgs.length > 0) allMessages.push(...msgs);

            if (entry.type === 'user') {
              const message = entry.message as { content?: unknown } | undefined;
              const content = message?.content;
              if (Array.isArray(content)) {
                for (const block of content as Array<Record<string, unknown>>) {
                  if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                    const inner = block.content;
                    const innerStr = typeof inner === 'string' ? inner : JSON.stringify(inner ?? '');
                    const isError = block.is_error === true || detectInterruptText(innerStr) !== null;
                    toolStatusById.set(block.tool_use_id, isError ? 'error' : 'success');
                    if (!isError) {
                      toolResultContentById.set(block.tool_use_id, innerStr);
                    }
                  }
                }
              }
            }
          } catch {
            // Skip unparseable lines
          }
        }

        for (const msg of allMessages) {
          if (msg.role === 'tool_use' && msg.toolId) {
            const s = toolStatusById.get(msg.toolId);
            if (s) msg.toolStatus = s;
            const r = toolResultContentById.get(msg.toolId);
            if (r) {
              msg.toolResultContent = r.length > HISTORY_TOOL_OUTPUT_CAP
                ? r.slice(0, HISTORY_TOOL_OUTPUT_CAP) + `… [+${r.length - HISTORY_TOOL_OUTPUT_CAP} chars]`
                : r;
            }
          }
        }

        // Include subagent history interleaved by timestamp
        const subagentMessages = this.getSubagentHistory(filePath);
        if (subagentMessages.length > 0) {
          allMessages.push(...subagentMessages);
          allMessages.sort((a, b) => {
            const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            return ta - tb;
          });
        }

        // Assign per-session monotonic seq via the persistent allocator.
        // Iteration order = chronological (we just sorted), so the first
        // time we see a sdk_uuid it gets the next free seq; subsequent
        // parses (same uuid) reuse the persisted seq → stable across
        // daemon restarts and JSONL re-parses. Rows missing sdk_uuid
        // (rare; some legacy JSONL fragments) get an anonymous seq drawn
        // from the same counter so order stays monotonic.
        const allocator = this.seqAllocators.for(sessionId);
        for (const msg of allMessages) {
          let seq: number;
          if (msg.sdkUuid) {
            seq = allocator.getOrAssign(msg.sdkUuid, msg.sdkBlockIndex);
          } else {
            seq = allocator.allocAnonymous();
          }
          msg.seq = seq;
          msg.session_seq = seq;
        }

        // Cache the parsed history
        this.historyCache.set(sessionId, { messages: allMessages, mtime });
      }

      // Filter by since timestamp before pagination (for incremental fetch).
      // sinceSeq takes precedence when present (gap-fill on reconnect).
      let filtered = allMessages;
      if (sinceSeq !== undefined) {
        filtered = allMessages.filter((m) => (m.seq ?? 0) > sinceSeq);
      } else if (since) {
        const sinceTime = new Date(since).getTime();
        if (!isNaN(sinceTime)) {
          filtered = allMessages.filter((m) => {
            if (!m.timestamp) return true;
            const msgTime = new Date(m.timestamp).getTime();
            return !isNaN(msgTime) && msgTime > sinceTime;
          });
        }
      }

      // Paginate: limit counts PARENT messages only. Subagent messages
      // (role === 'subagent') are absorbed into a panel anchored on a parent
      // Task tool_use, so a chatty subagent should not eat the page budget for
      // the main thread. We pick `limit` parent messages from the tail
      // (offset-aware), then re-include every subagent message whose seq falls
      // between the first and last parent in that window.
      const parentMsgs = filtered.filter((m) => m.role !== 'subagent');
      const total = parentMsgs.length;
      const parentEnd = Math.max(total - offset, 0);
      const parentStart = Math.max(parentEnd - limit, 0);
      // Authoritative tail must reflect what the JSONL-derived `m.seq` filter
      // can actually serve — not the allocator's internal counter. The
      // counter is bumped by every live `allocAnonymous()` (no sdk_uuid),
      // and those increments never appear on a parsed history row, so a
      // counter-derived tail is unreachable through `(m.seq) > sinceSeq`
      // and phone's gap-fill request against it returns 0 messages
      // (issue #74). Use the highest seq actually present on a parsed
      // message instead. `m.seq` is monotonic per row but may not be
      // strictly increasing across the array (older sdk_uuids re-bind to
      // their original seq), so we take a max rather than the tail element.
      let maxSeq = 0;
      for (const m of allMessages) {
        const s = m.seq ?? 0;
        if (s > maxSeq) maxSeq = s;
      }
      const tailSeq = maxSeq > 0 ? maxSeq : undefined;

      let pageMessages: HistoryMessage[] = [];
      if (parentStart < parentEnd) {
        const parentSlice = parentMsgs.slice(parentStart, parentEnd);
        const lo = parentSlice[0].seq ?? 0;
        // Extend `hi` forward through any trailing subagent run so a panel
        // anchored on a Task at the page tail keeps its messages. We stop at
        // the next parent message after the window.
        const lastParentSeq = parentSlice[parentSlice.length - 1].seq ?? Number.MAX_SAFE_INTEGER;
        const nextParentIdx = parentEnd; // index in parentMsgs
        const nextParentSeq = nextParentIdx < parentMsgs.length
          ? (parentMsgs[nextParentIdx].seq ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER;
        pageMessages = filtered.filter((m) => {
          const s = m.seq ?? 0;
          if (s < lo) return false;
          if (s <= lastParentSeq) return true;
          // Past the last parent in window: only keep subagent messages that
          // belong to a panel still inside the window (i.e. before the next
          // parent message).
          return m.role === 'subagent' && s < nextParentSeq;
        });
      }

      return {
        messages: pageMessages,
        // Report ALL-message count (parent + subagent) so the phone's
        // `phoneCount` (which counts every in-memory ChatMessage, subagent
        // included) can be compared 1:1 against `expectedCount`. The
        // parent-only number drives pagination internally but must not leak
        // into divergence checks — it would force constant resyncs.
        totalCount: filtered.length,
        offset,
        hasMore: parentStart > 0,
        tailSeq,
      };
    } catch (err) {
      logger.warn('discovery', `Read history failed: ${(err as Error).message}`, { sessionId });
      return { messages: [], totalCount: 0, offset, hasMore: false };
    }
  }

  private findSessionFile(dir: string, sessionId: string): string | null {
    if (!fs.existsSync(dir)) return null;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'subagents') continue;
          const result = this.findSessionFile(fullPath, sessionId);
          if (result) return result;
        } else if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
          return fullPath;
        }
      }
    } catch {
      // Permission errors, etc.
    }
    return null;
  }

  private parseHistoryEntry(entry: Record<string, unknown>): HistoryMessage[] {
    return parseHistoryEntry(entry) as HistoryMessage[];
  }

  /**
   * Read subagent JSONL files for a session and return history messages.
   * Subagent files live at <sessionJsonlDir>/<sessionId>/subagents/agent-*.jsonl
   * with companion agent-*.meta.json for metadata.
   */
  private getSubagentHistory(sessionFilePath: string): HistoryMessage[] {
    return getSubagentHistory(sessionFilePath) as HistoryMessage[];
  }

  // --------------------------------------------------------------------------
  // Running CLI Session Management
  // --------------------------------------------------------------------------

  /**
   * Find currently running Claude CLI terminal sessions by reading
   * ~/.claude/sessions/<PID>.json metadata files.
   * Only returns sessions with entrypoint === "cli" that have a live process.
   */
  getRunningCliSessions(): RunningCliSession[] {
    return scanRunningCliSessions(this.claudeDir);
  }

  /**
   * Get ALL running Claude sessions (cli, vscode, etc.) with live processes.
   * Same as getRunningCliSessions() but without the entrypoint filter.
   */
  getRunningAllSessions(): RunningCliSession[] {
    return scanRunningAllSessions(this.claudeDir);
  }

  /**
   * Get entrypoint for all running sessions (cli, claude-vscode, etc.)
   * by reading PID files. Returns a map of sessionId -> entrypoint.
   */
  getRunningSessionEntrypoints(): Map<string, string> {
    return scanRunningSessionEntrypoints(this.claudeDir);
  }

  /**
   * Gracefully exit all running Claude CLI terminal sessions.
   * Sends SIGINT so each Claude process exits cleanly and prints
   * "claude --resume <session-id>" to the user's terminal.
   * Returns the list of sessions that were signaled.
   */
  async gracefullyExitClaudeSessions(): Promise<RunningCliSession[]> {
    const running = this.getRunningCliSessions();
    if (running.length === 0) return [];

    console.log(`[SessionDiscovery] Found ${running.length} running Claude terminal session(s). Gracefully exiting...`);
    logger.info('discovery', `Gracefully exiting ${running.length} Claude session(s)`);
    for (const s of running) {
      console.log(`  PID ${s.pid}: session ${s.sessionId.slice(0, 8)}... (${s.cwd})`);
    }

    // Send SIGINT for graceful exit
    for (const s of running) {
      try {
        process.kill(s.pid, 'SIGINT');
      } catch {
        // Already exited
      }
    }

    // Wait up to 5 seconds for processes to exit
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const stillAlive = running.filter((s) => {
        try { process.kill(s.pid, 0); return true; } catch { return false; }
      });
      if (stillAlive.length === 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // Send SIGTERM to stragglers
    for (const s of running) {
      try {
        process.kill(s.pid, 0); // Check if still alive
        console.log(`  PID ${s.pid} still alive after SIGINT, sending SIGTERM...`);
        logger.warn('discovery', `PID ${s.pid} ignored SIGINT, sending SIGTERM`);
        process.kill(s.pid, 'SIGTERM');
      } catch {
        // Already exited — good
      }
    }

    console.log(`[SessionDiscovery] All Claude terminal sessions exited. Users will see 'claude --resume <id>' in their terminals.`);
    logger.info('discovery', 'All Claude terminal sessions exited');
    return running;
  }

  /**
   * Force-kill all running Claude CLI sessions (for emergency/panic).
   * Sends SIGTERM first, then SIGKILL after a short grace period.
   */
  async forceKillClaudeSessions(): Promise<RunningCliSession[]> {
    const running = this.getRunningCliSessions();
    if (running.length === 0) {
      console.log('[SessionDiscovery] No running Claude terminal sessions found.');
      logger.info('discovery', 'No running Claude sessions to kill');
      return [];
    }

    console.log(`[SessionDiscovery] Force-killing ${running.length} Claude terminal session(s)...`);
    logger.warn('discovery', `Force-killing ${running.length} Claude session(s)`);
    for (const s of running) {
      console.log(`  PID ${s.pid}: session ${s.sessionId.slice(0, 8)}... (${s.cwd})`);
    }

    // Send SIGTERM first
    for (const s of running) {
      try { process.kill(s.pid, 'SIGTERM'); } catch { /* already dead */ }
    }

    // Short grace period
    await new Promise((r) => setTimeout(r, 1000));

    // SIGKILL stragglers
    for (const s of running) {
      try {
        process.kill(s.pid, 0);
        process.kill(s.pid, 'SIGKILL');
      } catch { /* already dead */ }
    }

    console.log('[SessionDiscovery] All Claude processes terminated.');
    logger.info('discovery', 'All Claude processes terminated (force-kill)');
    return running;
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private async scanDirectory(
    dir: string,
    results: DiscoveredSession[],
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip subagent directories — they contain per-agent JSONL files, not sessions
        if (entry.name === 'subagents') continue;
        await this.scanDirectory(fullPath, results);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const session = this.parseSessionFile(fullPath);
        if (session) {
          results.push(session);
        }
      }
    }
  }

  private parseSessionFile(filePath: string): DiscoveredSession | null {
    try {
      const stat = fs.statSync(filePath);

      // Skip sessions older than 10 days
      const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
      if (stat.mtimeMs < tenDaysAgo) {
        return null;
      }

      const fileName = path.basename(filePath, '.jsonl');

      // The session ID is typically the filename without extension
      const sessionId = fileName;

      // The project directory is derived from the directory structure.
      // ~/.claude/projects/<encoded-path>/<session-id>.jsonl
      const projectsDir = path.join(this.claudeDir, 'projects');
      const relativePath = path.relative(projectsDir, path.dirname(filePath));

      // The encoded project path uses URL-safe encoding or hyphens for slashes
      const projectDir = this.decodeProjectPath(relativePath);

      // Drop daemon's own SDK-prefetch sessions — they're internal-only
      // (used to fetch supportedCommands once at startup) and must not
      // surface to the phone or fire a session_completed notification.
      if (projectDir === PREFETCH_CWD) {
        return null;
      }

      // Read the first few lines to extract custom-title
      const customTitle = this.extractCustomTitle(filePath);

      return {
        sessionId,
        projectDir,
        lastModified: stat.mtimeMs,
        filePath,
        customTitle,
      };
    } catch {
      return null;
    }
  }

  /**
   * Read the JSONL file to find a custom-title or ai-title entry.
   * Checks up to 64KB since ai-title entries appear after Claude's first response.
   */
  private extractCustomTitle(filePath: string): string | undefined {
    try {
      const fd = fs.openSync(filePath, 'r');
      const stat = fs.fstatSync(fd);
      const bytesToRead = Math.min(stat.size, 65536);
      const buf = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, 0);
      fs.closeSync(fd);

      const head = buf.subarray(0, bytesRead).toString('utf-8');
      const lines = head.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
            return entry.customTitle;
          }
          if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
            return entry.aiTitle;
          }
        } catch {
          // Partial line at end of buffer — skip
        }
      }
    } catch {
      // Ignore read errors
    }
    return undefined;
  }

  /**
   * Decode the project path from the directory name.
   * Claude stores project sessions under encoded directories, commonly
   * replacing path separators with hyphens or URL-encoding them.
   */
  private decodeProjectPath(encodedPath: string): string {
    // Try URL-decoding first (e.g., %2F for /)
    try {
      const decoded = decodeURIComponent(encodedPath.replace(/-/g, '%2F'));
      // If it looks like a real path, use it
      if (decoded.includes('/') || decoded.includes('\\')) {
        return decoded;
      }
    } catch {
      // Fall through to raw path
    }

    // Otherwise, return as-is (directory name is the project reference)
    return encodedPath;
  }
}
