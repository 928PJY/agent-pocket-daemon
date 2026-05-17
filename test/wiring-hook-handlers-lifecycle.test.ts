import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import {
  registerSessionStopHandler,
  registerSessionStopFailureHandler,
  registerSessionEndHandler,
  registerSessionStartHandler,
  registerPermissionDismissedHandler,
  registerPermissionPromptHandler,
  type HookGateway,
  type PendingClearInfo,
} from '../src/wiring/hook-handlers-lifecycle.js';
import type {
  PendingBlockingEntry,
  MessageSeqRef,
} from '../src/wiring/hook-handlers-codex.js';
import type { TurnSummary } from '../src/utils/transcript-reader.js';
import type { SessionMap } from '../src/utils/session-map.js';
import type { HookPermissionPrompt } from '../src/hooks/hook-server.js';

interface FakeHookServer extends HookGateway {
  emit(event: string, ...args: unknown[]): boolean;
}

function makeHooks(): FakeHookServer {
  return new EventEmitter() as unknown as FakeHookServer;
}

// ---------------------------------------------------------------------------
// session_stop
// ---------------------------------------------------------------------------

interface FakeSession {
  sessionId: string;
  workingDirectory: string;
  customTitle?: string;
}

interface SessionStopHarness {
  pending: Map<string, PendingBlockingEntry>;
  notifiedEvents: Array<{ event: unknown; et: string; sId: string; rId: string; wake: unknown }>;
  sentEvents: unknown[];
  clearedDeliveries: Array<{ et: string; sId: string; rId: string }>;
  clearPendingActionsCalls: string[];
  scheduledTimers: Array<{ fn: () => void; ms: number }>;
}

