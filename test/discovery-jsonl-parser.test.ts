import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  truncateToolInput,
  parseHistoryEntry,
  detectInterruptReason,
  isInternalMessage,
} from '../src/discovery/jsonl-parser.js';

// ---------------------------------------------------------------------------
// truncateToolInput
// ---------------------------------------------------------------------------

test('truncateToolInput: returns undefined when input is undefined', () => {
  assert.equal(truncateToolInput(undefined), undefined);
});

test('truncateToolInput: passes through short string values unchanged', () => {
  const out = truncateToolInput({ a: 'hello', n: 42 });
  assert.deepEqual(out, { a: 'hello', n: 42 });
});

test('truncateToolInput: caps long string values at 2000 chars and appends suffix', () => {
  const long = 'x'.repeat(3000);
  const out = truncateToolInput({ body: long });
  const body = (out as { body: string }).body;
  assert.ok(body.startsWith('x'.repeat(2000)));
  assert.ok(body.includes('… [+1000 chars]'));
});

test('truncateToolInput: leaves arrays and nested objects untouched even if huge', () => {
  const arr = ['x'.repeat(3000)];
  const obj = { inner: 'x'.repeat(3000) };
  const out = truncateToolInput({ arr, obj });
  assert.deepEqual((out as { arr: unknown[] }).arr, arr);
  assert.deepEqual((out as { obj: object }).obj, obj);
});

// ---------------------------------------------------------------------------
// isInternalMessage
// ---------------------------------------------------------------------------

test('isInternalMessage: false for plain user prose', () => {
  assert.equal(isInternalMessage('hello world'), false);
});

test('isInternalMessage: false for non-< text even if prefixed by spaces', () => {
  assert.equal(isInternalMessage('   plain text'), false);
});

test('isInternalMessage: true for system-reminder envelope', () => {
  assert.equal(isInternalMessage('<system-reminder>foo</system-reminder>'), true);
});

test('isInternalMessage: true for command-name and other known envelopes', () => {
  assert.equal(isInternalMessage('<command-name>x</command-name>'), true);
  assert.equal(isInternalMessage('<task-notification>x'), true);
  assert.equal(isInternalMessage('<teammate-message>x'), true);
  assert.equal(isInternalMessage('<local-command-caveat>x'), true);
  assert.equal(isInternalMessage('<local-command>x'), true);
  assert.equal(isInternalMessage('<user-prompt-submit-hook>x'), true);
});

test('isInternalMessage: false for unrelated XML-like prefixes', () => {
  assert.equal(isInternalMessage('<custom-tag>x</custom-tag>'), false);
});

test('isInternalMessage: trims leading whitespace before checking', () => {
  assert.equal(isInternalMessage('  \n<system-reminder>x'), true);
});

// ---------------------------------------------------------------------------
// detectInterruptReason
// ---------------------------------------------------------------------------

test('detectInterruptReason: returns null for arbitrary string', () => {
  assert.equal(detectInterruptReason('regular message'), null);
});

test('detectInterruptReason: returns "streaming" for cancel marker string', () => {
  assert.equal(detectInterruptReason('[Request interrupted by user]'), 'streaming');
});

test('detectInterruptReason: detects in array of text blocks', () => {
  const r = detectInterruptReason([
    { type: 'text', text: 'hello' },
    { type: 'text', text: '[Request interrupted by user]' },
  ]);
  assert.equal(r, 'streaming');
});

test('detectInterruptReason: detects "tool_use" marker inside tool_result string', () => {
  const r = detectInterruptReason([
    { type: 'tool_result', content: '[Tool use interrupted]' },
  ]);
  assert.equal(r, 'tool_use');
});

test('detectInterruptReason: detects marker inside tool_result content array', () => {
  const r = detectInterruptReason([
    {
      type: 'tool_result',
      content: [{ type: 'text', text: '[Tool use interrupted]' }],
    },
  ]);
  assert.equal(r, 'tool_use');
});

