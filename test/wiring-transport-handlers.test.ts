import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import {
  registerCommandMessageHandler,
  registerTransportErrorHandler,
  registerDecryptErrorHandler,
  registerRelayConnectedHandler,
  registerLanConnectedHandler,
  registerDisconnectedHandler,
  registerPhoneOnlineHandler,
  registerKeyVerifyHandler,
  type TransportGateway,
} from '../src/wiring/transport-handlers.js';
import type { PendingBlockingEntry } from '../src/wiring/hook-handlers-codex.js';
import { SessionStatus } from 'agent-pocket-protocol';

interface FakeTransport extends TransportGateway {
  emit(event: string, ...args: unknown[]): boolean;
}

function makeTransport(): FakeTransport {
  return new EventEmitter() as unknown as FakeTransport;
}

// ---------------------------------------------------------------------------
// registerCommandMessageHandler
// ---------------------------------------------------------------------------

test('command_message: peer_hello is dispatched to handlePeerHello, not handleCommand', () => {
  const t = makeTransport();
  const peerCalls: unknown[] = [];
  let handleCalled = false;
  registerCommandMessageHandler(t, {
    source: 'relay',
    handlePeerHello(p: unknown) { peerCalls.push(p); },
    async handleCommand() { handleCalled = true; },
    sendToPhone() {},
  });
  t.emit('message', { type: 'peer_hello', who: 'phone' });
  assert.equal(peerCalls.length, 1);
  assert.equal(handleCalled, false);
});

test('command_message: PhoneCommand is dispatched to handleCommand', async () => {
  const t = makeTransport();
  const handled: unknown[] = [];
  registerCommandMessageHandler(t, {
    source: 'relay',
    handlePeerHello() { throw new Error('nope'); },
    async handleCommand(c: unknown) { handled.push(c); },
    sendToPhone() {},
  });
  t.emit('message', { type: 'list_sessions', request_id: 'r1' });
  await new Promise(r => setImmediate(r));
  assert.equal(handled.length, 1);
});

test('command_message: handleCommand rejection emits error event with COMMAND_ERROR code', async () => {
  const t = makeTransport();
  const sent: unknown[] = [];
  registerCommandMessageHandler(t, {
    source: 'relay',
    handlePeerHello() {},
    async handleCommand() { throw new Error('boom'); },
    sendToPhone(e: unknown) { sent.push(e); },
  });
  t.emit('message', { type: 'list_sessions', request_id: 'r-err' });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 1);
  const e = sent[0] as Record<string, unknown>;
  assert.equal(e.type, 'error');
  assert.equal(e.code, 'COMMAND_ERROR');
  assert.equal(e.request_id, 'r-err');
  assert.equal(e.message, 'Command handler error: boom');
});

test('command_message: lan source still emits the same error event', async () => {
  const t = makeTransport();
  const sent: unknown[] = [];
  registerCommandMessageHandler(t, {
    source: 'lan',
    handlePeerHello() {},
    async handleCommand() { throw new Error('lan-boom'); },
    sendToPhone(e: unknown) { sent.push(e); },
  });
  t.emit('message', { type: 'x', request_id: 'r2' });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal((sent[0] as Record<string, unknown>).message, 'Command handler error: lan-boom');
});

// ---------------------------------------------------------------------------
// registerTransportErrorHandler
// ---------------------------------------------------------------------------

test('transport_error: subscribes to error event without throwing', () => {
  const t = makeTransport();
  registerTransportErrorHandler(t, 'relay');
  registerTransportErrorHandler(t, 'lan');
  t.emit('error', new Error('x'));
  assert.equal(t.listenerCount('error'), 2);
});

// ---------------------------------------------------------------------------
// registerDecryptErrorHandler
// ---------------------------------------------------------------------------

test('decrypt_error: count !== 3 does not call sendE2EError', () => {
  const t = makeTransport();
  let called = 0;
  registerDecryptErrorHandler(t, { source: 'relay', sendE2EError() { called++; } });
  t.emit('decrypt_error', 1);
  t.emit('decrypt_error', 2);
  t.emit('decrypt_error', 4);
  assert.equal(called, 0);
});

