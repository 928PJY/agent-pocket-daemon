import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionStatus } from 'agent-pocket-protocol';
import { SessionObserver } from '../src/observers/session-observer.js';
import { SessionManager } from '../src/sessions/session-manager.js';

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

    session.injectedMessages.add('already-rendered');
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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
