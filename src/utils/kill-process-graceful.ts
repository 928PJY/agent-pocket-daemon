// Stepped process kill: SIGINT → SIGTERM → SIGKILL with short waits between.
//
// Used for stopping a single observed Claude terminal session. SIGINT lets
// Claude Code unwind cleanly (close MCP, write SessionEnd hook); SIGTERM and
// SIGKILL are escalating fallbacks for processes that ignore SIGINT.
//
// `panic` in session-discovery.ts uses the same pattern across many PIDs at
// once; this helper targets exactly one PID with a tighter total budget.

import { logger } from '../logger.js';

export interface GracefulKillOptions {
  /** ms to wait after SIGINT before escalating to SIGTERM. Default 1000. */
  sigintGraceMs?: number;
  /** ms to wait after SIGTERM before escalating to SIGKILL. Default 1000. */
  sigtermGraceMs?: number;
  /** ms between liveness polls. Default 100. */
  pollIntervalMs?: number;
}

export type KillOutcome = 'already_dead' | 'sigint' | 'sigterm' | 'sigkill' | 'failed';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number, pollIntervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return !isAlive(pid);
}

/**
 * Kill a process gracefully, escalating signals until it exits.
 * Returns which signal finally took effect (or `already_dead` / `failed`).
 */
export async function killProcessGraceful(
  pid: number,
  opts: GracefulKillOptions = {},
): Promise<KillOutcome> {
  const sigintGraceMs = opts.sigintGraceMs ?? 1000;
  const sigtermGraceMs = opts.sigtermGraceMs ?? 1000;
  const pollIntervalMs = opts.pollIntervalMs ?? 100;

  if (!isAlive(pid)) return 'already_dead';

  try {
    process.kill(pid, 'SIGINT');
  } catch {
    return isAlive(pid) ? 'failed' : 'already_dead';
  }
  if (await waitForExit(pid, sigintGraceMs, pollIntervalMs)) return 'sigint';

  logger.warn('kill', `PID ${pid} ignored SIGINT, escalating to SIGTERM`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return isAlive(pid) ? 'failed' : 'already_dead';
  }
  if (await waitForExit(pid, sigtermGraceMs, pollIntervalMs)) return 'sigterm';

  logger.warn('kill', `PID ${pid} ignored SIGTERM, escalating to SIGKILL`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return isAlive(pid) ? 'failed' : 'already_dead';
  }
  if (await waitForExit(pid, sigtermGraceMs, pollIntervalMs)) return 'sigkill';

  return 'failed';
}
