import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import {
  registerPermissionExpiredHandler,
  registerCodexSessionStartHandler,
  registerCodexUserPromptSubmitHandler,
  registerCodexStopHandler,
  registerCodexPermissionRequestHandler,
  type HookGateway,
  type PendingBlockingEntry,
  type CodexObserverEntry,
  type MessageSeqRef,
} from '../src/wiring/hook-handlers-codex.js';
import { SessionStatus } from 'agent-pocket-protocol';

// ---------------------------------------------------------------------------
// Fake HookServer harness
// ---------------------------------------------------------------------------

interface FakeHookServer extends HookGateway {
  emit(event: string, ...args: unknown[]): boolean;
}

function makeHooks(): FakeHookServer {
  return new EventEmitter() as unknown as FakeHookServer;
}

// ---------------------------------------------------------------------------
// permission_expired
// ---------------------------------------------------------------------------

interface PermissionExpiredHarness {
  pending: Map<string, PendingBlockingEntry>;
  sentEvents: unknown[];
  expiredCalls: Array<{ sId: string; rId: string; tn: string; at: string; e?: PendingBlockingEntry }>;
  clearedDeliveries: Array<{ et: string; sId: string; rId: string }>;
  resolveExternalCalls: string[];
  resolveCodexCalls: string[];
  findCalls: string[];
}

function makePermissionExpiredDeps(opts: {
  matchedSession?: { sessionId: string } | undefined;
  externalIdMap?: Record<string, string>;
  codexExternalId?: string | undefined;
  pending?: Array<[string, PendingBlockingEntry]>;
} = {}) {
  const harness: PermissionExpiredHarness = {
    pending: new Map(opts.pending ?? []),
    sentEvents: [],
    expiredCalls: [],
    clearedDeliveries: [],
    resolveExternalCalls: [],
    resolveCodexCalls: [],
    findCalls: [],
  };
  const externalIdMap = opts.externalIdMap ?? {};
  return {
    harness,
    deps: {
      sessionManager: {
        findByClaudeSessionId(claudeSessionId: string) {
          harness.findCalls.push(claudeSessionId);
          return opts.matchedSession as never;
        },
      },
      resolveExternalSessionId(internalId: string) {
        harness.resolveExternalCalls.push(internalId);
        return externalIdMap[internalId] ?? internalId;
      },
      resolveCodexExternalSessionId(claudeSessionId: string) {
        harness.resolveCodexCalls.push(claudeSessionId);
        return opts.codexExternalId;
      },
      sendToPhone(event: unknown) { harness.sentEvents.push(event); },
      pendingBlockingRequests: harness.pending,
      sendExpiredPendingSystemMessage(sId: string, rId: string, tn: string, at: string, e?: PendingBlockingEntry) {
        harness.expiredCalls.push({ sId, rId, tn, at, e });
      },
      clearNotificationDelivery(et: string, sId: string, rId: string) {
        harness.clearedDeliveries.push({ et, sId, rId });
      },
    },
  };
}

test('permission_expired: codex external id wins over session.findByClaudeSessionId mapping', () => {
  const hooks = makeHooks();
  const { harness, deps } = makePermissionExpiredDeps({
    matchedSession: { sessionId: 'int-1' },
    externalIdMap: { 'int-1': 'ext-claude' },
    codexExternalId: 'codex:ABC',
  });
  registerPermissionExpiredHandler(hooks, deps);
  hooks.emit('permission_expired', { sessionId: 'cs', toolUseId: 'tu', toolName: 'Bash' });
  // First sent event is permission_expired itself, with codex external id
  assert.equal((harness.sentEvents[0] as { session_id: string }).session_id, 'codex:ABC');
});

test('permission_expired: falls through to claude external id when no codex mapping', () => {
  const hooks = makeHooks();
  const { harness, deps } = makePermissionExpiredDeps({
    matchedSession: { sessionId: 'int-1' },
    externalIdMap: { 'int-1': 'ext-claude' },
    codexExternalId: undefined,
  });
  registerPermissionExpiredHandler(hooks, deps);
  hooks.emit('permission_expired', { sessionId: 'cs', toolUseId: 'tu', toolName: 'Bash' });
  assert.equal((harness.sentEvents[0] as { session_id: string }).session_id, 'ext-claude');
});

