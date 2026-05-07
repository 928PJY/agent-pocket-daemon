// Agent Pocket — Codex Helpers
// Pure / state-isolated utilities for Codex session handling, extracted
// from AgentPocketDaemon. Only the easily-testable, non-event-driven
// pieces live here — observer wiring, the discovery loop, and the phone
// notification side effects are still in src/index.ts (planned for a
// follow-up Step 1.2b).
//
// Functions here have no dependency on AgentPocketDaemon state; they
// either operate on plain inputs (filesystem paths, hook requests) or
// encapsulate a single piece of state (the stop-hook deduper).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CodexHookRequest } from '../hooks/hook-server.js';
import { findOpenCodexRollouts, isCodexSessionId, codexExternalSessionId } from '../discovery/codex-discovery.js';
import type { CodexSession } from '../discovery/codex-discovery.js';
import type { TerminalTarget } from '../pty/tmux-injector.js';

/**
 * The cached terminal+identity info the daemon keeps for each Codex
 * session it has seen via hooks or discovery. Used to route remote
 * messages and interrupts into the right tmux pane / TTY.
 */
export interface CodexTerminalTargetEntry {
  pid?: number;
  target?: TerminalTarget;
  cwd?: string;
  transcriptPath?: string;
  turnId?: string;
  updatedAt: number;
}

/**
 * Window after a `codex_stop` hook fires during which the rollout
 * observer's own `completed` event is treated as a duplicate and
 * suppressed. The hook is the source of truth for completion timing
 * (it fires synchronously when the user's turn ends); the rollout
 * tail can lag and re-trigger a "completed" later.
 */
export const CODEX_STOP_DEDUPE_MS = 5000;

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Capability list reported to the phone for a Codex session. Codex sessions
 * with an attached terminal can be remote-controlled (send message, interrupt,
 * answer permission prompts); without a terminal, only passive observation is
 * possible.
 */
export function getCodexCapabilities(target: CodexTerminalTargetEntry | undefined): string[] {
  return target?.target
    ? ['observe', 'terminal_remote_message', 'terminal_interrupt', 'permissions']
    : ['observe'];
}

// ---------------------------------------------------------------------------
// Hook request → rollout path
// ---------------------------------------------------------------------------

/**
 * Locate the rollout JSONL file referenced by a Codex hook request.
 *
 * Resolution order:
 *   1. `request.transcriptPath` if it exists on disk (fast path — the hook
 *      script usually fills this in)
 *   2. exact match on the request's threadId among open rollouts of `codexPid`
 *   3. newest open rollout for `codexPid` (best-effort fallback)
 *
 * Returns undefined when nothing can be resolved.
 */
export function findCodexHookRolloutPath(
  request: CodexHookRequest,
  requestedSessionId: string,
  deps: {
    findOpenRollouts?: (pid: number) => string[];
    fileExists?: (file: string) => boolean;
    fileMtimeMs?: (file: string) => number | undefined;
  } = {},
): string | undefined {
  const findOpen = deps.findOpenRollouts ?? findOpenCodexRollouts;
  const exists = deps.fileExists ?? ((f: string) => fs.existsSync(f));
  const mtime = deps.fileMtimeMs ?? ((f: string) => {
    try { return fs.statSync(f).mtimeMs; } catch { return undefined; }
  });

  if (request.transcriptPath && exists(request.transcriptPath)) {
    return request.transcriptPath;
  }
  if (!request.codexPid) return undefined;

  const requestedThreadId = requestedSessionId.startsWith('codex:')
    ? requestedSessionId.slice('codex:'.length)
    : requestedSessionId;

  const opened = findOpen(request.codexPid);
  const exact = opened.find((rolloutPath) => path.basename(rolloutPath).includes(requestedThreadId));
  if (exact) return exact;

  let newest: { rolloutPath: string; mtime: number } | undefined;
  for (const rolloutPath of opened) {
    const m = mtime(rolloutPath);
    if (m === undefined) continue;
    if (!newest || m > newest.mtime) newest = { rolloutPath, mtime: m };
  }
  return newest?.rolloutPath;
}