function makeSessionStopDeps(opts: {
  matchedSession?: FakeSession;
  externalIdMap?: Record<string, string>;
  pending?: Array<[string, PendingBlockingEntry]>;
  showCompletionMetrics?: boolean;
  summary?: TurnSummary | null;
  summaryThrows?: boolean;
  prefetchClaudeSessionIds?: Set<string>;
  /** Defaults to false (legacy path) so existing fixtures still emit the chip. */
  phoneHasTurnMetricsCap?: boolean;
} = {}) {
  const harness: SessionStopHarness = {
    pending: new Map(opts.pending ?? []),
    notifiedEvents: [],
    sentEvents: [],
    clearedDeliveries: [],
    clearPendingActionsCalls: [],
    scheduledTimers: [],
  };
  const externalIdMap = opts.externalIdMap ?? {};
  return {
    harness,
    deps: {
      sessionManager: {
        findByClaudeSessionId(_id: string) { return opts.matchedSession as never; },
        clearPendingActions(id: string) { harness.clearPendingActionsCalls.push(id); },
      },
      resolveExternalSessionId(internalId: string) {
        return externalIdMap[internalId] ?? internalId;
      },
      pendingBlockingRequests: harness.pending,
      prefetchClaudeSessionIds: opts.prefetchClaudeSessionIds ?? new Set<string>(),
      clearNotificationDelivery(et: string, sId: string, rId: string) {
        harness.clearedDeliveries.push({ et, sId, rId });
      },
      nextCompletionRequestId(sessionId: string, ts: number) {
        return `comp_${sessionId}_${ts}`;
      },
      sendNotificationEventToPhone(event: unknown, et: string, sId: string, rId: string, wake: unknown) {
        harness.notifiedEvents.push({ event, et, sId, rId, wake });
      },
      sendToPhone(event: unknown) { harness.sentEvents.push(event); },
      prefs: { showCompletionMetrics: opts.showCompletionMetrics ?? true },
      hasPeerCapability(_name: string) { return opts.phoneHasTurnMetricsCap ?? false; },
      setTimeoutFn: ((fn: () => void, ms: number) => {
        harness.scheduledTimers.push({ fn, ms });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      readLastTurnSummaryFn: async (_p: string) => {
        if (opts.summaryThrows) throw new Error('boom');
        return opts.summary ?? null;
      },
    },
  };
}

test('session_stop: with transcript + matched session emits notification + delayed metrics chip', async () => {
  const hooks = makeHooks();
  const summary: TurnSummary = { text: 'hi there', toolUseCount: 2, totalTokens: 5000, durationSec: 12 };
  const session: FakeSession = { sessionId: 'int-1', workingDirectory: '/tmp/proj', customTitle: 'My Proj' };
  const { harness, deps } = makeSessionStopDeps({
    matchedSession: session,
    externalIdMap: { 'int-1': 'ext-1' },
    summary,
    pending: [['req-a', { sessionId: 'ext-1', type: 'permission_request' }]],
  });
  registerSessionStopHandler(hooks, deps);
  hooks.emit('session_stop', 'claude-abc', '/tmp/transcript.jsonl');
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.equal(harness.notifiedEvents.length, 1);
  const notified = harness.notifiedEvents[0]!;
  assert.equal(notified.et, 'session_completed');
  assert.equal(notified.sId, 'ext-1');
  const ev = notified.event as Record<string, unknown>;
  assert.equal(ev.is_completion, true);
  assert.equal(ev.completion_body, 'hi there');
  // completion_subtitle is no longer set — metrics live in chat as a chip,
  // not in the notification text.
  assert.equal(ev.completion_subtitle, undefined);
  assert.equal((notified.wake as Record<string, unknown>).subtitle, undefined);
  assert.equal((notified.wake as Record<string, unknown>).session_name, 'My Proj');

  // pending blocking cleared
  assert.equal(harness.pending.size, 0);
  assert.equal(harness.clearedDeliveries.length, 1);
  // clearPendingActions called
  assert.deepEqual(harness.clearPendingActionsCalls, ['int-1']);

  // legacy metrics chip still scheduled — this fixture does not announce the
  // MESSAGES_TURN_METRICS cap, so back-compat path runs.
  assert.equal(harness.scheduledTimers.length, 1);
  assert.equal(harness.scheduledTimers[0]!.ms, 500);
  harness.scheduledTimers[0]!.fn();
  assert.equal(harness.sentEvents.length, 1);
  const chip = harness.sentEvents[0] as Record<string, unknown>;
  assert.equal(chip.output_type, 'completion_metrics');
  assert.equal(chip.session_id, 'ext-1');
});

test('session_stop: phone has MESSAGES_TURN_METRICS cap → suppresses legacy chip', async () => {
  const hooks = makeHooks();
  const summary: TurnSummary = { text: 'ok', toolUseCount: 1, totalTokens: 100, durationSec: 3 };
  const { harness, deps } = makeSessionStopDeps({ summary, phoneHasTurnMetricsCap: true });
  registerSessionStopHandler(hooks, deps);
  hooks.emit('session_stop', 'claude-x', '/path');
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  // Notification still fires (and still has no subtitle).
  assert.equal(harness.notifiedEvents.length, 1);
  assert.equal((harness.notifiedEvents[0]!.event as Record<string, unknown>).completion_subtitle, undefined);
  // But the legacy session_output chip is suppressed — metrics arrive inline
  // on the assistant_message via the session-observer path.
  assert.equal(harness.scheduledTimers.length, 0);
  assert.equal(harness.sentEvents.length, 0);
});

test('session_stop: without transcriptPath emits notification with default body', async () => {
  const hooks = makeHooks();
  const { harness, deps } = makeSessionStopDeps({});
  registerSessionStopHandler(hooks, deps);
  hooks.emit('session_stop', 'claude-x', undefined);
  await new Promise(r => setImmediate(r));

  assert.equal(harness.notifiedEvents.length, 1);
  const wake = harness.notifiedEvents[0]!.wake as Record<string, unknown>;
  assert.equal(wake.body, 'Session finished');
  assert.equal(harness.scheduledTimers.length, 0);
});

test('session_stop: readLastTurnSummary returning null still notifies, no chip', async () => {
  const hooks = makeHooks();
  const { harness, deps } = makeSessionStopDeps({ summary: null });
  registerSessionStopHandler(hooks, deps);
  hooks.emit('session_stop', 'claude-x', '/path');
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.equal(harness.notifiedEvents.length, 1);
  assert.equal(harness.scheduledTimers.length, 0);
});

test('session_stop: readLastTurnSummary throwing still notifies', async () => {
  const hooks = makeHooks();
  const { harness, deps } = makeSessionStopDeps({ summaryThrows: true });
  registerSessionStopHandler(hooks, deps);
  hooks.emit('session_stop', 'claude-x', '/path');
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.equal(harness.notifiedEvents.length, 1);
  assert.equal(harness.scheduledTimers.length, 0);
});

test('session_stop: showCompletionMetrics=false suppresses metrics chip', async () => {
  const hooks = makeHooks();
  const summary: TurnSummary = { text: 'x', toolUseCount: 1, totalTokens: 100, durationSec: 5 };
  const { harness, deps } = makeSessionStopDeps({ summary, showCompletionMetrics: false });
  registerSessionStopHandler(hooks, deps);
  hooks.emit('session_stop', 'claude-x', '/path');
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.equal(harness.scheduledTimers.length, 0);
});

test('session_stop: SDK-prefetch session is suppressed (no notification, no chip)', async () => {
  const hooks = makeHooks();
  const summary: TurnSummary = { text: 'noop', toolUseCount: 0, totalTokens: 1, durationSec: 1 };
  const prefetchSet = new Set<string>(['claude-prefetch']);
  const { harness, deps } = makeSessionStopDeps({
    summary,
    showCompletionMetrics: true,
    prefetchClaudeSessionIds: prefetchSet,
  });
  registerSessionStopHandler(hooks, deps);
  hooks.emit('session_stop', 'claude-prefetch', '/tmp/transcript.jsonl');
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.equal(harness.notifiedEvents.length, 0);
  assert.equal(harness.sentEvents.length, 0);
  assert.equal(harness.scheduledTimers.length, 0);
  // Tag is consumed so a later real Stop with the same id wouldn't be suppressed.
  assert.equal(prefetchSet.has('claude-prefetch'), false);
});

test('session_stop: defaults setTimeoutFn + readLastTurnSummaryFn when omitted', async () => {
  const hooks = makeHooks();
  const harness = { notified: [] as unknown[] };
  registerSessionStopHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return undefined as never; },
      clearPendingActions() {},
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingBlockingRequests: new Map(),
    prefetchClaudeSessionIds: new Set(),
    clearNotificationDelivery() {},
    nextCompletionRequestId(s: string, t: number) { return `${s}_${t}`; },
    sendNotificationEventToPhone(event: unknown) { harness.notified.push(event); },
    sendToPhone() {},
    prefs: { showCompletionMetrics: false },
    hasPeerCapability() { return false; },
  });
  hooks.emit('session_stop', 'claude-x', undefined);
  await new Promise(r => setImmediate(r));
  assert.equal(harness.notified.length, 1);
});