test('decrypt_error: count === 3 fires sendE2EError exactly once', () => {
  const t = makeTransport();
  const msgs: string[] = [];
  registerDecryptErrorHandler(t, { source: 'lan', sendE2EError(m: string) { msgs.push(m); } });
  t.emit('decrypt_error', 3);
  assert.deepEqual(msgs, ['Decryption failed. Please re-pair the device.']);
});

// ---------------------------------------------------------------------------
// registerRelayConnectedHandler
// ---------------------------------------------------------------------------

test('relay_connected: sends peer_hello before emitting connected callback', () => {
  const t = makeTransport();
  const order: string[] = [];
  registerRelayConnectedHandler(t, {
    sendPeerHello() { order.push('peer'); },
    emitConnected() { order.push('connected'); },
  });
  t.emit('connected');
  assert.deepEqual(order, ['peer', 'connected']);
});

// ---------------------------------------------------------------------------
// registerLanConnectedHandler
// ---------------------------------------------------------------------------

test('lan_connected: sends peer_hello before emitting connected', () => {
  const t = makeTransport();
  const order: string[] = [];
  registerLanConnectedHandler(t, {
    sendPeerHello() { order.push('peer'); },
    emitConnected() { order.push('connected'); },
  });
  t.emit('connected');
  assert.deepEqual(order, ['peer', 'connected']);
});

// ---------------------------------------------------------------------------
// registerDisconnectedHandler
// ---------------------------------------------------------------------------

test('disconnected: forwards reason to emitDisconnected', () => {
  const t = makeTransport();
  const reasons: string[] = [];
  registerDisconnectedHandler(t, { source: 'relay', emitDisconnected(r: string) { reasons.push(r); } });
  t.emit('disconnected', 'gone');
  assert.deepEqual(reasons, ['gone']);
});

// ---------------------------------------------------------------------------
// registerPhoneOnlineHandler
// ---------------------------------------------------------------------------

interface PhoneOnlineHarness {
  pending: Map<string, PendingBlockingEntry>;
  peerHellos: number;
  controlFrames: Array<Record<string, unknown>>;
  sent: unknown[];
  resends: Array<unknown[]>;
  expiredCalls: Array<unknown[]>;
  cleared: Array<unknown[]>;
}

function makePhoneOnlineDeps(opts: {
  pending?: Array<[string, PendingBlockingEntry]>;
  fingerprint?: string | null;
  hookHas?: (id: string) => boolean;
  sdkSessions?: Array<{ pendingPermissions?: Map<string, unknown> }>;
} = {}) {
  const harness: PhoneOnlineHarness = {
    pending: new Map(opts.pending ?? []),
    peerHellos: 0,
    controlFrames: [],
    sent: [],
    resends: [],
    expiredCalls: [],
    cleared: [],
  };
  return {
    harness,
    deps: {
      hookServer: {
        hasPendingPermission(id: string) { return opts.hookHas ? opts.hookHas(id) : false; },
      },
      sessionManager: {
        getAllSessions() { return (opts.sdkSessions ?? []) as never; },
      },
      sendPeerHello() { harness.peerHellos++; },
      getKeyFingerprint() { return opts.fingerprint ?? null; },
      sendControlFrame(frame: Record<string, unknown>) { harness.controlFrames.push(frame); },
      pendingBlockingRequests: harness.pending,
      resendTrackedBlockingEvent(...args: unknown[]) { harness.resends.push(args); },
      sendToPhone(event: unknown) { harness.sent.push(event); },
      sendExpiredPendingSystemMessage(...args: unknown[]) { harness.expiredCalls.push(args); },
      clearNotificationDelivery(...args: unknown[]) { harness.cleared.push(args); },
    },
  };
}

