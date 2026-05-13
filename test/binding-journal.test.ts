import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BindingJournal, type BindingEvent } from '../src/persistence/binding-journal.js';

function makeTempJournal(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-journal-test-'));
  return path.join(dir, 'binding.jsonl');
}

function readLines(file: string): BindingEvent[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as BindingEvent);
}

test('BindingJournal appends observe and round-trips through readAll', () => {
  const file = makeTempJournal();
  let nowCallCount = 0;
  const journal = new BindingJournal({ filePath: file, nowFn: () => 1_000 + nowCallCount++ });

  journal.appendObserve({
    pid: 86703,
    sessionId: '8a63ce95',
    cwd: '/Users/x/workspace/agent-pocket',
    jsonlPath: '/path/to/8a63ce95.jsonl',
    customTitle: 'Agent Main',
    entrypoint: 'cli',
  });

  const events = journal.readAll();
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'observe');
  if (events[0].event !== 'observe') return; // type guard for ts
  assert.equal(events[0].pid, 86703);
  assert.equal(events[0].sessionId, '8a63ce95');
  assert.equal(events[0].customTitle, 'Agent Main');
  assert.equal(events[0].ts, 1_000);
});

test('BindingJournal appends multiple event types', () => {
  const file = makeTempJournal();
  const journal = new BindingJournal({ filePath: file, nowFn: () => 1_000 });

  journal.appendObserve({ pid: 1, sessionId: 'sid-A', cwd: '/x', jsonlPath: '/a.jsonl' });
  journal.appendHistorify({ pid: 1, sessionId: 'sid-A', reason: 'pid_zombie' });
  journal.appendClear({ pid: 1, oldSessionId: 'sid-A', newSessionId: 'sid-B' });
  journal.appendPidExited({ pid: 1, sessionId: 'sid-B' });
  journal.appendRemove({ pid: 1, sessionId: 'sid-B' });

  const lines = readLines(file);
  assert.equal(lines.length, 5);
  assert.deepEqual(lines.map((e) => e.event), ['observe', 'historify', 'clear', 'pid-exited', 'remove']);
});

test('lastObserveForPid returns the live binding when only an observe exists', () => {
  const file = makeTempJournal();
  const journal = new BindingJournal({ filePath: file, nowFn: () => 1_000 });

  journal.appendObserve({ pid: 100, sessionId: 'sid-A', cwd: '/x', jsonlPath: '/a.jsonl' });

  const result = journal.lastObserveForPid(100);
  assert.ok(result);
  assert.equal(result!.claudeSessionId, 'sid-A');
  assert.equal(result!.jsonlPath, '/a.jsonl');
});

test('lastObserveForPid returns undefined after historify', () => {
  const file = makeTempJournal();
  let t = 1_000;
  const journal = new BindingJournal({ filePath: file, nowFn: () => t++ });

  journal.appendObserve({ pid: 100, sessionId: 'sid-A', cwd: '/x', jsonlPath: '/a.jsonl' });
  journal.appendHistorify({ pid: 100, sessionId: 'sid-A', reason: 'pid_zombie' });

  assert.equal(journal.lastObserveForPid(100), undefined);
});

test('lastObserveForPid returns the new binding after clear', () => {
  const file = makeTempJournal();
  let t = 1_000;
  const journal = new BindingJournal({ filePath: file, nowFn: () => t++ });

  journal.appendObserve({ pid: 100, sessionId: 'sid-A', cwd: '/x', jsonlPath: '/a.jsonl' });
  journal.appendClear({ pid: 100, oldSessionId: 'sid-A', newSessionId: 'sid-B' });
  journal.appendObserve({ pid: 100, sessionId: 'sid-B', cwd: '/x', jsonlPath: '/b.jsonl' });

  const result = journal.lastObserveForPid(100);
  assert.ok(result);
  assert.equal(result!.claudeSessionId, 'sid-B');
  assert.equal(result!.jsonlPath, '/b.jsonl');
});

test('lastObserveForPid returns undefined for unknown PID', () => {
  const file = makeTempJournal();
  const journal = new BindingJournal({ filePath: file, nowFn: () => 1_000 });
  journal.appendObserve({ pid: 100, sessionId: 'sid-A', cwd: '/x', jsonlPath: '/a.jsonl' });
  assert.equal(journal.lastObserveForPid(999), undefined);
});

test('lastObserveForJsonl returns most recent observer regardless of sessionId', () => {
  const file = makeTempJournal();
  let t = 1_000;
  const journal = new BindingJournal({ filePath: file, nowFn: () => t++ });

  journal.appendObserve({ pid: 100, sessionId: 'sid-A', cwd: '/x', jsonlPath: '/shared.jsonl' });
  journal.appendObserve({ pid: 200, sessionId: 'sid-B', cwd: '/x', jsonlPath: '/shared.jsonl' });

  const result = journal.lastObserveForJsonl('/shared.jsonl');
  assert.ok(result);
  assert.equal(result!.pid, 200);
  assert.equal(result!.claudeSessionId, 'sid-B');
});

