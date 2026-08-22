import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startSleepPrevention, stopSleepPrevention } from '../src/relay/sleep-prevention.js';
import { execFileSync } from 'node:child_process';

// Resolve PIDs of caffeinate processes whose -w argument equals our pid.
// We use this instead of inspecting the ChildProcess directly so the test
// asserts the property that actually matters in production: there IS a
// system caffeinate child watching this daemon pid.
function findCaffeinateWatchingPid(targetPid: number): number[] {
  try {
    const out = execFileSync('pgrep', ['-f', `caffeinate.* -w ${targetPid}`], { encoding: 'utf-8' });
    return out.split('\n').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
  } catch {
    // pgrep exits 1 when no match — that's expected, not an error
    return [];
  }
}

test('startSleepPrevention spawns caffeinate watching daemon pid (macOS only)', async () => {
  if (process.platform !== 'darwin') {
    return; // no-op on non-macOS, exercised by the "skip" path below
  }

  // Pre-state: no stale caffeinate from prior test runs
  const before = findCaffeinateWatchingPid(process.pid);
  for (const pid of before) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  }

  startSleepPrevention();
  // Give the spawn syscall a tick to register in the kernel proc table
  await new Promise((r) => setTimeout(r, 200));

  const matches = findCaffeinateWatchingPid(process.pid);
  assert.ok(matches.length >= 1, `expected ≥1 caffeinate watching pid ${process.pid}, found ${matches.length}`);

  stopSleepPrevention();
  await new Promise((r) => setTimeout(r, 200));

  const after = findCaffeinateWatchingPid(process.pid);
  assert.equal(after.length, 0, `expected stopSleepPrevention to kill caffeinate, still found ${after.length}`);
});

test('startSleepPrevention is idempotent — second call does not spawn a second process', async () => {
  if (process.platform !== 'darwin') return;

  startSleepPrevention();
  await new Promise((r) => setTimeout(r, 100));
  startSleepPrevention();
  await new Promise((r) => setTimeout(r, 100));

  const matches = findCaffeinateWatchingPid(process.pid);
  assert.equal(matches.length, 1, `expected exactly 1 caffeinate after two start calls, found ${matches.length}`);

  stopSleepPrevention();
  await new Promise((r) => setTimeout(r, 200));
});

test('startSleepPrevention is a no-op on non-macOS platforms', () => {
  if (process.platform === 'darwin') return; // covered above
  // Just verify it doesn't throw — there's no observable side effect to check
  assert.doesNotThrow(() => startSleepPrevention());
  assert.doesNotThrow(() => stopSleepPrevention());
});
