// Agent Pocket — list_sessions command handler
//
// Builds the unified session list for the phone by merging four sources:
//   1. Daemon-tracked sessions from SessionManager (rich status + observer state).
//   2. Live Claude PIDs not already claimed by phase 1 (alive but unobserved).
//   3. Discovered JSONL files with no live PID (history-only).
//   4. Codex sessions (history + observed).
//
// Then overlays pending_actions from the hook server, sorts active-first,
// paginates, and attaches a 3-message history snippet per entry.
//
// Extracted from AgentPocketDaemon as part of Step 1.4h. Behaviour is
// unchanged — the only mechanical transformations are: passing daemon
// state in via `ListSessionsDeps` and replacing `this.<helper>` with the
// corresponding dep callback.

import * as path from 'node:path';
import type {
  PcEvent,
  ListSessionsCommand,
} from 'agent-pocket-protocol';
import { SessionStatus } from 'agent-pocket-protocol';
import type { CommandContext } from '../command-context.js';
import { isCodexSessionId } from '../../discovery/codex-discovery.js';
import type { CodexSession, CodexLiveSession } from '../../discovery/codex-discovery.js';
import type { DiscoveredSession, HistoryPage, RunningCliSession } from '../../discovery/session-discovery.js';
import type { SessionState } from '../../sessions/session-manager.js';
import type { CodexTerminalTargetEntry } from '../../codex/codex-handler.js';
import { getLatestSessionMapEntryForPid } from '../../utils/session-map.js';
import { logger } from '../../logger.js';

/** Subset of the daemon's pendingBlockingRequests map used by list_sessions. */
export interface PendingBlockingEntry {
  sessionId: string;
  type: 'permission_request' | 'user_question' | 'plan_review';
}

/** Subset of the daemon's per-codex-observer state list_sessions cares about. */
export interface CodexObserverInfo {
  status: SessionStatus;
  lastActivity: number;
}

export interface ListSessionsDeps {
  // ── Discovery ────────────────────────────────────────────────────────────
  getCachedSessions(): DiscoveredSession[] | null;
  discoverSessions(): Promise<DiscoveredSession[]>;
  getRunningAllSessions(): RunningCliSession[];
  getSessionHistory(sessionId: string, options?: { limit?: number }): HistoryPage;

  // ── Codex ────────────────────────────────────────────────────────────────
  discoverCodexSessions(): CodexSession[];
  discoverCodexLiveSessions(sessions: CodexSession[]): Map<string, CodexLiveSession>;
  getCodexHistory(sessionId: string, options?: { limit?: number }): HistoryPage;
  resolveCodexTerminalTarget(sessionId: string, liveCodex: CodexLiveSession | null): CodexTerminalTargetEntry | undefined;
  getCodexCapabilities(sessionId: string): string[];
  getCodexObserver(sessionId: string): CodexObserverInfo | undefined;

  // ── Tracked sessions / blocking requests ────────────────────────────────
  getAllTrackedSessions(): SessionState[];
  pendingBlockingRequests: Map<string, PendingBlockingEntry>;

  // ── Daemon static / state ───────────────────────────────────────────────
  replacedSessionIds: Set<string>;
  claudeAgentVersion: string | undefined;
  // Optional: only present once binding-journal wiring lands. Used to
  // suppress phantom Phase-2 rows whose JSONL has been adopted by a
  // different live PID (Anomaly B's `528fcedd-104` ghost).
  getBindingJournal?: () => { lastObserveForJsonl: (jsonlPath: string) => { pid: number } | undefined } | null;
}

const CLAUDE_CODE_CAPABILITIES = [
  'observe', 'terminal_remote_message', 'terminal_interrupt',
  'permissions', 'plan_review', 'user_question',
] as const;
const ACTIVE_STATUSES = new Set<SessionStatus>([
  SessionStatus.RUNNING,
  SessionStatus.PENDING_ACTIONS,
  SessionStatus.READY,
  SessionStatus.STARTING,
]);
const SYNTHETIC_PENDING_TTL_MS = 10 * 60 * 1000;

interface CollectedEntry {
  entry: Record<string, unknown>;
  historyKey: string;
}

