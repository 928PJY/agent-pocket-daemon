export interface SessionMapEntry {
  pid?: number;
  transcript_path?: string;
  timestamp?: number;
  missing_since?: number;
  dead_since?: number;
  [key: string]: unknown;
}

export type SessionMap = Record<string, SessionMapEntry>;

export interface SessionMapGcOptions {
  now: number;
  isPidAlive: (pid: number) => boolean;
  transcriptExists: (path: string) => boolean;
  confirmMissingMs?: number;
  confirmDeadMs?: number;
}

export interface SessionMapGcResult {
  map: SessionMap;
  changed: boolean;
  removed: string[];
  markedMissing: string[];
  markedDead: string[];
}

const DEFAULT_CONFIRM_MISSING_MS = 90_000;
const DEFAULT_CONFIRM_DEAD_MS = 30_000;

export function gcSessionMapEntries(map: SessionMap, options: SessionMapGcOptions): SessionMapGcResult {
  const next: SessionMap = cloneMap(map);
  const removed: string[] = [];
  const markedMissing: string[] = [];
  const markedDead: string[] = [];
  const confirmMissingMs = options.confirmMissingMs ?? DEFAULT_CONFIRM_MISSING_MS;
  const confirmDeadMs = options.confirmDeadMs ?? DEFAULT_CONFIRM_DEAD_MS;
  let changed = false;

  for (const [sid, entry] of Object.entries(next)) {
    const pid = entry.pid;
    const shouldPreserve = isMostRecentForPid(sid, entry, next);

    if (!pid || pid <= 0) {
      if (!shouldPreserve) {
        delete next[sid];
        removed.push(sid);
        changed = true;
      }
      continue;
    }

    if (!options.isPidAlive(pid)) {
      if (shouldPreserve) {
        if (entry.dead_since === undefined) {
          entry.dead_since = options.now;
          markedDead.push(sid);
          changed = true;
        }
      } else if (entry.dead_since !== undefined && options.now - entry.dead_since >= confirmDeadMs) {
        delete next[sid];
        removed.push(sid);
        changed = true;
      } else if (entry.dead_since === undefined) {
        entry.dead_since = options.now;
        markedDead.push(sid);
        changed = true;
      }
      continue;
    }

    if (entry.dead_since !== undefined) {
      delete entry.dead_since;
      changed = true;
    }

    if (entry.transcript_path && !options.transcriptExists(entry.transcript_path)) {
      if (shouldPreserve) {
        if (entry.missing_since === undefined) {
          entry.missing_since = options.now;
          markedMissing.push(sid);
          changed = true;
        }
      } else if (entry.missing_since !== undefined && options.now - entry.missing_since >= confirmMissingMs) {
        delete next[sid];
        removed.push(sid);
        changed = true;
      } else if (entry.missing_since === undefined) {
        entry.missing_since = options.now;
        markedMissing.push(sid);
        changed = true;
      }
      continue;
    }

    if (entry.missing_since !== undefined) {
      delete entry.missing_since;
      changed = true;
    }
  }

  return { map: next, changed, removed, markedMissing, markedDead };
}

export function removeSessionMapEntriesConservatively(map: SessionMap, sessionIds: string[]): SessionMapGcResult {
  const next: SessionMap = cloneMap(map);
  const removed: string[] = [];
  let changed = false;

  for (const sid of sessionIds) {
    const entry = next[sid];
    if (!entry) continue;
    if (entry.pid !== undefined && isMostRecentForPid(sid, entry, next)) continue;
    delete next[sid];
    removed.push(sid);
    changed = true;
  }

  return { map: next, changed, removed, markedMissing: [], markedDead: [] };
}

function isMostRecentForPid(sid: string, entry: SessionMapEntry, map: SessionMap): boolean {
  if (!entry.pid || entry.pid <= 0) return false;
  const timestamp = entry.timestamp ?? 0;

  for (const [otherSid, other] of Object.entries(map)) {
    if (otherSid === sid || other.pid !== entry.pid) continue;
    const otherTimestamp = other.timestamp ?? 0;
    if (otherTimestamp > timestamp || (otherTimestamp === timestamp && otherSid > sid)) {
      return false;
    }
  }

  return true;
}

function cloneMap(map: SessionMap): SessionMap {
  return Object.fromEntries(Object.entries(map).map(([sid, entry]) => [sid, { ...entry }]));
}
