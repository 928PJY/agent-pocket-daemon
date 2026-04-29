import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionListReconcileIndexes, isObservedSessionPidBindingStale } from '../src/sessions/session-list-reconcile.js';

test('observed session is stale when its PID file points at a different session id', () => {
  const indexes = createSessionListReconcileIndexes([
    { pid: 72480, sessionId: 'real-sid', cwd: '/repo', entrypoint: 'cli' },
  ]);

  assert.equal(isObservedSessionPidBindingStale({
    isObserved: true,
    terminalPid: 72480,
    claudeSessionId: 'wrong-sid',
  }, indexes), true);
});

test('observed session is stale when its session id belongs to another live PID', () => {
  const indexes = createSessionListReconcileIndexes([
    { pid: 62994, sessionId: 'shared-sid', cwd: '/repo', entrypoint: 'cli' },
    { pid: 72480, sessionId: 'real-sid', cwd: '/repo', entrypoint: 'cli' },
  ]);

  assert.equal(isObservedSessionPidBindingStale({
    isObserved: true,
    terminalPid: 72480,
    claudeSessionId: 'shared-sid',
  }, indexes), true);
});

test('observed session is not stale when live PID metadata agrees', () => {
  const indexes = createSessionListReconcileIndexes([
    { pid: 72480, sessionId: 'real-sid', cwd: '/repo', entrypoint: 'cli' },
  ]);

  assert.equal(isObservedSessionPidBindingStale({
    isObserved: true,
    terminalPid: 72480,
    claudeSessionId: 'real-sid',
  }, indexes), false);
});

test('controlled or pid-less sessions are not treated as stale PID bindings', () => {
  const indexes = createSessionListReconcileIndexes([
    { pid: 72480, sessionId: 'real-sid', cwd: '/repo', entrypoint: 'cli' },
  ]);

  assert.equal(isObservedSessionPidBindingStale({
    isObserved: false,
    terminalPid: 72480,
    claudeSessionId: 'wrong-sid',
  }, indexes), false);
  assert.equal(isObservedSessionPidBindingStale({
    isObserved: true,
    claudeSessionId: 'wrong-sid',
  }, indexes), false);
});
