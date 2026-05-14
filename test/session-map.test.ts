import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readSessionMap,
  getLatestSessionMapEntryForPid,
  gcSessionMap,
  cleanSessionMap,
  removeSessionMapEntries,
  type SessionMap,
} from '../src/utils/session-map.js';

function makeTmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-map-test-'));
  return path.join(dir, 'session-map.json');
}

function writeMap(file: string, map: SessionMap | object): void {
  fs.writeFileSync(file, JSON.stringify(map), 'utf-8');
}

// ---------------------------------------------------------------------------
// readSessionMap
// ---------------------------------------------------------------------------

test('readSessionMap returns {} when the file does not exist', () => {
  const file = makeTmpFile();
  assert.deepEqual(readSessionMap(file), {});
});

test('readSessionMap returns {} when the file is malformed JSON', () => {
  const file = makeTmpFile();
  fs.writeFileSync(file, '{not json', 'utf-8');
  assert.deepEqual(readSessionMap(file), {});
});

test('readSessionMap returns parsed entries from a well-formed file', () => {
  const file = makeTmpFile();
  const map: SessionMap = {
    'sess-1': { source: 'startup', cwd: '/tmp/a', pid: 100, timestamp: 1 },
    'sess-2': { source: 'clear', cwd: '/tmp/b', pid: 101, timestamp: 2 },
  };
  writeMap(file, map);
  assert.deepEqual(readSessionMap(file), map);
});

test('readSessionMap filters out subagent transcript entries', () => {
  const file = makeTmpFile();
  const map: SessionMap = {
    'parent-sess': {
      source: 'startup',
      cwd: '/tmp/a',
      pid: 100,
      timestamp: 1,
      transcript_path: '/tmp/transcripts/parent.jsonl',
    },
    'subagent-sess': {
      source: 'startup',
      cwd: '/tmp/a',
      pid: 100,
      timestamp: 2,
      transcript_path: '/tmp/transcripts/subagents/child.jsonl',
    },
  };
  writeMap(file, map);
  const result = readSessionMap(file);
  assert.equal(Object.keys(result).length, 1);
  assert.ok(result['parent-sess']);
  assert.equal(result['subagent-sess'], undefined);
});

// ---------------------------------------------------------------------------
// getLatestSessionMapEntryForPid
// ---------------------------------------------------------------------------

test('getLatestSessionMapEntryForPid returns undefined when no entry matches the pid', () => {
  const file = makeTmpFile();
  writeMap(file, {
    'sess-1': { source: 'startup', cwd: '/tmp/a', pid: 100, timestamp: 1 },
  });
  assert.equal(getLatestSessionMapEntryForPid(999, file), undefined);
});

test('getLatestSessionMapEntryForPid returns the entry with the highest timestamp for the pid', () => {
  const file = makeTmpFile();
  writeMap(file, {
    'old-sess': { source: 'startup', cwd: '/tmp/old', pid: 100, timestamp: 1 },
    'new-sess': { source: 'clear', cwd: '/tmp/new', pid: 100, timestamp: 5 },
    'other-sess': { source: 'startup', cwd: '/tmp/x', pid: 200, timestamp: 10 },
  });
  const result = getLatestSessionMapEntryForPid(100, file);
  assert.ok(result);
  assert.equal(result!.sessionId, 'new-sess');
  assert.equal(result!.cwd, '/tmp/new');
  assert.equal(result!.timestamp, 5);
});

test('getLatestSessionMapEntryForPid skips entries whose transcript file is missing', () => {
  const file = makeTmpFile();
  writeMap(file, {
    'fresh-but-missing': {
      source: 'clear',
      cwd: '/tmp/b',
      pid: 100,
      timestamp: 10,
      transcript_path: '/definitely/does/not/exist.jsonl',
    },
    'older-but-present': { source: 'startup', cwd: '/tmp/a', pid: 100, timestamp: 1 },
  });
  const result = getLatestSessionMapEntryForPid(100, file);
  assert.ok(result);
  assert.equal(result!.sessionId, 'older-but-present');
});

// ---------------------------------------------------------------------------
// gcSessionMap
// ---------------------------------------------------------------------------

test('gcSessionMap returns [] when the file does not exist', () => {
  const file = makeTmpFile();
  assert.deepEqual(gcSessionMap(file, () => true), []);
});

test('gcSessionMap removes entries whose pid is dead', () => {
  const file = makeTmpFile();
  writeMap(file, {
    'live': { source: 'startup', cwd: '/a', pid: 100, timestamp: 1 },
    'dead': { source: 'startup', cwd: '/b', pid: 200, timestamp: 2 },
  });
  const removed = gcSessionMap(file, (pid) => pid === 100);
  assert.deepEqual(removed, ['dead']);
  const remaining = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepEqual(Object.keys(remaining), ['live']);
});

