import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NdjsonProtocolHandler } from '../src/protocol/ndjson-handler.js';

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

test('buffers partial NDJSON lines until newline arrives', () => {
  const handler = new NdjsonProtocolHandler();
  const messages: string[] = [];
  handler.on('assistant_message', (event) => messages.push(event.message));

  const payload = line({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'ignored without start' },
  });
  const assistant = line({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hello' }] },
  });

  handler.feed(payload);
  handler.feed(assistant.slice(0, -1));
  assert.deepEqual(messages, []);

  handler.feed('\n');
  assert.deepEqual(messages, ['hello']);
});

test('flush parses a trailing line without newline', () => {
  const handler = new NdjsonProtocolHandler();
  const results: unknown[] = [];
  handler.on('result', (event) => results.push(event));

  handler.feed(JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 12 }));
  handler.flush();

  assert.deepEqual(results, [{ type: 'result', subtype: 'success', duration_ms: 12 }]);
});

test('emits accumulated thinking and assistant text deltas', () => {
  const handler = new NdjsonProtocolHandler();
  const thinking: string[] = [];
  const messages: string[] = [];
  handler.on('thinking', (event) => thinking.push(event.thinking));
  handler.on('assistant_message', (event) => messages.push(event.message));

  handler.feed(line({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'a' } }));
  handler.feed(line({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'b' } }));
  handler.feed(line({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'he' } }));
  handler.feed(line({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'llo' } }));

  assert.deepEqual(thinking, ['a', 'ab']);
  assert.deepEqual(messages, ['he', 'hello']);
});

test('emits initial and final tool use when JSON input deltas complete', () => {
  const handler = new NdjsonProtocolHandler();
  const toolUses: unknown[] = [];
  handler.on('tool_use', (event) => toolUses.push(event));

  handler.feed(line({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash' },
  }));
  handler.feed(line({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command"' } }));
  handler.feed(line({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':"npm test"}' } }));
  handler.feed(line({ type: 'content_block_stop', index: 0 }));

  assert.deepEqual(toolUses, [
    { type: 'tool_use', tool_id: 'tool-1', tool_name: 'Bash', tool_input: {} },
    { type: 'tool_use', tool_id: 'tool-1', tool_name: 'Bash', tool_input: { command: 'npm test' } },
  ]);
});

test('maps user tool results to success and error events', () => {
  const handler = new NdjsonProtocolHandler();
  const toolResults: unknown[] = [];
  handler.on('tool_result', (event) => toolResults.push(event));

  handler.feed(line({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'ok', content: 'done' },
        { type: 'tool_result', tool_use_id: 'bad', content: 'failed', is_error: true },
      ],
    },
  }));

  assert.deepEqual(toolResults, [
    { type: 'tool_result', tool_id: 'ok', status: 'success', output: 'done' },
    { type: 'tool_result', tool_id: 'bad', status: 'error', output: 'failed' },
  ]);
});

test('emits permission requests from control_request events', () => {
  const handler = new NdjsonProtocolHandler();
  const requests: unknown[] = [];
  handler.on('permission_request', (event) => requests.push(event));

  handler.feed(line({
    type: 'control_request',
    request_id: 'perm-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      tool_input: { file_path: 'README.md' },
    },
  }));

  assert.deepEqual(requests, [{
    request_id: 'perm-1',
    tool_name: 'Write',
    tool_input: { file_path: 'README.md' },
  }]);
});

test('invalid JSON emits error and reset clears buffered active state', () => {
  const handler = new NdjsonProtocolHandler();
  const errors: string[] = [];
  const toolUses: unknown[] = [];
  handler.on('error', (error) => errors.push(error.message));
  handler.on('tool_use', (event) => toolUses.push(event));

  handler.feed('{not json}\n');
  handler.feed(line({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-2', name: 'Read' } }));
  handler.feed(line({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":"a"}' } }));
  handler.reset();
  handler.feed(line({ type: 'content_block_stop', index: 2 }));

  assert.equal(errors.length, 1);
  assert.match(errors[0], /Failed to parse NDJSON line/);
  assert.deepEqual(toolUses, [{ type: 'tool_use', tool_id: 'tool-2', tool_name: 'Read', tool_input: {} }]);
});
