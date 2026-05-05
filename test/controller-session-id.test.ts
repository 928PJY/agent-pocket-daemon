import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { SessionManager, type QueryFactory } from '../src/sessions/session-manager.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeStubFactory(): { factory: QueryFactory; capturedSessionId: () => string | undefined } {
  let captured: string | undefined;
  const stubQuery = {
    [Symbol.asyncIterator]() { return this; },
    async next() { return new Promise<IteratorResult<never, void>>(() => {}); },
    async return() { return { done: true, value: undefined } as IteratorResult<never, void>; },
    async throw() { return { done: true, value: undefined } as IteratorResult<never, void>; },
    async interrupt() {},
    async setPermissionMode() {},
    async setModel() {},
    async setMaxThinkingTokens() {},
    async applyFlagSettings() {},
    async initializationResult() { return {} as never; },
    async supportedCommands() { return []; },
    async supportedModels() { return []; },
    async supportedAgents() { return []; },
    async mcpServerStatus() { return []; },
    async setMcpServers() {},
    async getContextUsage() { return undefined as never; },
    async rewindFiles() { return undefined as never; },
  } as unknown as Query;

  const factory: QueryFactory = ({ options }) => {
    captured = (options as { sessionId?: string }).sessionId;
    return stubQuery;
  };
  return { factory, capturedSessionId: () => captured };
}

test('createSession assigns a UUID claudeSessionId synchronously and forwards it to the SDK', () => {
  const { factory, capturedSessionId } = makeStubFactory();
  const manager = new SessionManager({ queryFactory: factory });
  manager.on('error', () => {});
  const cwd = mkdtempSync(join(tmpdir(), 'session-id-stable-'));
  try {
    const sessionId = manager.createSession({ working_directory: cwd });
    const session = manager.getSession(sessionId);
    assert.ok(session, 'session should exist');
    assert.match(session!.claudeSessionId ?? '', UUID_RE,
      'claudeSessionId should be a UUID assigned synchronously by createSession');
    assert.equal(capturedSessionId(), session!.claudeSessionId,
      'SDK queryFactory must receive options.sessionId equal to the pre-assigned UUID');
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});