test('gcSessionMap removes entries with pid <= 0 unconditionally', () => {
  const file = makeTmpFile();
  writeMap(file, {
    'no-pid': { source: 'startup', cwd: '/a', timestamp: 1 },
    'zero-pid': { source: 'startup', cwd: '/b', pid: 0, timestamp: 2 },
    'neg-pid': { source: 'startup', cwd: '/c', pid: -1, timestamp: 3 },
    'live': { source: 'startup', cwd: '/d', pid: 100, timestamp: 4 },
  });
  // isPidAlive should never even be called for the bad-pid entries
  const removed = gcSessionMap(file, () => true).sort();
  assert.deepEqual(removed, ['neg-pid', 'no-pid', 'zero-pid']);
});

test('gcSessionMap removes entries whose transcript file is gone', () => {
  const file = makeTmpFile();
  writeMap(file, {
    'gone': {
      source: 'startup',
      cwd: '/a',
      pid: 100,
      timestamp: 1,
      transcript_path: '/no/such/file.jsonl',
    },
  });
  const removed = gcSessionMap(file, () => true);
  assert.deepEqual(removed, ['gone']);
});

test('gcSessionMap returns [] and does not rewrite when nothing to remove', () => {
  const file = makeTmpFile();
  writeMap(file, { 'a': { source: 'startup', cwd: '/a', pid: 100, timestamp: 1 } });
  const mtimeBefore = fs.statSync(file).mtimeMs;
  const removed = gcSessionMap(file, () => true);
  assert.deepEqual(removed, []);
  // File must not be rewritten (preserve mtime as a proxy)
  assert.equal(fs.statSync(file).mtimeMs, mtimeBefore);
});

test('gcSessionMap is best-effort on malformed JSON', () => {
  const file = makeTmpFile();
  fs.writeFileSync(file, 'garbage', 'utf-8');
  assert.deepEqual(gcSessionMap(file, () => true), []);
});

// ---------------------------------------------------------------------------
// cleanSessionMap
// ---------------------------------------------------------------------------

test('cleanSessionMap removes only entries whose pid is in deadPids', () => {
  const file = makeTmpFile();
  writeMap(file, {
    'a': { source: 'startup', cwd: '/a', pid: 100, timestamp: 1 },
    'b': { source: 'startup', cwd: '/b', pid: 200, timestamp: 2 },
    'c': { source: 'startup', cwd: '/c', pid: 300, timestamp: 3 },
  });
  const removed = cleanSessionMap([100, 300], file).sort();
  assert.deepEqual(removed, ['a', 'c']);
  const remaining = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepEqual(Object.keys(remaining), ['b']);
});

test('cleanSessionMap returns [] when no entry matches and does not rewrite', () => {
  const file = makeTmpFile();
  writeMap(file, { 'a': { source: 'startup', cwd: '/a', pid: 100, timestamp: 1 } });
  const mtimeBefore = fs.statSync(file).mtimeMs;
  const removed = cleanSessionMap([999], file);
  assert.deepEqual(removed, []);
  assert.equal(fs.statSync(file).mtimeMs, mtimeBefore);
});

test('cleanSessionMap returns [] when file does not exist', () => {
  const file = makeTmpFile();
  assert.deepEqual(cleanSessionMap([100], file), []);
});

// ---------------------------------------------------------------------------
// removeSessionMapEntries
// ---------------------------------------------------------------------------

test('removeSessionMapEntries removes only requested ids', () => {
  const file = makeTmpFile();
  writeMap(file, {
    'a': { source: 'startup', cwd: '/a', pid: 100, timestamp: 1 },
    'b': { source: 'startup', cwd: '/b', pid: 200, timestamp: 2 },
  });
  const removed = removeSessionMapEntries(['a', 'missing'], file);
  assert.deepEqual(removed, ['a']);
  const remaining = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepEqual(Object.keys(remaining), ['b']);
});

test('removeSessionMapEntries returns [] when the file does not exist', () => {
  const file = makeTmpFile();
  assert.deepEqual(removeSessionMapEntries(['a'], file), []);
});

test('removeSessionMapEntries does not rewrite when nothing matches', () => {
  const file = makeTmpFile();
  writeMap(file, { 'a': { source: 'startup', cwd: '/a', pid: 100, timestamp: 1 } });
  const mtimeBefore = fs.statSync(file).mtimeMs;
  const removed = removeSessionMapEntries(['missing'], file);
  assert.deepEqual(removed, []);
  assert.equal(fs.statSync(file).mtimeMs, mtimeBefore);
});
