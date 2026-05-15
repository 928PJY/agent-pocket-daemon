// Per-session sdk_uuid → session_seq allocator that persists to disk.
//
// Why this exists: prior to PEER_CAPABILITIES.MESSAGES_SEQ_AUTHORITATIVE, the
// daemon used two independent in-memory counters — one in JSONL parse code
// (`i+1` over the chronologically-sorted history) and one in
// notification-bookkeeping (`sessionSeqCounters: Map<sessionId, number>`).
// Both were lost on daemon restart, and the parse-time counter could even
// re-shuffle on re-parse (when JSONL grew). The phone, which uses
// `session_seq` as its canonical sort key, would then see the same message
// at a different seq across reconnects → reorderings and dedup failures.
//
// The allocator below assigns a stable monotonic seq to each unique
// (sdk_uuid[:blockIndex]) key per session and persists the mapping to
// `~/.claude/sessions/<sessionId>.seqmap.json`. Both the JSONL parse path
// and the live `session_output` emission path go through this single
// allocator, so seq values are consistent across the two streams and across
// process restarts.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../logger.js';

const SEQMAP_DIR = path.join(os.homedir(), '.claude', 'sessions');
const SEQMAP_VERSION = 1;

interface SeqmapFile {
  version: number;
  /** Next seq to hand out for an unseen key. */
  nextSeq: number;
  /** sdk_uuid (or `sdk_uuid:blockIndex`) → assigned seq. */
  entries: Record<string, number>;
}

/**
 * Compose the lookup key. Most rows have only `sdkUuid`. Multi-block
 * assistant rows reuse one `sdkUuid` across blocks; we disambiguate via
 * `blockIndex` so each block gets its own seq slot.
 */
export function seqmapKey(sdkUuid: string, blockIndex?: number): string {
  return blockIndex === undefined ? sdkUuid : `${sdkUuid}:${blockIndex}`;
}

/** Per-session allocator. One instance is cached per session by the manager. */
export class SessionSeqAllocator {
  private nextSeq: number;
  private readonly entries: Map<string, number>;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly file: string;

  constructor(private readonly sessionId: string, file: string, snapshot: SeqmapFile | null) {
    this.file = file;
    if (snapshot && snapshot.version === SEQMAP_VERSION) {
      this.nextSeq = snapshot.nextSeq;
      this.entries = new Map(Object.entries(snapshot.entries));
    } else {
      this.nextSeq = 1;
      this.entries = new Map();
    }
  }

  /** Look up the seq for a key without assigning. Used by parse to detect
   *  whether a JSONL row is already known. */
  peek(sdkUuid: string, blockIndex?: number): number | undefined {
    return this.entries.get(seqmapKey(sdkUuid, blockIndex));
  }

  /**
   * Look up or assign a stable seq for `(sdkUuid, blockIndex)`. Same
   * arguments always return the same seq — even across daemon restarts
   * (after the initial restart loads the persisted snapshot).
   */
  getOrAssign(sdkUuid: string, blockIndex?: number): number {
    const key = seqmapKey(sdkUuid, blockIndex);
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;
    const seq = this.nextSeq++;
    this.entries.set(key, seq);
    this.markDirty();
    return seq;
  }

  /**
   * Allocate a fresh monotonic seq for an event that has no stable
   * `sdk_uuid` (rare — daemon-internal frames). Still consumed from the
   * same counter so live order is preserved, but the value is never
   * recoverable later. Persisted via the same flush path so a restart
   * doesn't reuse it.
   */
  allocAnonymous(): number {
    const seq = this.nextSeq++;
    this.markDirty();
    return seq;
  }

  /** Highest seq ever handed out for this session. */
  tail(): number {
    return this.nextSeq - 1;
  }

  /** Force flush to disk. Called on SIGTERM / explicit save. */
  flushSync(): void {
    if (!this.dirty) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      const data: SeqmapFile = {
        version: SEQMAP_VERSION,
        nextSeq: this.nextSeq,
        entries: Object.fromEntries(this.entries),
      };
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      logger.warn('seq-allocator', `flushSync failed for ${this.sessionId}`, { err: String(err) });
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    // Coalesce bursts (history parse can hand out hundreds in one tick).
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSync();
    }, 250);
    // Don't pin event loop on shutdown.
    this.flushTimer.unref?.();
  }
}

// ---------------------------------------------------------------------------
// Manager — hands out per-session allocators, lazy-loaded from disk.
// ---------------------------------------------------------------------------

export class SessionSeqAllocatorManager {
  private readonly cache = new Map<string, SessionSeqAllocator>();
  private readonly dir: string;

  constructor(dir: string = SEQMAP_DIR) {
    this.dir = dir;
  }

  for(sessionId: string): SessionSeqAllocator {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    const file = path.join(this.dir, `${sessionId}.seqmap.json`);
    let snapshot: SeqmapFile | null = null;
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        snapshot = JSON.parse(raw) as SeqmapFile;
      }
    } catch (err) {
      logger.warn('seq-allocator', `failed to load seqmap for ${sessionId}, starting fresh`, { err: String(err) });
      snapshot = null;
    }
    const allocator = new SessionSeqAllocator(sessionId, file, snapshot);
    this.cache.set(sessionId, allocator);
    return allocator;
  }

  /**
   * Read-only `tail()` lookup that does NOT instantiate or cache an
   * allocator for `sessionId`. Used by hot paths (every `list_sessions`
   * stamps `tail_seq` onto every session) where blocking the event loop
   * to read every session's `.seqmap.json` from disk would be wasteful.
   *
   * Returns `undefined` for sessions that have never been allocated
   * against in this process and that aren't already cached. Call
   * `preloadAllFromDisk()` once at daemon startup so that all on-disk
   * seqmaps are warmed into cache and `peekTail()` can return a
   * meaningful value for every session the daemon has ever known.
   */
  peekTail(sessionId: string): number | undefined {
    const cached = this.cache.get(sessionId);
    if (cached) {
      const t = cached.tail();
      return t > 0 ? t : undefined;
    }
    return undefined;
  }

  /**
   * Warm the cache from `<dir>/*.seqmap.json` so subsequent `peekTail()`
   * calls return real values without needing to do disk IO. Called once
   * during daemon startup; safe to call repeatedly (idempotent).
   */
  preloadAllFromDisk(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return; // dir doesn't exist yet — nothing to preload
    }
    for (const name of entries) {
      const m = name.match(/^(.+)\.seqmap\.json$/);
      if (!m) continue;
      const sessionId = m[1];
      if (!this.cache.has(sessionId)) {
        // Force a load — `for()` reads + caches.
        this.for(sessionId);
      }
    }
  }

  /** Flush every cached allocator to disk. Call on shutdown. */
  flushAllSync(): void {
    for (const a of this.cache.values()) a.flushSync();
  }
}
