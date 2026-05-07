import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import {
  registerSessionStartedHandler,
  registerPermissionModeChangedHandler,
  registerSessionOutputHandler,
  registerSessionEndedHandler,
  registerPermissionRequestHandler,
  registerSessionErrorHandler,
  registerSessionStatusHandler,
  registerPendingActionDetectedHandler,
  registerSessionTitleHandler,
  registerSessionInterruptedHandler,
  type SessionManagerGateway,
} from '../src/wiring/session-manager-handlers.js';
import type { PendingBlockingEntry, MessageSeqRef } from '../src/wiring/hook-handlers-codex.js';
import type { ClaudeEvent } from 'agent-pocket-protocol';
import { SessionStatus } from 'agent-pocket-protocol';

interface FakeSm extends SessionManagerGateway {
  emit(event: string, ...args: unknown[]): boolean;
}

function makeSm(): FakeSm {
  return new EventEmitter() as unknown as FakeSm;
}

function makeMessageSeqRef(start = 0): { ref: MessageSeqRef; seq: () => number } {
  let v = start;
  return {
    ref: { peek: () => v, getAndIncrement: () => v++ },
    seq: () => v,
  };
}

// ---------------------------------------------------------------------------
// session_started
// ---------------------------------------------------------------------------

test('session_started: suppressed during initial discovery', () => {
  const sm = makeSm();
  const sent: unknown[] = [];
  registerSessionStartedHandler(sm, {
    sessionManager: { getSession() { throw new Error('nope'); } },
    resolveExternalSessionId(id: string) { return id; },
    findRequestIdForSession() { return undefined; },
    getClaudeAgentVersion() { return undefined; },
    isInitialDiscoveryDone() { return false; },
    sendToPhone(e: unknown) { sent.push(e); },
  });
  sm.emit('session_started', 'int-1', '/proj');
  assert.equal(sent.length, 0);
});

test('session_started: observed session emits without permission_mode/dangerous fields', () => {
  const sm = makeSm();
  const sent: unknown[] = [];
  registerSessionStartedHandler(sm, {
    sessionManager: {
      getSession() { return { isObserved: true } as never; },
    },
    resolveExternalSessionId(id: string) { return id === 'int-1' ? 'ext-1' : id; },
    findRequestIdForSession() { return 'req-1'; },
    getClaudeAgentVersion() { return '1.2.3'; },
    isInitialDiscoveryDone() { return true; },
    sendToPhone(e: unknown) { sent.push(e); },
  });
  sm.emit('session_started', 'int-1', '/proj/foo', 'Foo Title');
  assert.equal(sent.length, 1);
  const e = sent[0] as Record<string, unknown>;
  assert.equal(e.session_id, 'ext-1');
  assert.equal(e.request_id, 'req-1');
  assert.equal(e.project_name, 'Foo Title');
  assert.equal(e.agent_version, '1.2.3');
  assert.equal(e.is_observed, true);
  assert.equal(e.permission_mode, undefined);
  assert.equal(e.dangerously_skip_permissions, undefined);
});

test('session_started: SDK session emits permission_mode + dangerously_skip_permissions, fallback project_name to basename', () => {
  const sm = makeSm();
  const sent: unknown[] = [];
  registerSessionStartedHandler(sm, {
    sessionManager: {
      getSession() {
        return { isObserved: false, permissionMode: 'plan', config: { dangerously_skip_permissions: true } } as never;
      },
    },
    resolveExternalSessionId(id: string) { return id; },
    findRequestIdForSession() { return undefined; },
    getClaudeAgentVersion() { return undefined; },
    isInitialDiscoveryDone() { return true; },
    sendToPhone(e: unknown) { sent.push(e); },
  });
  sm.emit('session_started', 'int-1', '/work/myrepo');
  const e = sent[0] as Record<string, unknown>;
  assert.equal(e.project_name, 'myrepo');
  assert.equal(e.request_id, 'int-1');
  assert.equal(e.is_observed, false);
  assert.equal(e.permission_mode, 'plan');
  assert.equal(e.dangerously_skip_permissions, true);
});

