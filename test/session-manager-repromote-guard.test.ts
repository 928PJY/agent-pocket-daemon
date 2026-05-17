import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Options as SDKQueryOptions, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SessionStatus } from 'agent-pocket-protocol';
import { SessionManager, type QueryFactory } from '../src/sessions/session-manager.js';

// Minimal Query stub: an empty async iterator that does nothing. The query
// methods we don't exercise here just resolve to undefined so the SDK consumer
// loop has nothing to do and the session sits in its created state.
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

// Drive a controller session into the given non-HISTORY status, then assert
// rePromoteHistoryToObserved refuses to flip it into observer mode.
async function expectRePromoteRefused(status: SessionStatus): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'repromote-guard-'));
  try {
    const manager = new SessionManager({
      queryFactory: makeIdleQueryFactory(),
      bindingJournal: null,
    });

    const internalId = manager.createSession({
      working_directory: cwd,
      agent_type: 'claude_code',
    });

    const state = manager.getSession(internalId);
    assert.ok(state, 'session should exist');
    assert.equal(state.isObserved, false, 'controller starts as not-observed');
    assert.ok(state.claudeSessionId, 'controller has pre-allocated claudeSessionId');
    assert.ok(state.queryHandle, 'controller owns an SDK query handle');

    // Force the status the discovery loop / SessionStart(resume) handler
    // might see when it picks up the daemon's own PID + the controller's
    // JSONL file mid-flight.
    state.status = status;

    const statusEvents: SessionStatus[] = [];
    manager.on('session_status', (_id, s) => statusEvents.push(s));

    const result = manager.rePromoteHistoryToObserved(
      internalId,
      99999,
      join(cwd, `${state.claudeSessionId}.jsonl`),
    );

    assert.equal(result, false, `rePromote must refuse for status=${status}`);
    assert.equal(state.isObserved, false, 'isObserved must remain false');
    assert.equal(state.status, status, 'status must not be rewritten to READY');
    assert.equal(state.terminalPid, undefined, 'terminalPid must not be set');
    assert.equal(state.observer, undefined, 'no SessionObserver must be attached');
    assert.equal(statusEvents.length, 0, 'no session_status event must be emitted');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('rePromoteHistoryToObserved refuses controller in STARTING', async () => {
  await expectRePromoteRefused(SessionStatus.STARTING);
});

test('rePromoteHistoryToObserved refuses controller in READY', async () => {
  await expectRePromoteRefused(SessionStatus.READY);
});

test('rePromoteHistoryToObserved refuses controller in RUNNING', async () => {
  await expectRePromoteRefused(SessionStatus.RUNNING);
});

test('rePromoteHistoryToObserved refuses controller in PENDING_ACTIONS', async () => {
  await expectRePromoteRefused(SessionStatus.PENDING_ACTIONS);
});