test('permission_expired: falls back to raw claude session id when neither codex nor session match', () => {
  const hooks = makeHooks();
  const { harness, deps } = makePermissionExpiredDeps({});
  registerPermissionExpiredHandler(hooks, deps);
  hooks.emit('permission_expired', { sessionId: 'raw-cs', toolUseId: 'tu', toolName: 'Bash' });
  assert.equal((harness.sentEvents[0] as { session_id: string }).session_id, 'raw-cs');
});

test('permission_expired with a tracked blocking entry: deletes it, uses entry.type, and clears notification', () => {
  const hooks = makeHooks();
  const entry: PendingBlockingEntry = { sessionId: 'sess-1', type: 'user_question' };
  const { harness, deps } = makePermissionExpiredDeps({
    pending: [['tu', entry]],
  });
  registerPermissionExpiredHandler(hooks, deps);
  hooks.emit('permission_expired', { sessionId: 'sess-1', toolUseId: 'tu', toolName: 'AskUserQuestion' });
  assert.equal(harness.pending.size, 0);
  assert.deepEqual(harness.expiredCalls, [{ sId: 'sess-1', rId: 'tu', tn: 'AskUserQuestion', at: 'user_question', e: entry }]);
  assert.deepEqual(harness.clearedDeliveries, [{ et: 'user_question', sId: 'sess-1', rId: 'tu' }]);
});

test('permission_expired with no tracked entry: still sends expired-system-message + clearNotification, defaults to permission_request', () => {
  const hooks = makeHooks();
  const { harness, deps } = makePermissionExpiredDeps({});
  registerPermissionExpiredHandler(hooks, deps);
  hooks.emit('permission_expired', { sessionId: 'sess-1', toolUseId: 'tu', toolName: 'Bash' });
  assert.deepEqual(harness.expiredCalls, [{ sId: 'sess-1', rId: 'tu', tn: 'Bash', at: 'permission_request', e: undefined }]);
  assert.deepEqual(harness.clearedDeliveries, [{ et: 'permission_request', sId: 'sess-1', rId: 'tu' }]);
});

test('permission_expired: fires session_status=ready when no other blocking entries remain for the session', () => {
  const hooks = makeHooks();
  const { harness, deps } = makePermissionExpiredDeps({
    pending: [['tu', { sessionId: 'sess-1', type: 'permission_request' }]],
  });
  registerPermissionExpiredHandler(hooks, deps);
  hooks.emit('permission_expired', { sessionId: 'sess-1', toolUseId: 'tu', toolName: 'Bash' });
  // sentEvents[0] is permission_expired, [1] should be session_status=ready
  assert.equal(harness.sentEvents.length, 2);
  assert.deepEqual(harness.sentEvents[1], { type: 'session_status', session_id: 'sess-1', status: SessionStatus.READY });
});

test('permission_expired: skips session_status=ready when other blocking entries remain for the same session', () => {
  const hooks = makeHooks();
  const { harness, deps } = makePermissionExpiredDeps({
    pending: [
      ['tu', { sessionId: 'sess-1', type: 'permission_request' }],
      ['other', { sessionId: 'sess-1', type: 'user_question' }],
    ],
  });
  registerPermissionExpiredHandler(hooks, deps);
  hooks.emit('permission_expired', { sessionId: 'sess-1', toolUseId: 'tu', toolName: 'Bash' });
  // Only permission_expired event, no follow-up session_status
  assert.equal(harness.sentEvents.length, 1);
});

// ---------------------------------------------------------------------------
// codex_session_start
// ---------------------------------------------------------------------------