test('phone_online: with no pending entries, sends no peer_hello + skips key_verify when fingerprint null', () => {
  const t = makeTransport();
  const { harness, deps } = makePhoneOnlineDeps({ fingerprint: null });
  registerPhoneOnlineHandler(t, deps);
  t.emit('phone_online');
  // peer_hello is no longer fired on phone_online — relay caches + replays
  // it on the phone's connect, so re-emitting here would be redundant.
  assert.equal(harness.peerHellos, 0);
  assert.equal(harness.controlFrames.length, 0);
  assert.equal(harness.resends.length, 0);
});

test('phone_online: with fingerprint, sends key_verify control frame', () => {
  const t = makeTransport();
  const { harness, deps } = makePhoneOnlineDeps({ fingerprint: 'fp-123' });
  registerPhoneOnlineHandler(t, deps);
  t.emit('phone_online');
  assert.equal(harness.controlFrames.length, 1);
  assert.deepEqual(harness.controlFrames[0], { action: 'key_verify', key_fingerprint: 'fp-123' });
});

test('phone_online: expiredToTerminal entry resends + sends permission_expired + system message + status', () => {
  const t = makeTransport();
  const entry = {
    sessionId: 'ext-1',
    type: 'permission_request' as const,
    event: { type: 'permission_request', tool_name: 'Bash' },
    sentAt: 100,
    expiredToTerminal: true,
  } as unknown as PendingBlockingEntry;
  const { harness, deps } = makePhoneOnlineDeps({ pending: [['r-x', entry]] });
  registerPhoneOnlineHandler(t, deps);
  t.emit('phone_online');

  assert.equal(harness.resends.length, 1);
  assert.equal(harness.resends[0]![0], 'permission_request');
  // Two phone events: permission_expired + session_status pending_actions
  const types = harness.sent.map(e => (e as Record<string, unknown>).type);
  assert.deepEqual(types, ['permission_expired', 'session_status']);
  const expired = harness.sent[0] as Record<string, unknown>;
  assert.equal(expired.tool_name, 'Bash');
  assert.equal(expired.session_id, 'ext-1');
  const status = harness.sent[1] as Record<string, unknown>;
  assert.equal(status.status, SessionStatus.PENDING_ACTIONS);
  assert.equal(status.action_type, 'permission_request');
  assert.equal(harness.expiredCalls.length, 1);
  assert.equal(harness.cleared.length, 1);
  // Entry stays in the map (not deleted)
  assert.equal(harness.pending.has('r-x'), true);
});

test('phone_online: expiredToTerminal entry without tool_name falls back to entry.toolName then to type', () => {
  const t = makeTransport();
  const entryWithToolName = {
    sessionId: 'ext-1',
    type: 'plan_review' as const,
    event: { type: 'session_status' },
    sentAt: 100,
    expiredToTerminal: true,
    toolName: 'ExitPlanMode',
  } as unknown as PendingBlockingEntry;
  const entryNoName = {
    sessionId: 'ext-2',
    type: 'user_question' as const,
    event: { type: 'session_status' },
    sentAt: 100,
    expiredToTerminal: true,
  } as unknown as PendingBlockingEntry;
  const { harness, deps } = makePhoneOnlineDeps({
    pending: [['r1', entryWithToolName], ['r2', entryNoName]],
  });
  registerPhoneOnlineHandler(t, deps);
  t.emit('phone_online');
  // Each entry produces 2 sent events
  assert.equal(harness.sent.length, 4);
  // r1 → permission_expired with toolName
  assert.equal((harness.sent[0] as Record<string, unknown>).tool_name, 'ExitPlanMode');
  // r2 → permission_expired falls back to type
  assert.equal((harness.sent[2] as Record<string, unknown>).tool_name, 'user_question');
});

