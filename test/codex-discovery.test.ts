import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  codexLiveSessionsFromOpenedRollouts,
  codexStateDbReadonlyUri,
  codexHistoryMessageToEvent,
  codexExternalSessionId,
  parseCodexHistoryEntry,
  parseCodexLifecycleEntry,
  parseCodexProcessList,
} from '../src/discovery/codex-discovery.js';

test('parseCodexProcessList matches terminal Codex executables', () => {
  const pids = parseCodexProcessList(`
    101 /opt/homebrew/bin/codex
    102 /usr/local/bin/codex-cli --model gpt-5
    103 /usr/local/bin/codex-foo
    104 node /tmp/codex
    105 /Applications/Codex.app/Contents/MacOS/codex
    106 /Applications/Codex.app/Contents/MacOS/codex app-server --analytics-default-enabled
  `);

  assert.deepEqual(pids, [101, 102, 105]);
});

test('codexStateDbReadonlyUri opens immutable read-only snapshots', () => {
  assert.equal(
    codexStateDbReadonlyUri('/Users/test user/.codex/state_5.sqlite'),
    'file:///Users/test%20user/.codex/state_5.sqlite?mode=ro&immutable=1',
  );
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

  const agentMessage = parseCodexHistoryEntry({
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'Done.' },
  });
  assert.deepEqual(agentMessage, []);
});

test('codexExternalSessionId namespaces Codex thread IDs', () => {
  assert.equal(codexExternalSessionId('thread-1'), 'codex:thread-1');
});

test('codexLiveSessionsFromOpenedRollouts keeps sibling rollouts for one PID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pocket-codex-live-'));
  try {
    const rolloutA = path.join(dir, 'rollout-a.jsonl');
    const rolloutB = path.join(dir, 'rollout-b.jsonl');
    fs.writeFileSync(rolloutA, '{}\n');
    fs.writeFileSync(rolloutB, '{}\n');

    const byRolloutPath = new Map([
      [path.resolve(rolloutA), {
        threadId: 'thread-a',
        sessionId: 'codex:thread-a',
        rolloutPath: rolloutA,
        cwd: dir,
      }],
      [path.resolve(rolloutB), {
        threadId: 'thread-b',
        sessionId: 'codex:thread-b',
        rolloutPath: rolloutB,
        cwd: dir,
      }],
    ]);

    const live = codexLiveSessionsFromOpenedRollouts(1234, [rolloutA, rolloutB], byRolloutPath);

    assert.deepEqual(live.map((session) => session.sessionId).sort(), ['codex:thread-a', 'codex:thread-b']);
    assert.equal(live.every((session) => session.pid === 1234), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    timestamp: '2026-04-29T00:00:02.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'Done.' },
  }), {
    type: 'turn_completed',
    summary: 'Done.',
    timestamp: '2026-04-29T00:00:02.000Z',
  });

  assert.deepEqual(parseCodexLifecycleEntry({
    type: 'event_msg',
    payload: { type: 'task_failed', error: { message: 'tool failed' } },
  }), {
    type: 'turn_failed',
    message: '{"message":"tool failed"}',
    timestamp: undefined,
  });

  assert.equal(parseCodexLifecycleEntry({
    type: 'event_msg',
    payload: { type: 'exec_command_end', call_id: 'call_2', exit_code: 1, aggregated_output: 'test failed' },
  }), null);
});
