import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { killProcessGraceful } from '../src/utils/kill-process-graceful.js';

function spawnSleeper(args: string[] = ['1000']): { pid: number; done: Promise<void> } {
  const child = spawn('sleep', args, { stdio: 'ignore', detached: false });
  if (!child.pid) throw new Error('failed to spawn sleeper');
  const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return { pid: child.pid, done };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('killProcessGraceful returns already_dead for nonexistent pid', async () => {
  const outcome = await killProcessGraceful(999999);
  assert.equal(outcome, 'already_dead');
});

test('killProcessGraceful kills sleep with SIGINT', async () => {
  const { pid, done } = spawnSleeper();
  const outcome = await killProcessGraceful(pid, { sigintGraceMs: 500, pollIntervalMs: 20 });
  await done;
  assert.equal(outcome, 'sigint');
  assert.equal(isAlive(pid), false);
});

test('killProcessGraceful escalates to SIGKILL when SIGINT/SIGTERM trapped', async () => {
  // Pure-bash busy-wait so the bash process itself receives the signals
  // (vs. forwarding them to a child sleep that doesn't trap). Trap discards
  // INT and TERM, leaving SIGKILL as the only way out.
  const child = spawn('bash', ['-c', 'trap "" INT TERM; while true; do :; done'], { stdio: 'ignore' });
  if (!child.pid) throw new Error('failed to spawn trapper');
  const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  // Give bash a moment to install the trap before we start signaling.
  await new Promise((r) => setTimeout(r, 100));

  const outcome = await killProcessGraceful(child.pid, {
    sigintGraceMs: 200,
    sigtermGraceMs: 200,
    pollIntervalMs: 20,
  });
  await done;
  assert.equal(outcome, 'sigkill');
  assert.equal(isAlive(child.pid), false);
});
