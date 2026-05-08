import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import {
  createCompletionRequestIdGenerator,
  sendCodexCompletion,
  attachCodexObserverHandlers,
  type SendCodexCompletionDeps,
  type AttachCodexObserverHandlersDeps,
  type CodexObserverTracked,
} from '../src/wiring/codex-event-bridge.js';
import { SessionStatus, type PcEvent } from 'agent-pocket-protocol';
import type { CodexSession } from '../src/discovery/codex-discovery.js';
import type { CodexObserver } from '../src/observers/codex-observer.js';

// ---------------------------------------------------------------------------
// createCompletionRequestIdGenerator
// ---------------------------------------------------------------------------

test('createCompletionRequestIdGenerator: increments counter per call', () => {
  const gen = createCompletionRequestIdGenerator();
  const a = gen('s1', 1000);
  const b = gen('s1', 1000);
  const c = gen('s2', 2000);
  assert.equal(a, 'completion_s1_1000_1');
  assert.equal(b, 'completion_s1_1000_2');
  assert.equal(c, 'completion_s2_2000_3');
});

test('createCompletionRequestIdGenerator: uses Date.now when no timestamp passed', () => {
  const gen = createCompletionRequestIdGenerator();
  const before = Date.now();
  const id = gen('sid');
  const after = Date.now();
  const ts = Number(id.split('_')[2]);
  assert.ok(ts >= before && ts <= after, `timestamp ${ts} should be within [${before}, ${after}]`);
});

test('createCompletionRequestIdGenerator: independent counters per generator', () => {
  const a = createCompletionRequestIdGenerator();
  const b = createCompletionRequestIdGenerator();
  assert.equal(a('x', 0), 'completion_x_0_1');
  assert.equal(b('x', 0), 'completion_x_0_1');
});

// ---------------------------------------------------------------------------
// sendCodexCompletion
// ---------------------------------------------------------------------------

interface SendCodexFixture {
  deps: SendCodexCompletionDeps;
  notifications: Array<{ event: PcEvent; eventType: string; sessionId: string; requestId: string; wakePayload: unknown }>;
  initialDone: boolean;
  setInitialDone(v: boolean): void;
}

function makeSendCodexFixture(opts: {
  initialDone?: boolean;
  lastAssistantMessage?: string | undefined;
  sessionName?: string;
  fixedRequestId?: string;
} = {}): SendCodexFixture {
  let initialDone = opts.initialDone ?? true;
  const notifications: SendCodexFixture['notifications'] = [];
  const deps: SendCodexCompletionDeps = {
    isInitialDiscoveryDone: () => initialDone,
    getLastAssistantMessage: () => opts.lastAssistantMessage,
    nextCompletionRequestId: () => opts.fixedRequestId ?? 'req-1',
    getSessionName: () => opts.sessionName ?? 'fallback-name',
    sendNotificationEventToPhone: (event, eventType, sessionId, requestId, wakePayload) => {
      notifications.push({ event, eventType, sessionId, requestId, wakePayload });
    },
  };
  return {
    deps,
    notifications,
    get initialDone() { return initialDone; },
    setInitialDone(v) { initialDone = v; },
  };
}

test('sendCodexCompletion: skipped when initial discovery not done', () => {
  const f = makeSendCodexFixture({ initialDone: false });
  sendCodexCompletion(f.deps, 'sid', undefined, 'summary');
  assert.equal(f.notifications.length, 0);
});

test('sendCodexCompletion: uses summary when present (trimmed)', () => {
  const f = makeSendCodexFixture({ lastAssistantMessage: 'fallback' });
  sendCodexCompletion(f.deps, 'sid', undefined, '  hello world  ');
  assert.equal(f.notifications.length, 1);
  const wp = f.notifications[0].wakePayload as { body: string };
  assert.equal(wp.body, 'hello world');
});

test('sendCodexCompletion: falls back to last assistant message when summary blank', () => {
  const f = makeSendCodexFixture({ lastAssistantMessage: 'last msg' });
  sendCodexCompletion(f.deps, 'sid', undefined, '   ');
  const wp = f.notifications[0].wakePayload as { body: string };
  assert.equal(wp.body, 'last msg');
});

test('sendCodexCompletion: falls back to "Codex turn finished" when no summary or last msg', () => {
  const f = makeSendCodexFixture();
  sendCodexCompletion(f.deps, 'sid', undefined);
  const wp = f.notifications[0].wakePayload as { body: string };
  assert.equal(wp.body, 'Codex turn finished');
});