function makeCodexHarness(opts: {
  initialDiscoveryDone?: boolean;
  observed?: Array<[string, CodexObserverEntry]>;
  recordReturns?: string;
} = {}) {
  const observers = new Map<string, CodexObserverEntry>(opts.observed ?? []);
  const sentEvents: unknown[] = [];
  const recordCalls: unknown[] = [];
  const capabilityCalls: string[] = [];
  return {
    observers,
    sentEvents,
    recordCalls,
    capabilityCalls,
    deps: {
      codexObservers: observers,
      recordCodexHookActivity(req: unknown) {
        recordCalls.push(req);
        return opts.recordReturns ?? 'codex:abc';
      },
      sendToPhone(event: unknown) { sentEvents.push(event); },
      isInitialDiscoveryDone: () => opts.initialDiscoveryDone ?? true,
      getCodexCapabilities(sessionId: string) {
        capabilityCalls.push(sessionId);
        return ['codex_cap'];
      },
    },
  };
}

test('codex_session_start: marks tracked observer READY and updates lastActivity, emits session_started post-discovery', () => {
  const hooks = makeHooks();
  const tracked: CodexObserverEntry = {
    session: { id: 'codex:abc', cwd: '/proj', title: 'My Title', cliVersion: '0.5.1' } as never,
    status: SessionStatus.RUNNING,
    lastActivity: 1,
  };
  const h = makeCodexHarness({ observed: [['codex:abc', tracked]] });
  registerCodexSessionStartHandler(hooks, h.deps);
  const before = Date.now();
  hooks.emit('codex_session_start', { sessionId: 'codex:abc', cwd: '/proj', source: 'launch', codexPid: 1234 });
  assert.equal(tracked.status, SessionStatus.READY);
  assert.ok(tracked.lastActivity >= before);
  assert.equal(h.sentEvents.length, 1);
  const evt = h.sentEvents[0] as { type: string; project_name: string; agent_type: string; agent_version: string; capabilities: string[] };
  assert.equal(evt.type, 'session_started');
  assert.equal(evt.project_name, 'My Title');
  assert.equal(evt.agent_type, 'codex');
  assert.equal(evt.agent_version, '0.5.1');
  assert.deepEqual(evt.capabilities, ['codex_cap']);
});

test('codex_session_start: defaults project_name from cwd basename when no tracked title', () => {
  const hooks = makeHooks();
  const h = makeCodexHarness({});
  registerCodexSessionStartHandler(hooks, h.deps);
  hooks.emit('codex_session_start', { sessionId: 'codex:abc', cwd: '/some/dir/proj-x', source: 'launch' });
  assert.equal((h.sentEvents[0] as { project_name: string }).project_name, 'proj-x');
});

test('codex_session_start: uses literal "Codex" when neither title nor cwd available', () => {
  const hooks = makeHooks();
  const h = makeCodexHarness({});
  registerCodexSessionStartHandler(hooks, h.deps);
  hooks.emit('codex_session_start', { sessionId: 'codex:abc', cwd: '', source: 'launch' });
  assert.equal((h.sentEvents[0] as { project_name: string }).project_name, 'Codex');
});

test('codex_session_start: skips session_started when initial discovery is not yet done', () => {
  const hooks = makeHooks();
  const h = makeCodexHarness({ initialDiscoveryDone: false });
  registerCodexSessionStartHandler(hooks, h.deps);
  hooks.emit('codex_session_start', { sessionId: 'codex:abc', cwd: '/p', source: 'launch' });
  assert.equal(h.sentEvents.length, 0);
});

// ---------------------------------------------------------------------------
// codex_user_prompt_submit
// ---------------------------------------------------------------------------

test('codex_user_prompt_submit: marks tracked observer RUNNING and broadcasts session_status', () => {
  const hooks = makeHooks();
  const tracked: CodexObserverEntry = { session: {} as never, status: SessionStatus.READY, lastActivity: 1 };
  const h = makeCodexHarness({ observed: [['codex:abc', tracked]] });
  registerCodexUserPromptSubmitHandler(hooks, h.deps);
  hooks.emit('codex_user_prompt_submit', { sessionId: 'codex:abc' });
  assert.equal(tracked.status, SessionStatus.RUNNING);
  assert.deepEqual(h.sentEvents, [{ type: 'session_status', session_id: 'codex:abc', status: SessionStatus.RUNNING }]);
});