// ---------------------------------------------------------------------------
// External session-id resolution
// ---------------------------------------------------------------------------

/**
 * Map a raw sessionId to its `codex:`-prefixed external ID, but only if the
 * caller already knows about that session (via terminal target cache,
 * observer registry, or discovery). Returns undefined when there is no
 * record of the session — the caller should treat the input as a
 * non-Codex Claude session.
 */
export function resolveCodexExternalSessionId(
  sessionId: string,
  predicates: {
    hasTerminalTarget: (id: string) => boolean;
    hasObserver: (id: string) => boolean;
    hasSession: (id: string) => boolean;
  },
): string | undefined {
  if (isCodexSessionId(sessionId)) return sessionId;
  if (!sessionId) return undefined;
  const externalId = codexExternalSessionId(sessionId);
  if (predicates.hasTerminalTarget(externalId)) return externalId;
  if (predicates.hasObserver(externalId)) return externalId;
  if (predicates.hasSession(externalId)) return externalId;
  return undefined;
}

// ---------------------------------------------------------------------------
// Stop-hook deduper
// ---------------------------------------------------------------------------

/**
 * Tracks recent `codex_stop` hook fires per session, with TTL-based eviction.
 * Used to suppress the rollout observer's `completed` event when the stop
 * hook has already triggered the completion notification.
 *
 * `consume(sessionId)` returns true exactly once per record — subsequent
 * calls (or calls after the TTL) return false.
 *
 * The TTL defaults to {@link CODEX_STOP_DEDUPE_MS} but is configurable for
 * testing. `now` is also injectable so tests don't need to sleep.
 */
export class CodexStopHookDeduper {
  private records = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? CODEX_STOP_DEDUPE_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Record that a `codex_stop` hook fired for this session. Also evicts
   * any expired entries opportunistically so the map can't grow without
   * bound across daemon uptime.
   */
  record(sessionId: string): void {
    const t = this.now();
    for (const [id, at] of this.records.entries()) {
      if (t - at > this.ttlMs) this.records.delete(id);
    }
    this.records.set(sessionId, t);
  }

  /**
   * If a recent (within TTL) record exists for this session, delete it
   * and return true. Otherwise return false (and clean up an expired
   * record if one was present).
   */
  consume(sessionId: string): boolean {
    const stoppedAt = this.records.get(sessionId);
    if (stoppedAt === undefined) return false;
    if (this.now() - stoppedAt > this.ttlMs) {
      this.records.delete(sessionId);
      return false;
    }
    this.records.delete(sessionId);
    return true;
  }

  /** Test/diagnostic helper — current number of tracked records. */
  size(): number {
    return this.records.size;
  }
}

// ---------------------------------------------------------------------------
// Resolve / refresh terminal target
// ---------------------------------------------------------------------------

/**
 * Compute the next `CodexTerminalTargetEntry` for `sessionId`, given the
 * cached entry (if any) and a freshly-discovered live Codex session.
 *
 * Preserves cached cwd/transcriptPath/turnId; refreshes pid + tmux target
 * from the live session. Pure: callers handle storing the result back into
 * their map and resolving the live session from discovery.
 *
 * Returns the existing entry unchanged when no live session is provided
 * and no cached target exists to refresh (caller should treat this as
 * "unknown").
 */
export function refreshCodexTerminalTarget(
  existing: CodexTerminalTargetEntry | undefined,
  liveCodex: { pid: number } | undefined,
  findTerminal: (pid: number) => TerminalTarget | undefined | null,
  now: () => number = Date.now,
): CodexTerminalTargetEntry | undefined {
  if (existing?.target) return existing;
  if (!liveCodex) return existing;

  const target = findTerminal(liveCodex.pid) ?? existing?.target ?? undefined;
  return {
    pid: liveCodex.pid,
    target,
    cwd: existing?.cwd,
    transcriptPath: existing?.transcriptPath,
    turnId: existing?.turnId,
    updatedAt: now(),
  };
}
