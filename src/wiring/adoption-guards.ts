// Agent Pocket — adoption guards for the discovery loop
//
// Two predicates that gate "should this discovered JSONL be adopted onto
// this PID?" decisions in `session-discovery-loop.ts`. They live in their
// own module so unit tests can target them as public API instead of
// reaching into discovery-loop internals via test-only re-exports.

import type { DiscoveredSession, RunningCliSession } from '../discovery/session-discovery.js';

/**
 * Anomaly A guard. Used by the observed-session newer-pick at line ~140 of
 * `session-discovery-loop.ts` (the "current JSONL is stale, is there a fresher
 * one in the same project dir that we should hot-swap to?" path).
 *
 * A discovered JSONL is safe to adopt onto an already-observed `pid` only if
 * the SessionStart hook itself wrote that (sessionId, pid) pair into
 * `~/.agent-pocket/session-map.json`. The hook is the single authoritative
 * signal for /clear and `--resume`; Claude Code does NOT update
 * `~/.claude/sessions/<pid>.json` on /clear, so PID JSON cannot corroborate.
 *
 * The binding journal is intentionally NOT consulted: an earlier (pre-fix)
 * daemon run can have written `observe` events for an orphan JSONL onto this
 * PID, and blindly trusting that record perpetuates the misbind across
 * restarts.
 *
 * Degradation window: between daemon start and the first SessionStart hook
 * delivery, session-map.json may not yet contain the post-/clear (sid, pid)
 * pair. This guard returns false in that window; the standalone-PID branch
 * (~line 332 of session-discovery-loop.ts) will pick up the new sid via PID
 * JSON instead, so the session is not lost — the user just sees a brief
 * "old session ended → new session appeared" instead of a smooth in-place
 * adoption. Acceptable UX cost for correctness.
 *
 * Legacy fallback: if `sessionMap` is null/undefined (test fixtures or
 * bring-up before session-map wiring), behave permissively — no extra check.
 */
export function passesAdoptionGuard(
  jsonlSessionId: string,
  pid: number,
  sessionMap: Record<string, { pid?: number }> | null | undefined,
): boolean {
  if (!sessionMap) return true;
  const entry = sessionMap[jsonlSessionId];
  return entry?.pid === pid;
}

/**
 * Cold-start standalone-PID newer-pick guard. Used by the standalone-PID
 * branch in `session-discovery-loop.ts` to decide whether a fresher JSONL in
 * the same project dir should be promoted over the candidate the PID JSON
 * named.
 *
 * The original 4-filter chain accepted any candidate not claimed by another
 * live PID — including orphan graveyard files left behind by dead
 * `claude --resume <name>` invocations whose mtime got bumped by some
 * unrelated process. Adoption fingerprint:
 *
 *   - `runningCli` MUST contain a live PID JSON entry whose pid === this pid
 *     AND sessionId === d.sessionId.
 *
 * The binding journal is not enough on its own — see `passesAdoptionGuard`
 * for why journal trust is poisonable across restarts.
 *
 * The /clear case still passes here: the post-/clear PID JSON sid IS the
 * new sid by definition, so `runningCli` corroborates.
 *
 * Legacy fallback: if `journal` is null/undefined, behave permissively.
 */
export function passesStandalonePidNewerPick(
  d: DiscoveredSession,
  pid: number,
  runningCli: ReadonlyArray<RunningCliSession>,
  journal: unknown | null | undefined,
): boolean {
  if (!journal) return true;
  return runningCli.some(c => c.pid === pid && c.sessionId === d.sessionId);
}
