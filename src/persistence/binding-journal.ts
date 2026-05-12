// Agent Pocket — Binding Journal
// Append-only ledger of (pid, claudeSessionId, jsonlPath) state transitions
// at ~/.agent-pocket/binding.jsonl. Replaces the empirically-unreliable lsof
// primitive: lsof on JSONL paths returns nothing because Claude opens/appends/
// closes per write, so the daemon needs its own truth source for what each
// PID is currently bound to.
//
// Five event types, one line each (JSONL):
//   - observe:    SessionManager.observeSession success
//   - historify:  markObservedSessionHistory (records reason: HistorifyReason)
//   - clear:      session-discovery-loop "Detected /clear" / SessionStart(clear)
//   - pid-exited: index.ts checkObservedSessionPids exit branch
//   - remove:     SessionManager.removeSession (when not preceded by historify)
//
// Read APIs scan the file in reverse to find the most-recent record per key.
// Compaction (every 100th discovery tick) drops events for claudeSessionIds
// whose JSONL is no longer on disk.
//
// All file I/O is best-effort: write/read failures are swallowed and logged.
// The daemon must continue to function (degraded) if the journal is broken.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HistorifyReason =
  | 'pid_exited'
  | 'pid_zombie'
  | 'pid_suspended'
  | 'session_end_clear'
  | 'session_end_other'
  | 'session_replaced'
  | 'controller_aborted'
  | 'controller_non_resumable'
  | 'emergency_abort'
  | 'unknown';

interface BindingEventBase {
  ts: number;
}

export interface ObserveEvent extends BindingEventBase {
  event: 'observe';
  pid: number;
  sessionId: string;        // claudeSessionId
  cwd: string;
  jsonlPath: string;
  customTitle?: string;
  entrypoint?: string;
}

export interface HistorifyEvent extends BindingEventBase {
  event: 'historify';
  pid: number;
  sessionId: string;
  reason: HistorifyReason;
}

export interface ClearEvent extends BindingEventBase {
  event: 'clear';
  pid: number;
  oldSessionId: string;
  newSessionId: string;
}

export interface PidExitedEvent extends BindingEventBase {
  event: 'pid-exited';
  pid: number;
  sessionId: string;
}

export interface RemoveEvent extends BindingEventBase {
  event: 'remove';
  pid?: number;
  sessionId: string;
}

export type BindingEvent =
  | ObserveEvent
  | HistorifyEvent
  | ClearEvent
  | PidExitedEvent
  | RemoveEvent;

// ---------------------------------------------------------------------------
// Default path + factory
// ---------------------------------------------------------------------------

export const DEFAULT_BINDING_JOURNAL_PATH = path.join(
  os.homedir(),
  '.agent-pocket',
  'binding.jsonl',
);

export interface BindingJournalDeps {
  /** Absolute path to the journal file. Defaults to ~/.agent-pocket/binding.jsonl. */
  filePath?: string;
  /** fs module — overridable for tests. */
  fsModule?: Pick<typeof fs, 'appendFileSync' | 'readFileSync' | 'existsSync' | 'writeFileSync' | 'mkdirSync' | 'renameSync' | 'unlinkSync'>;
  /** Date.now wrapper. */
  nowFn?: () => number;
  /** Predicate for "JSONL still exists on disk" (for compaction filtering). */
  jsonlExistsFn?: (jsonlPath: string) => boolean;
}

// ---------------------------------------------------------------------------
// Journal class
// ---------------------------------------------------------------------------

export class BindingJournal {
  private readonly filePath: string;
  private readonly fs: NonNullable<BindingJournalDeps['fsModule']>;
  private readonly now: () => number;
  private readonly jsonlExists: (p: string) => boolean;

  constructor(deps: BindingJournalDeps = {}) {
    this.filePath = deps.filePath ?? DEFAULT_BINDING_JOURNAL_PATH;
    this.fs = deps.fsModule ?? fs;
    this.now = deps.nowFn ?? (() => Date.now());
    this.jsonlExists = deps.jsonlExistsFn ?? ((p: string) => fs.existsSync(p));
  }

