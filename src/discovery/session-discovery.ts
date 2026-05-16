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
  /**
   * Normalised daemon timestamp (epoch ms). Always set when the daemon
   * announces PEER_CAPABILITIES.HISTORY_CURSOR_MS. Same value the wire
   * `timestamp` ISO string decodes to. Rows missing a source timestamp
   * are filled with `prev_row_ts_ms + 1` so the page sorts stably.
   */
  tsMs?: number;
  /**
   * 0-based index into the parsed-JSONL order for this session. Acts as
   * the secondary sort key under PEER_CAPABILITIES.HISTORY_CURSOR_MS so
   * same-ms clusters resolve in SDK happens-before order. Not sent on
   * the wire — internal only.
   */
  parseIndex?: number;
}

export interface HistoryPage {
  messages: HistoryMessage[];
  totalCount: number;
  offset: number;
  hasMore: boolean;
  /** Max seq across the entire on-disk history (independent of pagination/filter). */
  tailSeq?: number;
  /**
   * Daemon timestamp (epoch ms) of the last message in `messages` after
   * filtering. Sent on the wire as `tail_ms` under HISTORY_CURSOR_MS.
   */
  tailMs?: number;
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
  getSessionHistory(sessionId: string, options?: { offset?: number; limit?: number; since?: string; sinceSeq?: number; sinceMs?: number }): HistoryPage {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 30;
    const since = options?.since;
    const sinceSeq = options?.sinceSeq;
    const sinceMs = options?.sinceMs;

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

        // Include subagent history. Anchor each subagent agent's rows to the
        // ts of the corresponding Task tool_use on the main thread, so the
        // panel sorts adjacent to where it was spawned (subagent's own JSONL
        // ts records when the subagent ran internally — often minutes/hours
        // before the main thread received the tool_result, which would push
        // the panel far back in time once we sort by ts).
        //
        // Pairing: walk main-thread Task tool_uses in JSONL order, and walk
        // distinct subagent agentIds in first-seen order from the subagent
        // file load — the Claude Agent SDK spawns these 1:1, so the Nth Task
        // pairs with the Nth subagent agent. If counts don't match (e.g. a
        // Task that crashed before producing a subagent file, or an orphan
        // subagent file), unpaired subagent rows fall through and keep their
        // original ts.
        const subagentMessages = this.getSubagentHistory(filePath);
        if (subagentMessages.length > 0) {
          const taskToolUseTs: number[] = [];
          const SUBAGENT_SPAWN_TOOLS = new Set(['Task', 'Agent', 'dispatch_agent', 'Subagent']);
          for (const m of allMessages) {
            if (m.role === 'tool_use' && m.toolName && SUBAGENT_SPAWN_TOOLS.has(m.toolName) && m.timestamp) {
              const ts = Date.parse(m.timestamp);
              if (Number.isFinite(ts)) taskToolUseTs.push(ts);
            }
          }
          const distinctAgentIds: string[] = [];
          const seenAgentIds = new Set<string>();
          for (const sm of subagentMessages) {
            const aid = sm.agentId;
            if (aid && !seenAgentIds.has(aid)) {
              seenAgentIds.add(aid);
              distinctAgentIds.push(aid);
            }
          }
          const agentIdToAnchorTs = new Map<string, number>();
          const pairCount = Math.min(taskToolUseTs.length, distinctAgentIds.length);
          for (let i = 0; i < pairCount; i++) {
            agentIdToAnchorTs.set(distinctAgentIds[i], taskToolUseTs[i]);
          }
          let anchored = 0;
          for (const sm of subagentMessages) {
            const anchorTs = sm.agentId ? agentIdToAnchorTs.get(sm.agentId) : undefined;
            if (anchorTs !== undefined) {
              sm.timestamp = new Date(anchorTs).toISOString();
              anchored++;
            }
          }
          logger.info('history-debug', 'subagent ts anchoring', {
            sessionId,
            taskToolUses: taskToolUseTs.length,
            distinctAgents: distinctAgentIds.length,
            paired: pairCount,
            anchoredRows: anchored,
            subagentRowsTotal: subagentMessages.length,
          });

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

        // Re-sort by seq so the array order matches the canonical seq order.
        // Why: allocator hands out seq in *chronological* order on first parse,
        // but on subsequent re-parses (JSONL grew) any row whose timestamp is
        // older than the current allocator tail (subagent backfill, late
        // arrivals, codex injected echoes) gets a *fresh* high seq — its
        // timestamp says "old" but its seq says "newest". Without this re-sort,
        // the array order disagrees with seq order, and the phone — which
        // sorts by seq — sees a different sequence than the daemon's history
        // page reports. ChatMessage.less is seq-primary, so phone-side dump
        // and daemon-side dump must agree.
        allMessages.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

        // HISTORY_CURSOR_MS: assign tsMs + parseIndex, then re-sort by
        // (tsMs ASC, parseIndex ASC). This is the authoritative order the
        // phone trusts verbatim under the cap. Rows missing a source
        // timestamp inherit `prev_ts_ms + 1` so they sort adjacent to
        // their parse-neighbour instead of drifting to either end of the
        // page. Wire `timestamp` is re-encoded from the normalised ms so
        // phone's next `since_ms` = normalised tsMs of the last received row.
        let prevTs = 0;
        let missingTs = 0;
        let sameMsClusters = 0;
        let lastTs = -1;
        let lastTsCount = 0;
        for (let i = 0; i < allMessages.length; i++) {
          const msg = allMessages[i];
          msg.parseIndex = i;
          const srcMs = msg.timestamp ? Date.parse(msg.timestamp) : NaN;
          if (Number.isFinite(srcMs)) {
            msg.tsMs = srcMs;
            prevTs = srcMs;
          } else {
            missingTs++;
            msg.tsMs = (prevTs > 0 ? prevTs : 0) + 1;
            prevTs = msg.tsMs;
          }
          if (msg.tsMs === lastTs) {
            lastTsCount++;
          } else {
            if (lastTsCount > 1) sameMsClusters++;
            lastTs = msg.tsMs;
            lastTsCount = 1;
          }
        }
        if (lastTsCount > 1) sameMsClusters++;

        allMessages.sort((a, b) => {
          const da = (a.tsMs ?? 0) - (b.tsMs ?? 0);
          if (da !== 0) return da;
          return (a.parseIndex ?? 0) - (b.parseIndex ?? 0);
        });
        // Reassign parseIndex to reflect the final order (so future re-sorts
        // and the wire-level "second key" agree even after sort shuffles).
        for (let i = 0; i < allMessages.length; i++) allMessages[i].parseIndex = i;
        // The phone's cursor is currently a single `since_ms` and daemon-side
        // filtering is strictly greater than that cursor. If two rows share
        // the same ms, the second row can be skipped after the phone receives
        // the first. Make the wire/cursor timestamp strictly increasing while
        // preserving the already-computed (tsMs, parseIndex) order.
        let cursorTs = 0;
        for (const msg of allMessages) {
          const ts = msg.tsMs ?? 0;
          cursorTs = Math.max(ts, cursorTs + 1);
          msg.tsMs = cursorTs;
        }
        // Re-encode wire timestamp from normalised ms.
        for (const msg of allMessages) {
          if (msg.tsMs !== undefined) {
            msg.timestamp = new Date(msg.tsMs).toISOString();
          }
        }

        logger.info('history-debug', 'timestamp normalization', {
          sessionId,
          totalRows: allMessages.length,
          missingTs,
          sameMsClusters,
          headTsMs: allMessages[0]?.tsMs,
          tailTsMs: allMessages[allMessages.length - 1]?.tsMs,
        });

        // Diagnostic: confirm whether tool_use rows actually carry sdkUuid in
        // the parsed history. Phone-side dedup keys on sdkUuid; if the daemon
        // ships them without one, live + history fingerprints diverge and the
        // same logical tool_use renders twice. Logged once per session per
        // re-parse (cache miss/mtime change); not in steady-state hot path.
        const toolUses = allMessages.filter((m) => m.role === 'tool_use');
        const toolUseWithUuid = toolUses.filter((m) => !!m.sdkUuid).length;
        const toolUseWithToolId = toolUses.filter((m) => !!m.toolId).length;
        logger.info('history-debug', 'parsed history sdkUuid coverage', {
          sessionId,
          totalRows: allMessages.length,
          toolUseTotal: toolUses.length,
          toolUseWithSdkUuid: toolUseWithUuid,
          toolUseMissingSdkUuid: toolUses.length - toolUseWithUuid,
          toolUseWithToolId: toolUseWithToolId,
        });

        // Cache the parsed history
        this.historyCache.set(sessionId, { messages: allMessages, mtime });
      }

      // Filter by since cursor before pagination.
      // Precedence under HISTORY_CURSOR_MS: sinceMs > sinceSeq > since.
      let filtered = allMessages;
      if (sinceMs !== undefined) {
        filtered = allMessages.filter((m) => (m.tsMs ?? 0) > sinceMs);
      } else if (sinceSeq !== undefined) {
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
      // (offset-aware), then re-include every subagent message whose tsMs
      // falls within [first parent tsMs, last parent tsMs] — this keeps each
      // panel adjacent to its anchor Agent tool_use after ts-anchoring (where
      // subagent rows share the Agent tool_use's tsMs but their seqs may be
      // much higher, so seq-based windowing would either miss or over-include).
      const parentMsgs = filtered.filter((m) => m.role !== 'subagent');
      const total = parentMsgs.length;
      const parentEnd = Math.max(total - offset, 0);
      const parentStart = Math.max(parentEnd - limit, 0);
      const allocatorTail = this.seqAllocators.for(sessionId).tail();
      const tailSeq = allocatorTail > 0 ? allocatorTail : undefined;

      let pageMessages: HistoryMessage[] = [];
      if (parentStart < parentEnd) {
        const parentSlice = parentMsgs.slice(parentStart, parentEnd);
        const loTs = parentSlice[0].tsMs ?? 0;
        const hiTs = parentSlice[parentSlice.length - 1].tsMs ?? Number.MAX_SAFE_INTEGER;
        const nextParentTs = parentEnd < parentMsgs.length
          ? (parentMsgs[parentEnd].tsMs ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER;
        pageMessages = filtered.filter((m) => {
          const t = m.tsMs ?? 0;
          if (t < loTs) return false;
          if (t <= hiTs) return true;
          // Past the window's last parent: only keep subagent rows that belong
          // to a panel still inside the window (anchored before the next
          // parent's tsMs).
          return m.role === 'subagent' && t < nextParentTs;
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
        tailMs: pageMessages.length > 0 ? pageMessages[pageMessages.length - 1].tsMs : undefined,
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
