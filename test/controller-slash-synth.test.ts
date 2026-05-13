import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Query, SDKMessage, SDKUserMessage, Options as SDKQueryOptions } from '@anthropic-ai/claude-agent-sdk';
import { SessionStatus } from 'agent-pocket-protocol';
import type { ClaudeEvent } from 'agent-pocket-protocol';
import { PEER_CAPABILITIES } from 'agent-pocket-protocol';
import { SessionManager, type QueryFactory } from '../src/sessions/session-manager.js';

// ---------------------------------------------------------------------------
// Fake Query helper (same pattern as controller-mode-happy-path.test.ts)
// ---------------------------------------------------------------------------

function createFakeQuery() {
  const queue: SDKMessage[] = [];
  let waiting: ((value: IteratorResult<SDKMessage, void>) => void) | null = null;
  let done = false;
  let error: Error | undefined;

  const fakeQuery = {
    [Symbol.asyncIterator]() { return this; },
    next(): Promise<IteratorResult<SDKMessage, void>> {
      if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift()! });
      if (error) return Promise.reject(error);
      if (done) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => { waiting = resolve; });
    },
    async return() { done = true; if (waiting) { const r = waiting; waiting = null; r({ done: true, value: undefined }); } return { done: true, value: undefined } as IteratorResult<SDKMessage, void>; },
    async throw(err: unknown) { error = err instanceof Error ? err : new Error(String(err)); if (waiting) { const r = waiting; waiting = null; r({ done: true, value: undefined }); } return { done: true, value: undefined } as IteratorResult<SDKMessage, void>; },
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
    async rewindFiles() { return { canRewind: true } as never; },
  };

  let prompt: AsyncIterable<SDKUserMessage> = (async function* () {})();

  return {
    query: fakeQuery as unknown as Query,
    get prompt() { return prompt; },
    set prompt(p: AsyncIterable<SDKUserMessage>) { prompt = p; },
    emit(message: SDKMessage) {
      if (waiting) { const r = waiting; waiting = null; r({ done: false, value: message }); }
      else queue.push(message);
    },
    finish() { done = true; if (waiting) { const r = waiting; waiting = null; r({ done: true, value: undefined }); } },
  };
}

