import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionSeqAllocatorManager, seqmapKey } from '../src/discovery/seq-allocator.js';

function makeManager(): { mgr: SessionSeqAllocatorManager; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqmap-test-'));
  return { mgr: new SessionSeqAllocatorManager(dir), dir };
}

test('seqmapKey distinguishes block indices', () => {
  assert.equal(seqmapKey('uuid-1'), 'uuid-1');
  assert.equal(seqmapKey('uuid-1', 0), 'uuid-1:0');
  assert.equal(seqmapKey('uuid-1', 3), 'uuid-1:3');
});

test('getOrAssign returns same seq for same uuid', () => {
  const { mgr } = makeManager();
  const a = mgr.for('s1');
  assert.equal(a.getOrAssign('u-A'), 1);
  assert.equal(a.getOrAssign('u-B'), 2);
  assert.equal(a.getOrAssign('u-A'), 1); // stable
  assert.equal(a.getOrAssign('u-A', 0), 3); // different blockIndex → different slot
  assert.equal(a.tail(), 3);
});

test('peek does not assign', () => {
  const { mgr } = makeManager();
  const a = mgr.for('s1');
  assert.equal(a.peek('u-X'), undefined);
  assert.equal(a.tail(), 0);
});

test('allocAnonymous keeps counter monotonic alongside getOrAssign', () => {
  const { mgr } = makeManager();
  const a = mgr.for('s1');
  assert.equal(a.getOrAssign('u-A'), 1);
  assert.equal(a.allocAnonymous(), 2);
  assert.equal(a.getOrAssign('u-B'), 3);
});

test('per-session allocators are isolated', () => {
  const { mgr } = makeManager();
  const a = mgr.for('s1');
  const b = mgr.for('s2');
  assert.equal(a.getOrAssign('u-A'), 1);
  assert.equal(b.getOrAssign('u-A'), 1); // same uuid, separate session → separate seq space
  assert.equal(a.getOrAssign('u-A'), 1);
});

test('persists across manager instances (simulates daemon restart)', () => {
  const { mgr, dir } = makeManager();
  const a = mgr.for('s1');
  assert.equal(a.getOrAssign('u-A'), 1);
  assert.equal(a.getOrAssign('u-B'), 2);
  a.flushSync();

  // New manager pointing at same dir → same allocator state
  const mgr2 = new SessionSeqAllocatorManager(dir);
  const a2 = mgr2.for('s1');
  assert.equal(a2.getOrAssign('u-A'), 1, 'reload preserves uuid → seq mapping');
  assert.equal(a2.getOrAssign('u-B'), 2);
  assert.equal(a2.getOrAssign('u-C'), 3, 'new uuid continues from persisted nextSeq');
});

test('flushAllSync persists every cached session', () => {
  const { mgr, dir } = makeManager();
  mgr.for('s1').getOrAssign('u-A');
  mgr.for('s2').getOrAssign('u-Z');
  mgr.flushAllSync();
  const f1 = JSON.parse(fs.readFileSync(path.join(dir, 's1.seqmap.json'), 'utf8'));
  const f2 = JSON.parse(fs.readFileSync(path.join(dir, 's2.seqmap.json'), 'utf8'));
  assert.equal(f1.entries['u-A'], 1);
  assert.equal(f2.entries['u-Z'], 1);
});

test('corrupt seqmap file falls back to fresh allocator', () => {
  const { mgr, dir } = makeManager();
  mgr.for('s1').getOrAssign('u-A');
  mgr.flushAllSync();
  // Corrupt the file
  fs.writeFileSync(path.join(dir, 's1.seqmap.json'), '{ not valid json');
  const mgr2 = new SessionSeqAllocatorManager(dir);
  const a = mgr2.for('s1');
  assert.equal(a.getOrAssign('u-A'), 1, 'fresh allocator restarts from 1');
});

test('peekTail returns undefined for an unknown session without instantiating an allocator', () => {
  const { mgr } = makeManager();
  // Cold lookup must NOT instantiate / cache / read disk — list_sessions
  // calls this for every session every request, instantiating each one
  // would (a) blocking-read disk, (b) leak entries into the cache.
  assert.equal(mgr.peekTail('never-seen'), undefined);
  assert.equal(mgr.peekTail('never-seen'), undefined); // still undefined; nothing cached
});

test('peekTail reflects current tail of an already-cached allocator', () => {
  const { mgr } = makeManager();
  mgr.for('s1').getOrAssign('u-A');
  mgr.for('s1').getOrAssign('u-B');
  assert.equal(mgr.peekTail('s1'), 2);
});

test('preloadAllFromDisk warms cache so peekTail returns persisted tails after restart', () => {
  const { mgr, dir } = makeManager();
  mgr.for('s1').getOrAssign('u-A');
  mgr.for('s1').getOrAssign('u-B');
  mgr.for('s2').getOrAssign('u-X');
  mgr.flushAllSync();

  // Simulate daemon restart with the same on-disk dir.
  const mgr2 = new SessionSeqAllocatorManager(dir);
  // Without preload, peekTail returns undefined for everything (cache cold).
  assert.equal(mgr2.peekTail('s1'), undefined);
  // After preload, cache is warm and peekTail returns the persisted tails.
  mgr2.preloadAllFromDisk();
  assert.equal(mgr2.peekTail('s1'), 2);
  assert.equal(mgr2.peekTail('s2'), 1);
});

test('preloadAllFromDisk is idempotent and survives missing dir', () => {
  // Missing dir → no-op, no throw.
  const ghostDir = path.join(os.tmpdir(), 'seqmap-ghost-' + Math.random());
  const ghost = new SessionSeqAllocatorManager(ghostDir);
  ghost.preloadAllFromDisk();
  ghost.preloadAllFromDisk();

  // Idempotent on real dir too.
  const { mgr, dir } = makeManager();
  mgr.for('s1').getOrAssign('u-A');
  mgr.flushAllSync();
  const mgr2 = new SessionSeqAllocatorManager(dir);
  mgr2.preloadAllFromDisk();
  mgr2.preloadAllFromDisk(); // second call is a no-op
  assert.equal(mgr2.peekTail('s1'), 1);
});
