import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CodexDiscovery,
  codexLiveSessionsFromOpenedRollouts,
  codexStateDbReadonlyUri,
  codexHistoryMessageToEvent,
  codexExternalSessionId,
  extractThreadIdFromRolloutPath,
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
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].role, 'assistant');
  assert.equal(assistant[0].content, 'Done.');
  assert.equal(assistant[0].timestamp, '2026-04-29T00:00:00.000Z');
  assert.match(assistant[0].sdkUuid ?? '', /^codex_msg:/);

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

test('codexLiveSessionsFromOpenedRollouts returns only the newest rollout for one PID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pocket-codex-live-'));
  try {
    const rolloutA = path.join(dir, 'rollout-a.jsonl');
    const rolloutB = path.join(dir, 'rollout-b.jsonl');
    fs.writeFileSync(rolloutA, '{}\n');
    fs.writeFileSync(rolloutB, '{}\n');
    fs.utimesSync(rolloutA, new Date(1000), new Date(1000));
    fs.utimesSync(rolloutB, new Date(2000), new Date(2000));

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

    assert.deepEqual(live.map((session) => session.sessionId), ['codex:thread-b']);
    assert.equal(live[0].pid, 1234);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CodexDiscovery registers hook sessions from rollout before sqlite sees them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pocket-codex-hook-'));
  try {
    const codexDir = path.join(dir, '.codex');
    const sessionsDir = path.join(codexDir, 'sessions', '2026', '04', '29');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const rolloutPath = path.join(sessionsDir, 'rollout-2026-04-29T23-01-05-019dd9c2-079a-79f0-91d2-ba359ad51711.jsonl');
    fs.writeFileSync(rolloutPath, JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ready' }],
      },
    }) + '\n');

    const discovery = new CodexDiscovery(codexDir);
    const session = discovery.registerSessionFromRollout({
      sessionId: 'codex:placeholder',
      rolloutPath,
      cwd: dir,
    });

    assert.equal(session?.threadId, '019dd9c2-079a-79f0-91d2-ba359ad51711');
    assert.equal(discovery.getSession('codex:019dd9c2-079a-79f0-91d2-ba359ad51711')?.rolloutPath, path.resolve(rolloutPath));
    assert.equal(discovery.getSessionHistory('codex:019dd9c2-079a-79f0-91d2-ba359ad51711').messages[0].content, 'ready');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extractThreadIdFromRolloutPath parses Codex rollout filenames', () => {
  assert.equal(
    extractThreadIdFromRolloutPath('/tmp/rollout-2026-04-29T23-01-05-019dd9c2-079a-79f0-91d2-ba359ad51711.jsonl'),
    '019dd9c2-079a-79f0-91d2-ba359ad51711',
  );
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

test('parseCodexHistoryEntry maps Codex interrupt markers to system messages', () => {
  const claudeStyleMessages = parseCodexHistoryEntry({
    timestamp: '2026-04-30T00:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '[Request interrupted by user]' }],
    },
  });

  assert.deepEqual(claudeStyleMessages, [{
    role: 'system',
    content: 'Interrupted by user.',
    timestamp: '2026-04-30T00:00:00.000Z',
  }]);
  assert.deepEqual(codexHistoryMessageToEvent(claudeStyleMessages[0]), {
    type: 'system_message',
    message: 'Interrupted by user.',
  });

  const codexAbortedMessages = parseCodexHistoryEntry({
    timestamp: '2026-04-30T00:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>' }],
    },
  });

  assert.deepEqual(codexAbortedMessages, [{
    role: 'system',
    content: 'Interrupted by user.',
    timestamp: '2026-04-30T00:00:01.000Z',
  }]);
  assert.deepEqual(codexHistoryMessageToEvent(codexAbortedMessages[0]), {
    type: 'system_message',
    message: 'Interrupted by user.',
  });
});

test('parseCodexHistoryEntry drops Codex runtime warnings recorded as user messages', () => {
  const messages = parseCodexHistoryEntry({
    timestamp: '2026-04-30T00:00:02.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Warning: apply_patch was requested via exec_command. Use the apply_patch tool instead of exec_command.' }],
    },
  });

  assert.deepEqual(messages, []);
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

  assert.deepEqual(parseCodexLifecycleEntry({
    timestamp: '2026-04-30T00:00:03.000Z',
    type: 'event_msg',
    payload: { type: 'turn_aborted', reason: 'interrupted' },
  }), {
    type: 'turn_aborted',
    timestamp: '2026-04-30T00:00:03.000Z',
  });

  assert.equal(parseCodexLifecycleEntry({
    type: 'event_msg',
    payload: { type: 'exec_command_end', call_id: 'call_2', exit_code: 1, aggregated_output: 'test failed' },
  }), null);
});

