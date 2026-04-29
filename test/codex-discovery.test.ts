import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codexHistoryMessageToEvent,
  parseCodexHistoryEntry,
  parseCodexLifecycleEntry,
  parseCodexProcessList,
} from '../src/discovery/codex-discovery.js';

test('parseCodexProcessList matches only Codex executables', () => {
  const pids = parseCodexProcessList(`
    101 /opt/homebrew/bin/codex
    102 /usr/local/bin/codex-cli --model gpt-5
    103 /usr/local/bin/codex-foo
    104 node /tmp/codex
    105 /Applications/Codex.app/Contents/MacOS/codex
  `);

  assert.deepEqual(pids, [101, 102, 105]);
});

test('parseCodexHistoryEntry maps Codex response items to history messages', () => {
  const assistant = parseCodexHistoryEntry({
    timestamp: '2026-04-29T00:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Done.' }],
    },
  });
  assert.deepEqual(assistant, [{ role: 'assistant', content: 'Done.', timestamp: '2026-04-29T00:00:00.000Z' }]);

  const toolUse = parseCodexHistoryEntry({
    type: 'response_item',
    payload: {
      type: 'function_call',
      call_id: 'call_1',
      name: 'exec_command',
      arguments: '{"cmd":"npm test"}',
    },
  });
  assert.equal(toolUse[0].role, 'tool_use');
  assert.equal(toolUse[0].toolId, 'call_1');
  assert.equal(toolUse[0].toolName, 'exec_command');
  assert.deepEqual(toolUse[0].toolInput, { cmd: 'npm test' });

  const toolResult = parseCodexHistoryEntry({
    type: 'event_msg',
    payload: {
      type: 'exec_command_end',
      call_id: 'call_1',
      exit_code: 0,
      aggregated_output: 'ok',
    },
  });
  assert.equal(toolResult[0].role, 'tool_result');
  assert.equal(toolResult[0].toolStatus, 'success');
  assert.equal(toolResult[0].toolResultContent, 'ok');
});

test('codexHistoryMessageToEvent maps history messages to phone events', () => {
  assert.deepEqual(codexHistoryMessageToEvent({ role: 'assistant', content: 'hi' }), {
    type: 'assistant_message',
    message: 'hi',
  });
  assert.deepEqual(codexHistoryMessageToEvent({ role: 'tool_result', content: 'bad', toolId: 't1', toolStatus: 'error' }), {
    type: 'tool_result',
    tool_id: 't1',
    status: 'error',
    output: 'bad',
  });
});

test('parseCodexLifecycleEntry detects completed and failed Codex turns', () => {
  assert.deepEqual(parseCodexLifecycleEntry({
    timestamp: '2026-04-29T00:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'turn_completed', summary: 'Ready.' },
  }), {
    type: 'turn_completed',
    summary: 'Ready.',
    timestamp: '2026-04-29T00:00:01.000Z',
  });

  assert.deepEqual(parseCodexLifecycleEntry({
    type: 'event_msg',
    payload: { type: 'turn_failed', message: 'network failed' },
  }), {
    type: 'turn_failed',
    message: 'network failed',
    timestamp: undefined,
  });

  assert.deepEqual(parseCodexLifecycleEntry({
    type: 'event_msg',
    payload: { type: 'exec_command_end', call_id: 'call_2', exit_code: 1, aggregated_output: 'test failed' },
  }), {
    type: 'turn_failed',
    message: 'test failed',
    timestamp: undefined,
  });
});
