import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CODEX_STOP_DEDUPE_MS,
  CodexStopHookDeduper,
  findCodexHookRolloutPath,
  getCodexCapabilities,
  refreshCodexTerminalTarget,
  resolveCodexExternalSessionId,
  incrementInjectedMessageCount,
  consumeInjectedMessage,
  type CodexTerminalTargetEntry,
} from '../src/codex/codex-handler.js';
import type { CodexHookRequest } from '../src/hooks/hook-server.js';
import type { TerminalTarget } from '../src/pty/tmux-injector.js';

function tmpFile(name: string, contents = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-handler-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents, 'utf-8');
  return file;
}

const fakeTarget: TerminalTarget = { kind: 'tmux', target: '%1' } as unknown as TerminalTarget;

// ---------------------------------------------------------------------------
// getCodexCapabilities
// ---------------------------------------------------------------------------

test('getCodexCapabilities returns full set when a terminal target is attached', () => {
  const entry: CodexTerminalTargetEntry = { target: fakeTarget, updatedAt: 1 };
  assert.deepEqual(
    getCodexCapabilities(entry),
    ['observe', 'terminal_remote_message', 'terminal_interrupt', 'permissions'],
  );
});

test('getCodexCapabilities returns observe-only when no target is attached', () => {
  assert.deepEqual(getCodexCapabilities({ updatedAt: 1 }), ['observe']);
});

test('getCodexCapabilities returns observe-only when entry is undefined', () => {
  assert.deepEqual(getCodexCapabilities(undefined), ['observe']);
});

// ---------------------------------------------------------------------------
// findCodexHookRolloutPath
// ---------------------------------------------------------------------------

test('findCodexHookRolloutPath uses transcriptPath when it exists on disk', () => {
  const file = tmpFile('rollout.jsonl');
  const request: CodexHookRequest = { sessionId: 'codex:abc', transcriptPath: file } as CodexHookRequest;
  assert.equal(findCodexHookRolloutPath(request, 'codex:abc'), file);
});

test('findCodexHookRolloutPath ignores transcriptPath that does not exist', () => {
  const request: CodexHookRequest = {
    sessionId: 'codex:abc',
    transcriptPath: '/no/such/file.jsonl',
    codexPid: 999,
  } as CodexHookRequest;
  // codexPid is set but the injected findOpenRollouts returns nothing
  const result = findCodexHookRolloutPath(request, 'codex:abc', {
    findOpenRollouts: () => [],
  });
  assert.equal(result, undefined);
});

test('findCodexHookRolloutPath returns undefined when there is no transcriptPath and no codexPid', () => {
  const request = { sessionId: 'codex:abc' } as CodexHookRequest;
  assert.equal(findCodexHookRolloutPath(request, 'codex:abc'), undefined);
});

test('findCodexHookRolloutPath finds the open rollout matching the threadId', () => {
  const request = { sessionId: 'codex:thread-7', codexPid: 5 } as CodexHookRequest;
  const result = findCodexHookRolloutPath(request, 'codex:thread-7', {
    findOpenRollouts: () => [
      '/tmp/rollouts/2025-01-01-thread-other.jsonl',
      '/tmp/rollouts/2025-01-02-thread-7.jsonl',
    ],
    fileExists: () => false,
    fileMtimeMs: () => 1,
  });
  assert.equal(result, '/tmp/rollouts/2025-01-02-thread-7.jsonl');
});

test('findCodexHookRolloutPath falls back to newest rollout when no exact threadId match', () => {
  const request = { sessionId: 'codex:thread-7', codexPid: 5 } as CodexHookRequest;
  const mtimes: Record<string, number> = {
    '/tmp/a.jsonl': 100,
    '/tmp/b.jsonl': 500,
    '/tmp/c.jsonl': 300,
  };
  const result = findCodexHookRolloutPath(request, 'codex:thread-7', {
    findOpenRollouts: () => ['/tmp/a.jsonl', '/tmp/b.jsonl', '/tmp/c.jsonl'],
    fileExists: () => false,
    fileMtimeMs: (f) => mtimes[f],
  });
  assert.equal(result, '/tmp/b.jsonl');
});

