import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Options as SDKQueryOptions, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SessionStatus } from 'agent-pocket-protocol';
import { SessionManager, type QueryFactory } from '../src/sessions/session-manager.js';

function makeIdleQueryFactory(): QueryFactory {
  return (_args: { prompt: AsyncIterable<unknown>; options: SDKQueryOptions }) => {
    const iter: AsyncIterator<SDKMessage, void> & {
      [Symbol.asyncIterator](): AsyncIterator<SDKMessage, void>;
    } = {
      [Symbol.asyncIterator]() { return this; },
      next() { return new Promise<IteratorResult<SDKMessage, void>>(() => { /* never resolves */ }); },
      async return() { return { done: true, value: undefined }; },
      async throw() { return { done: true, value: undefined }; },
    };
    const stub = {
      ...iter,
      async interrupt() {},
      async setPermissionMode() {},
      async setModel() {},
      async setMaxThinkingTokens() {},
      async applyFlagSettings() {},
      async initializationResult() { return {} as never; },
      async supportedCommands() { return [] as never; },
      async supportedModels() { return [] as never; },
      async supportedAgents() { return [] as never; },
      async mcpServerStatus() { return [] as never; },
      async setMcpServers() {},
      async getContextUsage() { return {} as never; },
      async rewindFiles() { return { canRewind: false } as never; },
    };
    return stub as unknown as Query;
  };
}

function withSession<T>(fn: (mgr: SessionManager, internalId: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), 'mark-turn-complete-'));
  try {
    const manager = new SessionManager({
      queryFactory: makeIdleQueryFactory(),
      bindingJournal: null,
    });
    const internalId = manager.createSession({
      working_directory: cwd,
      agent_type: 'claude_code',
    });
    return fn(manager, internalId);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('markTurnComplete flips RUNNING → READY and emits session_status', () => {
  withSession((manager, internalId) => {
    const state = manager.getSession(internalId);
    assert.ok(state);
    state.status = SessionStatus.RUNNING;

    const events: SessionStatus[] = [];
    manager.on('session_status', (_id, s) => events.push(s));

    manager.markTurnComplete(internalId);

    assert.equal(state.status, SessionStatus.READY);
    assert.deepEqual(events, [SessionStatus.READY]);
  });
});

test('markTurnComplete is a no-op when already READY (no duplicate emit)', () => {
  withSession((manager, internalId) => {
    const state = manager.getSession(internalId);
    assert.ok(state);
    state.status = SessionStatus.READY;

    const events: SessionStatus[] = [];
    manager.on('session_status', (_id, s) => events.push(s));

    manager.markTurnComplete(internalId);

    assert.equal(state.status, SessionStatus.READY);
    assert.equal(events.length, 0);
  });
});

test('markTurnComplete is a no-op when HISTORY (terminal state preserved)', () => {
  withSession((manager, internalId) => {
    const state = manager.getSession(internalId);
    assert.ok(state);
    state.status = SessionStatus.HISTORY;

    const events: SessionStatus[] = [];
    manager.on('session_status', (_id, s) => events.push(s));

    manager.markTurnComplete(internalId);

    assert.equal(state.status, SessionStatus.HISTORY);
    assert.equal(events.length, 0);
  });
});

test('markTurnComplete is a no-op when ERROR (error semantics preserved)', () => {
  withSession((manager, internalId) => {
    const state = manager.getSession(internalId);
    assert.ok(state);
    state.status = SessionStatus.ERROR;

    const events: SessionStatus[] = [];
    manager.on('session_status', (_id, s) => events.push(s));

    manager.markTurnComplete(internalId);

    assert.equal(state.status, SessionStatus.ERROR);
    assert.equal(events.length, 0);
  });
});

test('markTurnComplete on unknown sessionId does nothing', () => {
  withSession((manager) => {
    const events: SessionStatus[] = [];
    manager.on('session_status', (_id, s) => events.push(s));

    manager.markTurnComplete('does-not-exist');

    assert.equal(events.length, 0);
  });
});
