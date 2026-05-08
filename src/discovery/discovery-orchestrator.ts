// Agent Pocket — discovery loop scheduler
//
// Owns the 5-second tick that the daemon uses to:
//   1. Reap dead PIDs from observed sessions (synchronous).
//   2. Re-scan disk for new Claude sessions and attach observers
//      (async — fire-and-forget; errors are logged, not surfaced).
//   3. Re-scan SQLite + live PIDs for Codex sessions (synchronous).
//
// The scheduler is a thin wrapper around `setInterval` so the lifecycle
// is testable without spinning up an entire AgentPocketDaemon. The body
// of each callback still lives on the daemon — this module only owns
// the timer and the orchestration order.
//
// Extracted from AgentPocketDaemon as part of Step 1.5 (scheduler-only
// variant — full body extraction was deemed too risky given the depth
// of state entanglement in the original methods).

import { logger } from '../logger.js';

export const DISCOVERY_INTERVAL_MS = 5000;

export interface DiscoveryCallbacks {
  /** Reap dead PIDs from observed sessions. */
  checkObservedSessionPids(): void;
  /** Re-scan for Claude sessions; rejection is logged + swallowed. */
  discoverAndObserveSessions(): Promise<void>;
  /** Re-scan for Codex sessions. */
  discoverAndObserveCodexSessions(): void;
}

/**
 * Drives the periodic discovery loop. `start()` schedules the tick and
 * is idempotent — re-calling it after start is a no-op until `stop()`
 * is called. `stop()` clears the timer (also idempotent).
 *
 * Errors from the async callback are intentionally swallowed (with a
 * log) so a single bad scan can't tear down the loop.
 */
export class DiscoveryLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;

  constructor(
    private readonly callbacks: DiscoveryCallbacks,
    options: {
      intervalMs?: number;
      setInterval?: typeof setInterval;
      clearInterval?: typeof clearInterval;
    } = {},
  ) {
    this.intervalMs = options.intervalMs ?? DISCOVERY_INTERVAL_MS;
    this.setIntervalFn = options.setInterval ?? setInterval;
    this.clearIntervalFn = options.clearInterval ?? clearInterval;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = this.setIntervalFn(() => {
      this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  /** Run a single discovery pass synchronously (test seam + manual trigger). */
  tick(): void {
    this.callbacks.checkObservedSessionPids();
    this.callbacks.discoverAndObserveSessions().catch((err) => {
      logger.error('daemon', `Periodic discovery error: ${(err as Error).message}`);
    });
    this.callbacks.discoverAndObserveCodexSessions();
  }

  /** Test/diagnostic helper. */
  isRunning(): boolean {
    return this.timer !== null;
  }
}
