// Agent Pocket — Session preview cache
//
// list_sessions only needs three short fields per session for its preview:
//   { role, content (<=200 chars), tool_name }
//
// The original code path for this was `getSessionHistory(..., { limit: 3 })`,
// which on cache miss does a full-file read + JSON.parse-per-line + subagent
// anchoring + persistent seq allocation + timestamp normalisation. For a
// 2000-row session that's 200-500ms of synchronous Node event-loop work.
// Multiplied by 20 sessions in the first page, peer_hello → first session_list
// blocked the daemon for ~3-5s, which queued the phone's `sync_request` in
// the kernel TCP buffer and produced the 17:12 trace's 5.6s
// `sent→firstHistoryDone` and 6.7s first render.
//
// This module reads the JSONL tail bytes (LRU-bounded ~64KB), parses just
// enough rows for the preview, and caches the result keyed by file mtime.
// No subagent walk, no allocator touch, no sort, no normalisation.
//
// Lifecycle:
//   - Keyed on `filePath + mtimeMs`. A new mtime invalidates the entry for
//     that file; other sessions' previews stay warm.
//   - LRU-trimmed at PREVIEW_CACHE_MAX_ENTRIES so memory is bounded for users
//     with thousands of historical sessions.
//
// Not used by `get_history`, `sync_request`, or anything else that needs the
// full normalised view. Those keep the existing `getSessionHistory` pipeline.

import * as fs from 'node:fs';
import { logger } from '../logger.js';
import { parseHistoryEntry } from './jsonl-parser.js';

export interface PreviewMessage {
  role: string;
  content: string;
  toolName?: string;
}

/** A parser that maps one parsed JSONL row to 0..N display blocks. Used so
 *  Claude and Codex can share the tail-read + cache plumbing while each
 *  contributing its own row → message mapping. The function must be pure
 *  (no fs, no allocator, no logging) — preview is hot-path. */
export type PreviewRowParser = (entry: Record<string, unknown>) => Array<{
  role: string;
  content: string;
  toolName?: string;
}>;

/** Default parser for Claude-Code-style JSONL transcripts. */
export const CLAUDE_PREVIEW_PARSER: PreviewRowParser = (entry) =>
  parseHistoryEntry(entry).map((m) => ({
    role: m.role,
    content: m.content,
    toolName: m.toolName,
  }));

interface CacheEntry {
  mtime: number;
  size: number;
  messages: PreviewMessage[];
}

/** Bytes read from the JSONL tail. 64KB comfortably holds the last ~30 rows
 *  even for transcripts with large tool_result blocks; we only need 3. */
const TAIL_READ_BYTES = 64 * 1024;

/** Char cap mirrors what `list-sessions.ts` was already slicing to. */
const CONTENT_CAP = 200;

/** Maximum sessions kept warm. LRU eviction beyond this. */
const PREVIEW_CACHE_MAX_ENTRIES = 256;

const cache = new Map<string, CacheEntry>();

/**
 * Read the last N preview messages for a JSONL transcript without triggering
 * the full normalisation pipeline. Returns an empty array if the file is
 * missing or unreadable.
 *
 * @param filePath  Absolute path to the session's main JSONL file.
 * @param limit     Number of preview messages to return (newest-last order).
 */
export function getSessionPreview(
  filePath: string,
  parser: PreviewRowParser,
  limit = 3,
): PreviewMessage[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }

  const cached = cache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
    // LRU touch
    cache.delete(filePath);
    cache.set(filePath, cached);
    return cached.messages.slice(-limit);
  }

  let raw: string;
  try {
    if (stat.size <= TAIL_READ_BYTES) {
      raw = fs.readFileSync(filePath, 'utf-8');
    } else {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(TAIL_READ_BYTES);
        fs.readSync(fd, buf, 0, TAIL_READ_BYTES, stat.size - TAIL_READ_BYTES);
        raw = buf.toString('utf-8');
        // Drop the first (likely partial) line so JSON.parse won't see it.
        const firstNewline = raw.indexOf('\n');
        if (firstNewline >= 0) raw = raw.slice(firstNewline + 1);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (err) {
    logger.debug('preview', 'tail read failed', { filePath, error: (err as Error).message });
    return [];
  }

  const lines = raw.split('\n');
  const out: PreviewMessage[] = [];
  // Walk from the end so the last `limit` parent rows pop out without
  // parsing the entire tail buffer when most rows are tool_results.
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    let parsed: ReturnType<PreviewRowParser>;
    try {
      parsed = parser(entry);
    } catch {
      continue;
    }
    // The parser emits source-order blocks for a row's content. For the
    // preview we want the row's *last* visible block since that's what the
    // user would see as the latest activity.
    for (let j = parsed.length - 1; j >= 0 && out.length < limit; j--) {
      const m = parsed[j];
      if (!m.content && !m.toolName) continue;
      out.unshift({
        role: m.role,
        content: m.content.slice(0, CONTENT_CAP),
        toolName: m.toolName,
      });
    }
  }

  const entry: CacheEntry = { mtime: stat.mtimeMs, size: stat.size, messages: out };
  cache.set(filePath, entry);

  // LRU trim. Map iteration order = insertion order, so the oldest entry is
  // first. Delete-then-set on hit moves it to the tail (above).
  while (cache.size > PREVIEW_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }

  return out;
}

/** Test hook — clears the in-process cache. */
export function clearPreviewCacheForTests(): void {
  cache.clear();
}