test('session_stop: no transcript and unmatched session uses claude id as external id', async () => {
  const hooks = makeHooks();
  const { harness, deps } = makeSessionStopDeps({});
  registerSessionStopHandler(hooks, deps);
  hooks.emit('session_stop', 'claude-x', undefined);
  await new Promise(r => setImmediate(r));
  assert.equal(harness.notifiedEvents[0]!.sId, 'claude-x');
  assert.deepEqual(harness.clearPendingActionsCalls, []);
});

// ---------------------------------------------------------------------------
// session_stop_failure
// ---------------------------------------------------------------------------

test('session_stop_failure: clears pending blocking, fires session_status=ready, no clearNotification', () => {
  const hooks = makeHooks();
  const pending = new Map<string, PendingBlockingEntry>([
    ['r1', { sessionId: 'ext-1', type: 'permission_request' }],
    ['r2', { sessionId: 'other', type: 'permission_request' }],
  ]);
  const sent: unknown[] = [];
  const cleared: string[] = [];
  registerSessionStopFailureHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return { sessionId: 'int-1' } as never; },
      clearPendingActions(id: string) { cleared.push(id); },
    },
    resolveExternalSessionId() { return 'ext-1'; },
    pendingBlockingRequests: pending,
    sendToPhone(event: unknown) { sent.push(event); },
  });
  hooks.emit('session_stop_failure', 'claude-x', 'API down');
  assert.equal(pending.has('r1'), false);
  assert.equal(pending.has('r2'), true);
  assert.deepEqual(cleared, ['int-1']);
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as Record<string, unknown>).status, 'ready');
});

test('session_stop_failure: unmatched session falls back to claudeSessionId, skips clearPendingActions', () => {
  const hooks = makeHooks();
  const sent: unknown[] = [];
  const cleared: string[] = [];
  registerSessionStopFailureHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return undefined as never; },
      clearPendingActions(id: string) { cleared.push(id); },
    },
    resolveExternalSessionId() { return 'unused'; },
    pendingBlockingRequests: new Map(),
    sendToPhone(event: unknown) { sent.push(event); },
  });
  hooks.emit('session_stop_failure', 'claude-x', 'err');
  assert.equal((sent[0] as Record<string, unknown>).session_id, 'claude-x');
  assert.deepEqual(cleared, []);
});

// ---------------------------------------------------------------------------
// session_end
// ---------------------------------------------------------------------------

test('session_end: ignores non-clear reasons', () => {
  const hooks = makeHooks();
  const sent: unknown[] = [];
  registerSessionEndHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { throw new Error('should not be called'); },
      markObservedSessionHistory() {},
      removeSession() {},
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: new Map(),
    sessionIdMap: new Map(),
    replacedSessionIds: new Set(),
    sendToPhone(e: unknown) { sent.push(e); },
  });
  hooks.emit('session_end', 'claude-x', 'logout', '/cwd');
  assert.equal(sent.length, 0);
});

test('session_end(clear): missing session is no-op', () => {
  const hooks = makeHooks();
  const sent: unknown[] = [];
  registerSessionEndHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return undefined as never; },
      markObservedSessionHistory() { throw new Error('nope'); },
      removeSession() { throw new Error('nope'); },
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: new Map(),
    sessionIdMap: new Map(),
    replacedSessionIds: new Set(),
    sendToPhone(e: unknown) { sent.push(e); },
  });
  hooks.emit('session_end', 'claude-missing', 'clear', '/cwd');
  assert.equal(sent.length, 0);
});

test('session_end(clear): stores clear info, schedules cleanup, tears down session, broadcasts', () => {
  const hooks = makeHooks();
  const sent: unknown[] = [];
  const sessionIdMap = new Map<string, string>([['int-1', 'claude-old']]);
  const replaced = new Set<string>();
  const pendingClear = new Map<string, PendingClearInfo>();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const marked: string[] = [];
  const removed: string[] = [];
  const session = {
    sessionId: 'int-1',
    workingDirectory: '/proj',
    terminalPid: 1234,
    terminalTarget: { kind: 'tmux' as const, pane: '0' } as unknown as PendingClearInfo['target'],
    entrypoint: 'claude',
  };
  registerSessionEndHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return session as never; },
      markObservedSessionHistory(id: string) { marked.push(id); },
      removeSession(id: string) { removed.push(id); },
    },
    resolveExternalSessionId(id: string) { return id === 'int-1' ? 'ext-1' : id; },
    pendingClearInfo: pendingClear,
    sessionIdMap,
    replacedSessionIds: replaced,
    sendToPhone(e: unknown) { sent.push(e); },
    setTimeoutFn: ((fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
  });
  hooks.emit('session_end', 'claude-old', 'clear', '/cwd');

  assert.equal(pendingClear.get('/cwd')!.pid, 1234);
  assert.equal(pendingClear.get('/cwd')!.cwd, '/proj');
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, 30_000);

  assert.deepEqual(marked, ['int-1']);
  assert.deepEqual(removed, ['int-1']);
  assert.equal(sessionIdMap.has('int-1'), false);
  assert.ok(replaced.has('claude-old'));
  assert.equal((sent[0] as Record<string, unknown>).type, 'session_ended');
  assert.equal((sent[0] as Record<string, unknown>).session_id, 'ext-1');

  // Run timer callback to confirm cleanup deletes the entry
  timers[0]!.fn();
  assert.equal(pendingClear.has('/cwd'), false);
});

