import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCodexHookRequest, pickString, pickNumber } from '../src/hooks/codex-hook-parser.js';

// ---------------------------------------------------------------------------
// pickString
// ---------------------------------------------------------------------------

test('pickString: returns first non-empty string match in key order', () => {
  assert.equal(pickString({ a: 'x', b: 'y' }, ['a', 'b']), 'x');
  assert.equal(pickString({ a: 'x', b: 'y' }, ['b', 'a']), 'y');
});

test('pickString: skips missing/empty/non-string values', () => {
  assert.equal(pickString({ a: '', b: 'y' }, ['a', 'b']), 'y');
  assert.equal(pickString({ a: 42, b: 'y' }, ['a', 'b']), 'y');
  assert.equal(pickString({ a: null, b: 'y' }, ['a', 'b']), 'y');
});

test('pickString: returns undefined when no key matches', () => {
  assert.equal(pickString({}, ['a']), undefined);
  assert.equal(pickString({ a: '', b: 0 }, ['a', 'b']), undefined);
});

// ---------------------------------------------------------------------------
// pickNumber
// ---------------------------------------------------------------------------

test('pickNumber: returns first finite number match', () => {
  assert.equal(pickNumber({ a: 1, b: 2 }, ['a', 'b']), 1);
  assert.equal(pickNumber({ a: 0, b: 2 }, ['a', 'b']), 0);
});

test('pickNumber: parses digit-only string', () => {
  assert.equal(pickNumber({ a: '123' }, ['a']), 123);
});

test('pickNumber: rejects non-digit strings', () => {
  assert.equal(pickNumber({ a: '12.3' }, ['a']), undefined);
  assert.equal(pickNumber({ a: '1e3' }, ['a']), undefined);
  assert.equal(pickNumber({ a: 'abc' }, ['a']), undefined);
});

test('pickNumber: rejects NaN/Infinity', () => {
  assert.equal(pickNumber({ a: NaN }, ['a']), undefined);
  assert.equal(pickNumber({ a: Infinity }, ['a']), undefined);
});

test('pickNumber: returns undefined when no key matches', () => {
  assert.equal(pickNumber({}, ['a']), undefined);
});

// ---------------------------------------------------------------------------
// parseCodexHookRequest — sessionId fallback chain
// ---------------------------------------------------------------------------

test('parseCodexHookRequest: prefers session_id over thread_id over conversation_id', () => {
  assert.equal(parseCodexHookRequest({ session_id: 'a', thread_id: 'b', conversation_id: 'c' }).sessionId, 'a');
  assert.equal(parseCodexHookRequest({ thread_id: 'b', conversation_id: 'c' }).sessionId, 'b');
  assert.equal(parseCodexHookRequest({ conversation_id: 'c' }).sessionId, 'c');
});

test('parseCodexHookRequest: sessionId defaults to "" when none present', () => {
  assert.equal(parseCodexHookRequest({}).sessionId, '');
});

test('parseCodexHookRequest: hookEventName defaults to CodexHook', () => {
  assert.equal(parseCodexHookRequest({}).hookEventName, 'CodexHook');
  assert.equal(parseCodexHookRequest({ hook_event_name: 'X' }).hookEventName, 'X');
  assert.equal(parseCodexHookRequest({ hookEventName: 'Y' }).hookEventName, 'Y');
});

// ---------------------------------------------------------------------------
// parseCodexHookRequest — toolInput shape
// ---------------------------------------------------------------------------

test('parseCodexHookRequest: toolInput accepts plain objects', () => {
  const r = parseCodexHookRequest({ tool_input: { x: 1 } });
  assert.deepEqual(r.toolInput, { x: 1 });
});

test('parseCodexHookRequest: toolInput rejects arrays', () => {
  const r = parseCodexHookRequest({ tool_input: [1, 2] });
  assert.equal(r.toolInput, undefined);
});

test('parseCodexHookRequest: toolInput rejects non-objects', () => {
  assert.equal(parseCodexHookRequest({ tool_input: 'str' }).toolInput, undefined);
  assert.equal(parseCodexHookRequest({ tool_input: null }).toolInput, undefined);
  assert.equal(parseCodexHookRequest({ tool_input: 42 }).toolInput, undefined);
  assert.equal(parseCodexHookRequest({}).toolInput, undefined);
});

// ---------------------------------------------------------------------------
// parseCodexHookRequest — fallback fields
// ---------------------------------------------------------------------------

test('parseCodexHookRequest: cwd + transcriptPath default to ""', () => {
  const r = parseCodexHookRequest({});
  assert.equal(r.cwd, '');
  assert.equal(r.transcriptPath, '');
});

test('parseCodexHookRequest: transcriptPath falls back from rollout_path', () => {
  assert.equal(parseCodexHookRequest({ rollout_path: '/r' }).transcriptPath, '/r');
  // transcript_path wins over rollout_path
  assert.equal(parseCodexHookRequest({ transcript_path: '/t', rollout_path: '/r' }).transcriptPath, '/t');
});

test('parseCodexHookRequest: toolUseId / toolName fallbacks (call_id, name)', () => {
  assert.equal(parseCodexHookRequest({ tool_use_id: 'a' }).toolUseId, 'a');
  assert.equal(parseCodexHookRequest({ call_id: 'b' }).toolUseId, 'b');
  assert.equal(parseCodexHookRequest({ tool_use_id: 'a', call_id: 'b' }).toolUseId, 'a');
  assert.equal(parseCodexHookRequest({ tool_name: 'x' }).toolName, 'x');
  assert.equal(parseCodexHookRequest({ name: 'y' }).toolName, 'y');
});

test('parseCodexHookRequest: hookPid + codexPid accept agent_pocket_* and bare keys', () => {
  assert.equal(parseCodexHookRequest({ agent_pocket_hook_pid: 100 }).hookPid, 100);
  assert.equal(parseCodexHookRequest({ hook_pid: 200 }).hookPid, 200);
  assert.equal(parseCodexHookRequest({ agent_pocket_codex_pid: '300' }).codexPid, 300);
  assert.equal(parseCodexHookRequest({ codex_pid: 400 }).codexPid, 400);
});

test('parseCodexHookRequest: optional fields undefined when missing', () => {
  const r = parseCodexHookRequest({});
  assert.equal(r.threadId, undefined);
  assert.equal(r.turnId, undefined);
  assert.equal(r.source, undefined);
  assert.equal(r.prompt, undefined);
  assert.equal(r.toolUseId, undefined);
  assert.equal(r.toolName, undefined);
  assert.equal(r.hookPid, undefined);
  assert.equal(r.codexPid, undefined);
});

test('parseCodexHookRequest: full payload round-trip', () => {
  const r = parseCodexHookRequest({
    session_id: 's-1',
    thread_id: 't-1',
    turn_id: 'turn-1',
    cwd: '/repo',
    transcript_path: '/t.jsonl',
    hook_event_name: 'PermissionRequest',
    source: 'codex',
    prompt: 'hello',
    tool_use_id: 'tu-1',
    tool_name: 'shell',
    tool_input: { cmd: 'ls' },
    agent_pocket_hook_pid: 999,
    agent_pocket_codex_pid: 888,
  });
  assert.deepEqual(r, {
    sessionId: 's-1',
    threadId: 't-1',
    turnId: 'turn-1',
    cwd: '/repo',
    transcriptPath: '/t.jsonl',
    hookEventName: 'PermissionRequest',
    source: 'codex',
    prompt: 'hello',
    toolUseId: 'tu-1',
    toolName: 'shell',
    toolInput: { cmd: 'ls' },
    hookPid: 999,
    codexPid: 888,
  });
});
