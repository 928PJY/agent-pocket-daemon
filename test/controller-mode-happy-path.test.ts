import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Options as SDKQueryOptions, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
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
  setPermissionModeCalls: unknown[][];
  setModelCalls: unknown[][];
  supportedModelsCalls: number;
  setSupportedModelsResult(models: unknown[]): void;
  setSupportedModelsError(err: Error): void;
  getContextUsageCalls: number;
  setContextUsageResult(usage: unknown): void;
  setContextUsageError(err: Error): void;
  supportedCommandsCalls: number;
  setSupportedCommandsResult(commands: unknown[]): void;
  setSupportedCommandsError(err: Error): void;
  supportedAgentsCalls: number;
  setSupportedAgentsResult(agents: unknown[]): void;
  setSupportedAgentsError(err: Error): void;
  mcpServerStatusCalls: number;
  setMcpServerStatusResult(servers: unknown[]): void;
  setMcpServerStatusError(err: Error): void;
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
    setPermissionModeCalls: [] as unknown[][],
    setModelCalls: [] as unknown[][],
    supportedModelsCalls: 0,
    supportedModelsResult: [] as unknown[],
    supportedModelsError: undefined as Error | undefined,
    getContextUsageCalls: 0,
    contextUsageResult: undefined as unknown,
    contextUsageError: undefined as Error | undefined,
    supportedCommandsCalls: 0,
    supportedCommandsResult: [] as unknown[],
    supportedCommandsError: undefined as Error | undefined,
    supportedAgentsCalls: 0,
    supportedAgentsResult: [] as unknown[],
    supportedAgentsError: undefined as Error | undefined,
    mcpServerStatusCalls: 0,
    mcpServerStatusResult: [] as unknown[],
    mcpServerStatusError: undefined as Error | undefined,
    async interrupt() { fakeQuery.interruptCalls += 1; },
    async setPermissionMode(...args: unknown[]) { fakeQuery.setPermissionModeCalls.push(args); },
    async setModel(...args: unknown[]) { fakeQuery.setModelCalls.push(args); },
    async setMaxThinkingTokens() {},
    async applyFlagSettings() {},
    async initializationResult() { return {} as never; },
    async supportedCommands() {
      fakeQuery.supportedCommandsCalls += 1;
      if (fakeQuery.supportedCommandsError) throw fakeQuery.supportedCommandsError;
      return fakeQuery.supportedCommandsResult as never;
    },
    async supportedModels() {
      fakeQuery.supportedModelsCalls += 1;
      if (fakeQuery.supportedModelsError) throw fakeQuery.supportedModelsError;
      return fakeQuery.supportedModelsResult as never;
    },
    async supportedAgents() {
      fakeQuery.supportedAgentsCalls += 1;
      if (fakeQuery.supportedAgentsError) throw fakeQuery.supportedAgentsError;
      return fakeQuery.supportedAgentsResult as never;
    },
    async mcpServerStatus() {
      fakeQuery.mcpServerStatusCalls += 1;
      if (fakeQuery.mcpServerStatusError) throw fakeQuery.mcpServerStatusError;
      return fakeQuery.mcpServerStatusResult as never;
    },
    async setMcpServers() {},
    async getContextUsage() {
      fakeQuery.getContextUsageCalls += 1;
      if (fakeQuery.contextUsageError) throw fakeQuery.contextUsageError;
      return fakeQuery.contextUsageResult as never;
    },
    async rewindFiles() { return undefined as never; },
  };

  const handle: FakeQueryHandle = {
    query: fakeQuery as unknown as Query,
    prompt: (async function* () {})(),
    interruptCalls: 0,
    setPermissionModeCalls: [],
    setModelCalls: [],
    supportedModelsCalls: 0,
    setSupportedModelsResult(models) { fakeQuery.supportedModelsResult = models; },
    setSupportedModelsError(err) { fakeQuery.supportedModelsError = err; },
    getContextUsageCalls: 0,
    setContextUsageResult(usage) { fakeQuery.contextUsageResult = usage; },
    setContextUsageError(err) { fakeQuery.contextUsageError = err; },
    supportedCommandsCalls: 0,
    setSupportedCommandsResult(commands) { fakeQuery.supportedCommandsResult = commands; },
    setSupportedCommandsError(err) { fakeQuery.supportedCommandsError = err; },
    supportedAgentsCalls: 0,
    setSupportedAgentsResult(agents) { fakeQuery.supportedAgentsResult = agents; },
    setSupportedAgentsError(err) { fakeQuery.supportedAgentsError = err; },
    mcpServerStatusCalls: 0,
    setMcpServerStatusResult(servers) { fakeQuery.mcpServerStatusResult = servers; },
    setMcpServerStatusError(err) { fakeQuery.mcpServerStatusError = err; },
    emit(message) {
      if (waiting) deliver({ done: false, value: message });
      else queue.push(message);
    },
    finish() { done = true; deliver({ done: true, value: undefined }); },
    fail(err) { error = err; deliver({ done: true, value: undefined }); },
  };
  Object.defineProperty(handle, 'interruptCalls', { get: () => fakeQuery.interruptCalls });
  Object.defineProperty(handle, 'setPermissionModeCalls', { get: () => fakeQuery.setPermissionModeCalls });
  Object.defineProperty(handle, 'setModelCalls', { get: () => fakeQuery.setModelCalls });
  Object.defineProperty(handle, 'supportedModelsCalls', { get: () => fakeQuery.supportedModelsCalls });
  Object.defineProperty(handle, 'getContextUsageCalls', { get: () => fakeQuery.getContextUsageCalls });
  Object.defineProperty(handle, 'supportedCommandsCalls', { get: () => fakeQuery.supportedCommandsCalls });
  Object.defineProperty(handle, 'supportedAgentsCalls', { get: () => fakeQuery.supportedAgentsCalls });
  Object.defineProperty(handle, 'mcpServerStatusCalls', { get: () => fakeQuery.mcpServerStatusCalls });

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

  const cwd = mkdtempSync(join(tmpdir(), 'cm-happy-path-'));
  try {
    const sessionId = manager.createSession({
      name: 'happy-path',
      agent_type: 'claude_code',
      working_directory: cwd,
    });

    await waitFor(() => startedWith !== undefined);
    assert.equal(startedWith?.sessionId, sessionId);
    assert.equal(startedWith?.cwd, cwd);

    const session = manager.getSession(sessionId)!;
    assert.equal(session.status, SessionStatus.READY);
    assert.ok(session.queryHandle, 'queryHandle must be set after createSession');

    await manager.sendMessage(sessionId, 'hello claude');
    assert.equal(session.status, SessionStatus.RUNNING);
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
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('createSession persists name as customTitle and forwards as SDK options.title', async () => {
  const fake = createFakeQuery();
  let capturedOptions: SDKQueryOptions | undefined;
  const factory: QueryFactory = ({ prompt, options }) => {
    fake.prompt = prompt;
    capturedOptions = options;
    return fake.query;
  };
  const manager = new SessionManager({ queryFactory: factory });

  const cwd = mkdtempSync(join(tmpdir(), 'cm-name-'));
  try {
    const sessionId = manager.createSession({
      name: 'demo session',
      agent_type: 'claude_code',
      working_directory: cwd,
    });

    const session = manager.getSession(sessionId)!;
    assert.equal(session.customTitle, 'demo session');
    assert.equal(session.titleIsCustom, true);
    assert.equal((capturedOptions as { title?: string } | undefined)?.title, 'demo session');
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('session_started carries customTitle and starts in READY before any input', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });

  let startedTitle: string | undefined;
  let firstStatus: SessionStatus | undefined;
  manager.on('session_started', (_id, _cwd, title) => { startedTitle = title; });
  manager.on('session_status', (_id, status) => { if (firstStatus === undefined) firstStatus = status; });

  const cwd = mkdtempSync(join(tmpdir(), 'cm-started-'));
  try {
    manager.createSession({ name: 'titled', agent_type: 'claude_code', working_directory: cwd });
    await waitFor(() => startedTitle !== undefined);
    assert.equal(startedTitle, 'titled');
    assert.equal(firstStatus, SessionStatus.READY);
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('SDK-driven interrupt emits session_interrupted with source=sdk', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });

  const interrupts: Array<{ reason: string; source: string }> = [];
  manager.on('session_interrupted', (_id, reason, source) => interrupts.push({ reason, source }));

  const cwd = mkdtempSync(join(tmpdir(), 'cm-interrupt-'));
  try {
    const sessionId = manager.createSession({
      name: 'irq',
      agent_type: 'claude_code',
      working_directory: cwd,
    });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);
    await manager.sendMessage(sessionId, 'go');
    await manager.interruptSession(sessionId);
    await waitFor(() => interrupts.length > 0);
    assert.equal(interrupts[0]?.source, 'sdk');
    assert.equal(interrupts[0]?.reason, 'streaming');
    assert.ok(fake.interruptCalls >= 1, 'SDK interrupt() should have been called');
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('setPermissionMode forwards to query.setPermissionMode', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  const cwd = mkdtempSync(join(tmpdir(), 'cm-mode-'));
  try {
    const sessionId = manager.createSession({ name: 'm', agent_type: 'claude_code', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);
    await manager.setPermissionMode(sessionId, 'plan');
    assert.deepEqual(fake.setPermissionModeCalls.at(-1), ['plan']);
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('setModel forwards to query.setModel including undefined for reset', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  const cwd = mkdtempSync(join(tmpdir(), 'cm-model-'));
  try {
    const sessionId = manager.createSession({ name: 'm', agent_type: 'claude_code', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);
    await manager.setModel(sessionId, 'claude-sonnet-4-6');
    await manager.setModel(sessionId, undefined);
    assert.deepEqual(fake.setModelCalls.at(-2), ['claude-sonnet-4-6']);
    assert.deepEqual(fake.setModelCalls.at(-1), [undefined]);
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('setPermissionMode rejects observed sessions with not_supported', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  await assert.rejects(
    () => manager.setPermissionMode('does-not-exist', 'plan'),
    (err: Error) => err.message.includes('Session not found'),
  );
  manager.shutdown();
});

test('getSupportedModels forwards to query.supportedModels and returns the list', async () => {
  const fake = createFakeQuery();
  const fakeModels = [
    { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'fast', supportsEffort: false },
    { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'smart', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
  ];
  fake.setSupportedModelsResult(fakeModels);
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  const cwd = mkdtempSync(join(tmpdir(), 'cm-models-'));
  try {
    const sessionId = manager.createSession({ name: 'm', agent_type: 'claude_code', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);
    const models = await manager.getSupportedModels(sessionId);
    assert.equal(fake.supportedModelsCalls, 1);
    assert.deepEqual(models, fakeModels);
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('getSupportedModels rejects unknown sessions', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  await assert.rejects(
    () => manager.getSupportedModels('does-not-exist'),
    (err: Error) => err.message.includes('Session not found'),
  );
  manager.shutdown();
});

test('getSupportedModels propagates SDK errors', async () => {
  const fake = createFakeQuery();
  fake.setSupportedModelsError(new Error('boom from sdk'));
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  const cwd = mkdtempSync(join(tmpdir(), 'cm-models-err-'));
  try {
    const sessionId = manager.createSession({ name: 'm', agent_type: 'claude_code', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);
    await assert.rejects(
      () => manager.getSupportedModels(sessionId),
      (err: Error) => err.message.includes('boom from sdk'),
    );
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('getContextUsage forwards to query.getContextUsage and returns the snapshot', async () => {
  const fake = createFakeQuery();
  const fakeUsage = {
    categories: [{ name: 'messages', tokens: 5000, color: '#abc' }],
    totalTokens: 5000,
    maxTokens: 200000,
    rawMaxTokens: 200000,
    percentage: 2.5,
    gridRows: [],
    model: 'claude-sonnet-4-6',
    memoryFiles: [],
    mcpTools: [],
  };
  fake.setContextUsageResult(fakeUsage);
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  const cwd = mkdtempSync(join(tmpdir(), 'cm-ctx-'));
  try {
    const sessionId = manager.createSession({ name: 'c', agent_type: 'claude_code', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);
    const usage = await manager.getContextUsage(sessionId);
    assert.equal(fake.getContextUsageCalls, 1);
    assert.equal((usage as { totalTokens: number }).totalTokens, 5000);
    assert.equal((usage as { model: string }).model, 'claude-sonnet-4-6');
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('getContextUsage rejects unknown sessions', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  await assert.rejects(
    () => manager.getContextUsage('does-not-exist'),
    (err: Error) => err.message.includes('Session not found'),
  );
  manager.shutdown();
});

test('getContextUsage propagates SDK errors', async () => {
  const fake = createFakeQuery();
  fake.setContextUsageError(new Error('boom usage'));
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  const cwd = mkdtempSync(join(tmpdir(), 'cm-ctx-err-'));
  try {
    const sessionId = manager.createSession({ name: 'c', agent_type: 'claude_code', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);
    await assert.rejects(
      () => manager.getContextUsage(sessionId),
      (err: Error) => err.message.includes('boom usage'),
    );
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('getSupportedCommands forwards to query.supportedCommands and returns the list', async () => {
  const fake = createFakeQuery();
  const fakeCommands = [{ name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost'] }];
  fake.setSupportedCommandsResult(fakeCommands);
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  const cwd = mkdtempSync(join(tmpdir(), 'cm-cmds-'));
  try {
    const sessionId = manager.createSession({ name: 'c', agent_type: 'claude_code', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);
    const commands = await manager.getSupportedCommands(sessionId);
    assert.equal(fake.supportedCommandsCalls, 1);
    assert.equal((commands as Array<{ name: string }>)[0]?.name, 'usage');
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('getSupportedCommands rejects unknown sessions', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  await assert.rejects(
    () => manager.getSupportedCommands('does-not-exist'),
    (err: Error) => err.message.includes('Session not found'),
  );
  manager.shutdown();
});

test('getSupportedCommands propagates SDK errors', async () => {
  const fake = createFakeQuery();
  fake.setSupportedCommandsError(new Error('boom cmds'));
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  const cwd = mkdtempSync(join(tmpdir(), 'cm-cmds-err-'));
  try {
    const sessionId = manager.createSession({ name: 'c', agent_type: 'claude_code', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);
    await assert.rejects(
      () => manager.getSupportedCommands(sessionId),
      (err: Error) => err.message.includes('boom cmds'),
    );
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('getSupportedAgents forwards to query.supportedAgents and returns the list', async () => {
  const fake = createFakeQuery();
  const fakeAgents = [{ name: 'Explore', description: 'Codebase explorer', model: 'haiku' }];
  fake.setSupportedAgentsResult(fakeAgents);
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  const cwd = mkdtempSync(join(tmpdir(), 'cm-agents-'));
  try {
    const sessionId = manager.createSession({ name: 'c', agent_type: 'claude_code', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);
    const agents = await manager.getSupportedAgents(sessionId);
    assert.equal(fake.supportedAgentsCalls, 1);
    assert.equal((agents as Array<{ name: string }>)[0]?.name, 'Explore');
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('getSupportedAgents rejects unknown sessions', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  await assert.rejects(
    () => manager.getSupportedAgents('does-not-exist'),
    (err: Error) => err.message.includes('Session not found'),
  );
  manager.shutdown();
});

test('getSupportedAgents propagates SDK errors', async () => {
  const fake = createFakeQuery();
  fake.setSupportedAgentsError(new Error('boom agents'));
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  const cwd = mkdtempSync(join(tmpdir(), 'cm-agents-err-'));
  try {
    const sessionId = manager.createSession({ name: 'c', agent_type: 'claude_code', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);
    await assert.rejects(
      () => manager.getSupportedAgents(sessionId),
      (err: Error) => err.message.includes('boom agents'),
    );
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('getMcpServerStatus forwards to query.mcpServerStatus and returns the list', async () => {
  const fake = createFakeQuery();
  const fakeServers = [{ name: 'github', status: 'connected', tools: [{ name: 'list_prs' }] }];
  fake.setMcpServerStatusResult(fakeServers);
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  const cwd = mkdtempSync(join(tmpdir(), 'cm-mcp-'));
  try {
    const sessionId = manager.createSession({ name: 'c', agent_type: 'claude_code', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);
    const servers = await manager.getMcpServerStatus(sessionId);
    assert.equal(fake.mcpServerStatusCalls, 1);
    assert.equal((servers as Array<{ name: string }>)[0]?.name, 'github');
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('getMcpServerStatus rejects unknown sessions', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  await assert.rejects(
    () => manager.getMcpServerStatus('does-not-exist'),
    (err: Error) => err.message.includes('Session not found'),
  );
  manager.shutdown();
});

test('getMcpServerStatus propagates SDK errors', async () => {
  const fake = createFakeQuery();
  fake.setMcpServerStatusError(new Error('boom mcp'));
  const manager = new SessionManager({ queryFactory: makeFactory(fake) });
  const cwd = mkdtempSync(join(tmpdir(), 'cm-mcp-err-'));
  try {
    const sessionId = manager.createSession({ name: 'c', agent_type: 'claude_code', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);
    await assert.rejects(
      () => manager.getMcpServerStatus(sessionId),
      (err: Error) => err.message.includes('boom mcp'),
    );
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});