test('session_started: SDK session with default permission mode + missing config', () => {
  const sm = makeSm();
  const sent: unknown[] = [];
  registerSessionStartedHandler(sm, {
    sessionManager: {
      getSession() { return { isObserved: false } as never; },
    },
    resolveExternalSessionId(id: string) { return id; },
    findRequestIdForSession() { return undefined; },
    getClaudeAgentVersion() { return undefined; },
    isInitialDiscoveryDone() { return true; },
    sendToPhone(e: unknown) { sent.push(e); },
  });
  sm.emit('session_started', 'int-1', '/work');
  const e = sent[0] as Record<string, unknown>;
  assert.equal(e.permission_mode, 'default');
  assert.equal(e.dangerously_skip_permissions, false);
});

test('session_started: missing state defaults is_observed=true', () => {
  const sm = makeSm();
  const sent: unknown[] = [];
  registerSessionStartedHandler(sm, {
    sessionManager: { getSession() { return undefined as never; } },
    resolveExternalSessionId(id: string) { return id; },
    findRequestIdForSession() { return undefined; },
    getClaudeAgentVersion() { return undefined; },
    isInitialDiscoveryDone() { return true; },
    sendToPhone(e: unknown) { sent.push(e); },
  });
  sm.emit('session_started', 'int-1', '/work');
  assert.equal((sent[0] as Record<string, unknown>).is_observed, true);
});

// ---------------------------------------------------------------------------
// permission_mode_changed
// ---------------------------------------------------------------------------

test('permission_mode_changed: forwards external session id + mode', () => {
  const sm = makeSm();
  const sent: unknown[] = [];
  registerPermissionModeChangedHandler(sm, {
    resolveExternalSessionId(id: string) { return `ext-${id}`; },
    sendToPhone(e: unknown) { sent.push(e); },
  });
  sm.emit('permission_mode_changed', 'int-1', 'acceptEdits');
  assert.deepEqual(sent[0], {
    type: 'session_permission_mode_changed',
    session_id: 'ext-int-1',
    mode: 'acceptEdits',
  });
});

// ---------------------------------------------------------------------------
// session_output
// ---------------------------------------------------------------------------

test('session_output: showToolUse=false drops tool_result events silently', () => {
  const sm = makeSm();
  const flat: unknown[] = [];
  const sent: unknown[] = [];
  registerSessionOutputHandler(sm, {
    resolveExternalSessionId(id: string) { return id; },
    sendToPhone(e: unknown) { sent.push(e); },
    sendFlattenedSessionOutput(_id: string, e: ClaudeEvent) { flat.push(e); },
    prefs: { showToolUse: false },
  });
  sm.emit('session_output', 'int-1', { type: 'tool_result', tool_use_id: 'x', content: 'ok' } as unknown as ClaudeEvent);
  assert.equal(flat.length, 0);
  assert.equal(sent.length, 0);
});

test('session_output: showToolUse=false on tool_use emits empty assistant_message complete', () => {
  const sm = makeSm();
  const flat: unknown[] = [];
  const sent: unknown[] = [];
  registerSessionOutputHandler(sm, {
    resolveExternalSessionId(id: string) { return `ext-${id}`; },
    sendToPhone(e: unknown) { sent.push(e); },
    sendFlattenedSessionOutput(_id: string, e: ClaudeEvent) { flat.push(e); },
    prefs: { showToolUse: false },
  });
  sm.emit('session_output', 'int-1', { type: 'tool_use', name: 'Bash', input: {}, id: 'tu-1' } as unknown as ClaudeEvent);
  assert.equal(flat.length, 0);
  assert.equal(sent.length, 1);
  const e = sent[0] as Record<string, unknown>;
  assert.equal(e.session_id, 'ext-int-1');
  assert.equal(e.output_type, 'assistant_message');
  assert.equal(e.content, '');
  assert.equal(e.is_complete, true);
});

test('session_output: showToolUse=true forwards tool_use through sendFlattenedSessionOutput', () => {
  const sm = makeSm();
  const flat: unknown[] = [];
  registerSessionOutputHandler(sm, {
    resolveExternalSessionId(id: string) { return `ext-${id}`; },
    sendToPhone() { throw new Error('nope'); },
    sendFlattenedSessionOutput(_id: string, e: ClaudeEvent) { flat.push(e); },
    prefs: { showToolUse: true },
  });
  sm.emit('session_output', 'int-1', { type: 'tool_use', name: 'X', input: {}, id: 'tu' } as unknown as ClaudeEvent);
  assert.equal(flat.length, 1);
});

