import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DiscoveryLoop,
  DISCOVERY_INTERVAL_MS,
  type DiscoveryCallbacks,
} from '../src/discovery/discovery-orchestrator.js';

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function makeFakeTimers() {
  const timers: FakeTimer[] = [];
  const setIntervalFn = ((fn: () => void, ms: number) => {
    const t: FakeTimer = { fn, ms, cleared: false };
    timers.push(t);
    return t as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  const clearIntervalFn = ((handle: unknown) => {
    (handle as FakeTimer).cleared = true;
  }) as unknown as typeof clearInterval;
  return { timers, setIntervalFn, clearIntervalFn };
}

interface CallbackHarness {
  callbacks: DiscoveryCallbacks;
  pidCalls: number;
  observeCalls: number;
  codexCalls: number;
  observeRejection: Error | null;
  observePromise: Promise<void> | null;
}

function makeCallbacks(observeRejection: Error | null = null): CallbackHarness {
  const harness: CallbackHarness = {
    callbacks: {} as never,
    pidCalls: 0,
    observeCalls: 0,
    codexCalls: 0,
    observeRejection,
    observePromise: null,
  };
  harness.callbacks = {
    checkObservedSessionPids: () => { harness.pidCalls++; },
    discoverAndObserveSessions: async () => {
      harness.observeCalls++;
      if (harness.observeRejection) throw harness.observeRejection;
    },
    discoverAndObserveCodexSessions: () => { harness.codexCalls++; },
  };
  return harness;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('DiscoveryLoop.start() schedules a setInterval at DISCOVERY_INTERVAL_MS by default', () => {
  const { timers, setIntervalFn, clearIntervalFn } = makeFakeTimers();
  const harness = makeCallbacks();
  const loop = new DiscoveryLoop(harness.callbacks, { setInterval: setIntervalFn, clearInterval: clearIntervalFn });
  loop.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, DISCOVERY_INTERVAL_MS);
  assert.equal(loop.isRunning(), true);
});

test('DiscoveryLoop.start() honours the intervalMs option', () => {
  const { timers, setIntervalFn, clearIntervalFn } = makeFakeTimers();
  const loop = new DiscoveryLoop(makeCallbacks().callbacks, {
    intervalMs: 250, setInterval: setIntervalFn, clearInterval: clearIntervalFn,
  });
  loop.start();
  assert.equal(timers[0].ms, 250);
});

test('DiscoveryLoop.start() is idempotent — second call does not schedule a new timer', () => {
  const { timers, setIntervalFn, clearIntervalFn } = makeFakeTimers();
  const loop = new DiscoveryLoop(makeCallbacks().callbacks, { setInterval: setIntervalFn, clearInterval: clearIntervalFn });
  loop.start();
  loop.start();
  loop.start();
  assert.equal(timers.length, 1);
});

test('DiscoveryLoop.stop() clears the timer and lets start() re-schedule', () => {
  const { timers, setIntervalFn, clearIntervalFn } = makeFakeTimers();
  const loop = new DiscoveryLoop(makeCallbacks().callbacks, { setInterval: setIntervalFn, clearInterval: clearIntervalFn });
  loop.start();
  loop.stop();
  assert.equal(timers[0].cleared, true);
  assert.equal(loop.isRunning(), false);
  loop.start();
  assert.equal(timers.length, 2);
  assert.equal(loop.isRunning(), true);
});

test('DiscoveryLoop.stop() before start is a no-op', () => {
  const { timers, setIntervalFn, clearIntervalFn } = makeFakeTimers();
  const loop = new DiscoveryLoop(makeCallbacks().callbacks, { setInterval: setIntervalFn, clearInterval: clearIntervalFn });
  loop.stop();
  assert.equal(timers.length, 0);
  assert.equal(loop.isRunning(), false);
});

test('DiscoveryLoop.stop() after stop is a no-op (no double clear)', () => {
  const { timers, setIntervalFn, clearIntervalFn } = makeFakeTimers();
  const loop = new DiscoveryLoop(makeCallbacks().callbacks, { setInterval: setIntervalFn, clearInterval: clearIntervalFn });
  loop.start();
  loop.stop();
  loop.stop();
  assert.equal(timers[0].cleared, true); // still only set once, no error
});

// ---------------------------------------------------------------------------
// Tick orchestration
// ---------------------------------------------------------------------------

test('DiscoveryLoop tick invokes all three callbacks in order', () => {
  const order: string[] = [];
  const callbacks: DiscoveryCallbacks = {
    checkObservedSessionPids: () => { order.push('pid'); },
    discoverAndObserveSessions: async () => { order.push('observe'); },
    discoverAndObserveCodexSessions: () => { order.push('codex'); },
  };
  const loop = new DiscoveryLoop(callbacks);
  loop.tick();
  assert.deepEqual(order, ['pid', 'observe', 'codex']);
});

test('DiscoveryLoop fires the registered tick body on each setInterval invocation', () => {
  const { timers, setIntervalFn, clearIntervalFn } = makeFakeTimers();
  const harness = makeCallbacks();
  const loop = new DiscoveryLoop(harness.callbacks, { setInterval: setIntervalFn, clearInterval: clearIntervalFn });
  loop.start();
  timers[0].fn();
  timers[0].fn();
  assert.equal(harness.pidCalls, 2);
  assert.equal(harness.observeCalls, 2);
  assert.equal(harness.codexCalls, 2);
});

test('DiscoveryLoop swallows discoverAndObserveSessions rejections without breaking the loop', async () => {
  const harness = makeCallbacks(new Error('disk dead'));
  const loop = new DiscoveryLoop(harness.callbacks);
  loop.tick();
  // Wait for the swallowed promise to settle so the test doesn't leak unhandled rejection
  await new Promise((r) => setImmediate(r));
  // Subsequent tick still runs without throwing
  loop.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(harness.observeCalls, 2);
  assert.equal(harness.pidCalls, 2);
  assert.equal(harness.codexCalls, 2);
});