test('detectInterruptReason: returns null for unrelated array contents', () => {
  const r = detectInterruptReason([
    { type: 'text', text: 'hello' },
    { type: 'tool_result', content: 'no marker here' },
  ]);
  assert.equal(r, null);
});

test('detectInterruptReason: returns null for non-string non-array (numbers, objects)', () => {
  assert.equal(detectInterruptReason(42 as unknown), null);
  assert.equal(detectInterruptReason({ foo: 'bar' } as unknown), null);
  assert.equal(detectInterruptReason(null), null);
});

// ---------------------------------------------------------------------------
// parseHistoryEntry — user rows
// ---------------------------------------------------------------------------

test('parseHistoryEntry: user row with string content yields user message + sdkUuid', () => {
  const out = parseHistoryEntry({
    type: 'user',
    timestamp: 't1',
    uuid: 'u-1',
    message: { role: 'user', content: 'hi' },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content, 'hi');
  assert.equal(out[0].timestamp, 't1');
  assert.equal(out[0].sdkUuid, 'u-1');
});

test('parseHistoryEntry: user row missing content returns []', () => {
  assert.deepEqual(parseHistoryEntry({ type: 'user', message: {} }), []);
  assert.deepEqual(parseHistoryEntry({ type: 'user' }), []);
});

test('parseHistoryEntry: user row with array content concatenates text blocks', () => {
  const out = parseHistoryEntry({
    type: 'user',
    timestamp: 't',
    message: { content: [
      { type: 'text', text: 'foo' },
      { type: 'text', text: 'bar' },
      { type: 'tool_use', name: 'X' },  // skipped
    ] },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'foobar');
});

test('parseHistoryEntry: user row with empty concatenated content returns []', () => {
  const out = parseHistoryEntry({
    type: 'user',
    message: { content: [] },
  });
  assert.deepEqual(out, []);
});

test('parseHistoryEntry: user row that is internal-message envelope is filtered out', () => {
  const out = parseHistoryEntry({
    type: 'user',
    message: { content: '<system-reminder>internal</system-reminder>' },
  });
  assert.deepEqual(out, []);
});

test('parseHistoryEntry: user row that is interrupt marker becomes a system message', () => {
  const out = parseHistoryEntry({
    type: 'user',
    timestamp: 't',
    message: { content: '[Request interrupted by user]' },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'system');
  assert.ok(out[0].content.length > 0);
  assert.equal(out[0].timestamp, 't');
});

test('parseHistoryEntry: user row with non-string entry.uuid leaves sdkUuid undefined', () => {
  const out = parseHistoryEntry({
    type: 'user',
    uuid: 42,
    message: { content: 'hi' },
  });
  assert.equal(out[0].sdkUuid, undefined);
});

test('parseHistoryEntry: user row with non-string non-array content yields []', () => {
  const out = parseHistoryEntry({
    type: 'user',
    message: { content: 42 as unknown },
  });
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------
// parseHistoryEntry — assistant rows
// ---------------------------------------------------------------------------

test('parseHistoryEntry: assistant row with text + tool_use blocks emits both', () => {
  const out = parseHistoryEntry({
    type: 'assistant',
    timestamp: 't',
    message: { content: [
      { type: 'text', text: 'thinking out loud' },
      { type: 'tool_use', name: 'Bash', id: 'tu-1', input: { command: 'ls' } },
    ] },
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].content, 'thinking out loud');
  assert.equal(out[1].role, 'tool_use');
  assert.equal(out[1].toolName, 'Bash');
  assert.equal(out[1].toolId, 'tu-1');
  assert.deepEqual(out[1].toolInput, { command: 'ls' });
});

test('parseHistoryEntry: assistant row with no content returns []', () => {
  assert.deepEqual(parseHistoryEntry({ type: 'assistant', message: {} }), []);
  assert.deepEqual(parseHistoryEntry({ type: 'assistant' }), []);
});

test('parseHistoryEntry: assistant row with non-array content returns []', () => {
  assert.deepEqual(parseHistoryEntry({
    type: 'assistant',
    message: { content: 'just a string' as unknown },
  }), []);
});

test('parseHistoryEntry: assistant row emits one ParsedMessage per text block with sdkBlockIndex', () => {
  const out = parseHistoryEntry({
    type: 'assistant',
    uuid: 'row-uuid-1',
    message: { content: [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ] },
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].content, 'a');
  assert.equal(out[0].sdkUuid, 'row-uuid-1');
  assert.equal(out[0].sdkBlockIndex, 0);
  assert.equal(out[1].role, 'assistant');
  assert.equal(out[1].content, 'b');
  assert.equal(out[1].sdkUuid, 'row-uuid-1');
  assert.equal(out[1].sdkBlockIndex, 1);
});

test('parseHistoryEntry: assistant row with [Tool use interrupted] text emits system marker (timestamp+1ms)', () => {
  const out = parseHistoryEntry({
    type: 'assistant',
    timestamp: '2025-01-01T00:00:00.000Z',
    message: { content: [
      { type: 'text', text: '[Tool use interrupted]' },
    ] },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].timestamp, '2025-01-01T00:00:00.001Z');
});

test('parseHistoryEntry: assistant row interrupted with no timestamp leaves timestamp undefined', () => {
  const out = parseHistoryEntry({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: '[Tool use interrupted]' },
    ] },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].timestamp, undefined);
});

test('parseHistoryEntry: assistant row caps tool_use input string fields', () => {
  const long = 'y'.repeat(3000);
  const out = parseHistoryEntry({
    type: 'assistant',
    message: { content: [
      { type: 'tool_use', name: 'Write', id: 't', input: { content: long } },
    ] },
  });
  const body = (out[0].toolInput as { content: string }).content;
  assert.ok(body.length < long.length);
  assert.ok(body.endsWith('chars]'));
});

test('parseHistoryEntry: assistant row with text + interrupt marker keeps non-interrupt text and adds system marker', () => {
  const out = parseHistoryEntry({
    type: 'assistant',
    timestamp: '2025-01-01T00:00:00.000Z',
    message: { content: [
      { type: 'text', text: 'real output' },
      { type: 'text', text: '[Tool use interrupted]' },
    ] },
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].content, 'real output');
  assert.equal(out[1].role, 'system');
});

// ---------------------------------------------------------------------------
// parseHistoryEntry — other types
// ---------------------------------------------------------------------------

test('parseHistoryEntry: unknown type returns []', () => {
  assert.deepEqual(parseHistoryEntry({ type: 'system' }), []);
  assert.deepEqual(parseHistoryEntry({}), []);
});

// ---------------------------------------------------------------------------
// parseHistoryEntry — parentUuid → parentInvokeSdkUuid
// ---------------------------------------------------------------------------

test('parseHistoryEntry: user row with <local-command-stdout> + parentUuid sets parentInvokeSdkUuid', () => {
  const out = parseHistoryEntry({
    type: 'user',
    uuid: 'u-stdout-1',
    parentUuid: 'parent-2',
    timestamp: 't',
    message: { content: '<local-command-stdout>cost: $0.42</local-command-stdout>' },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'local_command_output');
  assert.equal(out[0].content, 'cost: $0.42');
  assert.equal(out[0].parentInvokeSdkUuid, 'parent-2');
  assert.equal(out[0].sdkUuid, 'u-stdout-1');
});

test('parseHistoryEntry: system local_command subtype with parentUuid sets parentInvokeSdkUuid', () => {
  const out = parseHistoryEntry({
    type: 'system',
    subtype: 'local_command',
    uuid: 'sys-1',
    parentUuid: 'parent-3',
    content: '<local-command-stdout>context: 50%</local-command-stdout>',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'local_command_output');
  assert.equal(out[0].parentInvokeSdkUuid, 'parent-3');
});

test('parseHistoryEntry: local_command_invoke does NOT carry parentInvokeSdkUuid', () => {
  const out = parseHistoryEntry({
    type: 'user',
    uuid: 'u-invoke-1',
    parentUuid: 'parent-4',
    message: { content: '<command-name>/cost</command-name>' },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'local_command_invoke');
  assert.equal(out[0].parentInvokeSdkUuid, undefined);
});
