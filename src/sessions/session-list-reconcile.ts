import type { RunningCliSession } from '../discovery/session-discovery.js';
import type { SessionState } from './session-manager.js';

export interface SessionListReconcileIndexes {
  runningByPid: Map<number, RunningCliSession>;
  runningPidBySessionId: Map<string, number>;
}

export function createSessionListReconcileIndexes(running: RunningCliSession[]): SessionListReconcileIndexes {
  const runningByPid = new Map<number, RunningCliSession>();
  const runningPidBySessionId = new Map<string, number>();

  for (const session of running) {
    runningByPid.set(session.pid, session);
    if (session.sessionId) {
      runningPidBySessionId.set(session.sessionId, session.pid);
    }
  }

  return { runningByPid, runningPidBySessionId };
}

export function isObservedSessionPidBindingStale(
  session: Pick<SessionState, 'claudeSessionId' | 'terminalPid' | 'isObserved'>,
  indexes: SessionListReconcileIndexes,
): boolean {
  if (!session.isObserved || !session.terminalPid || !session.claudeSessionId) return false;

  const liveForPid = indexes.runningByPid.get(session.terminalPid);
  if (liveForPid && liveForPid.sessionId !== session.claudeSessionId) {
    return true;
  }

  const livePidForSession = indexes.runningPidBySessionId.get(session.claudeSessionId);
  if (livePidForSession !== undefined && livePidForSession !== session.terminalPid) {
    return true;
  }

  return false;
}