test('session_end(clear): no terminalPid skips clearInfo storage', () => {
  const hooks = makeHooks();
  const pendingClear = new Map<string, PendingClearInfo>();
  const sent: unknown[] = [];
  const session = { sessionId: 'int-1', workingDirectory: '/proj' };
  registerSessionEndHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return session as never; },
      markObservedSessionHistory() {},
      removeSession() {},
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: pendingClear,
    sessionIdMap: new Map(),
    replacedSessionIds: new Set(),
    sendToPhone(e: unknown) { sent.push(e); },
  });
  hooks.emit('session_end', 'claude-x', 'clear', '/cwd');
  assert.equal(pendingClear.size, 0);
  assert.equal(sent.length, 1);
});

test('session_end: defaults setTimeoutFn when omitted', () => {
  const hooks = makeHooks();
  registerSessionEndHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return undefined as never; },
      markObservedSessionHistory() {},
      removeSession() {},
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: new Map(),
    sessionIdMap: new Map(),
    replacedSessionIds: new Set(),
    sendToPhone() {},
  });
  // non-clear: no path through setTimeout
  hooks.emit('session_end', 'claude-x', 'logout', '/cwd');
  assert.ok(true);
});

// ---------------------------------------------------------------------------
// session_start
// ---------------------------------------------------------------------------

test('session_start: ignores non-clear sources', () => {
  const hooks = makeHooks();
  let touched = false;
  registerSessionStartHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { touched = true; return undefined as never; },
      findByTerminalPid() { return undefined as never; },
      observeSession() { return 'int-new'; },
      markObservedSessionHistory() {},
      removeSession() {},
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: new Map(),
    sessionIdMap: new Map(),
    replacedSessionIds: new Set(),
    sendToPhone() {},
    prefetchClaudeSessionIds: new Set(),
    isInitialDiscoveryDone() { return true; },
    sendSessionHistory() { return 0; },
  });
  hooks.emit('session_start', 'claude-x', 'startup', '/cwd', '');
  assert.equal(touched, false);
});

test('session_start(clear): already-tracked session is skipped', () => {
  const hooks = makeHooks();
  let observed = 0;
  registerSessionStartHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return { sessionId: 'int-x' } as never; },
      findByTerminalPid() { return undefined as never; },
      observeSession() { observed++; return 'int-new'; },
      markObservedSessionHistory() {},
      removeSession() {},
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: new Map(),
    sessionIdMap: new Map(),
    replacedSessionIds: new Set(),
    sendToPhone() {},
    prefetchClaudeSessionIds: new Set(),
    isInitialDiscoveryDone() { return true; },
    sendSessionHistory() { return 0; },
  });
  hooks.emit('session_start', 'claude-x', 'clear', '/cwd', '/transcript');
  assert.equal(observed, 0);
});

test('session_start(clear): uses pendingClearInfo + transcriptPath, calls sendSessionHistory', () => {
  const hooks = makeHooks();
  const pendingClear = new Map<string, PendingClearInfo>([
    ['/cwd', { pid: 999, cwd: '/proj', target: undefined, entrypoint: 'claude' }],
  ]);
  const sessionIdMap = new Map<string, string>();
  const observeArgs: unknown[][] = [];
  const histCalls: string[] = [];
  registerSessionStartHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return undefined as never; },
      findByTerminalPid() { throw new Error('should not call'); },
      observeSession(...args: unknown[]) { observeArgs.push(args); return 'int-new'; },
      markObservedSessionHistory() {},
      removeSession() {},
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: pendingClear,
    sessionIdMap,
    replacedSessionIds: new Set(),
    sendToPhone() {},
    prefetchClaudeSessionIds: new Set(),
    isInitialDiscoveryDone() { return true; },
    sendSessionHistory(id: string) { histCalls.push(id); return 5; },
  });
  hooks.emit('session_start', 'claude-new', 'clear', '/cwd', '/transcript.jsonl');
  assert.equal(pendingClear.has('/cwd'), false);
  assert.equal(observeArgs.length, 1);
  // observeSession(claudeId, jsonlPath, cwd, pid, undefined, target, entrypoint)
  assert.equal(observeArgs[0]![0], 'claude-new');
  assert.equal(observeArgs[0]![1], '/transcript.jsonl');
  assert.equal(observeArgs[0]![2], '/proj');
  assert.equal(observeArgs[0]![3], 999);
  assert.equal(sessionIdMap.get('int-new'), 'claude-new');
  assert.deepEqual(histCalls, ['claude-new']);
});

test('session_start(clear): jsonlPath fallback when transcriptPath empty', () => {
  const hooks = makeHooks();
  const pendingClear = new Map<string, PendingClearInfo>([
    ['/proj/work', { pid: 1, cwd: '/proj', target: undefined }],
  ]);
  let jsonlPath: unknown;
  registerSessionStartHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return undefined as never; },
      findByTerminalPid() { return undefined as never; },
      observeSession(_a: string, b: string) { jsonlPath = b; return 'int-new'; },
      markObservedSessionHistory() {},
      removeSession() {},
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: pendingClear,
    sessionIdMap: new Map(),
    replacedSessionIds: new Set(),
    sendToPhone() {},
    prefetchClaudeSessionIds: new Set(),
    isInitialDiscoveryDone() { return false; },
    sendSessionHistory() { return 0; },
  });
  hooks.emit('session_start', 'claude-new', 'clear', '/proj/work', '');
  // path.dirname('/proj/work') === '/proj'
  assert.equal(jsonlPath, '/proj/claude-new.jsonl');
});