/**
 * Build the unified merged session view: tracked sessions (Phase 1) +
 * alive-but-untracked PIDs (Phase 2) + history-only JSONLs (Phase 3) +
 * Codex sessions (Phase 4), with pending-actions status overlay applied.
 *
 * This is the single source of truth for "what sessions exist". Both the
 * phone-facing `handleListSessions` and the local-introspection
 * `api_sessions` derive their output by projecting from this same merged
 * view, so the two channels can never diverge on what counts as a session.
 */
export async function buildMergedSessionView(
  ctx: Pick<CommandContext, 'resolveExternalSessionId'>,
  deps: ListSessionsDeps,
): Promise<CollectedEntry[]> {
  const discoveredSessions = deps.getCachedSessions() ?? await deps.discoverSessions();
  const allSessions: CollectedEntry[] = [];
  const claimedPids = new Set<number>();
  const claimedSessionIds = new Set<string>();

  const runningAll = deps.getRunningAllSessions();
  const pidNameByPid = new Map<number, string>();
  for (const r of runningAll) {
    if (r.name) pidNameByPid.set(r.pid, r.name);
  }

  const activeSessions = deps.getAllTrackedSessions();
  collectTrackedSessions(activeSessions, ctx, deps, pidNameByPid, allSessions, claimedPids, claimedSessionIds);
  collectAlivePids(runningAll, discoveredSessions, deps, allSessions, claimedPids, claimedSessionIds);
  collectHistorySessions(discoveredSessions, deps, allSessions, claimedSessionIds);
  collectCodexSessions(deps, allSessions, claimedSessionIds);
  overlayPendingActions(deps, allSessions);

  allSessions.sort(compareSessions);
  return allSessions;
}

