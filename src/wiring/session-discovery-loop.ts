// Agent Pocket — session discovery + observation (Step 1.9)
//
// Extracted from discoverAndObserveSessions (Claude) and
// discoverAndObserveCodexSessions (Codex) in src/index.ts. Both run from
// the discovery loop and reconcile the daemon's observation state with the
// CLI's PID/JSONL files (Claude) or rollout files (Codex).
//
// Heavy logic preserved verbatim (the /clear detection, PID-mismatch
// re-observation, and session-map.json fallback in Claude). Tests can
// inject the session-map helpers + sessionDiscovery to drive scenarios
// without touching the filesystem.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SessionStatus,
  type PcEvent,
  type SessionEndedEvent,
} from 'agent-pocket-protocol';
import type { SessionManager } from '../sessions/session-manager.js';
import type { BindingJournal } from '../persistence/binding-journal.js';
import type { TerminalTarget } from '../pty/tmux-injector.js';
import type { SessionDiscovery, DiscoveredSession, RunningCliSession } from '../discovery/session-discovery.js';
import type { CodexDiscovery, CodexSession } from '../discovery/codex-discovery.js';
import { CodexObserver } from '../observers/codex-observer.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Claude session discovery + observation
// ---------------------------------------------------------------------------

export interface ClaudeDiscoveryDeps {
  sessionDiscovery: Pick<SessionDiscovery, 'getRunningAllSessions' | 'discoverSessions'>;
  sessionManager: Pick<SessionManager,
    | 'getAllSessions'
    | 'findByClaudeSessionId'
    | 'findByTerminalPid'
    | 'observeSession'
    | 'removeSession'
    | 'markObservedSessionHistory'
  > & {
    // Optional: only present once binding-journal wiring lands. Falsy on
    // older callers / tests, in which case the orphan guard and standalone
    // rescue degrade to legacy behavior.
    getBindingJournal?: () => BindingJournal | null;
    findByLastKnownPid?: (pid: number) => { sessionId: string; claudeSessionId?: string } | undefined;
    rePromoteHistoryToObserved?: (
      sessionId: string,
      pid: number,
      jsonlPath: string,
      customTitle?: string,
      terminalTarget?: TerminalTarget,
    ) => boolean;
  };
  /** Live reference — handler mutates with set/delete. */
  sessionIdMap: Map<string, string>;
  /** Live reference — handler mutates with add. */
  replacedSessionIds: Set<string>;
  /** Read-live; gates per-session sendSessionHistory while initial discovery is happening. */
  isInitialDiscoveryDone(): boolean;
  sendToPhone(event: PcEvent): void;
  sendSessionHistory(claudeSessionId: string): void;

  // ----- session-map.json helpers (injected so tests can stub) -----
  readSessionMap(): Record<string, { pid?: number; cwd: string; timestamp: number }>;
  getLatestSessionMapEntryForPid(pid: number): { sessionId: string; cwd: string } | undefined;
  removeSessionMapEntries(sessionIds: string[]): void;

  // ----- test seams -----
  /** fs.statSync wrapper — defaults to node:fs.statSync. */
  statSyncFn?: (p: string) => { mtimeMs: number };
  /** process.kill wrapper — defaults to process.kill. */
  killFn?: (pid: number, signal: number) => void;
  /** Date.now wrapper — defaults to Date.now. */
  nowFn?: () => number;
}

/**
 * Anomaly A guard. A discovered JSONL file is safe to adopt onto an already
 * observed `pid` only if the SessionStart hook ITSELF wrote that
 * (sessionId, pid) pair into session-map.json. The hook is the single
 * authoritative signal for /clear (and `--resume`), and Claude Code does NOT
 * update `~/.claude/sessions/<pid>.json` on /clear, so PID JSON cannot be used
 * as corroboration.
 *
 * The binding journal is intentionally NOT consulted here: it can be poisoned
 * by an earlier (pre-fix) daemon run that mis-bound the same orphan JSONL
 * onto this PID, and that misbind would then perpetuate across restarts.
 *
 * If session-map data is unavailable (legacy / test path), fall back to the
 * permissive behavior so existing fixtures aren't disturbed.
 */