test('session_start(clear): isInitialDiscoveryDone=false suppresses sendSessionHistory', () => {
  const hooks = makeHooks();
  const pendingClear = new Map<string, PendingClearInfo>([
    ['/cwd', { pid: 1, cwd: '/proj', target: undefined }],
  ]);
  let histCalled = false;
  registerSessionStartHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return undefined as never; },
      findByTerminalPid() { return undefined as never; },
      observeSession() { return 'int-new'; },
      markObservedSessionHistory() {},
      removeSession() {},
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: pendingClear,
    sessionIdMap: new Map(),
    replacedSessionIds: new Set(),
    sendToPhone() {},
    prefetchClaudeSessionIds: new Set(),
    isInitialDiscoveryDone() { return false; },
    sendSessionHistory() { histCalled = true; return 0; },
  });
  hooks.emit('session_start', 'claude-new', 'clear', '/cwd', '/t');
  assert.equal(histCalled, false);
});

test('session_start(clear): falls back to readSessionMap + findByTerminalPid, tears down old session', () => {
  const hooks = makeHooks();
  const sessionIdMap = new Map<string, string>([['int-old', 'claude-old']]);
  const replaced = new Set<string>();
  const sent: unknown[] = [];
  const removed: string[] = [];
  const marked: string[] = [];
  const existing = {
    sessionId: 'int-old',
    claudeSessionId: 'claude-old',
    workingDirectory: '/proj',
    terminalTarget: undefined,
    entrypoint: 'claude',
  };
  registerSessionStartHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return undefined as never; },
      findByTerminalPid(pid: number) {
        return pid === 7 ? (existing as never) : (undefined as never);
      },
      observeSession() { return 'int-new'; },
      markObservedSessionHistory(id: string) { marked.push(id); },
      removeSession(id: string) { removed.push(id); },
    },
    resolveExternalSessionId(id: string) { return id === 'int-old' ? 'ext-old' : id; },
    pendingClearInfo: new Map(),
    sessionIdMap,
    replacedSessionIds: replaced,
    sendToPhone(e: unknown) { sent.push(e); },
    prefetchClaudeSessionIds: new Set(),
    isInitialDiscoveryDone() { return true; },
    sendSessionHistory() { return 0; },
    readSessionMapFn: (() => ({ 'claude-new': { source: 'startup', cwd: '/proj', pid: 7, timestamp: 0 } })) as unknown as () => SessionMap,
  });
  hooks.emit('session_start', 'claude-new', 'clear', '/cwd', '/t');

  assert.deepEqual(marked, ['int-old']);
  assert.deepEqual(removed, ['int-old']);
  assert.equal(sessionIdMap.has('int-old'), false);
  assert.ok(replaced.has('claude-old'));
  assert.equal((sent[0] as Record<string, unknown>).type, 'session_ended');
  assert.equal((sent[0] as Record<string, unknown>).session_id, 'ext-old');
});

test('session_start(clear): readSessionMap with no matching pid bails out', () => {
  const hooks = makeHooks();
  let observed = 0;
  registerSessionStartHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return undefined as never; },
      findByTerminalPid() { return undefined as never; },
      observeSession() { observed++; return 'int-new'; },
      markObservedSessionHistory() {},
      removeSession() {},
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: new Map(),
    sessionIdMap: new Map(),
    replacedSessionIds: new Set(),
    sendToPhone() {},
    prefetchClaudeSessionIds: new Set(),
    isInitialDiscoveryDone() { return true; },
    sendSessionHistory() { return 0; },
    readSessionMapFn: (() => ({})) as unknown as () => SessionMap,
  });
  hooks.emit('session_start', 'claude-new', 'clear', '/cwd', '/t');
  assert.equal(observed, 0);
});

test('session_start: defaults readSessionMapFn when omitted', () => {
  const hooks = makeHooks();
  registerSessionStartHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return undefined as never; },
      findByTerminalPid() { return undefined as never; },
      observeSession() { return 'int-new'; },
      markObservedSessionHistory() {},
      removeSession() {},
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: new Map(),
    sessionIdMap: new Map(),
    replacedSessionIds: new Set(),
    sendToPhone() {},
    prefetchClaudeSessionIds: new Set(),
    isInitialDiscoveryDone() { return false; },
    sendSessionHistory() { return 0; },
  });
  // Falls through to readSessionMap from disk; without a real session-map file
  // it returns {} and the handler bails.
  hooks.emit('session_start', 'claude-new', 'clear', '/cwd', '/t');
  assert.ok(true);
});

test('session_start: cwd === PREFETCH_CWD tags session id and short-circuits', async () => {
  const { PREFETCH_CWD } = await import('../src/sessions/observer-commands.js');
  const hooks = makeHooks();
  const tagged = new Set<string>();
  let touchedSessionManager = false;
  registerSessionStartHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { touchedSessionManager = true; return undefined as never; },
      findByTerminalPid() { touchedSessionManager = true; return undefined as never; },
      observeSession() { touchedSessionManager = true; return 'int-new'; },
      markObservedSessionHistory() { touchedSessionManager = true; },
      removeSession() { touchedSessionManager = true; },
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: new Map(),
    sessionIdMap: new Map(),
    replacedSessionIds: new Set(),
    prefetchClaudeSessionIds: tagged,
    sendToPhone() { throw new Error('should not emit'); },
    isInitialDiscoveryDone() { return true; },
    sendSessionHistory() { throw new Error('should not query history'); },
  });
  hooks.emit('session_start', 'claude-prefetch', 'startup', PREFETCH_CWD, '/t');
  assert.ok(tagged.has('claude-prefetch'));
  assert.equal(touchedSessionManager, false);
});