test('codex_user_prompt_submit: still broadcasts session_status when no tracked observer', () => {
  const hooks = makeHooks();
  const h = makeCodexHarness({});
  registerCodexUserPromptSubmitHandler(hooks, h.deps);
  hooks.emit('codex_user_prompt_submit', { sessionId: 'codex:unknown' });
  assert.deepEqual(h.sentEvents, [{ type: 'session_status', session_id: 'codex:abc', status: SessionStatus.RUNNING }]);
});

// ---------------------------------------------------------------------------
// codex_stop
// ---------------------------------------------------------------------------

test('codex_stop: marks observer READY, records via deduper, calls sendCodexCompletion with session', () => {
  const hooks = makeHooks();
  const sess = { id: 'codex:abc' } as never;
  const tracked: CodexObserverEntry = { session: sess, status: SessionStatus.RUNNING, lastActivity: 1 };
  const h = makeCodexHarness({ observed: [['codex:abc', tracked]] });
  const deduperRecords: string[] = [];
  const completionCalls: Array<{ sId: string; sess?: unknown; summary?: string }> = [];
  registerCodexStopHandler(hooks, {
    ...h.deps,
    codexStopHookDeduper: { record: (id: string) => deduperRecords.push(id) },
    sendCodexCompletion: (sId, sess, summary) => completionCalls.push({ sId, sess, summary }),
  });
  hooks.emit('codex_stop', { sessionId: 'codex:abc' });
  assert.equal(tracked.status, SessionStatus.READY);
  assert.deepEqual(deduperRecords, ['codex:abc']);
  assert.equal(completionCalls.length, 1);
  assert.equal(completionCalls[0].sId, 'codex:abc');
  assert.equal(completionCalls[0].sess, sess);
});

test('codex_stop: passes undefined session when observer not tracked', () => {
  const hooks = makeHooks();
  const h = makeCodexHarness({});
  const completionCalls: Array<{ sess?: unknown }> = [];
  registerCodexStopHandler(hooks, {
    ...h.deps,
    codexStopHookDeduper: { record: () => {} },
    sendCodexCompletion: (_sId, sess) => completionCalls.push({ sess }),
  });
  hooks.emit('codex_stop', { sessionId: 'codex:unknown' });
  assert.equal(completionCalls[0].sess, undefined);
});

// ---------------------------------------------------------------------------
// codex_permission_request
// ---------------------------------------------------------------------------

interface CodexPermHarness {
  notificationCalls: Array<{ event: unknown; eventType: string; sessionId: string; requestId: string; wakePayload: { body: string } }>;
  blockingCalls: Array<{ requestId: string; sessionId: string; type: string }>;
  signCalls: string[];
  contextCalls: Array<{ tn: string; ti: Record<string, unknown> }>;
  nameCalls: string[];
  recordedRequests: unknown[];
}

function makeCodexPermDeps(opts: {
  recordReturns?: string;
  signThrows?: boolean;
  initialSeq?: number;
} = {}) {
  const harness: CodexPermHarness = {
    notificationCalls: [],
    blockingCalls: [],
    signCalls: [],
    contextCalls: [],
    nameCalls: [],
    recordedRequests: [],
  };
  let seq = opts.initialSeq ?? 7;
  const ref: MessageSeqRef = {
    peek: () => seq,
    getAndIncrement: () => seq++,
  };
  return {
    harness,
    seqRef: ref,
    getSeq: () => seq,
    deps: {
      recordCodexHookActivity(req: unknown) { harness.recordedRequests.push(req); return opts.recordReturns ?? 'codex:s'; },
      cryptoEngine: {
        sign(payload: string) {
          harness.signCalls.push(payload);
          if (opts.signThrows) throw new Error('signing-disabled');
          return `sig:${payload.length}`;
        },
      },
      messageSeq: ref,
      buildPermissionContext(toolName: string, toolInput: Record<string, unknown>) {
        harness.contextCalls.push({ tn: toolName, ti: toolInput });
        return `ctx-for-${toolName}`;
      },
      getSessionName(sessionId: string) {
        harness.nameCalls.push(sessionId);
        return `name-${sessionId}`;
      },
      sendNotificationEventToPhone(event: unknown, eventType: string, sessionId: string, requestId: string, wakePayload: unknown) {
        harness.notificationCalls.push({ event, eventType: eventType, sessionId, requestId, wakePayload: wakePayload as { body: string } });
      },
      trackBlockingRequest(requestId: string, sessionId: string, _event: unknown, type: string) {
        harness.blockingCalls.push({ requestId, sessionId, type });
      },
    } as Parameters<typeof registerCodexPermissionRequestHandler>[1],
  };
}