test('session_output: non-tool events always forwarded', () => {
  const sm = makeSm();
  const flat: Array<{ id: string; e: ClaudeEvent }> = [];
  registerSessionOutputHandler(sm, {
    resolveExternalSessionId(id: string) { return `ext-${id}`; },
    sendToPhone() {},
    sendFlattenedSessionOutput(id: string, e: ClaudeEvent) { flat.push({ id, e }); },
    prefs: { showToolUse: false },
  });
  sm.emit('session_output', 'int-1', { type: 'assistant_message', content: 'hi' } as unknown as ClaudeEvent);
  assert.equal(flat[0]!.id, 'ext-int-1');
});

// ---------------------------------------------------------------------------
// session_ended
// ---------------------------------------------------------------------------

test('session_ended: exit 0 sends plain ended event, deletes mappings, clears notifications', () => {
  const sm = makeSm();
  const sent: unknown[] = [];
  const notified: unknown[] = [];
  const cleared: string[] = [];
  const sessionIdMap = new Map<string, string>([['int-1', 'claude-1']]);
  const pending = new Map<string, PendingBlockingEntry>([
    ['r1', { sessionId: 'ext-1', type: 'permission_request' }],
    ['r2', { sessionId: 'other', type: 'permission_request' }],
  ]);
  registerSessionEndedHandler(sm, {
    resolveExternalSessionId(id: string) { return id === 'int-1' ? 'ext-1' : id; },
    getSessionName() { return 'never used'; },
    sendToPhone(e: unknown) { sent.push(e); },
    sendNotificationEventToPhone(e: unknown) { notified.push(e); },
    sessionIdMap,
    pendingBlockingRequests: pending,
    clearNotificationDeliveriesForSession(id: string) { cleared.push(id); },
  });
  sm.emit('session_ended', 'int-1', 0);
  assert.equal(sent.length, 1);
  assert.equal(notified.length, 0);
  const ev = sent[0] as Record<string, unknown>;
  assert.equal(ev.end_reason, 'completed');
  assert.equal(ev.request_id, undefined);
  assert.equal(sessionIdMap.has('int-1'), false);
  assert.equal(pending.has('r1'), false);
  assert.equal(pending.has('r2'), true);
  assert.deepEqual(cleared, ['ext-1']);
});

test('session_ended: non-zero exit fires notification (no clearNotifications)', () => {
  const sm = makeSm();
  const sent: unknown[] = [];
  const notified: Array<{ event: unknown; et: string; sId: string; rId: string; wake: unknown }> = [];
  let clearCalled = false;
  registerSessionEndedHandler(sm, {
    resolveExternalSessionId(id: string) { return `ext-${id}`; },
    getSessionName() { return 'mysess'; },
    sendToPhone(e: unknown) { sent.push(e); },
    sendNotificationEventToPhone(event: unknown, et: string, sId: string, rId: string, wake: unknown) {
      notified.push({ event, et, sId, rId, wake });
    },
    sessionIdMap: new Map(),
    pendingBlockingRequests: new Map(),
    clearNotificationDeliveriesForSession() { clearCalled = true; },
  });
  sm.emit('session_ended', 'int-1', 137);
  assert.equal(sent.length, 0);
  assert.equal(notified.length, 1);
  assert.equal(notified[0]!.et, 'session_error');
  const ev = notified[0]!.event as Record<string, unknown>;
  assert.equal(ev.end_reason, 'error');
  assert.equal(ev.exit_code, 137);
  assert.ok(typeof ev.request_id === 'string' && (ev.request_id as string).startsWith('session_error_ext-int-1_'));
  const wake = notified[0]!.wake as Record<string, unknown>;
  assert.equal(wake.body, 'Session exited with code 137');
  assert.equal(wake.subtitle, 'mysess');
  assert.equal(clearCalled, false);
});

// ---------------------------------------------------------------------------
// permission_request
// ---------------------------------------------------------------------------

