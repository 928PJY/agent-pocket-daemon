// Agent Pocket — Transcript Reader
// Reads the last completed assistant turn from a Claude Code session JSONL
// transcript and extracts everything the Stop hook needs for a "Session
// Completed" notification: end-of-turn text, tool-use count, token usage,
// and turn duration.

import * as fs from 'node:fs';
import { logger } from '../logger.js';

interface TranscriptLine {
  type: string;
  timestamp?: string;
  message?: {
    stop_reason?: string;
    content?: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

export interface TurnSummary {
  text: string;
  toolUseCount: number;
  totalTokens: number;
  durationSec: number;
}

function tailLines(filePath: string, maxLines: number): string[] {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  // Read at most the last 256KB — enough for ~400 turn lines in practice,
  // and bounded so we don't grow with session length.
  const window = Math.min(size, 256 * 1024);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(window);
    fs.readSync(fd, buf, 0, window, size - window);
    let text = buf.toString('utf-8');
    // If we didn't start at byte 0 we may have sliced into the middle of a
    // line — drop the leading partial line so JSON.parse doesn't see junk.
    if (window < size) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    const lines = text.split('\n').filter((l) => l.length > 0);
    return lines.slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

function parse(line: string): TranscriptLine | null {
  try {
    return JSON.parse(line) as TranscriptLine;
  } catch {
    return null;
  }
}

function extractText(line: TranscriptLine): string | null {
  const content = line.message?.content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0)
    .map((b) => b.text!.trim());
  return texts.length > 0 ? texts.join('\n') : null;
}

function tokensOf(line: TranscriptLine): number {
  // This-turn cost only: output we generated + cache we created. Skip
  // input_tokens (it includes the entire conversation re-sent each turn) and
  // cache_read (historical context, not new spend).
  const u = line.message?.usage;
  if (!u) return 0;
  return (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

function toolUsesIn(line: TranscriptLine): number {
  const content = line.message?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((b) => b.type === 'tool_use').length;
}

/**
 * Read the most recent end-of-turn summary from a transcript file. Walks
 * backwards from the last `end_turn` assistant line up to the preceding
 * `user` message, summing tokens / tool_use blocks across the turn and
 * computing duration from timestamp deltas.
 *
 * The Stop hook can fire BEFORE the current turn's end_turn line is flushed
 * to disk. To avoid returning the previous turn's text, we require the found
 * end_turn timestamp to be ≥ `firedAt - 1s`. If it's older we keep polling
 * until the new line appears (or the budget runs out).
 *
 * Returns null if no fresh end_turn line was found within the budget.
 */
/**
 * Read the most recent end-of-turn summary from a transcript file.
 *
 * Boundary rule: the current turn is everything AFTER the last `user` line in
 * the transcript. We find that user line, then look for an `end_turn`
 * assistant line at a later index. This naturally excludes prior turns'
 * end_turns regardless of how long the current turn took.
 *
 * The Stop hook can fire BEFORE the current turn's end_turn line is flushed
 * to disk, so we poll briefly until it shows up (or budget expires).
 */
export async function readLastTurnSummary(
  transcriptPath: string,
): Promise<TurnSummary | null> {
  if (!transcriptPath) return null;

  const maxAttempts = 20;
  const delayMs = 100;
  const tailWindow = 400;

  let sawFileMissing = false;
  let sawNoUser = false;
  let sawNoEndTurn = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (fs.existsSync(transcriptPath)) {
        const lines = tailLines(transcriptPath, tailWindow).map(parse);
        const result = summarizeFromLines(lines);
        if (result.summary) return result.summary;
        if (result.reason === 'no-user') sawNoUser = true;
        if (result.reason === 'no-end-turn-after-user') sawNoEndTurn = true;
      } else {
        sawFileMissing = true;
      }
    } catch (err) {
      logger.warn('transcript', 'Failed to read transcript', {
        path: transcriptPath,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(delayMs);
  }

  logger.warn('transcript', 'readLastTurnSummary gave up', {
    path: transcriptPath,
    sawFileMissing,
    sawNoUser,
    sawNoEndTurn,
  });
  return null;
}

type SummaryResult =
  | { summary: TurnSummary; reason?: undefined }
  | { summary: null; reason: 'no-user' | 'no-end-turn-after-user' };

function summarizeFromLines(lines: Array<TranscriptLine | null>): SummaryResult {
  let userIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.type === 'user') { userIdx = i; break; }
  }
  if (userIdx < 0) return { summary: null, reason: 'no-user' };

  let endTurnIdx = -1;
  for (let i = lines.length - 1; i > userIdx; i--) {
    const l = lines[i];
    if (!l || l.type !== 'assistant') continue;
    if (l.message?.stop_reason !== 'end_turn') continue;
    if (!extractText(l)) continue;
    endTurnIdx = i;
    break;
  }
  if (endTurnIdx < 0) return { summary: null, reason: 'no-end-turn-after-user' };

  const endLine = lines[endTurnIdx]!;
  const text = extractText(endLine)!;

  let totalTokens = 0;
  let toolUseCount = 0;
  for (let i = endTurnIdx; i > userIdx; i--) {
    const l = lines[i];
    if (!l) continue;
    if (l.type === 'assistant') {
      totalTokens += tokensOf(l);
      toolUseCount += toolUsesIn(l);
    }
  }

  let durationSec = 0;
  const startTs = lines[userIdx]?.timestamp;
  const endTs = endLine.timestamp;
  if (startTs && endTs) {
    const start = Date.parse(startTs);
    const end = Date.parse(endTs);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      durationSec = Math.round((end - start) / 1000);
    }
  }

  return { summary: { text, toolUseCount, totalTokens, durationSec } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