test('codex_permission_request: signs with current seq AND emits same seq, then increments for the next event', () => {
  const hooks = makeHooks();
  const { harness, deps, getSeq } = makeCodexPermDeps({ initialSeq: 7 });
  registerCodexPermissionRequestHandler(hooks, deps);
  hooks.emit('codex_permission_request', { sessionId: 'cs', toolUseId: 'tu1', toolName: 'Bash', toolInput: { cmd: 'ls' } });
  // The signed payload should mention seq:7 (peek), and the wire event should also carry seq:7
  assert.equal(harness.signCalls.length, 1);
  assert.match(harness.signCalls[0], /"seq":7/);
  const evt = harness.notificationCalls[0].event as { seq: number };
  assert.equal(evt.seq, 7);
  // Next call would observe seq=8
  assert.equal(getSeq(), 8);
});

test('codex_permission_request: empty pc_signature when signing throws (sign-key not loaded)', () => {
  const hooks = makeHooks();
  const { harness, deps } = makeCodexPermDeps({ signThrows: true });
  registerCodexPermissionRequestHandler(hooks, deps);
  hooks.emit('codex_permission_request', { sessionId: 'cs', toolUseId: 'tu', toolName: 'Bash', toolInput: {} });
  const evt = harness.notificationCalls[0].event as { pc_signature: string };
  assert.equal(evt.pc_signature, '');
});

test('codex_permission_request: synthesises requestId when toolUseId absent', () => {
  const hooks = makeHooks();
  const { harness, deps } = makeCodexPermDeps({});
  registerCodexPermissionRequestHandler(hooks, deps);
  hooks.emit('codex_permission_request', { sessionId: 'cs', toolName: 'Bash', toolInput: {} });
  const rId = harness.notificationCalls[0].requestId;
  assert.match(rId, /^codex_hook_\d+$/);
});

test('codex_permission_request: defaults toolName="unknown" and toolInput={} when missing', () => {
  const hooks = makeHooks();
  const { harness, deps } = makeCodexPermDeps({});
  registerCodexPermissionRequestHandler(hooks, deps);
  hooks.emit('codex_permission_request', { sessionId: 'cs' });
  assert.deepEqual(harness.contextCalls[0], { tn: 'unknown', ti: {} });
  const evt = harness.notificationCalls[0].event as { tool_name: string; tool_input: Record<string, unknown> };
  assert.equal(evt.tool_name, 'unknown');
  assert.deepEqual(evt.tool_input, {});
});

test('codex_permission_request: tracks blocking + builds wake payload with truncated body', () => {
  const hooks = makeHooks();
  const { harness, deps } = makeCodexPermDeps({ recordReturns: 'codex:THE-SESS' });
  registerCodexPermissionRequestHandler(hooks, deps);
  hooks.emit('codex_permission_request', { sessionId: 'cs', toolUseId: 'tu99', toolName: 'WriteFile', toolInput: { path: '/x' } });
  assert.deepEqual(harness.blockingCalls, [{ requestId: 'tu99', sessionId: 'codex:THE-SESS', type: 'permission_request' }]);
  const wake = harness.notificationCalls[0].wakePayload;
  assert.equal(wake.body, 'WriteFile: ctx-for-WriteFile');
});