function makePermReqDeps(overrides: {
  isPlanModeTool?: (n: string, i: Record<string, unknown>) => boolean;
  signThrows?: boolean;
} = {}) {
  const sent: unknown[] = [];
  const notified: Array<{ event: unknown; et: string; wake: unknown }> = [];
  const tracked: Array<unknown[]> = [];
  const responded: Array<unknown[]> = [];
  const planCalls: Array<unknown[]> = [];
  const signedPayloads: string[] = [];
  const seq = makeMessageSeqRef(3);
  return {
    sent, notified, tracked, responded, planCalls, signedPayloads, seq,
    deps: {
      sessionManager: {
        getSession() { return { workingDirectory: '/proj' } as never; },
        respondPermission(...args: unknown[]) { responded.push(args); },
      },
      resolveExternalSessionId(id: string) { return `ext-${id}`; },
      isPlanModeTool(name: string, input: Record<string, unknown>) {
        return overrides.isPlanModeTool ? overrides.isPlanModeTool(name, input) : false;
      },
      sendPlanForReview(...args: unknown[]) { planCalls.push(args); },
      buildPermissionContext(name: string) { return `ctx-${name}`; },
      getSessionName() { return 'sess'; },
      cryptoEngine: {
        sign(payload: string) {
          signedPayloads.push(payload);
          if (overrides.signThrows) throw new Error('boom');
          return 'sig';
        },
      },
      messageSeq: seq.ref,
      sendToPhone(e: unknown) { sent.push(e); },
      sendNotificationEventToPhone(event: unknown, et: string, _sId: string, _rId: string, wake: unknown) {
        notified.push({ event, et, wake });
      },
      trackBlockingRequest(...args: unknown[]) { tracked.push(args); },
    },
  };
}

test('permission_request: AskUserQuestion forwards via notification + tracks user_question', () => {
  const sm = makeSm();
  const h = makePermReqDeps();
  registerPermissionRequestHandler(sm, h.deps);
  sm.emit('permission_request', 'int-1', 'req-q', 'AskUserQuestion', { questions: [{ question: 'pick?' }] });
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0]!.et, 'user_question');
  const wake = h.notified[0]!.wake as Record<string, unknown>;
  assert.equal(wake.body, 'pick?');
  assert.equal(h.tracked.length, 1);
  assert.equal(h.tracked[0]![3], 'user_question');
  assert.equal(h.sent.length, 0);
  assert.equal(h.responded.length, 0);
  assert.equal(h.planCalls.length, 0);
});

test('permission_request: AskUserQuestion with missing questions uses default body', () => {
  const sm = makeSm();
  const h = makePermReqDeps();
  registerPermissionRequestHandler(sm, h.deps);
  sm.emit('permission_request', 'int-1', 'req-q', 'AskUserQuestion', {});
  const wake = h.notified[0]!.wake as Record<string, unknown>;
  assert.equal(wake.body, 'Claude has a question');
});

test('permission_request: ExitPlanMode dispatches to sendPlanForReview and bails', () => {
  const sm = makeSm();
  const h = makePermReqDeps({ isPlanModeTool: () => true });
  registerPermissionRequestHandler(sm, h.deps);
  sm.emit('permission_request', 'int-1', 'req-p', 'ExitPlanMode', { plan: 'do x' });
  assert.equal(h.planCalls.length, 1);
  assert.equal(h.planCalls[0]![0], 'ext-int-1');
  assert.equal(h.planCalls[0]![3], '/proj');
  assert.equal(h.responded.length, 0);
  assert.equal(h.sent.length, 0);
});

test('permission_request: plan-mode tool other than ExitPlanMode auto-approves', () => {
  const sm = makeSm();
  const h = makePermReqDeps({ isPlanModeTool: () => true });
  registerPermissionRequestHandler(sm, h.deps);
  sm.emit('permission_request', 'int-1', 'req-w', 'Write', { file_path: '/p/PLAN.md' });
  assert.equal(h.responded.length, 1);
  assert.equal(h.responded[0]![0], 'int-1');
  assert.equal(h.responded[0]![1], 'req-w');
  // PermissionDecision.APPROVE = 'allow' (or similar enum value)
  assert.ok(h.responded[0]![2]);
  assert.equal(h.sent.length, 0);
  assert.equal(h.planCalls.length, 0);
});

