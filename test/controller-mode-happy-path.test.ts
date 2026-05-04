import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { SessionStatus } from 'agent-pocket-protocol';
import type { ClaudeEvent } from 'agent-pocket-protocol';
import { SessionManager, type QueryFactory } from '../src/sessions/session-manager.js';

interface FakeQueryHandle {
  query: Query;
  prompt: AsyncIterable<SDKUserMessage>;
  emit(message: SDKMessage): void;
  finish(): void;
  fail(err: Error): void;
  interruptCalls: number;
}

function createFakeQuery(): FakeQueryHandle {
  const queue: SDKMessage[] = [];
  let waiting: ((value: IteratorResult<SDKMessage, void>) => void) | null = null;
  let done = false;
  let error: Error | undefined;

  const deliver = (result: IteratorResult<SDKMessage, void>) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(result);
    }
  };

  const fakeQuery = {
    [Symbol.asyncIterator]() { return this; },
    next(): Promise<IteratorResult<SDKMessage, void>> {
      if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift()! });
      if (error) return Promise.reject(error);
      if (done) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => { waiting = resolve; });
    },
    async return() { done = true; deliver({ done: true, value: undefined }); return { done: true, value: undefined } as IteratorResult<SDKMessage, void>; },
    async throw(err: unknown) { error = err instanceof Error ? err : new Error(String(err)); deliver({ done: true, value: undefined }); return { done: true, value: undefined } as IteratorResult<SDKMessage, void>; },
    interruptCalls: 0,
    async interrupt() { fakeQuery.interruptCalls += 1; },
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
  };

  const handle: FakeQueryHandle = {
    query: fakeQuery as unknown as Query,
    prompt: (async function* () {})(),
    interruptCalls: 0,
    emit(message) {
      if (waiting) deliver({ done: false, value: message });
      else queue.push(message);
    },
    finish() { done = true; deliver({ done: true, value: undefined }); },
    fail(err) { error = err; deliver({ done: true, value: undefined }); },
  };
  Object.defineProperty(handle, 'interruptCalls', { get: () => fakeQuery.interruptCalls });

  return handle;
}

function makeFactory(handle: FakeQueryHandle): QueryFactory {
  return ({ prompt }) => {
    handle.prompt = prompt;
    return handle.query;
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('controller mode happy path: createSession streams events and reaches READY', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });

  const outputs: ClaudeEvent[] = [];
  const statuses: SessionStatus[] = [];
  let startedWith: { sessionId: string; cwd: string } | undefined;

  manager.on('session_output', (_id, event) => outputs.push(event));
  manager.on('session_status', (_id, status) => statuses.push(status));
  manager.on('session_started', (sessionId, cwd) => { startedWith = { sessionId, cwd }; });

  try {
    const sessionId = manager.createSession({
      working_directory: '/tmp/cm-happy-path',
      initial_message: 'hello claude',
    });

    await waitFor(() => startedWith !== undefined);
    assert.equal(startedWith?.sessionId, sessionId);
    assert.equal(startedWith?.cwd, '/tmp/cm-happy-path');

    const session = manager.getSession(sessionId)!;
    assert.equal(session.status, SessionStatus.RUNNING);
    assert.ok(session.queryHandle, 'queryHandle must be set after createSession');

    const promptIter = fake.prompt[Symbol.asyncIterator]();
    const first = await promptIter.next();
    assert.equal(first.done, false);
    assert.equal((first.value as SDKUserMessage).message.content, 'hello claude');

    fake.emit({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as unknown as SDKMessage);
    fake.emit({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hi there' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
    } as unknown as SDKMessage);
    fake.emit({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    } as unknown as SDKMessage);
    fake.emit({ type: 'result', subtype: 'success', session_id: 'claude-sess-1' } as unknown as SDKMessage);

    await waitFor(() => session.status === SessionStatus.READY);
    assert.equal(session.claudeSessionId, 'claude-sess-1');
    assert.deepEqual(outputs, [
      { type: 'assistant_message', message: 'Hi there' },
      { type: 'tool_use', tool_id: 't1', tool_name: 'Read', tool_input: { file_path: 'a.ts' } },
      { type: 'tool_result', tool_id: 't1', status: 'success', output: 'ok' },
    ]);
    assert.ok(statuses.includes(SessionStatus.READY), 'READY status must be emitted');

    await manager.sendMessage(sessionId, 'follow up');
    const second = await promptIter.next();
    assert.equal(second.done, false);
    assert.equal((second.value as SDKUserMessage).message.content, 'follow up');

    fake.finish();
    await waitFor(() => session.queryHandle === null);
    assert.equal(session.status, SessionStatus.READY);
  } finally {
    manager.shutdown();
  }
});