function passesAdoptionGuard(
  jsonlSessionId: string,
  pid: number,
  sessionMap: Record<string, { pid?: number }> | null | undefined,
): boolean {
  if (!sessionMap) return true;
  const entry = sessionMap[jsonlSessionId];
  return entry?.pid === pid;
}

/**
 * Cold-start standalone-PID newer-pick guard. The newer-pick at the standalone
 * branch happily promoted whichever fresh JSONL shared a project dir with the
 * PID's primary JSONL — including orphan graveyard files left behind by dead
 * `claude --resume <name>` invocations whose mtime got bumped by some other
 * process. The journal-aware version refuses orphans and journal poisoning:
 *
 *  - Require live PID-JSON corroboration that THIS pid currently owns
 *    `d.sessionId` (i.e. the candidate appears in `runningCli` for this PID).
 *    The journal alone is not enough — a previous (buggy) daemon run can
 *    have written observe events for an orphan JSONL onto this PID, and
 *    blindly trusting that record perpetuates the misbind across restarts.
 *  - When no journal is wired (legacy / test fallback), behave as before
 *    (no extra check).
 *
 * The /clear case (PID JSON sessionId rotates to a brand-new sid) still
 * passes: the new sid IS in `runningCli` for this PID by definition.
 */
function passesStandalonePidNewerPick(
  d: DiscoveredSession,
  pid: number,
  runningCli: ReadonlyArray<RunningCliSession>,
  journal: BindingJournal | null | undefined,
): boolean {
  if (!journal) return true;
  return runningCli.some(c => c.pid === pid && c.sessionId === d.sessionId);
}

// Exported for unit tests. The runtime path uses the local symbol.
export const __test_passesStandalonePidNewerPick = passesStandalonePidNewerPick;