  // -------------------------------------------------------------------------
  // Write APIs
  // -------------------------------------------------------------------------

  appendObserve(args: Omit<ObserveEvent, 'ts' | 'event'>): void {
    this.append({ event: 'observe', ts: this.now(), ...args });
  }

  appendHistorify(args: Omit<HistorifyEvent, 'ts' | 'event'>): void {
    this.append({ event: 'historify', ts: this.now(), ...args });
  }

  appendClear(args: Omit<ClearEvent, 'ts' | 'event'>): void {
    this.append({ event: 'clear', ts: this.now(), ...args });
  }

  appendPidExited(args: Omit<PidExitedEvent, 'ts' | 'event'>): void {
    this.append({ event: 'pid-exited', ts: this.now(), ...args });
  }

  appendRemove(args: Omit<RemoveEvent, 'ts' | 'event'>): void {
    this.append({ event: 'remove', ts: this.now(), ...args });
  }

  private append(event: BindingEvent): void {
    try {
      this.ensureDir();
      this.fs.appendFileSync(this.filePath, JSON.stringify(event) + '\n', 'utf-8');
    } catch (err) {
      logger.warn('binding-journal', `append failed: ${(err as Error).message}`);
    }
  }

  private ensureDir(): void {
    const dir = path.dirname(this.filePath);
    try {
      this.fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore — appendFileSync will fail loudly if dir truly missing
    }
  }

  // -------------------------------------------------------------------------
  // Read APIs
  // -------------------------------------------------------------------------

