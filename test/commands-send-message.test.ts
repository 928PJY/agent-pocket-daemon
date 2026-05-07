import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionStatus } from 'agent-pocket-protocol';
import type {
  PcEvent,
  SendMessageCommand,
  MessageAckEvent,
} from 'agent-pocket-protocol';
import type { CommandContext } from '../src/commands/command-context.js';
import {
  handleSendMessage,
  type SendMessageDeps,
  type CodexObserverStatus,
} from '../src/commands/handlers/send-message.js';
import type { TerminalTarget } from '../src/pty/tmux-injector.js';
import type { RunningCliSession, DiscoveredSession } from '../src/discovery/session-discovery.js';

interface SentError { requestId?: string; message: string; code: string; }

interface SessionManagerStub {
  sendMessage?: (id: string, message: string) => Promise<{ sdkUuid?: string }>;
  observeSession?: (
    sessionId: string,
    filePath: string,
    cwd: string,
    pid: number,
    customTitle?: string,
    terminalTarget?: TerminalTarget,
    entrypoint?: string,
  ) => string;
}

function makeCtx(overrides: {
  sessionManager?: SessionManagerStub;
  resolveInternalSessionId?: (id: string) => string | undefined;
} = {}) {
  const sentErrors: SentError[] = [];
  const sentEvents: PcEvent[] = [];
  const historyCalls: string[] = [];
  const ctx: CommandContext = {
    sendToPhone: (event) => { sentEvents.push(event); },
    sendError: (requestId, message, code) => { sentErrors.push({ requestId, message, code }); },
    resolveInternalSessionId: overrides.resolveInternalSessionId ?? (() => undefined),
    resolveExternalSessionId: (id) => id,
    sendSessionHistory: (id) => { historyCalls.push(id); },
    sessionManager: (overrides.sessionManager ?? {}) as unknown as CommandContext['sessionManager'],
    sessionIdMap: new Map(),
    pendingSessionRequests: new Map(),
  };
  return { ctx, sentErrors, sentEvents, historyCalls };
}

interface DepsHarness {
  deps: SendMessageDeps;
  codexInjected: Map<string, Map<string, number>>;
  codexObservers: Map<string, CodexObserverStatus>;
  sessionIdMap: Map<string, string>;
  sentTerminal: Array<{ target: TerminalTarget; message: string }>;
  discoverCalls: number;
}

function makeDeps(overrides: {
  resolveCodexTerminalTarget?: (id: string) => { target?: TerminalTarget } | undefined;
  observerStatus?: SessionStatus;
  sendTerminalThrows?: Error;
  runningCli?: RunningCliSession[];
  discovered?: DiscoveredSession[];
} = {}): DepsHarness {
  const codexInjected = new Map<string, Map<string, number>>();
  const codexObservers = new Map<string, CodexObserverStatus>();
  const sessionIdMap = new Map<string, string>();
  const sentTerminal: Array<{ target: TerminalTarget; message: string }> = [];
  let discoverCalls = 0;

  if (overrides.observerStatus !== undefined) {
    codexObservers.set('codex:thread-1', { status: overrides.observerStatus });
  }

  const deps: SendMessageDeps = {
    resolveCodexTerminalTarget: overrides.resolveCodexTerminalTarget
      ?? (() => ({ target: { type: 'tmux', sessionName: 'main', windowIndex: '1', paneIndex: '0' } as unknown as TerminalTarget })),
    codexObservers,
    codexInjectedMessages: codexInjected,
    sendTerminalMessage: (target, message) => {
      if (overrides.sendTerminalThrows) throw overrides.sendTerminalThrows;
      sentTerminal.push({ target, message });
    },
    getRunningCliSessions: () => overrides.runningCli ?? [],
    discoverSessions: async () => {
      discoverCalls++;
      return overrides.discovered ?? [];
    },
    sessionIdMap,
  };

  return { deps, codexInjected, codexObservers, sessionIdMap, sentTerminal, discoverCalls };
}

const baseCmd = (extra: Partial<SendMessageCommand> = {}): SendMessageCommand => ({
  type: 'send_message',
  session_id: 'sess-1',
  message: 'hello',
  client_message_id: 'cid-12345678',
  ...extra,
});

function acks(events: PcEvent[]): MessageAckEvent[] {
  return events.filter((e) => (e as { type: string }).type === 'message_ack') as MessageAckEvent[];
}

// ---------------------------------------------------------------------------
// initial received-ack
// ---------------------------------------------------------------------------