test('permission_request: default branch signs with current seq, increments, sends + tracks', () => {
  const sm = makeSm();
  const h = makePermReqDeps();
  registerPermissionRequestHandler(sm, h.deps);
  sm.emit('permission_request', 'int-1', 'req-b', 'Bash', { command: 'ls' });
  assert.equal(h.sent.length, 1);
  const ev = h.sent[0] as Record<string, unknown>;
  assert.equal(ev.type, 'permission_request');
  assert.equal(ev.session_id, 'ext-int-1');
  assert.equal(ev.tool_name, 'Bash');
  assert.equal(ev.context, 'ctx-Bash');
  assert.equal(ev.pc_signature, 'sig');
  assert.equal(ev.seq, 3);
  assert.equal(h.seq.seq(), 4);
  const signed = JSON.parse(h.signedPayloads[0]!);
  assert.equal(signed.seq, 3);
  assert.equal(signed.session_id, 'int-1'); // signing uses the internal id (matches original)
  assert.equal(signed.tool_name, 'Bash');
  assert.equal(h.tracked.length, 1);
  assert.equal(h.tracked[0]![3], 'permission_request');
});

test('permission_request: default branch with sign() throwing yields empty pc_signature', () => {
  const sm = makeSm();
  const h = makePermReqDeps({ signThrows: true });
  registerPermissionRequestHandler(sm, h.deps);
  sm.emit('permission_request', 'int-1', 'req-b', 'Bash', {});
  assert.equal((h.sent[0] as Record<string, unknown>).pc_signature, '');
});

// ---------------------------------------------------------------------------
// error
// ---------------------------------------------------------------------------

test('error: forwards as ErrorEvent with composed message', () => {
  const sm = makeSm();
  const sent: unknown[] = [];
  registerSessionErrorHandler(sm, { sendToPhone(e: unknown) { sent.push(e); } });
  sm.emit('error', 'int-1', new Error('boom'));
  assert.deepEqual(sent[0], {
    type: 'error',
    message: 'Session int-1: boom',
    code: 'SESSION_ERROR',
  });
});

// ---------------------------------------------------------------------------
// session_status
// ---------------------------------------------------------------------------

test('session_status: suppressed during initial discovery', () => {
  const sm = makeSm();
  let touched = false;
  registerSessionStatusHandler(sm, {
    sessionManager: {
      getAllSessions() { touched = true; return [] as never; },
      clearPendingActions() {},
    },
    resolveExternalSessionId(id: string) { return id; },
    isInitialDiscoveryDone() { return false; },
    pendingBlockingRequests: new Map(),
    sendToPhone() {},
  });
  sm.emit('session_status', 'int-1', SessionStatus.RUNNING);
  assert.equal(touched, false);
});

test('session_status: RUNNING removes startup synthetic + clears session-manager pending', () => {
  const sm = makeSm();
  const pending = new Map<string, PendingBlockingEntry>([
    ['startup_pending_ext-1', { sessionId: 'ext-1', type: 'permission_request' }],
  ]);
  const cleared: string[] = [];
  const sent: unknown[] = [];
  registerSessionStatusHandler(sm, {
    sessionManager: {
      getAllSessions() { return [{ sessionId: 'int-1', claudeSessionId: 'claude-1' }] as never; },
      clearPendingActions(id: string) { cleared.push(id); },
    },
    resolveExternalSessionId(id: string) { return id === 'int-1' ? 'ext-1' : id; },
    isInitialDiscoveryDone() { return true; },
    pendingBlockingRequests: pending,
    sendToPhone(e: unknown) { sent.push(e); },
  });
  sm.emit('session_status', 'int-1', SessionStatus.RUNNING);
  assert.equal(pending.size, 0);
  assert.deepEqual(cleared, ['int-1']);
  // forwarded status (no pending after cleanup)
  assert.equal((sent[0] as Record<string, unknown>).status, SessionStatus.RUNNING);
});

test('session_status: synthetic cleanup gracefully handles unknown session in getAllSessions', () => {
  const sm = makeSm();
  const pending = new Map<string, PendingBlockingEntry>([
    ['startup_pending_ext-1', { sessionId: 'ext-1', type: 'permission_request' }],
  ]);
  let cleared = false;
  registerSessionStatusHandler(sm, {
    sessionManager: {
      getAllSessions() { return [] as never; },
      clearPendingActions() { cleared = true; },
    },
    resolveExternalSessionId(id: string) { return id === 'int-1' ? 'ext-1' : id; },
    isInitialDiscoveryDone() { return true; },
    pendingBlockingRequests: pending,
    sendToPhone() {},
  });
  sm.emit('session_status', 'int-1', SessionStatus.READY);
  assert.equal(pending.size, 0);
  assert.equal(cleared, false);
});