test('session_start: non-prefetch cwd does not tag', () => {
  const hooks = makeHooks();
  const tagged = new Set<string>();
  registerSessionStartHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return undefined as never; },
      findByTerminalPid() { return undefined as never; },
      observeSession() { return 'int-new'; },
      markObservedSessionHistory() {},
      removeSession() {},
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: new Map(),
    sessionIdMap: new Map(),
    replacedSessionIds: new Set(),
    prefetchClaudeSessionIds: tagged,
    sendToPhone() {},
    isInitialDiscoveryDone() { return true; },
    sendSessionHistory() { return 0; },
  });
  hooks.emit('session_start', 'claude-x', 'startup', '/some/other/cwd', '/t');
  assert.equal(tagged.size, 0);
});

test('session_start(resume): historified session is re-promoted via session-map PID', () => {
  const hooks = makeHooks();
  const repromoteCalls: Array<{ sessionId: string; pid: number; jsonlPath: string }> = [];
  const historyCalls: string[] = [];
  const sessionIdMap = new Map<string, string>();
  registerSessionStartHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() {
        return { sessionId: 'int-1', isObserved: false, terminalTarget: undefined } as never;
      },
      findByTerminalPid() { return undefined as never; },
      observeSession() { throw new Error('should not observe — re-promote path'); },
      markObservedSessionHistory() {},
      removeSession() {},
      rePromoteHistoryToObserved(sessionId: string, pid: number, jsonlPath: string) {
        repromoteCalls.push({ sessionId, pid, jsonlPath });
        return true;
      },
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: new Map(),
    sessionIdMap,
    replacedSessionIds: new Set(),
    prefetchClaudeSessionIds: new Set(),
    sendToPhone() {},
    isInitialDiscoveryDone() { return true; },
    sendSessionHistory(sid: string) { historyCalls.push(sid); return 0; },
    readSessionMapFn() {
      return { 'claude-resumed': { pid: 4242, cwd: '/proj', timestamp: 1 } };
    },
  });
  hooks.emit('session_start', 'claude-resumed', 'resume', '/proj', '/proj/claude-resumed.jsonl');
  assert.deepEqual(repromoteCalls, [{ sessionId: 'int-1', pid: 4242, jsonlPath: '/proj/claude-resumed.jsonl' }]);
  assert.equal(sessionIdMap.get('int-1'), 'claude-resumed');
  assert.deepEqual(historyCalls, ['claude-resumed']);
});

test('session_start(resume): observed session is left alone', () => {
  const hooks = makeHooks();
  let repromoted = false;
  registerSessionStartHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() {
        return { sessionId: 'int-1', isObserved: true, terminalTarget: undefined } as never;
      },
      findByTerminalPid() { return undefined as never; },
      observeSession() { throw new Error('no-op'); },
      markObservedSessionHistory() {},
      removeSession() {},
      rePromoteHistoryToObserved() { repromoted = true; return true; },
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: new Map(),
    sessionIdMap: new Map(),
    replacedSessionIds: new Set(),
    prefetchClaudeSessionIds: new Set(),
    sendToPhone() {},
    isInitialDiscoveryDone() { return true; },
    sendSessionHistory() { return 0; },
    readSessionMapFn() { return {}; },
  });
  hooks.emit('session_start', 'claude-resumed', 'resume', '/proj', '/t');
  assert.equal(repromoted, false);
});

test('session_start(resume): no PID in session-map → defers to polling', () => {
  const hooks = makeHooks();
  let repromoted = false;
  registerSessionStartHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() {
        return { sessionId: 'int-1', isObserved: false, terminalTarget: undefined } as never;
      },
      findByTerminalPid() { return undefined as never; },
      observeSession() { throw new Error('no-op'); },
      markObservedSessionHistory() {},
      removeSession() {},
      rePromoteHistoryToObserved() { repromoted = true; return true; },
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingClearInfo: new Map(),
    sessionIdMap: new Map(),
    replacedSessionIds: new Set(),
    prefetchClaudeSessionIds: new Set(),
    sendToPhone() {},
    isInitialDiscoveryDone() { return true; },
    sendSessionHistory() { return 0; },
    readSessionMapFn() { return {}; },
  });
  hooks.emit('session_start', 'claude-resumed', 'resume', '/proj', '/t');
  assert.equal(repromoted, false);
});

// ---------------------------------------------------------------------------
// permission_dismissed
// ---------------------------------------------------------------------------

test('permission_dismissed: untracks request + emits event with matched session', () => {
  const hooks = makeHooks();
  const untracked: string[] = [];
  const sent: unknown[] = [];
  registerPermissionDismissedHandler(hooks, {
    sessionManager: {
      findByClaudeSessionId() { return { sessionId: 'int-1' } as never; },
    },
    resolveExternalSessionId() { return 'ext-1'; },
    untrackBlockingRequest(id: string) { untracked.push(id); },
    sendToPhone(e: unknown) { sent.push(e); },
  });
  hooks.emit('permission_dismissed', 'tu-1', 'Bash', 'claude-x');
  assert.deepEqual(untracked, ['tu-1']);
  assert.equal((sent[0] as Record<string, unknown>).type, 'permission_dismissed');
  assert.equal((sent[0] as Record<string, unknown>).session_id, 'ext-1');
  assert.equal((sent[0] as Record<string, unknown>).tool_name, 'Bash');
  assert.equal((sent[0] as Record<string, unknown>).answers, undefined);
});