test('sendCodexCompletion: session_name resolution prefers session.title, then path.basename(cwd), then getSessionName', () => {
  // 1. title
  const f1 = makeSendCodexFixture();
  sendCodexCompletion(f1.deps, 'sid', { title: 'My Title', cwd: '/u/x' } as CodexSession, 'x');
  assert.equal((f1.notifications[0].wakePayload as { session_name: string }).session_name, 'My Title');

  // 2. path.basename(cwd)
  const f2 = makeSendCodexFixture();
  sendCodexCompletion(f2.deps, 'sid', { title: undefined, cwd: '/u/myproj' } as CodexSession, 'x');
  assert.equal((f2.notifications[0].wakePayload as { session_name: string }).session_name, 'myproj');

  // 3. getSessionName fallback
  const f3 = makeSendCodexFixture({ sessionName: 'fallback-name' });
  sendCodexCompletion(f3.deps, 'sid', undefined, 'x');
  assert.equal((f3.notifications[0].wakePayload as { session_name: string }).session_name, 'fallback-name');
});

test('sendCodexCompletion: emits session_status event with completion fields', () => {
  const f = makeSendCodexFixture({ fixedRequestId: 'completion-id-42' });
  sendCodexCompletion(f.deps, 'sid', undefined, 'done');
  const ev = f.notifications[0].event as unknown as {
    type: string;
    session_id: string;
    status: string;
    is_completion: boolean;
    completion_request_id: string;
    completion_body: string;
  };
  assert.equal(ev.type, 'session_status');
  assert.equal(ev.session_id, 'sid');
  assert.equal(ev.status, SessionStatus.READY);
  assert.equal(ev.is_completion, true);
  assert.equal(ev.completion_request_id, 'completion-id-42');
  assert.equal(ev.completion_body, 'done');
  assert.equal(f.notifications[0].eventType, 'session_completed');
  assert.equal(f.notifications[0].sessionId, 'sid');
  assert.equal(f.notifications[0].requestId, 'completion-id-42');
  const wp = f.notifications[0].wakePayload as { type: string; sound: string; category: string };
  assert.equal(wp.type, 'session_completed');
  assert.equal(wp.sound, 'completion.caf');
  assert.equal(wp.category, 'SESSION_COMPLETED');
});

test('sendCodexCompletion: truncates body to 256 utf8 bytes in wake payload', () => {
  const f = makeSendCodexFixture();
  const long = 'a'.repeat(500);
  sendCodexCompletion(f.deps, 'sid', undefined, long);
  const wp = f.notifications[0].wakePayload as { body: string };
  assert.ok(wp.body.length <= 256);
});

// ---------------------------------------------------------------------------
// attachCodexObserverHandlers
// ---------------------------------------------------------------------------

interface AttachFixture {
  deps: AttachCodexObserverHandlersDeps;
  observer: EventEmitter;
  tracked: CodexObserverTracked;
  outputs: Array<{ sessionId: string; agentEvent: unknown }>;
  phoneEvents: Array<{ event: PcEvent; wake?: boolean; wakePayload?: unknown }>;
  completions: Array<{ sessionId: string; session: CodexSession; summary?: string }>;
  consumeCalls: string[];
  consumeReturns: boolean;
  initialDone: boolean;
}

function makeAttachFixture(opts: {
  initialDone?: boolean;
  consumeReturns?: boolean;
  now?: number;
} = {}): AttachFixture {
  const observer = new EventEmitter();
  const session: CodexSession = {
    sessionId: 'cod-1',
    rolloutPath: '/r',
    cwd: '/u/projx',
    title: 'My Session',
  } as CodexSession;
  const tracked: CodexObserverTracked = {
    observer: observer as unknown as CodexObserver,
    session,
    status: SessionStatus.READY,
    lastActivity: 0,
  };
  const outputs: AttachFixture['outputs'] = [];
  const phoneEvents: AttachFixture['phoneEvents'] = [];
  const completions: AttachFixture['completions'] = [];
  const consumeCalls: string[] = [];
  const consumeReturns = opts.consumeReturns ?? false;
  const initialDone = opts.initialDone ?? true;
  const deps: AttachCodexObserverHandlersDeps = {
    isInitialDiscoveryDone: () => initialDone,
    codexStopHookDeduper: {
      consume: (sid: string) => { consumeCalls.push(sid); return consumeReturns; },
    },
    sendFlattenedSessionOutput: (sId, agentEvent) => {
      outputs.push({ sessionId: sId, agentEvent });
    },
    sendToPhone: (event, wake, wakePayload) => {
      phoneEvents.push({ event, wake, wakePayload });
    },
    sendCodexCompletion: (sId, sess, summary) => {
      completions.push({ sessionId: sId, session: sess, summary });
    },
    nowFn: opts.now !== undefined ? () => opts.now! : undefined,
  };
  return { deps, observer, tracked, outputs, phoneEvents, completions, consumeCalls, consumeReturns, initialDone };
}

test('attachCodexObserverHandlers: output forwards to sendFlattenedSessionOutput + bumps lastActivity', () => {
  const f = makeAttachFixture({ now: 1234 });
  attachCodexObserverHandlers(f.deps, f.tracked);
  f.observer.emit('output', { type: 'thinking', thinking: 'x' });
  assert.equal(f.outputs.length, 1);
  assert.equal(f.outputs[0].sessionId, 'cod-1');
  assert.equal(f.tracked.lastActivity, 1234);
});