test('findCodexHookRolloutPath skips rollouts whose mtime cannot be read', () => {
  const request = { sessionId: 'codex:thread-7', codexPid: 5 } as CodexHookRequest;
  const result = findCodexHookRolloutPath(request, 'codex:thread-7', {
    findOpenRollouts: () => ['/tmp/missing.jsonl', '/tmp/present.jsonl'],
    fileExists: () => false,
    fileMtimeMs: (f) => (f === '/tmp/present.jsonl' ? 100 : undefined),
  });
  assert.equal(result, '/tmp/present.jsonl');
});

test('findCodexHookRolloutPath strips the codex: prefix when matching threadId', () => {
  const request = { sessionId: 'codex:abc-def', codexPid: 5 } as CodexHookRequest;
  const result = findCodexHookRolloutPath(request, 'codex:abc-def', {
    findOpenRollouts: () => ['/tmp/rollout-abc-def.jsonl'],
    fileExists: () => false,
    fileMtimeMs: () => 1,
  });
  // Should match because basename 'rollout-abc-def.jsonl' includes 'abc-def'
  assert.equal(result, '/tmp/rollout-abc-def.jsonl');
});

// ---------------------------------------------------------------------------
// resolveCodexExternalSessionId
// ---------------------------------------------------------------------------

const noState = {
  hasTerminalTarget: () => false,
  hasObserver: () => false,
  hasSession: () => false,
};

test('resolveCodexExternalSessionId returns the input when it is already codex-prefixed', () => {
  assert.equal(resolveCodexExternalSessionId('codex:abc', noState), 'codex:abc');
});

test('resolveCodexExternalSessionId returns undefined for empty input', () => {
  assert.equal(resolveCodexExternalSessionId('', noState), undefined);
});

test('resolveCodexExternalSessionId returns undefined when no predicate matches', () => {
  assert.equal(resolveCodexExternalSessionId('thread-1', noState), undefined);
});

test('resolveCodexExternalSessionId returns the prefixed id when terminal target predicate matches', () => {
  const result = resolveCodexExternalSessionId('thread-1', {
    ...noState,
    hasTerminalTarget: (id) => id === 'codex:thread-1',
  });
  assert.equal(result, 'codex:thread-1');
});

test('resolveCodexExternalSessionId returns the prefixed id when observer predicate matches', () => {
  const result = resolveCodexExternalSessionId('thread-1', {
    ...noState,
    hasObserver: (id) => id === 'codex:thread-1',
  });
  assert.equal(result, 'codex:thread-1');
});

test('resolveCodexExternalSessionId returns the prefixed id when session predicate matches', () => {
  const result = resolveCodexExternalSessionId('thread-1', {
    ...noState,
    hasSession: (id) => id === 'codex:thread-1',
  });
  assert.equal(result, 'codex:thread-1');
});

// ---------------------------------------------------------------------------
// CodexStopHookDeduper
// ---------------------------------------------------------------------------

test('CodexStopHookDeduper.consume returns false when no record exists', () => {
  const d = new CodexStopHookDeduper();
  assert.equal(d.consume('s'), false);
});

test('CodexStopHookDeduper.consume returns true once after record(), then false', () => {
  const d = new CodexStopHookDeduper();
  d.record('s');
  assert.equal(d.consume('s'), true);
  assert.equal(d.consume('s'), false);
});

test('CodexStopHookDeduper.consume returns false (and clears) when record is past TTL', () => {
  let now = 1000;
  const d = new CodexStopHookDeduper({ ttlMs: 100, now: () => now });
  d.record('s');
  now = 2000; // far past TTL
  assert.equal(d.consume('s'), false);
  assert.equal(d.size(), 0);
});