test('handleSendMessage emits a received ack immediately when client_message_id is set', async () => {
  const { ctx, sentEvents } = makeCtx({
    resolveInternalSessionId: () => 'internal-1',
    sessionManager: { sendMessage: async () => ({ sdkUuid: 'uuid-1' }) },
  });
  const { deps } = makeDeps();

  await handleSendMessage(ctx, deps, baseCmd());
  const all = acks(sentEvents);
  assert.equal(all[0].status, 'received');
  assert.equal(all[0].client_message_id, 'cid-12345678');
});

test('handleSendMessage skips ack emission when client_message_id is omitted', async () => {
  const { ctx, sentEvents } = makeCtx({
    resolveInternalSessionId: () => 'internal-1',
    sessionManager: { sendMessage: async () => ({ sdkUuid: 'uuid-1' }) },
  });
  const { deps } = makeDeps();

  await handleSendMessage(ctx, deps, baseCmd({ client_message_id: undefined }));
  assert.equal(acks(sentEvents).length, 0);
});

// ---------------------------------------------------------------------------
// Codex branch
// ---------------------------------------------------------------------------

test('handleSendMessage codex without terminal target emits CODEX_TERMINAL_NOT_ATTACHED + failed ack', async () => {
  const { ctx, sentErrors, sentEvents } = makeCtx();
  const { deps, sentTerminal } = makeDeps({
    resolveCodexTerminalTarget: () => undefined,
  });

  await handleSendMessage(ctx, deps, baseCmd({ session_id: 'codex:thread-1' }));

  assert.equal(sentErrors[0].code, 'CODEX_TERMINAL_NOT_ATTACHED');
  const failed = acks(sentEvents).find((a) => a.status === 'failed');
  assert.ok(failed?.error?.includes('Codex remote message is not available'));
  assert.equal(sentTerminal.length, 0);
});

test('handleSendMessage codex while observer is RUNNING emits SESSION_NOT_READY + failed ack', async () => {
  const { ctx, sentErrors, sentEvents } = makeCtx();
  const { deps, sentTerminal } = makeDeps({ observerStatus: SessionStatus.RUNNING });

  await handleSendMessage(ctx, deps, baseCmd({ session_id: 'codex:thread-1' }));

  assert.equal(sentErrors[0].code, 'SESSION_NOT_READY');
  assert.ok(acks(sentEvents).some((a) => a.status === 'failed'));
  assert.equal(sentTerminal.length, 0);
});

test('handleSendMessage codex while observer is PENDING_ACTIONS also emits SESSION_NOT_READY', async () => {
  const { ctx, sentErrors } = makeCtx();
  const { deps } = makeDeps({ observerStatus: SessionStatus.PENDING_ACTIONS });

  await handleSendMessage(ctx, deps, baseCmd({ session_id: 'codex:thread-1' }));

  assert.equal(sentErrors[0].code, 'SESSION_NOT_READY');
});

test('handleSendMessage codex happy path injects message, bumps in-flight count, emits committed ack', async () => {
  const { ctx, sentEvents } = makeCtx();
  const { deps, codexInjected, sentTerminal } = makeDeps();

  await handleSendMessage(ctx, deps, baseCmd({ session_id: 'codex:thread-1', message: 'ping' }));

  assert.equal(sentTerminal.length, 1);
  assert.equal(sentTerminal[0].message, 'ping');
  assert.equal(codexInjected.get('codex:thread-1')?.get('ping'), 1);
  assert.ok(acks(sentEvents).some((a) => a.status === 'committed'));
});

test('handleSendMessage codex rolls back the in-flight count when sendTerminalMessage throws', async () => {
  const { ctx, sentErrors, sentEvents } = makeCtx();
  const { deps, codexInjected } = makeDeps({ sendTerminalThrows: new Error('tmux lost') });

  await handleSendMessage(ctx, deps, baseCmd({ session_id: 'codex:thread-1', message: 'ping' }));

  assert.equal(codexInjected.get('codex:thread-1')?.get('ping'), undefined);
  assert.equal(sentErrors[0].code, 'SEND_MESSAGE_ERROR');
  const failed = acks(sentEvents).find((a) => a.status === 'failed');
  assert.equal(failed?.error, 'tmux lost');
});

// ---------------------------------------------------------------------------
// SDK tracked branch
// ---------------------------------------------------------------------------

test('handleSendMessage SDK tracked path forwards to sessionManager and acks committed with sdk_uuid', async () => {
  const calls: Array<{ id: string; msg: string }> = [];
  const { ctx, sentEvents } = makeCtx({
    resolveInternalSessionId: () => 'internal-1',
    sessionManager: {
      sendMessage: async (id, msg) => { calls.push({ id, msg }); return { sdkUuid: 'uuid-42' }; },
    },
  });
  const { deps } = makeDeps();

  await handleSendMessage(ctx, deps, baseCmd());

  assert.deepEqual(calls, [{ id: 'internal-1', msg: 'hello' }]);
  const committed = acks(sentEvents).find((a) => a.status === 'committed');
  assert.equal(committed?.sdk_uuid, 'uuid-42');
});

