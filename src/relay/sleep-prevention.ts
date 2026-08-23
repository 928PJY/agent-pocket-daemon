// Agent Pocket -- Sleep Prevention
//
// Holds a macOS IOPMAssertion (via `caffeinate -i -s`) for the lifetime of the
// daemon process so the OS doesn't idle-sleep us while the phone has a live
// WebSocket. Without this, macOS suspends the Node event loop on AC idle /
// battery sleep; outbound `ws.send()` calls return synchronously but the
// kernel never schedules the bytes, the relay closes the dead socket after
// its 10s routing-header grace (code 4001), and the phone observes 17s
// "sync stalls" until the daemon wakes up and reconnects. (#271 root cause.)
//
// Strategy: shell out to the system `caffeinate` binary. This is preferable to
// a native NAPI binding because:
//   - zero extra dependencies, no node-gyp build step on user install
//   - `caffeinate -w <pid>` releases the assertion when our pid exits, so a
//     crash never leaves stale assertions behind
//   - macOS-only by definition; on Linux / Windows we no-op
//
// Flags:
//   -i  prevent idle sleep (system-wide; equivalent to PreventUserIdleSystemSleep)
//   -s  prevent sleep while on AC power (system-wide; equivalent to PreventSystemSleep)
//   -w  release the assertion when the watched pid exits
// We deliberately do NOT pass -d: the display is free to sleep on its own
// schedule. -i / -s alone do not exempt the process from macOS App Nap, so the
// App-Nap throttle is handled separately by app-nap-keepalive.ts (a pulsed
// UserIsActive assertion that resets App Nap's idle timer without lighting the
// screen). See #271 for why App Nap, not idle/system sleep, was the stall root
// cause.

import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../logger.js';

let child: ChildProcess | null = null;

/**
 * Install a sleep-prevention assertion for the lifetime of this daemon process.
 * Idempotent — safe to call multiple times. No-op on non-macOS platforms.
 */
export function startSleepPrevention(): void {
  if (process.platform !== 'darwin') {
    logger.debug('sleep', 'Sleep prevention skipped (not macOS)');
    return;
  }
  if (child && child.exitCode === null) {
    return;
  }

  try {
    child = spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], {
      stdio: 'ignore',
      detached: false,
    });
  } catch (err) {
    logger.warn('sleep', 'Failed to spawn caffeinate', { error: (err as Error).message });
    child = null;
    return;
  }

  const caffeinatePid = child.pid;
  logger.info('sleep', 'Sleep prevention armed (caffeinate -i -s)', {
    caffeinatePid,
    daemonPid: process.pid,
  });

  child.on('exit', (code, signal) => {
    logger.warn('sleep', 'caffeinate exited', { code, signal, caffeinatePid });
    child = null;
  });

  child.on('error', (err) => {
    logger.warn('sleep', 'caffeinate error', { error: err.message });
  });
}

/**
 * Release the sleep-prevention assertion. Called from daemon shutdown so we
 * don't leave a caffeinate process behind during graceful stop (`-w` already
 * handles crash exit, but `agent-pocket stop` is graceful — process keeps
 * running through the await chain).
 */
export function stopSleepPrevention(): void {
  if (!child || child.exitCode !== null) {
    child = null;
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // already dead
  }
  child = null;
}