test('parseCodexHistoryEntry maps task_started.collaboration_mode_kind to codex_collaboration_mode row', () => {
  const messages = parseCodexHistoryEntry({
    timestamp: '2026-05-20T03:37:12.000Z',
    type: 'event_msg',
    payload: {
      type: 'task_started',
      turn_id: 'turn-abc',
      collaboration_mode_kind: 'plan',
    },
  });
  assert.equal(messages.length, 1);
  const m = messages[0] as {
    role: string;
    codexMetaEvent: { type: string; mode: string; body: string };
    sdkUuid?: string;
    timestamp?: string;
  };
  assert.equal(m.role, 'codex_meta');
  assert.equal(m.codexMetaEvent.type, 'codex_collaboration_mode');
  assert.equal(m.codexMetaEvent.mode, 'Plan');
  assert.equal(m.codexMetaEvent.body, '');
  // sdkUuid must be pinned to turn_id so the seq-allocator hands out the
  // same seq on re-parse — without it allocAnonymous() bumps the seq on
  // every rollout mtime change, breaking phone-side dedupe of the banner.
  assert.equal(m.sdkUuid, 'codex_collaboration_mode:turn-abc');
  assert.equal(m.timestamp, '2026-05-20T03:37:12.000Z');
});

test('parseCodexHistoryEntry capitalizes various collaboration_mode_kind values', () => {
  const plan = parseCodexHistoryEntry({
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 't1', collaboration_mode_kind: 'plan' },
  });
  assert.equal((plan[0] as { codexMetaEvent: { mode: string } }).codexMetaEvent.mode, 'Plan');

  const dflt = parseCodexHistoryEntry({
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 't2', collaboration_mode_kind: 'default' },
  });
  assert.equal((dflt[0] as { codexMetaEvent: { mode: string } }).codexMetaEvent.mode, 'Default');

  const fullAccess = parseCodexHistoryEntry({
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 't3', collaboration_mode_kind: 'full_access' },
  });
  assert.equal((fullAccess[0] as { codexMetaEvent: { mode: string } }).codexMetaEvent.mode, 'Full_access');
});

test('parseCodexHistoryEntry returns [] when task_started lacks collaboration_mode_kind', () => {
  const messages = parseCodexHistoryEntry({
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 't1' },
  });
  assert.equal(messages.length, 0);
});

test('parseCodexHistoryEntry returns [] when task_started has no turn_id (still emits, but no sdkUuid)', () => {
  const messages = parseCodexHistoryEntry({
    type: 'event_msg',
    payload: { type: 'task_started', collaboration_mode_kind: 'plan' },
  });
  // Without turn_id the row still surfaces but with no sdkUuid (callers can
  // fall back to seq-allocator's anonymous slot).
  assert.equal(messages.length, 1);
  const m = messages[0] as { sdkUuid?: string; codexMetaEvent: { mode: string } };
  assert.equal(m.sdkUuid, undefined);
  assert.equal(m.codexMetaEvent.mode, 'Plan');
});

test('CodexDiscovery.getSessionHistory collapses consecutive same-mode codex_collaboration_mode rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pocket-codex-collapse-'));
  try {
    const codexDir = path.join(dir, '.codex');
    const sessionsDir = path.join(codexDir, 'sessions', '2026', '05', '20');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const rolloutPath = path.join(sessionsDir, 'rollout-2026-05-20T00-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
    // Sequence: default → default (dup) → plan → plan (dup) → default
    // Expected after collapse: default, plan, default (3 banners).
    fs.writeFileSync(rolloutPath, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', collaboration_mode_kind: 'default' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't2', collaboration_mode_kind: 'default' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't3', collaboration_mode_kind: 'plan' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't4', collaboration_mode_kind: 'plan' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't5', collaboration_mode_kind: 'default' } }),
    ].join('\n') + '\n');

    const discovery = new CodexDiscovery(codexDir);
    discovery.registerSessionFromRollout({
      sessionId: 'codex:placeholder',
      rolloutPath,
      cwd: dir,
    });
    const sessionId = 'codex:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const history = discovery.getSessionHistory(sessionId);

    const modeRows = history.messages.filter((m) => {
      const ev = (m as { codexMetaEvent?: { type?: string } }).codexMetaEvent;
      return m.role === 'codex_meta' && ev?.type === 'codex_collaboration_mode';
    }) as Array<{ codexMetaEvent: { mode: string } }>;
    assert.deepEqual(modeRows.map((m) => m.codexMetaEvent.mode), ['Default', 'Plan', 'Default']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
