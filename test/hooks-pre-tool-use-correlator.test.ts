import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PreToolUseCorrelator, sameToolInput } from '../src/hooks/pre-tool-use-correlator.js';

// ---------------------------------------------------------------------------
// sameToolInput
// ---------------------------------------------------------------------------

test('sameToolInput: identical objects are equal', () => {
  assert.equal(sameToolInput({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), true);
});

test('sameToolInput: different keys/values are not equal', () => {
  assert.equal(sameToolInput({ a: 1 }, { a: 2 }), false);
  assert.equal(sameToolInput({ a: 1 }, { b: 1 }), false);
});

test('sameToolInput: order-sensitive (JSON.stringify semantics)', () => {
  assert.equal(sameToolInput({ a: 1, b: 2 }, { b: 2, a: 1 }), false);
});

// ---------------------------------------------------------------------------
// enqueue + shift basics
// ---------------------------------------------------------------------------

test('shift: returns undefined when queue empty', () => {
  const c = new PreToolUseCorrelator({ ttlMs: 60_000 });
  assert.equal(c.shift('s:T', {}), undefined);
});

test('enqueue + shift FIFO when no input matches', () => {
  const c = new PreToolUseCorrelator({ ttlMs: 60_000 });
  c.enqueue('s:T', 'a', { x: 1 });
  c.enqueue('s:T', 'b', { x: 2 });
  // Shift with non-matching input falls back to head
  assert.equal(c.shift('s:T', { z: 9 }), 'a');
  assert.equal(c.shift('s:T', { z: 9 }), 'b');
  assert.equal(c.shift('s:T', { z: 9 }), undefined);
});

test('shift: prefers entry whose toolInput matches exactly', () => {
  const c = new PreToolUseCorrelator({ ttlMs: 60_000 });
  c.enqueue('s:T', 'first', { x: 1 });
  c.enqueue('s:T', 'second', { x: 2 });
  c.enqueue('s:T', 'third', { x: 3 });
  // Match second (skip ahead)
  assert.equal(c.shift('s:T', { x: 2 }), 'second');
  // Remaining: first, third — head is now 'first'
  assert.equal(c.shift('s:T', { z: 9 }), 'first');
  assert.equal(c.shift('s:T', { z: 9 }), 'third');
});

test('keys are isolated per session+tool', () => {
  const c = new PreToolUseCorrelator({ ttlMs: 60_000 });
  c.enqueue('s1:T', 'a', {});
  c.enqueue('s2:T', 'b', {});
  assert.equal(c.shift('s1:T', {}), 'a');
  assert.equal(c.shift('s1:T', {}), undefined);
  assert.equal(c.shift('s2:T', {}), 'b');
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

test('remove: returns undefined when key has no queue', () => {
  const c = new PreToolUseCorrelator({ ttlMs: 60_000 });
  assert.equal(c.remove('s:T', 'x'), undefined);
});

test('remove: returns undefined when toolUseId not in queue', () => {
  const c = new PreToolUseCorrelator({ ttlMs: 60_000 });
  c.enqueue('s:T', 'a', {});
  assert.equal(c.remove('s:T', 'nope'), undefined);
  // Original entry still present
  assert.equal(c.shift('s:T', {}), 'a');
});

test('remove: removes the matching entry only', () => {
  const c = new PreToolUseCorrelator({ ttlMs: 60_000 });
  c.enqueue('s:T', 'a', { x: 1 });
  c.enqueue('s:T', 'b', { x: 2 });
  c.enqueue('s:T', 'c', { x: 3 });
  assert.equal(c.remove('s:T', 'b'), 'b');
  assert.equal(c.shift('s:T', { z: 9 }), 'a');
  assert.equal(c.shift('s:T', { z: 9 }), 'c');
});

test('remove: deletes empty queue from the map', () => {
  const c = new PreToolUseCorrelator({ ttlMs: 60_000 });
  c.enqueue('s:T', 'a', {});
  assert.equal(c.remove('s:T', 'a'), 'a');
  assert.equal(c.shift('s:T', {}), undefined);
});

// ---------------------------------------------------------------------------
// TTL pruning
// ---------------------------------------------------------------------------

test('TTL: stale entries pruned on next op (shift returns undefined)', () => {
  let now = 1_000_000;
  const c = new PreToolUseCorrelator({ ttlMs: 60_000, nowFn: () => now });
  c.enqueue('s:T', 'old', { x: 1 });
  // Advance past TTL
  now += 60_001;
  assert.equal(c.shift('s:T', { x: 1 }), undefined);
});

test('TTL: keeps fresh entries while pruning stale ones', () => {
  let now = 1_000_000;
  const c = new PreToolUseCorrelator({ ttlMs: 60_000, nowFn: () => now });
  c.enqueue('s:T', 'old', { x: 1 });
  now += 30_000;
  c.enqueue('s:T', 'new', { x: 2 });
  now += 31_000; // old is past TTL (61s), new is at 31s
  assert.equal(c.shift('s:T', { z: 9 }), 'new');
});

test('TTL: remove also prunes stale before searching', () => {
  let now = 1_000_000;
  const c = new PreToolUseCorrelator({ ttlMs: 60_000, nowFn: () => now });
  c.enqueue('s:T', 'old', {});
  now += 70_000;
  assert.equal(c.remove('s:T', 'old'), undefined);
});

test('TTL: enqueue starts a fresh queue after stale entries pruned', () => {
  let now = 1_000_000;
  const c = new PreToolUseCorrelator({ ttlMs: 60_000, nowFn: () => now });
  c.enqueue('s:T', 'old', {});
  now += 70_000;
  c.enqueue('s:T', 'new', {});
  // Only 'new' should be present
  assert.equal(c.shift('s:T', {}), 'new');
  assert.equal(c.shift('s:T', {}), undefined);
});

// ---------------------------------------------------------------------------
// Bounded queue (MAX_PRE_TOOL_USE_QUEUE_SIZE = 32)
// ---------------------------------------------------------------------------

test('enqueue caps queue at 32, dropping oldest entries', () => {
  const c = new PreToolUseCorrelator({ ttlMs: 60_000 });
  for (let i = 0; i < 35; i++) {
    c.enqueue('s:T', `id-${i}`, { i });
  }
  // First 3 should have been dropped
  assert.equal(c.shift('s:T', { z: 9 }), 'id-3');
});

// ---------------------------------------------------------------------------
// Default nowFn smoke
// ---------------------------------------------------------------------------

test('default nowFn (Date.now) usable', () => {
  const c = new PreToolUseCorrelator({ ttlMs: 60_000 });
  c.enqueue('s:T', 'a', {});
  assert.equal(c.shift('s:T', {}), 'a');
});
