import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { __test_passesStandalonePidNewerPick as passes } from '../src/wiring/session-discovery-loop.js';
import { BindingJournal } from '../src/persistence/binding-journal.js';
import type { DiscoveredSession, RunningCliSession } from '../src/discovery/session-discovery.js';

function makeTempJournal(): BindingJournal {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdl-newer-pick-'));
  return new BindingJournal({ filePath: path.join(dir, 'binding.jsonl'), nowFn: () => 1_000 });
}

function discovered(sid: string, file: string): DiscoveredSession {
  return { sessionId: sid, projectDir: path.dirname(file), lastModified: 1, filePath: file };
}

function cli(pid: number, sid: string): RunningCliSession {
  return { pid, sessionId: sid, cwd: '/x', entrypoint: 'cli' };
}

test('passesStandalonePidNewerPick: no journal → accept (legacy fallback)', () => {
  const d = discovered('sid-A', '/p/sid-A.jsonl');
  assert.equal(passes(d, 100, [cli(100, 'sid-A')], null), true);
  assert.equal(passes(d, 100, [cli(100, 'sid-A')], undefined), true);
});

test('passesStandalonePidNewerPick: live PID-JSON corroboration → accept (clear case)', () => {
  const j = makeTempJournal();
  const d = discovered('sid-new-after-clear', '/p/new.jsonl');
  assert.equal(passes(d, 100, [cli(100, 'sid-new-after-clear')], j), true);
});

test('passesStandalonePidNewerPick: PID-JSON claims a different sid → reject (orphan)', () => {
  const j = makeTempJournal();
  const d = discovered('sid-orphan', '/p/orphan.jsonl');
  assert.equal(passes(d, 100, [cli(100, 'sid-real')], j), false);
});

test('passesStandalonePidNewerPick: journal poisoned with stale observe → still reject if PID-JSON disagrees', () => {
  // Prior buggy run wrote an observe for the orphan onto this PID — the
  // journal alone would whitelist it. The live PID-JSON check (which now
  // claims a different sid) must veto.
  const j = makeTempJournal();
  j.appendObserve({ pid: 100, sessionId: 'sid-orphan', cwd: '/x', jsonlPath: '/p/orphan.jsonl' });
  const d = discovered('sid-orphan', '/p/orphan.jsonl');
  assert.equal(passes(d, 100, [cli(100, 'sid-real')], j), false);
});

test('passesStandalonePidNewerPick: another PID owns the candidate → reject', () => {
  const j = makeTempJournal();
  const d = discovered('sid-other', '/p/other.jsonl');
  assert.equal(passes(d, 100, [cli(999, 'sid-other'), cli(100, 'sid-A')], j), false);
});