test('permission_dismissed: AskUserQuestion includes answers from toolResponse.answers', () => {
  const hooks = makeHooks();
  const sent: unknown[] = [];
  registerPermissionDismissedHandler(hooks, {
    sessionManager: { findByClaudeSessionId() { return undefined as never; } },
    resolveExternalSessionId(id: string) { return id; },
    untrackBlockingRequest() {},
    sendToPhone(e: unknown) { sent.push(e); },
  });
  hooks.emit('permission_dismissed', 'tu-2', 'AskUserQuestion', 'claude-y', { answers: ['yes'] });
  const ev = sent[0] as Record<string, unknown>;
  assert.deepEqual(ev.answers, ['yes']);
  assert.equal(ev.session_id, 'claude-y');
});

test('permission_dismissed: AskUserQuestion uses raw toolResponse when no answers field', () => {
  const hooks = makeHooks();
  const sent: unknown[] = [];
  registerPermissionDismissedHandler(hooks, {
    sessionManager: { findByClaudeSessionId() { return undefined as never; } },
    resolveExternalSessionId(id: string) { return id; },
    untrackBlockingRequest() {},
    sendToPhone(e: unknown) { sent.push(e); },
  });
  hooks.emit('permission_dismissed', 'tu-3', 'AskUserQuestion', 'claude-z', { other: 1 });
  assert.deepEqual((sent[0] as Record<string, unknown>).answers, { other: 1 });
});

// ---------------------------------------------------------------------------
// permission_prompt
// ---------------------------------------------------------------------------

function makeMessageSeqRef(start = 0): { ref: MessageSeqRef; seq: () => number } {
  let v = start;
  return {
    ref: {
      peek: () => v,
      getAndIncrement: () => v++,
    },
    seq: () => v,
  };
}

test('permission_prompt: ExitPlanMode dispatches to sendPlanForReview only', () => {
  const hooks = makeHooks();
  const planCalls: unknown[][] = [];
  const notified: unknown[] = [];
  const tracked: unknown[] = [];
  registerPermissionPromptHandler(hooks, {
    sessionManager: { findByClaudeSessionId() { return { sessionId: 'int-1' } as never; } },
    resolveExternalSessionId() { return 'ext-1'; },
    sendPlanForReview(...args: unknown[]) { planCalls.push(args); },
    buildPermissionContext() { throw new Error('not used'); },
    getSessionName() { return 'sess'; },
    cryptoEngine: { sign() { return 'sig'; } },
    messageSeq: makeMessageSeqRef().ref,
    sendNotificationEventToPhone(e: unknown) { notified.push(e); },
    trackBlockingRequest(...args: unknown[]) { tracked.push(args); },
  });
  const req: HookPermissionPrompt = {
    sessionId: 'claude-x',
    toolUseId: 'tu-1',
    toolName: 'ExitPlanMode',
    toolInput: { plan: 'do stuff' },
    cwd: '/proj',
  };
  hooks.emit('permission_prompt', req);
  assert.equal(planCalls.length, 1);
  assert.equal(planCalls[0]![0], 'ext-1');
  assert.equal(planCalls[0]![1], 'tu-1');
  assert.equal(planCalls[0]![3], '/proj');
  assert.equal(notified.length, 0);
  assert.equal(tracked.length, 0);
});

test('permission_prompt: AskUserQuestion forwards as user_question + tracks blocking', () => {
  const hooks = makeHooks();
  const notified: Array<{ event: unknown; et: string; sId: string; rId: string; wake: unknown }> = [];
  const tracked: unknown[][] = [];
  registerPermissionPromptHandler(hooks, {
    sessionManager: { findByClaudeSessionId() { return undefined as never; } },
    resolveExternalSessionId(id: string) { return id; },
    sendPlanForReview() { throw new Error('nope'); },
    buildPermissionContext() { throw new Error('nope'); },
    getSessionName() { return 'mysess'; },
    cryptoEngine: { sign() { return 'sig'; } },
    messageSeq: makeMessageSeqRef().ref,
    sendNotificationEventToPhone(event: unknown, et: string, sId: string, rId: string, wake: unknown) {
      notified.push({ event, et, sId, rId, wake });
    },
    trackBlockingRequest(...args: unknown[]) { tracked.push(args); },
  });
  const req: HookPermissionPrompt = {
    sessionId: 'claude-x',
    toolUseId: 'tu-q1',
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'pick one?' }] },
    cwd: '/proj',
  };
  hooks.emit('permission_prompt', req);
  assert.equal(notified.length, 1);
  assert.equal(notified[0]!.et, 'user_question');
  assert.equal(notified[0]!.sId, 'claude-x');
  const ev = notified[0]!.event as Record<string, unknown>;
  assert.equal(ev.type, 'session_output');
  assert.equal(ev.output_type, 'user_question');
  const wake = notified[0]!.wake as Record<string, unknown>;
  assert.equal(wake.body, 'pick one?');
  assert.equal(wake.session_name, 'mysess');
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0]![3], 'user_question');
});

test('permission_prompt: AskUserQuestion with no questions uses default body', () => {
  const hooks = makeHooks();
  const notified: Array<{ wake: unknown }> = [];
  registerPermissionPromptHandler(hooks, {
    sessionManager: { findByClaudeSessionId() { return undefined as never; } },
    resolveExternalSessionId(id: string) { return id; },
    sendPlanForReview() {},
    buildPermissionContext() { return ''; },
    getSessionName() { return 's'; },
    cryptoEngine: { sign() { return 'x'; } },
    messageSeq: makeMessageSeqRef().ref,
    sendNotificationEventToPhone(_e: unknown, _et: string, _sId: string, _rId: string, wake: unknown) {
      notified.push({ wake });
    },
    trackBlockingRequest() {},
  });
  hooks.emit('permission_prompt', {
    sessionId: 'cs',
    toolUseId: 'tu',
    toolName: 'AskUserQuestion',
    toolInput: {},
    cwd: '/p',
  } as HookPermissionPrompt);
  assert.equal((notified[0]!.wake as Record<string, unknown>).body, 'Claude has a question');
});