test('attachCodexObserverHandlers: status_change updates tracked.status + emits when initial done', () => {
  const f = makeAttachFixture({ now: 999 });
  attachCodexObserverHandlers(f.deps, f.tracked);
  f.observer.emit('status_change', 'running');
  assert.equal(f.tracked.status, 'running');
  assert.equal(f.tracked.lastActivity, 999);
  assert.equal(f.phoneEvents.length, 1);
  const ev = f.phoneEvents[0].event as unknown as { type: string; status: string };
  assert.equal(ev.type, 'session_status');
  assert.equal(ev.status, 'running');
});

test('attachCodexObserverHandlers: status_change does NOT emit when initial discovery in flight', () => {
  const f = makeAttachFixture({ initialDone: false });
  attachCodexObserverHandlers(f.deps, f.tracked);
  f.observer.emit('status_change', 'running');
  assert.equal(f.tracked.status, 'running');
  assert.equal(f.phoneEvents.length, 0);
});

test('attachCodexObserverHandlers: completed dispatches sendCodexCompletion when not deduped', () => {
  const f = makeAttachFixture({ consumeReturns: false });
  attachCodexObserverHandlers(f.deps, f.tracked);
  f.observer.emit('completed', 'all done');
  assert.equal(f.tracked.status, SessionStatus.READY);
  assert.deepEqual(f.consumeCalls, ['cod-1']);
  assert.equal(f.completions.length, 1);
  assert.equal(f.completions[0].summary, 'all done');
});

test('attachCodexObserverHandlers: completed deduped → does NOT call sendCodexCompletion', () => {
  const f = makeAttachFixture({ consumeReturns: true });
  attachCodexObserverHandlers(f.deps, f.tracked);
  f.observer.emit('completed', 'all done');
  assert.equal(f.tracked.status, SessionStatus.READY);
  assert.deepEqual(f.consumeCalls, ['cod-1']);
  assert.equal(f.completions.length, 0);
});

test('attachCodexObserverHandlers: completed does nothing when initial discovery in flight', () => {
  const f = makeAttachFixture({ initialDone: false });
  attachCodexObserverHandlers(f.deps, f.tracked);
  f.observer.emit('completed', 'x');
  // Status updated; consume not called; completion not sent
  assert.equal(f.tracked.status, SessionStatus.READY);
  assert.equal(f.consumeCalls.length, 0);
  assert.equal(f.completions.length, 0);
});

test('attachCodexObserverHandlers: error emits session_status ERROR with wake payload', () => {
  const f = makeAttachFixture();
  attachCodexObserverHandlers(f.deps, f.tracked);
  f.observer.emit('error', new Error('boom'));
  assert.equal(f.tracked.status, SessionStatus.ERROR);
  assert.equal(f.phoneEvents.length, 1);
  const sent = f.phoneEvents[0];
  const ev = sent.event as unknown as { type: string; status: string };
  assert.equal(ev.type, 'session_status');
  assert.equal(ev.status, SessionStatus.ERROR);
  assert.equal(sent.wake, true);
  const wp = sent.wakePayload as { type: string; body: string; session_name: string; sound: string };
  assert.equal(wp.type, 'session_error');
  assert.equal(wp.body, 'boom');
  assert.equal(wp.session_name, 'My Session');
  assert.equal(wp.sound, 'default');
});

test('attachCodexObserverHandlers: error uses path.basename(cwd) when no title', () => {
  const f = makeAttachFixture();
  // Override session
  f.tracked.session = { ...f.tracked.session, title: undefined } as unknown as CodexSession;
  attachCodexObserverHandlers(f.deps, f.tracked);
  f.observer.emit('error', new Error('boom'));
  const wp = f.phoneEvents[0].wakePayload as { session_name: string };
  assert.equal(wp.session_name, 'projx');
});

test('attachCodexObserverHandlers: error fallback body when err.message is empty', () => {
  const f = makeAttachFixture();
  attachCodexObserverHandlers(f.deps, f.tracked);
  f.observer.emit('error', new Error(''));
  const wp = f.phoneEvents[0].wakePayload as { body: string };
  assert.equal(wp.body, 'Codex turn failed');
});

test('attachCodexObserverHandlers: error skips emit when initial discovery in flight', () => {
  const f = makeAttachFixture({ initialDone: false });
  attachCodexObserverHandlers(f.deps, f.tracked);
  f.observer.emit('error', new Error('boom'));
  assert.equal(f.tracked.status, SessionStatus.ERROR);
  assert.equal(f.phoneEvents.length, 0);
});

test('attachCodexObserverHandlers: nowFn defaults to Date.now', () => {
  const f = makeAttachFixture(); // no `now` override
  attachCodexObserverHandlers(f.deps, f.tracked);
  const before = Date.now();
  f.observer.emit('output', { type: 'thinking', thinking: 'x' });
  const after = Date.now();
  assert.ok(f.tracked.lastActivity >= before && f.tracked.lastActivity <= after);
});