test('CodexStopHookDeduper.record evicts other expired records on insert', () => {
  let now = 1000;
  const d = new CodexStopHookDeduper({ ttlMs: 100, now: () => now });
  d.record('old');
  now = 2000;
  d.record('new');
  // 'old' was evicted opportunistically when 'new' was recorded
  assert.equal(d.size(), 1);
  assert.equal(d.consume('new'), true);
  assert.equal(d.consume('old'), false);
});

test('CodexStopHookDeduper default TTL matches CODEX_STOP_DEDUPE_MS', () => {
  // sanity check that the exported constant is the default
  let now = 0;
  const d = new CodexStopHookDeduper({ now: () => now });
  d.record('s');
  now = CODEX_STOP_DEDUPE_MS - 1;
  assert.equal(d.consume('s'), true);
  d.record('s');
  now = CODEX_STOP_DEDUPE_MS * 3;
  assert.equal(d.consume('s'), false);
});

// ---------------------------------------------------------------------------
// refreshCodexTerminalTarget
// ---------------------------------------------------------------------------

test('refreshCodexTerminalTarget returns existing entry untouched when it already has a target', () => {
  const existing: CodexTerminalTargetEntry = { pid: 100, target: fakeTarget, updatedAt: 1 };
  const result = refreshCodexTerminalTarget(existing, { pid: 200 }, () => undefined);
  assert.strictEqual(result, existing);
});

test('refreshCodexTerminalTarget returns existing (possibly undefined) when no live session', () => {
  assert.equal(refreshCodexTerminalTarget(undefined, undefined, () => undefined), undefined);
  const existing: CodexTerminalTargetEntry = { pid: 100, updatedAt: 1 };
  assert.strictEqual(
    refreshCodexTerminalTarget(existing, undefined, () => undefined),
    existing,
  );
});

test('refreshCodexTerminalTarget builds a new entry from the live pid', () => {
  const existing: CodexTerminalTargetEntry = {
    pid: 99,
    cwd: '/tmp/x',
    transcriptPath: '/tmp/t.jsonl',
    turnId: 'turn-1',
    updatedAt: 1,
  };
  const result = refreshCodexTerminalTarget(
    existing,
    { pid: 200 },
    (pid) => (pid === 200 ? fakeTarget : undefined),
    () => 9999,
  );
  assert.deepEqual(result, {
    pid: 200,
    target: fakeTarget,
    cwd: '/tmp/x',
    transcriptPath: '/tmp/t.jsonl',
    turnId: 'turn-1',
    updatedAt: 9999,
  });
});

test('refreshCodexTerminalTarget tolerates findTerminal returning null', () => {
  const result = refreshCodexTerminalTarget(
    undefined,
    { pid: 200 },
    () => null,
  );
  assert.equal(result?.pid, 200);
  assert.equal(result?.target, undefined);
});

// ---------------------------------------------------------------------------
// injected-message bookkeeping
// ---------------------------------------------------------------------------

test('incrementInjectedMessageCount bumps the counter and tracks repeat strings', () => {
  const m = new Map<string, number>();
  incrementInjectedMessageCount(m, 'hi');
  incrementInjectedMessageCount(m, 'hi');
  incrementInjectedMessageCount(m, 'bye');
  assert.equal(m.get('hi'), 2);
  assert.equal(m.get('bye'), 1);
});

test('consumeInjectedMessage decrements when count > 1, deletes when it hits 0, returns true on hit', () => {
  const m = new Map<string, number>();
  m.set('hi', 2);
  assert.equal(consumeInjectedMessage(m, 'hi'), true);
  assert.equal(m.get('hi'), 1);
  assert.equal(consumeInjectedMessage(m, 'hi'), true);
  assert.equal(m.has('hi'), false);
});

test('consumeInjectedMessage returns false when the message is unknown or the map is undefined', () => {
  const m = new Map<string, number>();
  assert.equal(consumeInjectedMessage(m, 'missing'), false);
  assert.equal(consumeInjectedMessage(undefined, 'missing'), false);
});