test('phone_online: hook-pending entry resends + bumps sentAt, leaves entry in place', () => {
  const t = makeTransport();
  const entry = {
    sessionId: 'ext-1',
    type: 'permission_request' as const,
    event: { type: 'permission_request' },
    sentAt: 100,
  } as unknown as PendingBlockingEntry;
  const { harness, deps } = makePhoneOnlineDeps({
    pending: [['r-h', entry]],
    hookHas: (id) => id === 'r-h',
  });
  registerPhoneOnlineHandler(t, deps);
  const before = Date.now();
  t.emit('phone_online');
  assert.equal(harness.resends.length, 1);
  assert.equal(harness.pending.has('r-h'), true);
  const updated = harness.pending.get('r-h') as unknown as { sentAt: number };
  assert.ok(updated.sentAt >= before);
  // No permission_expired sent
  assert.equal(harness.sent.length, 0);
});

test('phone_online: SDK-pending entry resends + leaves in place', () => {
  const t = makeTransport();
  const entry = {
    sessionId: 'ext-1',
    type: 'permission_request' as const,
    event: { type: 'permission_request' },
    sentAt: 100,
  } as unknown as PendingBlockingEntry;
  const { harness, deps } = makePhoneOnlineDeps({
    pending: [['r-s', entry]],
    sdkSessions: [{ pendingPermissions: new Map([['r-s', {}]]) }],
  });
  registerPhoneOnlineHandler(t, deps);
  t.emit('phone_online');
  assert.equal(harness.resends.length, 1);
  assert.equal(harness.pending.has('r-s'), true);
});

test('phone_online: stale entry (no hook + no sdk match) is dropped + clearNotificationDelivery called', () => {
  const t = makeTransport();
  const entry = {
    sessionId: 'ext-1',
    type: 'permission_request' as const,
    event: { type: 'permission_request' },
    sentAt: 100,
  } as unknown as PendingBlockingEntry;
  const { harness, deps } = makePhoneOnlineDeps({
    pending: [['r-stale', entry]],
    sdkSessions: [{ pendingPermissions: new Map([['unrelated', {}]]) }],
  });
  registerPhoneOnlineHandler(t, deps);
  t.emit('phone_online');
  assert.equal(harness.resends.length, 0);
  assert.equal(harness.pending.has('r-stale'), false);
  assert.equal(harness.cleared.length, 1);
  assert.equal(harness.cleared[0]![0], 'permission_request');
});

test('phone_online: sdk session without pendingPermissions field is treated as no-match', () => {
  const t = makeTransport();
  const entry = {
    sessionId: 'ext-1',
    type: 'permission_request' as const,
    event: { type: 'permission_request' },
    sentAt: 100,
  } as unknown as PendingBlockingEntry;
  const { harness, deps } = makePhoneOnlineDeps({
    pending: [['r-x', entry]],
    sdkSessions: [{}],
  });
  registerPhoneOnlineHandler(t, deps);
  t.emit('phone_online');
  assert.equal(harness.pending.has('r-x'), false);
});

// ---------------------------------------------------------------------------
// registerKeyVerifyHandler
// ---------------------------------------------------------------------------

test('key_verify: no expected fingerprint → no-op', () => {
  const t = makeTransport();
  let called = false;
  registerKeyVerifyHandler(t, {
    getExpectedFingerprint() { return null; },
    sendControlFrame() { called = true; },
  });
  t.emit('key_verify', 'fp-incoming');
  assert.equal(called, false);
});

test('key_verify: matching fingerprint → no control frame sent', () => {
  const t = makeTransport();
  let called = false;
  registerKeyVerifyHandler(t, {
    getExpectedFingerprint() { return 'fp-A'; },
    sendControlFrame() { called = true; },
  });
  t.emit('key_verify', 'fp-A');
  assert.equal(called, false);
});

test('key_verify: mismatching fingerprint → e2e_error control frame sent', () => {
  const t = makeTransport();
  const frames: Array<Record<string, unknown>> = [];
  registerKeyVerifyHandler(t, {
    getExpectedFingerprint() { return 'fp-A'; },
    sendControlFrame(f: Record<string, unknown>) { frames.push(f); },
  });
  t.emit('key_verify', 'fp-B');
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.action, 'e2e_error');
  assert.ok((frames[0]!.message as string).includes('re-pair'));
});