  /**
   * Read all events from the journal. Returns [] on any error or if the file
   * doesn't exist. Malformed lines are skipped silently.
   */
  readAll(): BindingEvent[] {
    if (!this.fs.existsSync(this.filePath)) return [];
    let raw: string;
    try {
      raw = this.fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      logger.warn('binding-journal', `read failed: ${(err as Error).message}`);
      return [];
    }
    const events: BindingEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as BindingEvent;
        if (parsed && typeof parsed === 'object' && 'event' in parsed) {
          events.push(parsed);
        }
      } catch {
        // skip malformed line
      }
    }
    return events;
  }

  /**
   * Find the most recent observe event for `pid` whose record has not been
   * superseded by a later historify/clear/pid-exited/remove for the same
   * sessionId. Returns undefined if no live binding exists for this PID.
   */
  lastObserveForPid(pid: number): { claudeSessionId: string; jsonlPath: string; cwd: string; ts: number } | undefined {
    const events = this.readAll();
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (!('pid' in ev) || ev.pid !== pid) continue;
      if (ev.event === 'observe') {
        const sid = ev.sessionId;
        for (let j = events.length - 1; j > i; j--) {
          const later = events[j];
          if ('sessionId' in later && later.sessionId === sid) {
            if (later.event === 'historify' || later.event === 'remove' || later.event === 'pid-exited') {
              return undefined;
            }
          }
        }
        return { claudeSessionId: sid, jsonlPath: ev.jsonlPath, cwd: ev.cwd, ts: ev.ts };
      }
      if (ev.event === 'clear') {
        return this.lastObserveForSessionId(ev.newSessionId);
      }
      return undefined;
    }
    return undefined;
  }

  /**
   * Find the most recent observe event whose sessionId matches.
   */
  lastObserveForSessionId(claudeSessionId: string): { claudeSessionId: string; jsonlPath: string; cwd: string; ts: number; pid: number } | undefined {
    const events = this.readAll();
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.event === 'observe' && ev.sessionId === claudeSessionId) {
        return { claudeSessionId, jsonlPath: ev.jsonlPath, cwd: ev.cwd, ts: ev.ts, pid: ev.pid };
      }
    }
    return undefined;
  }

  /**
   * Find the most recent observe event for `jsonlPath` (regardless of
   * sessionId — relevant when a JSONL is reused by `claude --resume <name>`).
   * Used by Anomaly A's three-state predicate to verify the candidate is the
   * legitimate most-recent observer of the JSONL.
   */
  lastObserveForJsonl(jsonlPath: string): { pid: number; claudeSessionId: string; ts: number } | undefined {
    const events = this.readAll();
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.event === 'observe' && ev.jsonlPath === jsonlPath) {
        return { pid: ev.pid, claudeSessionId: ev.sessionId, ts: ev.ts };
      }
    }
    return undefined;
  }

  /**
   * Replay the journal in chronological order, returning the live binding
   * for each currently-alive PID. Used at cold start to seed the
   * SessionManager BEFORE the first discovery tick.
   */
  liveBindingsAtBoot(livePids: ReadonlyArray<number>): Array<{ pid: number; claudeSessionId: string; jsonlPath: string; cwd: string; customTitle?: string; entrypoint?: string }> {
    const liveSet = new Set(livePids);
    const byPid = new Map<number, ObserveEvent>();
    const cleared = new Set<string>();
    const events = this.readAll();
    for (const ev of events) {
      if (ev.event === 'observe') {
        if (!liveSet.has(ev.pid)) continue;
        byPid.set(ev.pid, ev);
        cleared.delete(ev.sessionId);
      } else if (ev.event === 'clear') {
        const cur = byPid.get(ev.pid);
        if (cur && cur.sessionId === ev.oldSessionId) byPid.delete(ev.pid);
      } else if (ev.event === 'historify' || ev.event === 'remove' || ev.event === 'pid-exited') {
        cleared.add(ev.sessionId);
        const pidOnEvent = 'pid' in ev ? ev.pid : undefined;
        const cur = pidOnEvent !== undefined ? byPid.get(pidOnEvent) : undefined;
        if (cur && cur.sessionId === ev.sessionId) byPid.delete(cur.pid);
      }
    }
    const out: Array<{ pid: number; claudeSessionId: string; jsonlPath: string; cwd: string; customTitle?: string; entrypoint?: string }> = [];
    for (const ev of byPid.values()) {
      if (cleared.has(ev.sessionId)) continue;
      out.push({
        pid: ev.pid,
        claudeSessionId: ev.sessionId,
        jsonlPath: ev.jsonlPath,
        cwd: ev.cwd,
        customTitle: ev.customTitle,
        entrypoint: ev.entrypoint,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Compaction
  // -------------------------------------------------------------------------

  /**
   * Drop events whose claudeSessionId no longer has a JSONL on disk. Writes
   * the surviving events back via rename-replace. Best-effort: any failure
   * leaves the original file intact.
   */
  compact(): void {
    const events = this.readAll();
    if (events.length === 0) return;
    const aliveSessionIds = new Set(
      events
        .filter((e): e is ObserveEvent => e.event === 'observe')
        .filter((e) => this.jsonlExists(e.jsonlPath))
        .map((e) => e.sessionId),
    );
    const compacted = events.filter((ev) => {
      if (ev.event === 'observe') return aliveSessionIds.has(ev.sessionId);
      if (ev.event === 'clear') return aliveSessionIds.has(ev.newSessionId) || aliveSessionIds.has(ev.oldSessionId);
      return aliveSessionIds.has(ev.sessionId);
    });
    if (compacted.length === events.length) return;
    const tmpPath = this.filePath + '.compact.tmp';
    try {
      this.fs.writeFileSync(
        tmpPath,
        compacted.length > 0 ? compacted.map((e) => JSON.stringify(e)).join('\n') + '\n' : '',
        'utf-8',
      );
      this.fs.renameSync(tmpPath, this.filePath);
      logger.info('binding-journal', `compacted ${events.length} -> ${compacted.length} events`);
    } catch (err) {
      logger.warn('binding-journal', `compaction failed: ${(err as Error).message}`);
      try {
        this.fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  }
}