test('permission_prompt: default branch signs+emits permission_request, increments seq, has_always_allow=true when suggestions present', () => {
  const hooks = makeHooks();
  const notified: Array<{ event: unknown; wake: unknown }> = [];
  const tracked: unknown[][] = [];
  const signedPayloads: string[] = [];
  const seqAccess = makeMessageSeqRef(7);
  registerPermissionPromptHandler(hooks, {
    sessionManager: { findByClaudeSessionId() { return undefined as never; } },
    resolveExternalSessionId(id: string) { return id; },
    sendPlanForReview() {},
    buildPermissionContext(name: string) { return `ctx for ${name}`; },
    getSessionName() { return 'sess'; },
    cryptoEngine: {
      sign(payload: string) { signedPayloads.push(payload); return 'sig123'; },
    },
    messageSeq: seqAccess.ref,
    sendNotificationEventToPhone(event: unknown, _et: string, _sId: string, _rId: string, wake: unknown) {
      notified.push({ event, wake });
    },
    trackBlockingRequest(...args: unknown[]) { tracked.push(args); },
  });
  hooks.emit('permission_prompt', {
    sessionId: 'cs',
    toolUseId: 'tu-1',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    cwd: '/p',
    permissionSuggestions: [{ rule: 'Bash(ls:*)' }],
  } as HookPermissionPrompt);

  assert.equal(notified.length, 1);
  const ev = notified[0]!.event as Record<string, unknown>;
  assert.equal(ev.type, 'permission_request');
  assert.equal(ev.tool_name, 'Bash');
  assert.equal(ev.context, 'ctx for Bash');
  assert.equal(ev.pc_signature, 'sig123');
  assert.equal(ev.seq, 7);
  assert.equal(ev.has_always_allow, true);
  assert.equal(seqAccess.seq(), 8);
  assert.equal(signedPayloads.length, 1);
  const signed = JSON.parse(signedPayloads[0]!);
  assert.equal(signed.seq, 7);
  assert.equal(signed.tool_name, 'Bash');
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0]![3], 'permission_request');
  assert.equal((notified[0]!.wake as Record<string, unknown>).body, 'Bash: ctx for Bash');
});

test('permission_prompt: default branch with no permissionSuggestions sets has_always_allow=false', () => {
  const hooks = makeHooks();
  const notified: unknown[] = [];
  registerPermissionPromptHandler(hooks, {
    sessionManager: { findByClaudeSessionId() { return undefined as never; } },
    resolveExternalSessionId(id: string) { return id; },
    sendPlanForReview() {},
    buildPermissionContext() { return 'ctx'; },
    getSessionName() { return 's'; },
    cryptoEngine: { sign() { return 'sig'; } },
    messageSeq: makeMessageSeqRef().ref,
    sendNotificationEventToPhone(event: unknown) { notified.push(event); },
    trackBlockingRequest() {},
  });
  hooks.emit('permission_prompt', {
    sessionId: 'cs',
    toolUseId: 'tu',
    toolName: 'Write',
    toolInput: {},
    cwd: '/p',
  } as HookPermissionPrompt);
  assert.equal((notified[0] as Record<string, unknown>).has_always_allow, false);
});

test('permission_prompt: default branch with sign() throwing yields empty pc_signature', () => {
  const hooks = makeHooks();
  const notified: unknown[] = [];
  registerPermissionPromptHandler(hooks, {
    sessionManager: { findByClaudeSessionId() { return undefined as never; } },
    resolveExternalSessionId(id: string) { return id; },
    sendPlanForReview() {},
    buildPermissionContext() { return 'ctx'; },
    getSessionName() { return 's'; },
    cryptoEngine: { sign() { throw new Error('broken'); } },
    messageSeq: makeMessageSeqRef().ref,
    sendNotificationEventToPhone(event: unknown) { notified.push(event); },
    trackBlockingRequest() {},
  });
  hooks.emit('permission_prompt', {
    sessionId: 'cs',
    toolUseId: 'tu',
    toolName: 'Bash',
    toolInput: {},
    cwd: '/p',
  } as HookPermissionPrompt);
  assert.equal((notified[0] as Record<string, unknown>).pc_signature, '');
});

test('permission_prompt: matched session resolves to external id', () => {
  const hooks = makeHooks();
  const notified: unknown[] = [];
  registerPermissionPromptHandler(hooks, {
    sessionManager: { findByClaudeSessionId() { return { sessionId: 'int-1' } as never; } },
    resolveExternalSessionId(id: string) { return id === 'int-1' ? 'ext-1' : id; },
    sendPlanForReview() {},
    buildPermissionContext() { return 'c'; },
    getSessionName() { return 's'; },
    cryptoEngine: { sign() { return 'sig'; } },
    messageSeq: makeMessageSeqRef().ref,
    sendNotificationEventToPhone(event: unknown) { notified.push(event); },
    trackBlockingRequest() {},
  });
  hooks.emit('permission_prompt', {
    sessionId: 'cs',
    toolUseId: 'tu',
    toolName: 'Read',
    toolInput: {},
    cwd: '/p',
  } as HookPermissionPrompt);
  assert.equal((notified[0] as Record<string, unknown>).session_id, 'ext-1');
});