test('session_status: with non-synthetic pending entries reports pending_actions + action_type', () => {
  const sm = makeSm();
  const pending = new Map<string, PendingBlockingEntry>([
    ['real-req', { sessionId: 'ext-1', type: 'user_question' }],
  ]);
  const sent: unknown[] = [];
  registerSessionStatusHandler(sm, {
    sessionManager: { getAllSessions() { return [] as never; }, clearPendingActions() {} },
    resolveExternalSessionId(id: string) { return id === 'int-1' ? 'ext-1' : id; },
    isInitialDiscoveryDone() { return true; },
    pendingBlockingRequests: pending,
    sendToPhone(e: unknown) { sent.push(e); },
  });
  sm.emit('session_status', 'int-1', SessionStatus.RUNNING);
  const e = sent[0] as Record<string, unknown>;
  assert.equal(e.status, SessionStatus.PENDING_ACTIONS);
  assert.equal(e.action_type, 'user_question');
});

test('session_status: non-RUNNING/READY status passes through without synthetic cleanup', () => {
  const sm = makeSm();
  const pending = new Map<string, PendingBlockingEntry>([
    ['startup_pending_ext-1', { sessionId: 'ext-1', type: 'permission_request' }],
  ]);
  const sent: unknown[] = [];
  registerSessionStatusHandler(sm, {
    sessionManager: { getAllSessions() { throw new Error('nope'); }, clearPendingActions() {} },
    resolveExternalSessionId(id: string) { return id === 'int-1' ? 'ext-1' : id; },
    isInitialDiscoveryDone() { return true; },
    pendingBlockingRequests: pending,
    sendToPhone(e: unknown) { sent.push(e); },
  });
  sm.emit('session_status', 'int-1', SessionStatus.STARTING);
  // synthetic cleanup branch was skipped (no getAllSessions call), but pending remains
  assert.equal(pending.size, 1);
  // hasPending=true → status reported as pending_actions
  assert.equal((sent[0] as Record<string, unknown>).status, SessionStatus.PENDING_ACTIONS);
});

// ---------------------------------------------------------------------------
// pending_action_detected
// ---------------------------------------------------------------------------

test('pending_action_detected: AskUserQuestion -> user_question entry with synthetic id', () => {
  const sm = makeSm();
  const pending = new Map<string, PendingBlockingEntry>();
  registerPendingActionDetectedHandler(sm, {
    resolveExternalSessionId(id: string) { return `ext-${id}`; },
    pendingBlockingRequests: pending,
  });
  sm.emit('pending_action_detected', 'int-1', 'AskUserQuestion');
  const entry = pending.get('startup_pending_ext-int-1');
  assert.ok(entry);
  assert.equal(entry!.type, 'user_question');
  assert.equal(entry!.sessionId, 'ext-int-1');
});

test('pending_action_detected: ExitPlanMode -> plan_review entry', () => {
  const sm = makeSm();
  const pending = new Map<string, PendingBlockingEntry>();
  registerPendingActionDetectedHandler(sm, {
    resolveExternalSessionId(id: string) { return id; },
    pendingBlockingRequests: pending,
  });
  sm.emit('pending_action_detected', 'int-1', 'ExitPlanMode');
  assert.equal(pending.get('startup_pending_int-1')!.type, 'plan_review');
});

test('pending_action_detected: unknown tool -> permission_request entry', () => {
  const sm = makeSm();
  const pending = new Map<string, PendingBlockingEntry>();
  registerPendingActionDetectedHandler(sm, {
    resolveExternalSessionId(id: string) { return id; },
    pendingBlockingRequests: pending,
  });
  sm.emit('pending_action_detected', 'int-1', 'Bash');
  assert.equal(pending.get('startup_pending_int-1')!.type, 'permission_request');
});

test('pending_action_detected: undefined toolName -> permission_request entry', () => {
  const sm = makeSm();
  const pending = new Map<string, PendingBlockingEntry>();
  registerPendingActionDetectedHandler(sm, {
    resolveExternalSessionId(id: string) { return id; },
    pendingBlockingRequests: pending,
  });
  sm.emit('pending_action_detected', 'int-1');
  assert.equal(pending.get('startup_pending_int-1')!.type, 'permission_request');
});

// ---------------------------------------------------------------------------
// session_title
// ---------------------------------------------------------------------------

