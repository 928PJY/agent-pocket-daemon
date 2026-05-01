import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSyncSessionIds } from '../src/index.js';

test('mergeSyncSessionIds returns daemon-known sessions when phone has no cursors', () => {
  const merged = mergeSyncSessionIds(new Map(), ['sess-a', 'sess-b']);
  assert.deepEqual([...merged].sort(), ['sess-a', 'sess-b']);
});

test('mergeSyncSessionIds returns phone-cursored sessions when daemon knows nothing', () => {
  const cursors = new Map([['sess-a', 5], ['sess-b', 0]]);
  const merged = mergeSyncSessionIds(cursors, []);
  assert.deepEqual([...merged].sort(), ['sess-a', 'sess-b']);
});

test('mergeSyncSessionIds dedupes sessions present on both sides', () => {
  const cursors = new Map([['sess-a', 7]]);
  const merged = mergeSyncSessionIds(cursors, ['sess-a', 'sess-b']);
  assert.equal(merged.size, 2);
  assert.equal(merged.has('sess-a'), true);
  assert.equal(merged.has('sess-b'), true);
});

test('mergeSyncSessionIds includes daemon sessions absent from phone cursors', () => {
  const cursors = new Map([['sess-a', 3]]);
  const merged = mergeSyncSessionIds(cursors, ['sess-b', 'sess-c']);
  assert.deepEqual([...merged].sort(), ['sess-a', 'sess-b', 'sess-c']);
});

test('mergeSyncSessionIds handles empty inputs', () => {
  const merged = mergeSyncSessionIds(new Map(), []);
  assert.equal(merged.size, 0);
});
