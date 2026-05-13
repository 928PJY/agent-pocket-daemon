import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PermissionDecision, SessionStatus } from 'agent-pocket-protocol';
import { SessionObserver } from '../src/observers/session-observer.js';
import { SessionManager } from '../src/sessions/session-manager.js';

type SessionObserverInternals = SessionObserver & { readNewEntries(): void };

test('SessionObserver stops quietly when the watched JSONL file disappears', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-observer-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const observer = new SessionObserver('session-1', jsonlPath);
  const errors: Error[] = [];
  observer.on('error', (err) => errors.push(err));

  try {
    observer.start(false);
    unlinkSync(jsonlPath);
    await waitFor(() => !observer.isActive());

    assert.equal(observer.isActive(), false);
    assert.deepEqual(errors, []);
  } finally {
    observer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionObserver reports pending user action from the last unresolved tool use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-observer-'));
  const jsonlPath = join(dir, 'session.jsonl');

  try {
    writeEntries(jsonlPath, [
      {
        type: 'assistant',
        message: {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }],
        },
      },
    ]);
    assert.deepEqual(SessionObserver.isPendingUserAction(jsonlPath), { pending: true, toolName: 'Bash' });

    appendEntries(jsonlPath, [
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } },
    ]);
    assert.deepEqual(SessionObserver.isPendingUserAction(jsonlPath), { pending: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionObserver emits existing custom title when starting at end of transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-observer-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeEntries(jsonlPath, [
    { type: 'custom-title', customTitle: 'Older title' },
    { type: 'custom-title', customTitle: 'Latest title' },
  ]);
  const observer = new SessionObserver('session-1', jsonlPath);
  const titles: Array<[string, boolean]> = [];
  observer.on('title', (title, isCustom) => titles.push([title, isCustom]));

  try {
    observer.start();

    assert.deepEqual(titles, [['Latest title', true]]);
  } finally {
    observer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionObserver maps queue, user, assistant, and tool result entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-observer-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const observer = new SessionObserver('session-1', jsonlPath);
  const outputs: unknown[] = [];
  const titles: Array<[string, boolean]> = [];
  const statuses: string[] = [];
  observer.on('output', (event) => outputs.push(event));
  observer.on('title', (title, isCustom) => titles.push([title, isCustom]));
  observer.on('status_change', (status) => statuses.push(status));

  try {
    observer.start(false);
    appendEntries(jsonlPath, [
      { type: 'ai-title', aiTitle: 'Generated' },
      { type: 'queue-operation', operation: 'enqueue', content: '<system-reminder>skip</system-reminder>' },
      { type: 'queue-operation', operation: 'enqueue', content: 'queued user text' },
      { type: 'user', message: { content: 'plain user' } },
      { type: 'user', message: { content: '<command-name>skip</command-name>' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'think' },
            { type: 'text', text: 'hello' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [
            { type: 'thinking', thinking: 'thinking more' },
            { type: 'text', text: 'hello world' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'block user' },
            { type: 'tool_result', tool_use_id: 'tool-1', content: { ok: true } },
          ],
        },
      },
    ]);

    (observer as SessionObserverInternals).readNewEntries();

    assert.deepEqual(titles, [['Generated', false]]);
    // local_command_invoke entries don't flip status (the command wasn't an
    // SDK turn — the next stdout/stderr will flip to ready). 5 status flips:
    // user 'plain user' → running; assistant #1 → running; assistant #2 →
    // running + ready (end_turn); user with tool_result → running.
    assert.deepEqual(statuses, ['running', 'running', 'running', 'ready', 'running']);
    assert.equal(outputs.length, 10);
    // Spot-check shape — full equality is fragile across optional sdkUuid /
    // sdkBlockIndex fields that depend on whether the source entry had a uuid.
    const types = outputs.map((e) => (e as { type: string }).type);
    assert.deepEqual(types, [
      'user_message',          // queued user text (queue stableEventId sdkUuid)
      'user_message',          // plain user
      'local_command_invoke',  // <command-name>skip
      'thinking',              // assistant #1 thinking
      'assistant_message',     // assistant #1 text
      'tool_use',              // assistant #1 tool_use
      'thinking',              // assistant #2 thinking delta
      'assistant_message',     // assistant #2 text delta
      'user_message',          // 'block user' inside user with tool_result
      'tool_result',           // tool_result
    ]);
    // Queue-operation rows have no source uuid → daemon synthesizes a
    // deterministic id so live + history-replay collapse to one row.
    assert.equal(typeof (outputs[0] as { sdkUuid?: unknown }).sdkUuid, 'string');
  } finally {
    observer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionObserver emits interrupted system message and closes pending tools', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-observer-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const observer = new SessionObserver('session-1', jsonlPath);
  const outputs: unknown[] = [];
  const interrupted: string[] = [];
  const statuses: string[] = [];
  observer.on('output', (event) => outputs.push(event));
  observer.on('interrupted', (reason) => interrupted.push(reason));
  observer.on('status_change', (status) => statuses.push(status));

  try {
    observer.start(false);
    appendEntries(jsonlPath, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }] },
      },
      { type: 'user', message: { content: '[Request interrupted by user]' } },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '[Tool use interrupted]' }] },
      },
    ]);

    (observer as SessionObserverInternals).readNewEntries();

    assert.deepEqual(statuses, ['running']);
    assert.deepEqual(interrupted, ['streaming']);
    assert.equal(outputs.length, 3);
    const [toolUseEvent, toolResultEvent, systemEvent] = outputs as Array<Record<string, unknown>>;
    assert.deepEqual(toolUseEvent, {
      type: 'tool_use', tool_id: 'tool-1', tool_name: 'Bash', tool_input: {},
    });
    // Synthesized interrupt artifacts get deterministic ids derived from
    // session + entry-context so live emit and history replay collapse.
    assert.equal(toolResultEvent.type, 'tool_result');
    assert.equal(toolResultEvent.tool_id, 'tool-1');
    assert.equal(toolResultEvent.status, 'error');
    assert.equal(toolResultEvent.output, '[Tool use interrupted]');
    assert.equal(typeof toolResultEvent.sdkUuid, 'string');
    assert.equal(systemEvent.type, 'system_message');
    assert.equal(systemEvent.message, 'Interrupted by user.');
    assert.equal(typeof systemEvent.sdkUuid, 'string');
  } finally {
    observer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager.removeSession stops observed session watchers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const manager = new SessionManager();
  const sessionId = manager.observeSession('claude-session-1', jsonlPath, dir, 12345);
  const session = manager.getSession(sessionId);

  try {
    assert.equal(session?.observer?.isActive(), true);

    manager.removeSession(sessionId);

    assert.equal(manager.getSession(sessionId), undefined);
    assert.equal(session?.observer?.isActive(), false);
  } finally {
    session?.observer?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager.observeSession uses transcript mtime and supports lookup helpers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');
  const mtime = new Date('2026-01-02T03:04:05.000Z');
  utimesSync(jsonlPath, mtime, mtime);

  const manager = new SessionManager();

  try {
    const sessionId = manager.observeSession('claude-session-1', jsonlPath, dir, 12345, 'Custom title', {
      type: 'tmux',
      target: 'main:0.1',
      socket: '/tmp/tmux-test',
    });
    const session = manager.getSession(sessionId);

    assert.equal(session?.isObserved, true);
    assert.equal(session?.status, SessionStatus.READY);
    assert.equal(session?.lastActivity, mtime.getTime());
    assert.equal(manager.findByClaudeSessionId('claude-session-1')?.sessionId, sessionId);
    assert.equal(manager.findByTerminalPid(12345)?.sessionId, sessionId);
    assert.equal(manager.isObservedSession(sessionId), true);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager.observeSession evicts stale observed sessions for the same Claude session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const firstPath = join(dir, 'first.jsonl');
  const secondPath = join(dir, 'second.jsonl');
  writeFileSync(firstPath, '');
  writeFileSync(secondPath, '');

  const manager = new SessionManager();

  try {
    const firstId = manager.observeSession('claude-session-1', firstPath, dir, 111);
    const firstObserver = manager.getSession(firstId)?.observer;
    assert.equal(firstObserver?.isActive(), true);

    const secondId = manager.observeSession('claude-session-1', secondPath, dir, 222);

    assert.equal(manager.getSession(firstId), undefined);
    assert.equal(firstObserver?.isActive(), false);
    assert.equal(manager.findByClaudeSessionId('claude-session-1')?.sessionId, secondId);
    assert.equal(manager.findByTerminalPid(222)?.sessionId, secondId);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager bridges observed output and suppresses injected message echoes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const manager = new SessionManager();
  const outputs: unknown[] = [];
  manager.on('session_output', (_sessionId, event) => outputs.push(event));

  try {
    const sessionId = manager.observeSession('claude-session-1', jsonlPath, dir, 12345);
    const session = manager.getSession(sessionId)!;

    session.injectedMessages.set('already-rendered', '');
    session.observer!.emit('output', { type: 'user_message', message: 'already-rendered' });
    session.observer!.emit('output', { type: 'assistant_message', message: 'visible' });

    assert.deepEqual(outputs, [{ type: 'assistant_message', message: 'visible' }]);
    assert.equal(session.injectedMessages.has('already-rendered'), false);
    assert.equal(session.hasReceivedEvents, true);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager keeps custom observed titles from being overwritten by ai titles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const manager = new SessionManager();
  const titleEvents: string[] = [];
  manager.on('session_title', (_sessionId, title) => titleEvents.push(title));

  try {
    const sessionId = manager.observeSession('claude-session-1', jsonlPath, dir, 12345, 'Initial');
    const session = manager.getSession(sessionId)!;

    session.observer!.emit('title', 'User title', true);
    session.observer!.emit('title', 'Generated title', false);

    assert.equal(session.customTitle, 'User title');
    assert.deepEqual(titleEvents, ['User title']);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager preserves pending_actions from observed status changes until cleared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const manager = new SessionManager();
  const statuses: SessionStatus[] = [];
  manager.on('session_status', (_sessionId, status) => statuses.push(status));

  try {
    const sessionId = manager.observeSession('claude-session-1', jsonlPath, dir, 12345);
    const session = manager.getSession(sessionId)!;

    session.status = SessionStatus.PENDING_ACTIONS;
    session.observer!.emit('status_change', 'ready');

    assert.equal(session.status, SessionStatus.PENDING_ACTIONS);
    assert.equal(statuses.at(-1), SessionStatus.READY);

    manager.clearPendingActions(sessionId);

    assert.equal(session.status, SessionStatus.READY);
    assert.equal(statuses.at(-1), SessionStatus.READY);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager marks observed sessions as history and discards queued messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const manager = new SessionManager();

  try {
    const sessionId = manager.observeSession('claude-session-1', jsonlPath, dir, 12345, undefined, {
      type: 'tmux',
      target: 'main:0.1',
      socket: '/tmp/tmux-test',
    });
    const session = manager.getSession(sessionId)!;
    session.messageQueue.push('queued');

    manager.markObservedSessionHistory(sessionId);

    assert.equal(session.status, SessionStatus.HISTORY);
    assert.equal(session.isObserved, false);
    assert.equal(session.observer, undefined);
    assert.equal(session.terminalPid, undefined);
    assert.equal(session.terminalTarget, undefined);
    assert.deepEqual(session.messageQueue, []);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager.respondPermission resolves approve, deny, and always-allow branches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const manager = new SessionManager();
  const privateManager = manager as unknown as {
    registerPermissionRequest(sessionId: string, requestId: string, toolName: string, toolInput: Record<string, unknown>): void;
  };

  try {
    const sessionId = manager.observeSession('claude-session-1', jsonlPath, dir, 12345);
    const session = manager.getSession(sessionId)!;
    const resolved: unknown[] = [];
    const statuses: SessionStatus[] = [];
    manager.on('session_status', (_sessionId, status) => statuses.push(status));

    privateManager.registerPermissionRequest(sessionId, 'approve-1', 'Bash', { command: 'pwd' });
    session.pendingPermissionResolvers.set('approve-1', (result) => resolved.push(result));
    manager.respondPermission(sessionId, 'approve-1', PermissionDecision.APPROVE, { command: 'ls' });

    privateManager.registerPermissionRequest(sessionId, 'deny-1', 'Write', { file_path: 'a.txt' });
    session.pendingPermissionResolvers.set('deny-1', (result) => resolved.push(result));
    manager.respondPermission(sessionId, 'deny-1', PermissionDecision.DENY);

    privateManager.registerPermissionRequest(sessionId, 'always-1', 'Read', { file_path: 'b.txt' });
    session.pendingPermissionResolvers.set('always-1', (result) => resolved.push(result));
    manager.respondPermission(sessionId, 'always-1', PermissionDecision.ALWAYS_ALLOW);

    assert.deepEqual(resolved, [
      { behavior: 'allow', updatedInput: { command: 'ls' } },
      { behavior: 'deny', message: 'User denied permission' },
      { behavior: 'allow', updatedInput: { file_path: 'b.txt' } },
    ]);
    assert.equal(session.pendingPermissions.size, 0);
    assert.equal(session.pendingPermissionResolvers.size, 0);
    assert.equal(session.status, SessionStatus.RUNNING);
    assert.equal(session.alwaysAllowedTools.has('Read'), true);
    assert.equal(statuses.includes(SessionStatus.PENDING_ACTIONS), true);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager permission callback auto-allows remembered tools and aborts pending requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const manager = new SessionManager();
  const privateManager = manager as unknown as {
    buildCanUseTool(session: ReturnType<SessionManager['getSession']>): (
      toolName: string,
      toolInput: Record<string, unknown>,
      options: { signal: AbortSignal },
    ) => Promise<unknown>;
  };

  try {
    const sessionId = manager.observeSession('claude-session-1', jsonlPath, dir, 12345);
    const session = manager.getSession(sessionId)!;
    session.alwaysAllowedTools.add('Read');
    const canUseTool = privateManager.buildCanUseTool(session);

    assert.deepEqual(
      await canUseTool('Read', { file_path: 'a.txt' }, { signal: new AbortController().signal }),
      { behavior: 'allow', updatedInput: { file_path: 'a.txt' } },
    );

    const abortController = new AbortController();
    const pending = canUseTool('Bash', { command: 'sleep 1' }, { signal: abortController.signal });
    assert.equal(session.pendingPermissions.size, 1);

    abortController.abort();

    assert.deepEqual(await pending, { behavior: 'deny', message: 'Aborted' });
    assert.equal(session.pendingPermissionResolvers.size, 0);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager kill, interrupt, and emergency paths clean up session state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const manager = new SessionManager();

  try {
    const observedId = manager.observeSession('claude-session-1', jsonlPath, dir, 12345);
    const observed = manager.getSession(observedId)!;
    const ended: Array<[string, number]> = [];
    manager.on('session_ended', (sessionId, code) => ended.push([sessionId, code]));

    await manager.killSession(observedId);

    assert.equal(manager.getSession(observedId), undefined);
    assert.equal(observed.observer?.isActive(), false);
    assert.deepEqual(ended, [[observedId, 0]]);

    const interruptId = manager.observeSession('claude-session-2', jsonlPath, dir, 12346);
    await assert.rejects(() => manager.interruptSession(interruptId), /no terminal target available/);

    const emergencyId = manager.observeSession('claude-session-3', jsonlPath, dir, 12347);
    const emergency = manager.getSession(emergencyId)!;
    manager.emergencyAbort();

    assert.equal(emergency.status, SessionStatus.HISTORY);
    assert.equal(emergency.abortController.signal.aborted, true);
    assert.equal(emergency.observer?.isActive(), false);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function writeEntries(filePath: string, entries: unknown[]): void {
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

function appendEntries(filePath: string, entries: unknown[]): void {
  appendFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}


test('SessionManager reports missing sessions and no-op boundary helpers', async () => {
  const manager = new SessionManager();

  await assert.rejects(() => manager.sendMessage('missing', 'hello'), /Session not found: missing/);
  assert.throws(() => manager.respondPermission('missing', 'request-1', PermissionDecision.APPROVE), /Session not found: missing/);
  await assert.rejects(() => manager.killSession('missing'), /Session not found: missing/);
  await assert.rejects(() => manager.interruptSession('missing'), /Session not found: missing/);

  manager.clearPendingActions('missing');
  manager.removeSession('missing');
  manager.markObservedSessionHistory('missing');

  assert.equal(manager.findByClaudeSessionId('missing'), undefined);
  assert.equal(manager.findByTerminalPid(999), undefined);
  assert.equal(manager.isObservedSession('missing'), false);
});

test('SessionManager active session count excludes history and error sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const firstPath = join(dir, 'first.jsonl');
  const secondPath = join(dir, 'second.jsonl');
  const thirdPath = join(dir, 'third.jsonl');
  writeFileSync(firstPath, '');
  writeFileSync(secondPath, '');
  writeFileSync(thirdPath, '');

  const manager = new SessionManager();

  try {
    const readyId = manager.observeSession('claude-session-1', firstPath, dir, 111);
    const historyId = manager.observeSession('claude-session-2', secondPath, dir, 222);
    const errorId = manager.observeSession('claude-session-3', thirdPath, dir, 333);

    manager.getSession(historyId)!.status = SessionStatus.HISTORY;
    manager.getSession(errorId)!.status = SessionStatus.ERROR;

    assert.equal(manager.getAllSessions().length, 3);
    assert.equal(manager.getActiveSessionCount(), 1);
    assert.equal(manager.getSession(readyId)?.status, SessionStatus.READY);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager controller session count excludes observed sessions entirely (issue #223)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const paths = [1, 2, 3, 4, 5].map((n) => {
    const p = join(dir, `obs-${n}.jsonl`);
    writeFileSync(p, '');
    return p;
  });

  const manager = new SessionManager();

  try {
    paths.forEach((p, i) => manager.observeSession(`claude-obs-${i}`, p, dir, 1000 + i));

    assert.equal(manager.getActiveSessionCount(), 5);
    // The cap exists to bound concurrent SDK queries; observed sessions own
    // none, so they must not count toward it.
    assert.equal(manager.getControllerSessionCount(), 0);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager.respondPermission rejects unknown pending request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const manager = new SessionManager();

  try {
    const sessionId = manager.observeSession('claude-session-1', jsonlPath, dir, 12345);

    assert.throws(
      () => manager.respondPermission(sessionId, 'missing-request', PermissionDecision.APPROVE),
      /No pending permission with request ID: missing-request/,
    );
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager SDK message mapper emits deltas, tools, results, and ready status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const manager = new SessionManager();
  const outputs: unknown[] = [];
  const statuses: SessionStatus[] = [];
  manager.on('session_output', (_sessionId, event) => outputs.push(event));
  manager.on('session_status', (_sessionId, status) => statuses.push(status));
  const privateManager = manager as unknown as { handleSDKMessage(state: ReturnType<SessionManager['getSession']>, message: unknown): void };

  try {
    const sessionId = manager.observeSession('claude-session-1', jsonlPath, dir, 12345);
    const session = manager.getSession(sessionId)!;
    outputs.length = 0;
    statuses.length = 0;

    privateManager.handleSDKMessage(session, { type: 'system', session_id: 'sdk-session-1' });
    privateManager.handleSDKMessage(session, {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'think' },
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
    });
    privateManager.handleSDKMessage(session, {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'thinking' },
          { type: 'text', text: 'hello world' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
    });
    privateManager.handleSDKMessage(session, {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: { ok: true } },
          { type: 'tool_result', tool_use_id: 'tool-2', is_error: true, content: 'failed' },
        ],
      },
    });
    privateManager.handleSDKMessage(session, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: 'b.ts' } }] },
    });
    privateManager.handleSDKMessage(session, { type: 'result', session_id: 'sdk-session-2' });
    privateManager.handleSDKMessage(session, { type: 'stream_event' });

    assert.equal(session.claudeSessionId, 'sdk-session-2');
    assert.equal(session.status, SessionStatus.READY);
    assert.deepEqual(statuses, [SessionStatus.READY]);
    assert.deepEqual(outputs, [
      { type: 'thinking', thinking: 'think' },
      { type: 'assistant_message', message: 'hello' },
      { type: 'tool_use', tool_id: 'tool-1', tool_name: 'Read', tool_input: { file_path: 'a.ts' } },
      { type: 'thinking', thinking: 'ing' },
      { type: 'assistant_message', message: ' world' },
      { type: 'tool_result', tool_id: 'tool-1', status: 'success', output: '{"ok":true}' },
      { type: 'tool_result', tool_id: 'tool-2', status: 'error', output: 'failed' },
      { type: 'tool_use', tool_id: 'tool-1', tool_name: 'Write', tool_input: { file_path: 'b.ts' } },
    ]);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager cleanup denies pending permission resolvers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const manager = new SessionManager();
  const privateManager = manager as unknown as {
    registerPermissionRequest(sessionId: string, requestId: string, toolName: string, toolInput: Record<string, unknown>): void;
  };

  try {
    const sessionId = manager.observeSession('claude-session-1', jsonlPath, dir, 12345);
    const session = manager.getSession(sessionId)!;
    const resolved: unknown[] = [];

    privateManager.registerPermissionRequest(sessionId, 'request-1', 'Bash', { command: 'pwd' });
    session.pendingPermissionResolvers.set('request-1', (result) => resolved.push(result));

    manager.removeSession(sessionId);

    assert.equal(manager.getSession(sessionId), undefined);
    assert.deepEqual(resolved, [{ behavior: 'deny', message: 'Session killed' }]);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