export async function handleListSessions(
  ctx: Pick<CommandContext, 'sendToPhone' | 'sendError' | 'resolveExternalSessionId'>,
  deps: ListSessionsDeps,
  command: ListSessionsCommand,
): Promise<void> {
  try {
    const offset = command.offset ?? 0;
    const limit = command.limit ?? 20;

    const allSessions = await buildMergedSessionView(ctx, deps);

    const totalCount = allSessions.length;
    const pageSlice = allSessions.slice(offset, offset + limit);

    const sessions = pageSlice.map(({ entry, historyKey }) => {
      const historyPage = isCodexSessionId(historyKey)
        ? deps.getCodexHistory(historyKey, { limit: 3 })
        : deps.getSessionHistory(historyKey, { limit: 3 });
      return {
        ...entry,
        recent_messages: historyPage.messages.map((m) => ({
          role: m.role,
          content: m.content.slice(0, 200),
          tool_name: m.toolName,
        })),
      };
    });

    logger.debug('daemon', 'handleListSessions returning page', {
      count: sessions.length,
      sessions: pageSlice.map(({ entry }) => ({
        sessionId: entry.session_id,
        pid: entry.pid,
        capabilities: entry.capabilities,
      })),
    });

    const event = {
      type: 'session_list',
      request_id: command.request_id,
      sessions,
      total_count: totalCount,
      offset,
      has_more: offset + limit < totalCount,
    };

    ctx.sendToPhone(event as unknown as PcEvent);
  } catch (err) {
    ctx.sendError(
      command.request_id,
      `Failed to list sessions: ${(err as Error).message}`,
      'LIST_SESSIONS_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — daemon-tracked sessions (SessionManager)
// ---------------------------------------------------------------------------

function collectTrackedSessions(
  activeSessions: SessionState[],
  ctx: Pick<CommandContext, 'resolveExternalSessionId'>,
  deps: ListSessionsDeps,
  pidNameByPid: Map<number, string>,
  out: CollectedEntry[],
  claimedPids: Set<number>,
  claimedSessionIds: Set<string>,
): void {
  for (const active of activeSessions) {
    const externalId = ctx.resolveExternalSessionId(active.sessionId);
    const claudeId = active.claudeSessionId ?? externalId;

    let effectiveStatus = active.status as SessionStatus;
    let actionType: string | undefined;
    const realPending = Array.from(deps.pendingBlockingRequests.entries()).find(
      ([reqId, entry]) => entry.sessionId === externalId && !reqId.startsWith('startup_pending_'),
    );
    if (realPending) {
      effectiveStatus = SessionStatus.PENDING_ACTIONS;
      actionType = realPending[1].type;
    } else if (effectiveStatus === SessionStatus.PENDING_ACTIONS) {
      const idleMs = Date.now() - (active.lastActivity ?? 0);
      if (idleMs > SYNTHETIC_PENDING_TTL_MS) {
        const syntheticId = `startup_pending_${externalId}`;
        if (deps.pendingBlockingRequests.has(syntheticId)) {
          deps.pendingBlockingRequests.delete(syntheticId);
        }
      }
    }

    out.push({
      entry: {
        session_id: externalId,
        agent_type: 'claude_code',
        agent_display_name: 'Claude Code',
        agent_version: deps.claudeAgentVersion,
        capabilities: [...CLAUDE_CODE_CAPABILITIES],
        status: effectiveStatus,
        action_type: actionType,
        working_directory: active.workingDirectory,
        project_name: active.customTitle
          ?? (active.terminalPid ? pidNameByPid.get(active.terminalPid) : undefined)
          ?? path.basename(active.workingDirectory),
        last_activity: active.lastActivity,
        entrypoint: active.entrypoint,
        pid: active.terminalPid,
        is_observed: active.isObserved,
        ...(active.isObserved
          ? {}
          : {
              permission_mode: active.permissionMode ?? 'default',
              dangerously_skip_permissions: active.config?.dangerously_skip_permissions === true,
            }),
      },
      historyKey: claudeId,
    });
    if (active.terminalPid) claimedPids.add(active.terminalPid);
    claimedSessionIds.add(externalId);
    if (active.claudeSessionId) claimedSessionIds.add(active.claudeSessionId);
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — alive PIDs not claimed by Phase 1
// ---------------------------------------------------------------------------

function collectAlivePids(
  runningAll: RunningCliSession[],
  discoveredSessions: DiscoveredSession[],
  deps: ListSessionsDeps,
  out: CollectedEntry[],
  claimedPids: Set<number>,
  claimedSessionIds: Set<string>,
): void {
  for (const pidInfo of runningAll) {
    if (claimedPids.has(pidInfo.pid)) continue;

    const mapEntry = getLatestSessionMapEntryForPid(pidInfo.pid);
    if (mapEntry && mapEntry.sessionId !== pidInfo.sessionId) {
      pidInfo.sessionId = mapEntry.sessionId;
      pidInfo.cwd = mapEntry.cwd;
    }

    if (claimedSessionIds.has(pidInfo.sessionId)) continue;

    const historyKey = pidInfo.sessionId;
    let lastActivity: number | undefined;
    let customTitle: string | undefined;
    const exactMatch = discoveredSessions.find((d) => d.sessionId === pidInfo.sessionId);
    if (exactMatch) {
      lastActivity = exactMatch.lastModified;
      customTitle = exactMatch.customTitle;
    }

    // Phase-2 phantom suppression (Anomaly B defense in depth): if the
    // binding journal records a different PID as the most recent observer
    // of this JSONL, the row is a stale ghost — skip it. The live PID's
    // legitimate row will still be included via its own iteration.
    if (exactMatch) {
      const journal = deps.getBindingJournal?.();
      const lastObs = journal?.lastObserveForJsonl(exactMatch.filePath);
      if (lastObs && lastObs.pid !== pidInfo.pid) {
        continue;
      }
    }

    out.push({
      entry: {
        session_id: pidInfo.sessionId,
        agent_type: 'claude_code',
        agent_display_name: 'Claude Code',
        agent_version: deps.claudeAgentVersion,
        capabilities: [...CLAUDE_CODE_CAPABILITIES],
        status: SessionStatus.READY,
        working_directory: pidInfo.cwd,
        project_name: customTitle ?? pidInfo.name ?? path.basename(pidInfo.cwd),
        last_activity: lastActivity,
        entrypoint: pidInfo.entrypoint,
        pid: pidInfo.pid,
        is_observed: true,
      },
      historyKey,
    });
    claimedPids.add(pidInfo.pid);
    claimedSessionIds.add(pidInfo.sessionId);
    claimedSessionIds.add(historyKey);
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — history JSONL files with no live PID
// ---------------------------------------------------------------------------

function collectHistorySessions(
  discoveredSessions: DiscoveredSession[],
  deps: ListSessionsDeps,
  out: CollectedEntry[],
  claimedSessionIds: Set<string>,
): void {
  for (const discovered of discoveredSessions) {
    if (claimedSessionIds.has(discovered.sessionId)) continue;
    if (deps.replacedSessionIds.has(discovered.sessionId)) continue;
    out.push({
      entry: {
        session_id: discovered.sessionId,
        agent_type: 'claude_code',
        agent_display_name: 'Claude Code',
        agent_version: deps.claudeAgentVersion,
        capabilities: ['observe'],
        status: SessionStatus.HISTORY,
        working_directory: discovered.projectDir,
        project_name: discovered.customTitle ?? path.basename(discovered.projectDir),
        last_activity: discovered.lastModified,
        is_observed: true,
      },
      historyKey: discovered.sessionId,
    });
    claimedSessionIds.add(discovered.sessionId);
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — Codex history/observe sessions
// ---------------------------------------------------------------------------

function collectCodexSessions(
  deps: ListSessionsDeps,
  out: CollectedEntry[],
  claimedSessionIds: Set<string>,
): void {
  const codexSessions = deps.discoverCodexSessions();
  const liveCodexSessions = deps.discoverCodexLiveSessions(codexSessions);
  for (const codex of codexSessions) {
    if (claimedSessionIds.has(codex.sessionId)) continue;
    const observed = deps.getCodexObserver(codex.sessionId);
    const liveCodex = liveCodexSessions.get(codex.sessionId);
    const observedStatus = observed?.status;
    const codexStatus = liveCodex
      ? (observedStatus === SessionStatus.RUNNING || observedStatus === SessionStatus.PENDING_ACTIONS
        ? observedStatus
        : SessionStatus.READY)
      : SessionStatus.HISTORY;
    const terminal = liveCodex ? deps.resolveCodexTerminalTarget(codex.sessionId, liveCodex) : undefined;
    const capabilities = liveCodex ? deps.getCodexCapabilities(codex.sessionId) : ['observe'];
    out.push({
      entry: {
        session_id: codex.sessionId,
        agent_type: 'codex',
        agent_display_name: 'Codex',
        agent_version: codex.cliVersion,
        status: codexStatus,
        capabilities,
        working_directory: codex.cwd,
        project_name: codex.title ?? path.basename(codex.cwd),
        last_activity: observed?.lastActivity ?? codex.updatedAtMs,
        entrypoint: 'codex-cli',
        pid: liveCodex?.pid ?? terminal?.pid,
        is_observed: true,
      },
      historyKey: codex.sessionId,
    });
    claimedSessionIds.add(codex.sessionId);
  }
}

// ---------------------------------------------------------------------------
// Pending-action overlay + sort
// ---------------------------------------------------------------------------

function overlayPendingActions(deps: ListSessionsDeps, allSessions: CollectedEntry[]): void {
  const realPendingBySessionId = new Map<string, string>();
  for (const [reqId, entry] of deps.pendingBlockingRequests.entries()) {
    if (reqId.startsWith('startup_pending_')) continue;
    if (!realPendingBySessionId.has(entry.sessionId)) {
      realPendingBySessionId.set(entry.sessionId, entry.type);
    }
  }
  for (const item of allSessions) {
    const sid = item.entry.session_id as string;
    const pendingType = realPendingBySessionId.get(sid);
    if (pendingType && item.entry.status !== SessionStatus.PENDING_ACTIONS) {
      item.entry.status = SessionStatus.PENDING_ACTIONS;
      item.entry.action_type = pendingType;
    }
  }
}

function compareSessions(a: CollectedEntry, b: CollectedEntry): number {
  const aActive = ACTIVE_STATUSES.has(a.entry.status as SessionStatus) ? 1 : 0;
  const bActive = ACTIVE_STATUSES.has(b.entry.status as SessionStatus) ? 1 : 0;
  if (aActive !== bActive) return bActive - aActive;
  return ((b.entry.last_activity as number) ?? 0) - ((a.entry.last_activity as number) ?? 0);
}