test('lastObserveForSessionId finds observe by sessionId', () => {
  const file = makeTempJournal();
  let t = 1_000;
  const journal = new BindingJournal({ filePath: file, nowFn: () => t++ });

  journal.appendObserve({ pid: 100, sessionId: 'sid-A', cwd: '/x', jsonlPath: '/a.jsonl' });
  journal.appendObserve({ pid: 200, sessionId: 'sid-B', cwd: '/y', jsonlPath: '/b.jsonl' });

  const result = journal.lastObserveForSessionId('sid-A');
  assert.ok(result);
  assert.equal(result!.pid, 100);
  assert.equal(result!.jsonlPath, '/a.jsonl');
});

test('liveBindingsAtBoot returns observed PIDs that are still alive', () => {
  const file = makeTempJournal();
  let t = 1_000;
  const journal = new BindingJournal({ filePath: file, nowFn: () => t++ });

  journal.appendObserve({ pid: 100, sessionId: 'sid-A', cwd: '/x', jsonlPath: '/a.jsonl' });
  journal.appendObserve({ pid: 200, sessionId: 'sid-B', cwd: '/y', jsonlPath: '/b.jsonl' });
  journal.appendObserve({ pid: 300, sessionId: 'sid-C', cwd: '/z', jsonlPath: '/c.jsonl' });

  // Only PIDs 100 and 300 are alive
  const bindings = journal.liveBindingsAtBoot([100, 300]);
  assert.equal(bindings.length, 2);
  assert.deepEqual(bindings.map((b) => b.pid).sort(), [100, 300]);
});

test('liveBindingsAtBoot drops historified bindings', () => {
  const file = makeTempJournal();
  let t = 1_000;
  const journal = new BindingJournal({ filePath: file, nowFn: () => t++ });

  journal.appendObserve({ pid: 100, sessionId: 'sid-A', cwd: '/x', jsonlPath: '/a.jsonl' });
  journal.appendHistorify({ pid: 100, sessionId: 'sid-A', reason: 'pid_zombie' });

  const bindings = journal.liveBindingsAtBoot([100]);
  assert.equal(bindings.length, 0);
});

test('liveBindingsAtBoot follows clear to the new binding', () => {
  const file = makeTempJournal();
  let t = 1_000;
  const journal = new BindingJournal({ filePath: file, nowFn: () => t++ });

  journal.appendObserve({ pid: 100, sessionId: 'sid-A', cwd: '/x', jsonlPath: '/a.jsonl' });
  journal.appendClear({ pid: 100, oldSessionId: 'sid-A', newSessionId: 'sid-B' });
  journal.appendObserve({ pid: 100, sessionId: 'sid-B', cwd: '/x', jsonlPath: '/b.jsonl' });

  const bindings = journal.liveBindingsAtBoot([100]);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].claudeSessionId, 'sid-B');
  assert.equal(bindings[0].jsonlPath, '/b.jsonl');
});

test('readAll returns empty array when journal file does not exist', () => {
  const file = makeTempJournal();
  const journal = new BindingJournal({ filePath: file });
  assert.deepEqual(journal.readAll(), []);
});

test('readAll skips malformed lines', () => {
  const file = makeTempJournal();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"event":"observe","ts":1,"pid":1,"sessionId":"x","cwd":"/","jsonlPath":"/x"}\n{garbage\n{"event":"observe","ts":2,"pid":2,"sessionId":"y","cwd":"/","jsonlPath":"/y"}\n', 'utf-8');
  const journal = new BindingJournal({ filePath: file });
  const events = journal.readAll();
  assert.equal(events.length, 2);
});

test('compact drops events whose JSONL no longer exists', () => {
  const file = makeTempJournal();
  let t = 1_000;
  const aliveJsonls = new Set(['/alive.jsonl']);
  const journal = new BindingJournal({
    filePath: file,
    nowFn: () => t++,
    jsonlExistsFn: (p) => aliveJsonls.has(p),
  });

  journal.appendObserve({ pid: 1, sessionId: 'sid-alive', cwd: '/x', jsonlPath: '/alive.jsonl' });
  journal.appendObserve({ pid: 2, sessionId: 'sid-dead', cwd: '/x', jsonlPath: '/dead.jsonl' });
  journal.appendHistorify({ pid: 2, sessionId: 'sid-dead', reason: 'pid_exited' });

  journal.compact();

  const events = journal.readAll();
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'observe');
  if (events[0].event !== 'observe') return;
  assert.equal(events[0].sessionId, 'sid-alive');
});

test('compact is a no-op when nothing to drop', () => {
  const file = makeTempJournal();
  const aliveJsonls = new Set(['/alive.jsonl']);
  const journal = new BindingJournal({
    filePath: file,
    nowFn: () => 1_000,
    jsonlExistsFn: (p) => aliveJsonls.has(p),
  });

  journal.appendObserve({ pid: 1, sessionId: 'sid-A', cwd: '/x', jsonlPath: '/alive.jsonl' });
  const before = fs.readFileSync(file, 'utf-8');
  journal.compact();
  const after = fs.readFileSync(file, 'utf-8');
  assert.equal(before, after);
});

test('append errors are swallowed (does not throw)', () => {
  const journal = new BindingJournal({
    filePath: '/nonexistent/dir/that/cannot/be/created/binding.jsonl',
    fsModule: {
      ...fs,
      mkdirSync: () => { throw new Error('mock failure'); },
      appendFileSync: () => { throw new Error('mock failure'); },
    },
  });

  // Should not throw
  journal.appendObserve({ pid: 1, sessionId: 'sid-A', cwd: '/x', jsonlPath: '/a.jsonl' });
});
