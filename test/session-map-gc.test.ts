import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gcSessionMapEntries, removeSessionMapEntriesConservatively } from '../src/sessions/session-map-gc.js';

test('gcSessionMapEntries preserves and marks the most recent entry for a dead PID', () => {
  const result = gcSessionMapEntries({
    old: { pid: 42, timestamp: 1000 },
    current: { pid: 42, timestamp: 2000 },
  }, {
    now: 10_000,
    isPidAlive: () => false,
    transcriptExists: () => true,
    confirmDeadMs: 1,
  });

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.markedDead.sort(), ['current', 'old']);
  assert.equal(result.map.current.dead_since, 10_000);
  assert.equal(result.map.old.dead_since, 10_000);
});

test('gcSessionMapEntries removes only older sibling entries after dead PID confirmation', () => {
  const result = gcSessionMapEntries({
    old: { pid: 42, timestamp: 1000, dead_since: 1_000 },
    current: { pid: 42, timestamp: 2000, dead_since: 1_000 },
  }, {
    now: 31_000,
    isPidAlive: () => false,
    transcriptExists: () => true,
    confirmDeadMs: 30_000,
  });

  assert.deepEqual(result.removed, ['old']);
  assert.ok(result.map.current);
  assert.equal(result.map.current.dead_since, 1_000);
  assert.equal(result.map.old, undefined);
});

test('gcSessionMapEntries marks missing transcripts before removing confirmed stale siblings', () => {
  const first = gcSessionMapEntries({
    old: { pid: 42, timestamp: 1000, transcript_path: '/tmp/missing-old.jsonl' },
    current: { pid: 42, timestamp: 2000, transcript_path: '/tmp/missing-current.jsonl' },
  }, {
    now: 5_000,
    isPidAlive: () => true,
    transcriptExists: () => false,
    confirmMissingMs: 10_000,
  });

  assert.deepEqual(first.removed, []);
  assert.deepEqual(first.markedMissing.sort(), ['current', 'old']);

  const second = gcSessionMapEntries(first.map, {
    now: 15_000,
    isPidAlive: () => true,
    transcriptExists: () => false,
    confirmMissingMs: 10_000,
  });

  assert.deepEqual(second.removed, ['old']);
  assert.ok(second.map.current);
  assert.equal(second.map.old, undefined);
});

test('removeSessionMapEntriesConservatively preserves the newest entry for each PID', () => {
  const result = removeSessionMapEntriesConservatively({
    old: { pid: 42, timestamp: 1000 },
    current: { pid: 42, timestamp: 2000 },
    other: { pid: 43, timestamp: 1000 },
  }, ['old', 'current', 'other']);

  assert.deepEqual(result.removed, ['old']);
  assert.equal(result.map.old, undefined);
  assert.ok(result.map.current);
  assert.ok(result.map.other);
});