export async function discoverAndObserveSessions(deps: ClaudeDiscoveryDeps): Promise<void> {
  const stat = deps.statSyncFn ?? ((p: string) => fs.statSync(p));
  const kill = deps.killFn ?? ((pid: number, sig: number) => process.kill(pid, sig));
  const now = deps.nowFn ?? (() => Date.now());

  try {
    const runningCli = deps.sessionDiscovery.getRunningAllSessions();
    if (runningCli.length === 0) return;

    const discovered = await deps.sessionDiscovery.discoverSessions();

    const observedSessions = deps.sessionManager.getAllSessions().filter(s => s.isObserved && s.terminalPid);

    const sessionIdsByPid = new Map<string, number>();
    for (const cli of runningCli) {
      sessionIdsByPid.set(cli.sessionId, cli.pid);
    }

    const sessionMapForGuard = (() => {
      try {
        return deps.readSessionMap();
      } catch {
        return null;
      }
    })();

    for (const session of observedSessions) {
      if (!session.observer || !session.terminalPid) continue;

      try { kill(session.terminalPid, 0); } catch { continue; }

      const currentJsonlPath = session.observer.getJsonlPath();
      try {
        const currentStat = stat(currentJsonlPath);
        if (now() - currentStat.mtimeMs < 10_000) continue;
      } catch { continue; }

      const projectDir = path.dirname(currentJsonlPath);

      const observedSessionIds = new Set(
        deps.sessionManager.getAllSessions()
          .filter(s => s.claudeSessionId)
          .map(s => s.claudeSessionId!),
      );

      const newerFile = discovered.find(d =>
        path.dirname(d.filePath) === projectDir &&
        !observedSessionIds.has(d.sessionId) &&
        d.lastModified > (session.lastActivity || 0) &&
        d.filePath !== currentJsonlPath &&
        (!sessionIdsByPid.has(d.sessionId) || sessionIdsByPid.get(d.sessionId) === session.terminalPid) &&
        !deps.replacedSessionIds.has(d.sessionId) &&
        // Anomaly A guard: only adopt if the SessionStart hook recorded this
        // exact (sessionId, pid) pair in session-map.json. That's the
        // authoritative /clear signal; without it, a fresh-mtime JSONL in the
        // same project dir is just an orphan / graveyard file and adopting
        // it produces the misbind reported in Anomaly A.
        passesAdoptionGuard(d.sessionId, session.terminalPid!, sessionMapForGuard),
      );

      if (newerFile) {
        const pid = session.terminalPid!;
        const cwd = session.workingDirectory;
        const target = session.terminalTarget;

        logger.info('daemon', 'Adopted JSONL onto observed PID (verified)', { oldClaudeSessionId: session.claudeSessionId, newClaudeSessionId: newerFile.sessionId, pid });
        deps.sessionManager.getBindingJournal?.()?.appendClear({
          pid,
          oldSessionId: session.claudeSessionId ?? '',
          newSessionId: newerFile.sessionId,
        });

        const oldInternalId = session.sessionId;
        const oldClaudeId = session.claudeSessionId;

        if (oldClaudeId) {
          const endEvent: SessionEndedEvent = {
            type: 'session_ended',
            session_id: oldClaudeId,
            exit_code: 0,
            end_reason: 'completed',
          };
          deps.sendToPhone(endEvent);
        }

        deps.sessionManager.markObservedSessionHistory(oldInternalId, 'session_replaced');
        deps.sessionIdMap.delete(oldInternalId);
        deps.sessionManager.removeSession(oldInternalId);
        if (oldClaudeId) deps.replacedSessionIds.add(oldClaudeId);

        const newInternalId = deps.sessionManager.observeSession(
          newerFile.sessionId,
          newerFile.filePath,
          cwd,
          pid,
          newerFile.customTitle,
          target,
          session.entrypoint,
        );
        deps.sessionIdMap.set(newInternalId, newerFile.sessionId);
        if (deps.isInitialDiscoveryDone()) {
          deps.sendSessionHistory(newerFile.sessionId);
        }

        const termInfo = target ? ` [${target.type}: ${target.target}]` : '';
        logger.debug('daemon', `Now observing ${newerFile.sessionId} (PID ${pid})${termInfo}`);
      }
    }

    for (const pidInfo of runningCli) {
      const mapEntry = deps.getLatestSessionMapEntryForPid(pidInfo.pid);
      if (mapEntry && mapEntry.sessionId !== pidInfo.sessionId) {
        deps.replacedSessionIds.add(pidInfo.sessionId);
        pidInfo.sessionId = mapEntry.sessionId;
        pidInfo.cwd = mapEntry.cwd;
      }

      if (deps.sessionManager.findByClaudeSessionId(pidInfo.sessionId)) continue;

      const existingByPid = deps.sessionManager.findByTerminalPid(pidInfo.pid);
      if (existingByPid && existingByPid.claudeSessionId !== pidInfo.sessionId
          && !deps.replacedSessionIds.has(pidInfo.sessionId)) {
        logger.warn('daemon', 'PID session ID mismatch — re-observing', { pid: pidInfo.pid, observed: existingByPid.claudeSessionId, pidFile: pidInfo.sessionId });

        const match = discovered.find((s) => s.sessionId === pidInfo.sessionId);
        if (match) {
          const oldInternalId = existingByPid.sessionId;
          const oldClaudeId = existingByPid.claudeSessionId;

          deps.sessionManager.markObservedSessionHistory(oldInternalId, 'session_replaced');
          deps.sessionIdMap.delete(oldInternalId);
          deps.sessionManager.removeSession(oldInternalId);
          if (oldClaudeId) deps.replacedSessionIds.add(oldClaudeId);

          const newInternalId = deps.sessionManager.observeSession(
            pidInfo.sessionId,
            match.filePath,
            pidInfo.cwd,
            pidInfo.pid,
            match.customTitle,
            pidInfo.terminalTarget,
            pidInfo.entrypoint,
          );
          deps.sessionIdMap.set(newInternalId, pidInfo.sessionId);

          if (deps.isInitialDiscoveryDone()) {
            deps.sendSessionHistory(pidInfo.sessionId);
          }

          const termInfo = pidInfo.terminalTarget ? ` [${pidInfo.terminalTarget.type}: ${pidInfo.terminalTarget.target}]` : ' [no terminal injection]';
          logger.debug('daemon', `Re-observing PID ${pidInfo.pid} with updated session ${pidInfo.sessionId}${termInfo}`);
        }
        continue;
      }

      if (existingByPid) continue;

      if (deps.replacedSessionIds.has(pidInfo.sessionId)) {
        const mapped = deps.readSessionMap();
        let corrected: [string, { pid?: number; cwd: string; timestamp: number }] | undefined;
        const staleSids: string[] = [];
        for (const [sid, v] of Object.entries(mapped)) {
          if (v.pid !== pidInfo.pid) continue;
          if (deps.sessionManager.findByClaudeSessionId(sid)) { staleSids.push(sid); continue; }
          if (deps.replacedSessionIds.has(sid)) { staleSids.push(sid); continue; }
          if (!corrected || v.timestamp > corrected[1].timestamp) {
            if (corrected) staleSids.push(corrected[0]);
            corrected = [sid, v];
          } else {
            staleSids.push(sid);
          }
        }
        if (staleSids.length > 0) {
          deps.removeSessionMapEntries(staleSids);
        }
        if (!corrected) continue;
        const newSessionId = corrected[0];
        const mapEntryRecovered = corrected[1];
        const match = discovered.find((s) => s.sessionId === newSessionId);
        if (!match) continue;

        logger.info('daemon', 'Recovered session from session-map.json', { pid: pidInfo.pid, staleSessionId: pidInfo.sessionId, newSessionId });
        const newInternalId = deps.sessionManager.observeSession(
          newSessionId,
          match.filePath,
          mapEntryRecovered.cwd,
          pidInfo.pid,
          match.customTitle,
          pidInfo.terminalTarget,
          pidInfo.entrypoint,
        );
        deps.sessionIdMap.set(newInternalId, newSessionId);
        if (deps.isInitialDiscoveryDone()) {
          deps.sendSessionHistory(newSessionId);
        }
        continue;
      }

      const match = discovered.find((s) => s.sessionId === pidInfo.sessionId);
      if (!match) {
        // Standalone-PID rescue (Anomaly B): the CLI PID is alive but the
        // JSONL discovery couldn't match it. Consult the binding journal —
        // if we previously observed this PID and historified it (e.g. due
        // to a transient zombie/suspended check), re-promote that record
        // back to observed instead of leaving the PID invisible.
        const journal = deps.sessionManager.getBindingJournal?.();
        const lastObserve = journal?.lastObserveForPid(pidInfo.pid);
        if (lastObserve) {
          const historified = deps.sessionManager.findByLastKnownPid?.(pidInfo.pid);
          if (historified && historified.claudeSessionId === lastObserve.claudeSessionId) {
            const repromoted = deps.sessionManager.rePromoteHistoryToObserved?.(
              historified.sessionId,
              pidInfo.pid,
              lastObserve.jsonlPath,
              undefined,
              pidInfo.terminalTarget,
            );
            if (repromoted) {
              deps.sessionIdMap.set(historified.sessionId, lastObserve.claudeSessionId);
              logger.info('daemon', 'Re-promoted historified session via binding journal', {
                pid: pidInfo.pid,
                claudeSessionId: lastObserve.claudeSessionId,
              });
              continue;
            }
          }
        }
        continue;
      }

      let observeMatch = match;
      let observeSessionId = pidInfo.sessionId;
      const projectDir = path.dirname(match.filePath);
      const otherPidSids = new Set(
        runningCli.filter(c => c.pid !== pidInfo.pid).map(c => c.sessionId),
      );
      const newer = discovered
        .filter(d => path.dirname(d.filePath) === projectDir)
        .filter(d => !otherPidSids.has(d.sessionId))
        .filter(d => !deps.replacedSessionIds.has(d.sessionId))
        .filter(d => d.lastModified > match.lastModified)
        .filter(d => passesStandalonePidNewerPick(
          d,
          pidInfo.pid,
          runningCli,
          deps.sessionManager.getBindingJournal?.(),
        ))
        .sort((a, b) => b.lastModified - a.lastModified)[0];
      if (newer) {
        observeMatch = newer;
        observeSessionId = newer.sessionId;
        deps.replacedSessionIds.add(pidInfo.sessionId);
      }

      const sessionId = deps.sessionManager.observeSession(
        observeSessionId,
        observeMatch.filePath,
        pidInfo.cwd,
        pidInfo.pid,
        observeMatch.customTitle,
        pidInfo.terminalTarget,
        pidInfo.entrypoint,
      );

      deps.sessionIdMap.set(sessionId, observeSessionId);

      if (deps.isInitialDiscoveryDone()) {
        deps.sendSessionHistory(observeSessionId);
      }

      logger.info('daemon', 'Observing CLI session', { claudeSessionId: observeSessionId, pid: pidInfo.pid });
    }
  } catch (err) {
    logger.error('daemon', `Error discovering sessions: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Codex session discovery + observation
// ---------------------------------------------------------------------------

export interface CodexObserverEntry {
  observer: CodexObserver;
  session: CodexSession;
  status: SessionStatus;
  lastActivity: number;
}

export interface CodexDiscoveryDeps {
  codexDiscovery: Pick<CodexDiscovery, 'discoverSessions' | 'discoverLiveSessions'>;
  /** Live reference — handler reads via .get and inserts via .set. */
  codexObservers: Map<string, CodexObserverEntry>;
  isInitialDiscoveryDone(): boolean;
  sendToPhone(event: PcEvent): void;
  attachCodexObserverHandlers(tracked: CodexObserverEntry): void;

  // ----- test seams -----
  /** Factory for CodexObserver — defaults to `new CodexObserver(...)`. */
  createObserver?: (sessionId: string, rolloutPath: string) => CodexObserver;
  nowFn?: () => number;
}

export function discoverAndObserveCodexSessions(deps: CodexDiscoveryDeps): void {
  const create = deps.createObserver ?? ((sid: string, rp: string) => new CodexObserver(sid, rp));
  const now = deps.nowFn ?? (() => Date.now());

  try {
    const sessions = deps.codexDiscovery.discoverSessions();
    const liveSessions = deps.codexDiscovery.discoverLiveSessions(sessions);
    for (const session of sessions) {
      const existing = deps.codexObservers.get(session.sessionId);
      if (existing) {
        const live = liveSessions.has(session.sessionId);
        const nextStatus = live
          ? (existing.status === SessionStatus.RUNNING || existing.status === SessionStatus.PENDING_ACTIONS ? existing.status : SessionStatus.READY)
          : SessionStatus.HISTORY;
        if (existing.status !== nextStatus) {
          existing.status = nextStatus;
          existing.lastActivity = now();
          if (deps.isInitialDiscoveryDone()) {
            deps.sendToPhone({
              type: 'session_status',
              session_id: session.sessionId,
              status: nextStatus,
            } as unknown as PcEvent);
          }
        }
        continue;
      }
      const observer = create(session.sessionId, session.rolloutPath);
      const initialStatus = liveSessions.has(session.sessionId) ? SessionStatus.READY : SessionStatus.HISTORY;
      const tracked: CodexObserverEntry = {
        observer,
        session,
        status: initialStatus,
        lastActivity: session.updatedAtMs ?? now(),
      };
      deps.codexObservers.set(session.sessionId, tracked);
      deps.attachCodexObserverHandlers(tracked);
      observer.start();
    }
  } catch (err) {
    logger.warn('codex-discovery', `Error discovering Codex sessions: ${(err as Error).message}`);
  }
}