test('handleSendMessage SDK tracked path with no client_message_id still calls sendMessage', async () => {
  const calls: string[] = [];
  const { ctx } = makeCtx({
    resolveInternalSessionId: () => 'internal-1',
    sessionManager: {
      sendMessage: async (id) => { calls.push(id); return {}; },
    },
  });
  const { deps } = makeDeps();

  await handleSendMessage(ctx, deps, baseCmd({ client_message_id: undefined }));
  assert.deepEqual(calls, ['internal-1']);
});

test('handleSendMessage SDK tracked path maps sendMessage errors to SEND_MESSAGE_ERROR + failed ack', async () => {
  const { ctx, sentErrors, sentEvents } = makeCtx({
    resolveInternalSessionId: () => 'internal-1',
    sessionManager: {
      sendMessage: async () => { throw new Error('boom'); },
    },
  });
  const { deps } = makeDeps();

  await handleSendMessage(ctx, deps, baseCmd());
  assert.equal(sentErrors[0].code, 'SEND_MESSAGE_ERROR');
  assert.ok(sentErrors[0].message.includes('boom'));
  const failed = acks(sentEvents).find((a) => a.status === 'failed');
  assert.equal(failed?.error, 'boom');
});

// ---------------------------------------------------------------------------
// observe-and-inject branch
// ---------------------------------------------------------------------------

test('handleSendMessage observe-and-inject without a running terminal emits SESSION_NOT_RUNNING', async () => {
  const { ctx, sentErrors } = makeCtx({ resolveInternalSessionId: () => undefined });
  const { deps, discoverCalls } = makeDeps({ runningCli: [] });

  await handleSendMessage(ctx, deps, baseCmd());

  assert.equal(sentErrors[0].code, 'SESSION_NOT_RUNNING');
  assert.equal(discoverCalls, 0); // short-circuits before discovery
});

test('handleSendMessage observe-and-inject without a discovered session file emits SESSION_FILE_NOT_FOUND', async () => {
  const running: RunningCliSession[] = [{
    sessionId: 'sess-1',
    pid: 1234,
    cwd: '/tmp',
    terminalTarget: undefined,
    entrypoint: undefined,
  } as unknown as RunningCliSession];
  const { ctx, sentErrors } = makeCtx({ resolveInternalSessionId: () => undefined });
  const { deps } = makeDeps({ runningCli: running, discovered: [] });

  await handleSendMessage(ctx, deps, baseCmd());

  assert.equal(sentErrors[0].code, 'SESSION_FILE_NOT_FOUND');
});

test('handleSendMessage observe-and-inject happy path observes, sends history, forwards message, acks committed', async () => {
  const observeCalls: Array<{ sessionId: string; filePath: string }> = [];
  const sendCalls: Array<{ id: string; msg: string }> = [];
  const { ctx, historyCalls, sentEvents } = makeCtx({
    resolveInternalSessionId: () => undefined,
    sessionManager: {
      observeSession: (sessionId, filePath) => {
        observeCalls.push({ sessionId, filePath });
        return 'internal-observed';
      },
      sendMessage: async (id, msg) => { sendCalls.push({ id, msg }); return { sdkUuid: 'uuid-99' }; },
    },
  });
  const running = [{
    sessionId: 'sess-1',
    pid: 4321,
    cwd: '/work',
    terminalTarget: undefined,
    entrypoint: undefined,
  } as unknown as RunningCliSession];
  const discovered = [{
    sessionId: 'sess-1',
    filePath: '/path/to/sess-1.jsonl',
    customTitle: 'Title',
  } as unknown as DiscoveredSession];
  const { deps, sessionIdMap } = makeDeps({ runningCli: running, discovered });

  await handleSendMessage(ctx, deps, baseCmd());

  assert.deepEqual(observeCalls, [{ sessionId: 'sess-1', filePath: '/path/to/sess-1.jsonl' }]);
  assert.equal(sessionIdMap.get('internal-observed'), 'sess-1');
  assert.deepEqual(historyCalls, ['sess-1']);
  assert.deepEqual(sendCalls, [{ id: 'internal-observed', msg: 'hello' }]);
  const committed = acks(sentEvents).find((a) => a.status === 'committed');
  assert.equal(committed?.sdk_uuid, 'uuid-99');
});