test('session_title: forwards external id + title', () => {
  const sm = makeSm();
  const sent: unknown[] = [];
  registerSessionTitleHandler(sm, {
    resolveExternalSessionId(id: string) { return `ext-${id}`; },
    sendToPhone(e: unknown) { sent.push(e); },
  });
  sm.emit('session_title', 'int-1', 'New Title');
  assert.deepEqual(sent[0], {
    type: 'session_title',
    session_id: 'ext-int-1',
    title: 'New Title',
  });
});

// ---------------------------------------------------------------------------
// session_interrupted
// ---------------------------------------------------------------------------

test('session_interrupted (sdk): drops pending, emits dismiss + system_message + ready', () => {
  const sm = makeSm();
  const sent: unknown[] = [];
  const flat: unknown[] = [];
  const cleared: string[] = [];
  const pending = new Map<string, PendingBlockingEntry>([
    ['r1', { sessionId: 'ext-1', type: 'permission_request', event: { tool_name: 'Bash' } } as unknown as PendingBlockingEntry],
    ['r2', { sessionId: 'other', type: 'permission_request' }],
  ]);
  registerSessionInterruptedHandler(sm, {
    sessionManager: {
      getAllSessions() { return [{ sessionId: 'int-1' }] as never; },
      clearPendingActions(id: string) { cleared.push(id); },
    },
    resolveExternalSessionId(id: string) { return id === 'int-1' ? 'ext-1' : id; },
    pendingBlockingRequests: pending,
    sendToPhone(e: unknown) { sent.push(e); },
    sendFlattenedSessionOutput(_id: string, e: ClaudeEvent) { flat.push(e); },
  });
  sm.emit('session_interrupted', 'int-1', 'streaming', 'sdk');

  assert.equal(pending.has('r1'), false);
  assert.equal(pending.has('r2'), true);
  assert.deepEqual(cleared, ['int-1']);
  assert.equal(sent.length, 2); // dismiss + ready status
  const dismiss = sent[0] as Record<string, unknown>;
  assert.equal(dismiss.type, 'permission_dismissed');
  assert.equal(dismiss.tool_name, 'Bash');
  assert.equal(dismiss.cancelled, true);
  const status = sent[1] as Record<string, unknown>;
  assert.equal(status.status, SessionStatus.READY);
  assert.equal(flat.length, 1);
  assert.equal((flat[0] as Record<string, unknown>).type, 'system_message');
});

test('session_interrupted (observer): no synthetic system_message', () => {
  const sm = makeSm();
  const flat: unknown[] = [];
  registerSessionInterruptedHandler(sm, {
    sessionManager: {
      getAllSessions() { return [] as never; },
      clearPendingActions() {},
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingBlockingRequests: new Map(),
    sendToPhone() {},
    sendFlattenedSessionOutput(_id: string, e: ClaudeEvent) { flat.push(e); },
  });
  sm.emit('session_interrupted', 'int-1', 'tool_use', 'observer');
  assert.equal(flat.length, 0);
});

test('session_interrupted: pending entry without event uses empty tool_name', () => {
  const sm = makeSm();
  const sent: unknown[] = [];
  const pending = new Map<string, PendingBlockingEntry>([
    ['r1', { sessionId: 'ext-1', type: 'permission_request' }],
  ]);
  registerSessionInterruptedHandler(sm, {
    sessionManager: { getAllSessions() { return [] as never; }, clearPendingActions() {} },
    resolveExternalSessionId(id: string) { return id === 'int-1' ? 'ext-1' : id; },
    pendingBlockingRequests: pending,
    sendToPhone(e: unknown) { sent.push(e); },
    sendFlattenedSessionOutput() {},
  });
  sm.emit('session_interrupted', 'int-1', 'streaming', 'observer');
  assert.equal((sent[0] as Record<string, unknown>).tool_name, '');
});

test('session_interrupted: when no session matches, skips clearPendingActions', () => {
  const sm = makeSm();
  let cleared = false;
  registerSessionInterruptedHandler(sm, {
    sessionManager: {
      getAllSessions() { return [{ sessionId: 'other' }] as never; },
      clearPendingActions() { cleared = true; },
    },
    resolveExternalSessionId(id: string) { return id; },
    pendingBlockingRequests: new Map(),
    sendToPhone() {},
    sendFlattenedSessionOutput() {},
  });
  sm.emit('session_interrupted', 'int-1', 'streaming', 'observer');
  assert.equal(cleared, false);
});
