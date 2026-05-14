// Agent Pocket — Session Map
// Read/write helpers for ~/.agent-pocket/session-map.json, the file written
// by the SessionStart hook script that records, for each Claude session ID,
// the spawning PID, working directory, and transcript path.
//
// The daemon reads this file to recover the correct sessionId/cwd after
// /clear or worktree launches, and garbage-collects entries whose PID has
// died or whose transcript file is gone.
//
// All file I/O is best-effort: malformed JSON, missing files, and write
// errors are swallowed and treated as empty state. Functions are pure with
// respect to the file path argument so they can be unit-tested with a temp
// file.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../logger.js';

export interface SessionMapEntry {
  source: string;
  cwd: string;
  transcript_path?: string;
  pid?: number;
  timestamp: number;
}

export type SessionMap = Record<string, SessionMapEntry>;

export interface LatestSessionMapMatch {
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  timestamp: number;
}

/**
 * Default location of the session-map file written by the SessionStart hook.
 */
export const DEFAULT_SESSION_MAP_PATH = path.join(
  os.homedir(),
  '.agent-pocket',
  'session-map.json',
);

/**
 * Read ~/.agent-pocket/session-map.json. Returns an empty object if the file
 * is missing or unreadable.
 *
 * Defensive filter: subagent SessionStart events (older daemon versions
 * wrote them) share the parent Claude PID and would clobber the real
 * session-id mapping. Identify by transcript path under /subagents/.
 */
export function readSessionMap(mapFile: string = DEFAULT_SESSION_MAP_PATH): SessionMap {
  try {
    if (!fs.existsSync(mapFile)) return {};
    const raw = fs.readFileSync(mapFile, 'utf-8');
    const parsed = JSON.parse(raw) as SessionMap;
    const filtered: SessionMap = {};
    for (const [sid, v] of Object.entries(parsed)) {
      if (v.transcript_path && v.transcript_path.includes('/subagents/')) continue;
      filtered[sid] = v;
    }
    return filtered;
  } catch {
    return {};
  }
}

/**
 * Find the most recent session-map entry for `pid` whose transcript file
 * still exists on disk. Returns the corrected sessionId + cwd + transcript
 * path so callers can bypass (potentially stale) PID JSON metadata.
 *
 * Why: ~/.claude/sessions/<pid>.json records `sessionId`/`cwd` from the
 * process's first session. After /clear (and sometimes after a worktree
 * launch where cwd is recorded incorrectly), it stops matching reality.
 * The SessionStart hook always writes the correct values to session-map,
 * which persists across daemon restarts.
 */
export function getLatestSessionMapEntryForPid(
  pid: number,
  mapFile: string = DEFAULT_SESSION_MAP_PATH,
): LatestSessionMapMatch | undefined {
  const mapped = readSessionMap(mapFile);
  let best: LatestSessionMapMatch | undefined;
  for (const [sid, v] of Object.entries(mapped)) {
    if (v.pid !== pid) continue;
    if (v.transcript_path && !fs.existsSync(v.transcript_path)) continue;
    if (!best || v.timestamp > best.timestamp) {
      best = {
        sessionId: sid,
        cwd: v.cwd,
        transcriptPath: v.transcript_path,
        timestamp: v.timestamp,
      };
    }
  }
  return best;
}

/**
 * Garbage-collect session-map.json: remove entries whose PID is no longer
 * alive or whose transcript file is gone. Catches entries that were never
 * observed by this daemon (e.g. CLIs that started+ended before launch) and
 * stale entries left behind by PID reuse.
 *
 * `isPidAlive` defaults to `process.kill(pid, 0)`; injectable for tests.
 *
 * Returns the list of removed session IDs (empty if nothing changed).
 */
export function gcSessionMap(
  mapFile: string = DEFAULT_SESSION_MAP_PATH,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): string[] {
  try {
    if (!fs.existsSync(mapFile)) return [];
    const raw = fs.readFileSync(mapFile, 'utf-8');
    const map = JSON.parse(raw) as Record<string, { pid?: number; transcript_path?: string }>;
    const removed: string[] = [];
    for (const [sid, entry] of Object.entries(map)) {
      let dead = false;
      // pid<=0 means the hook couldn't resolve a real Claude PID; the
      // entry can never match a live process, so drop it.
      if (!entry.pid || entry.pid <= 0) {
        dead = true;
      } else if (!isPidAlive(entry.pid)) {
        dead = true;
      }
      if (!dead && entry.transcript_path && !fs.existsSync(entry.transcript_path)) {
        dead = true;
      }
      if (dead) {
        delete map[sid];
        removed.push(sid);
      }
    }
    if (removed.length > 0) {
      fs.writeFileSync(mapFile, JSON.stringify(map), 'utf-8');
      logger.debug('daemon', 'GC session-map', { removed: removed.length });
    }
    return removed;
  } catch {
    return [];
  }
}

/**
 * Remove session-map.json entries whose PID is in `deadPids`.
 * Returns the list of removed session IDs.
 */
export function cleanSessionMap(
  deadPids: number[],
  mapFile: string = DEFAULT_SESSION_MAP_PATH,
): string[] {
  try {
    if (!fs.existsSync(mapFile)) return [];
    const raw = fs.readFileSync(mapFile, 'utf-8');
    const map = JSON.parse(raw) as Record<string, { pid?: number }>;
    const deadSet = new Set(deadPids);
    const removed: string[] = [];
    for (const [sid, entry] of Object.entries(map)) {
      if (entry.pid && deadSet.has(entry.pid)) {
        delete map[sid];
        removed.push(sid);
      }
    }
    if (removed.length > 0) {
      fs.writeFileSync(mapFile, JSON.stringify(map), 'utf-8');
      logger.trace('daemon', 'Cleaned session-map entries for dead PIDs', { deadPids });
    }
    return removed;
  } catch {
    return [];
  }
}

/**
 * Remove specific session IDs from session-map.json.
 * Returns the list of session IDs that were actually removed.
 */
export function removeSessionMapEntries(
  sessionIds: string[],
  mapFile: string = DEFAULT_SESSION_MAP_PATH,
): string[] {
  try {
    if (!fs.existsSync(mapFile)) return [];
    const raw = fs.readFileSync(mapFile, 'utf-8');
    const map = JSON.parse(raw) as Record<string, unknown>;
    const removed: string[] = [];
    for (const sid of sessionIds) {
      if (sid in map) {
        delete map[sid];
        removed.push(sid);
      }
    }
    if (removed.length > 0) {
      fs.writeFileSync(mapFile, JSON.stringify(map), 'utf-8');
      logger.trace('daemon', 'Removed stale session-map entries', { sessionIds });
    }
    return removed;
  } catch {
    return [];
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