function makeFactory(handle: ReturnType<typeof createFakeQuery>): QueryFactory {
  return ({ prompt }) => { handle.prompt = prompt; return handle.query; };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// recordControllerSlashSynth ring + getControllerSlashSynthLog
// ---------------------------------------------------------------------------

test('getControllerSlashSynthLog returns [] for unknown claudeSessionId', () => {
  const manager = new SessionManager({ bindingJournal: null });
  assert.deepEqual(manager.getControllerSlashSynthLog('nonexistent-session'), []);
  manager.shutdown();
});

test('synth ring prunes to last 50 entries after handleSDKMessage synthesis', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({
    queryFactory: makeFactory(fake),
    hasPeerCapability: () => true,
    bindingJournal: null,
  });

  const cwd = mkdtempSync(join(tmpdir(), 'synth-ring-'));
  try {
    const sessionId = manager.createSession({ name: 'ring', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);
    const session = manager.getSession(sessionId)!;
    const claudeSessionId = session.claudeSessionId!;

    // Push 60 slash commands and receive 60 fast text replies to trigger synthesis
    for (let i = 0; i < 60; i++) {
      await manager.sendMessage(sessionId, `/cost${i}`);
      // Drain the prompt
      const iter = fake.prompt[Symbol.asyncIterator]();
      await iter.next();

      // Emit a fast text reply (< 1000ms)
      fake.emit({
        type: 'assistant',
        uuid: `uuid-${i}`,
        message: { content: [{ type: 'text', text: `Total: $${i}` }] },
      } as unknown as SDKMessage);

      // Need to wait for the event to be processed
      await new Promise((r) => setTimeout(r, 5));
    }

    const log = manager.getControllerSlashSynthLog(claudeSessionId);
    assert.equal(log.length, 50, `expected 50 entries, got ${log.length}`);
    // First kept entry should be from the 11th push (i=10)
    assert.equal(log[0].name, 'cost10');
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// pendingControllerSlash is set after sendMessage with /command
// ---------------------------------------------------------------------------

test('sendMessage with /cost sets pendingControllerSlash on controller session', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({ queryFactory: makeFactory(fake), bindingJournal: null });
  const cwd = mkdtempSync(join(tmpdir(), 'slash-latch-'));
  try {
    const sessionId = manager.createSession({ name: 'slash', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);

    await manager.sendMessage(sessionId, '/cost', 'cid-1');
    const session = manager.getSession(sessionId)!;
    assert.ok(session.pendingControllerSlash, 'pendingControllerSlash should be set');
    assert.equal(session.pendingControllerSlash.name, 'cost');
    assert.equal(session.pendingControllerSlash.args, '');
    assert.equal(session.pendingControllerSlash.clientMessageId, 'cid-1');
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('sendMessage with /model opus sets name=model args=opus', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({ queryFactory: makeFactory(fake), bindingJournal: null });
  const cwd = mkdtempSync(join(tmpdir(), 'slash-args-'));
  try {
    const sessionId = manager.createSession({ name: 'slash-args', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);

    await manager.sendMessage(sessionId, '/model opus');
    const session = manager.getSession(sessionId)!;
    assert.equal(session.pendingControllerSlash?.name, 'model');
    assert.equal(session.pendingControllerSlash?.args, 'opus');
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// handleSDKMessage synthesis branch: fast text reply
// ---------------------------------------------------------------------------

test('handleSDKMessage synthesizes invoke + output + phone_origin_committed for fast text reply', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({
    queryFactory: makeFactory(fake),
    hasPeerCapability: () => true,
    bindingJournal: null,
  });

  const outputs: ClaudeEvent[] = [];
  const committed: Array<{ sessionId: string; cid: string; sdkUuid: string }> = [];
  manager.on('session_output', (_id, event) => outputs.push(event));
  manager.on('phone_origin_committed', (sid, cid, uuid) => committed.push({ sessionId: sid, cid, sdkUuid: uuid }));

  const cwd = mkdtempSync(join(tmpdir(), 'synth-fast-'));
  try {
    const sessionId = manager.createSession({ name: 'synth', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);

    const { sdkUuid } = await manager.sendMessage(sessionId, '/cost', 'cid-1');
    // Drain prompt
    const iter = fake.prompt[Symbol.asyncIterator]();
    await iter.next();

    // Emit fast text reply
    fake.emit({
      type: 'assistant',
      uuid: 'asst-uuid-1',
      message: { content: [{ type: 'text', text: 'Total cost: $0.42' }] },
    } as unknown as SDKMessage);

    await waitFor(() => outputs.length >= 2 && committed.length >= 1);

    // Order: invoke, output
    assert.equal(outputs[0].type, 'local_command_invoke');
    const invoke = outputs[0] as { type: string; name: string; args: string; sdkUuid: string };
    assert.equal(invoke.name, 'cost');
    assert.equal(invoke.args, '');
    assert.equal(invoke.sdkUuid, sdkUuid);

    assert.equal(outputs[1].type, 'local_command_output');
    const output = outputs[1] as { type: string; stdout: string; parentInvokeSdkUuid: string };
    assert.equal(output.stdout, 'Total cost: $0.42');
    assert.equal(output.parentInvokeSdkUuid, sdkUuid);

    // phone_origin_committed carries the clientMessageId
    assert.equal(committed[0].cid, 'cid-1');
    assert.equal(committed[0].sdkUuid, sdkUuid);
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Latch-cleared branch: thinking first (real model turn)
// ---------------------------------------------------------------------------

test('handleSDKMessage clears latch on thinking block, emits phone_origin_committed, falls through to normal', async () => {
  const fake = createFakeQuery();
  const manager = new SessionManager({
    queryFactory: makeFactory(fake),
    hasPeerCapability: () => true,
    bindingJournal: null,
  });

  const outputs: ClaudeEvent[] = [];
  const committed: Array<{ cid: string; sdkUuid: string }> = [];
  manager.on('session_output', (_id, event) => outputs.push(event));
  manager.on('phone_origin_committed', (_sid, cid, uuid) => committed.push({ cid, sdkUuid: uuid }));

  const cwd = mkdtempSync(join(tmpdir(), 'synth-thinking-'));
  try {
    const sessionId = manager.createSession({ name: 'think', working_directory: cwd });
    await waitFor(() => manager.getSession(sessionId)?.queryHandle != null);

    const { sdkUuid } = await manager.sendMessage(sessionId, '/simplify', 'cid-2');
    const iter = fake.prompt[Symbol.asyncIterator]();
    await iter.next();

    // First block is thinking, not text
    fake.emit({
      type: 'assistant',
      uuid: 'asst-uuid-2',
      message: { content: [
        { type: 'thinking', thinking: 'Let me think...' },
        { type: 'text', text: 'Simplified code...' },
      ] },
    } as unknown as SDKMessage);

    await waitFor(() => outputs.length >= 2 && committed.length >= 1);

    // Should emit thinking + assistant_message (normal path), NOT invoke/output
    assert.equal(outputs[0].type, 'thinking');
    assert.equal(outputs[1].type, 'assistant_message');

    // phone_origin_committed still emitted
    assert.equal(committed[0].cid, 'cid-2');
    assert.equal(committed[0].sdkUuid, sdkUuid);

    // Synth log still records (so serializer can suppress the JSONL echo)
    const session = manager.getSession(sessionId)!;
    const log = manager.getControllerSlashSynthLog(session.claudeSessionId!);
    assert.equal(log.length, 1);
    assert.equal(log[0].name, 'simplify');
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});
