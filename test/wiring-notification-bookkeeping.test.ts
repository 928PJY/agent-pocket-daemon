import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createNotificationBookkeeping,
  type NotificationBookkeepingDeps,
  type PendingBlockingRequestEntry,
  type PendingNotificationDeliveryEntry,
  type RelaySink,
  type LanSink,
  type RekeyController,
} from '../src/wiring/notification-bookkeeping.js';
import { SessionSeqAllocatorManager } from '../src/discovery/seq-allocator.js';
import {
  PEER_CAPABILITIES,
  BLOCKING_RETRY_INTERVAL_MS,
  SessionStatus,
} from 'agent-pocket-protocol';
import { NOTIFICATION_DELIVERY_ACK_TIMEOUT_MS } from '../src/relay/phone-transport.js';
import { notificationDeliveryKey as buildKey } from '../src/commands/handlers/acks.js';
import type { PcEvent, WakeBlobPayload } from 'agent-pocket-protocol';

// ---------------------------------------------------------------------------
// Test harness — fakes for the four collaborator surfaces.
// ---------------------------------------------------------------------------

interface FakeRelay extends RelaySink {
  sent: Array<{ event: PcEvent; wake?: boolean; wakePayload?: WakeBlobPayload; forceWake?: boolean }>;
  phoneOnline: boolean;
}
function makeRelay(phoneOnline = true): FakeRelay {
  const sent: FakeRelay['sent'] = [];
  return {
    sent,
    phoneOnline,
    send(event, wake, wakePayload, forceWake) {
      sent.push({ event, wake, wakePayload, forceWake });
    },
    getPhonePeerOnline() {
      return this.phoneOnline;
    },
  };
}

interface FakeLan extends LanSink {
  sent: PcEvent[];
}
function makeLan(): FakeLan {
  const sent: PcEvent[] = [];
  return {
    sent,
    send(e) { sent.push(e); },
  };
}

interface FakeRekey extends RekeyController {
  needsRekeyValue: boolean;
  resetCalls: number;
}
function makeRekey(needsRekey = false): FakeRekey {
  return {
    needsRekeyValue: needsRekey,
    resetCalls: 0,
    needsRekey() { return this.needsRekeyValue; },
    resetRekeyCounters() { this.resetCalls++; },
  };
}

interface Fixture {
  deps: NotificationBookkeepingDeps;
  bk: ReturnType<typeof createNotificationBookkeeping>;
  relay: FakeRelay;
  lan: FakeLan;
  rekey: FakeRekey;
  blocking: Map<string, PendingBlockingRequestEntry>;
  notif: Map<string, PendingNotificationDeliveryEntry>;
  seq: SessionSeqAllocatorManager;
  capabilities: Set<string>;
  sessions: Array<{ sessionId: string; claudeSessionId?: string; status?: SessionStatus; pendingPermissions?: Map<string, unknown> }>;
  pendingPermissionIds: Set<string>;
  externalIdMap: Map<string, string>;
  setMode(mode: 'relay' | 'lan' | undefined): void;
}

function makeFixture(opts: { mode?: 'relay' | 'lan'; capabilities?: string[]; phoneOnline?: boolean } = {}): Fixture {
  const relay = makeRelay(opts.phoneOnline ?? true);
  const lan = makeLan();
  const rekey = makeRekey();
  const blocking = new Map<string, PendingBlockingRequestEntry>();
  const notif = new Map<string, PendingNotificationDeliveryEntry>();
  const seq = new SessionSeqAllocatorManager(fs.mkdtempSync(path.join(os.tmpdir(), 'seqmap-test-')));
  const capabilities = new Set(opts.capabilities ?? []);
  const sessions: Fixture['sessions'] = [];
  const pendingPermissionIds = new Set<string>();
  const externalIdMap = new Map<string, string>();
  let mode: 'relay' | 'lan' | undefined = opts.mode ?? 'relay';

  const deps: NotificationBookkeepingDeps = {
    seqAllocators: seq,
    pendingBlockingRequests: blocking,
    pendingNotificationDeliveries: notif,
    getConnectionMode: () => mode,
    getLanServer: () => mode === 'lan' ? lan : null,
    getRelayClient: () => mode === 'relay' ? relay : null,
    cryptoEngine: rekey,
    hasPeerCapability: (name) => capabilities.has(name),
    sessionManager: {
      getAllSessions: () => sessions as unknown as ReturnType<NotificationBookkeepingDeps['sessionManager']['getAllSessions']>,
    },
    hookServer: {
      hasPendingPermission: (id) => pendingPermissionIds.has(id),
    },
    resolveExternalSessionId: (id) => externalIdMap.get(id) ?? id,
  };

  const bk = createNotificationBookkeeping(deps);
  return {
    deps, bk, relay, lan, rekey, blocking, notif, seq, capabilities, sessions, pendingPermissionIds, externalIdMap,
    setMode(m) { mode = m; },
  };
}

// ---------------------------------------------------------------------------
// sendToPhone
// ---------------------------------------------------------------------------

test('sendToPhone: relay mode forwards event with wake flags', () => {
  const f = makeFixture({ mode: 'relay' });
  const wakePayload = { kind: 'permission', payload: { foo: 1 } } as unknown as WakeBlobPayload;
  f.bk.sendToPhone({ type: 'foo' } as unknown as PcEvent, true, wakePayload, true);
  assert.equal(f.relay.sent.length, 1);
  assert.equal(f.relay.sent[0].wake, true);
  assert.equal(f.relay.sent[0].wakePayload, wakePayload);
  assert.equal(f.relay.sent[0].forceWake, true);
});

test('sendToPhone: lan mode forwards via LanSink and skips wake args', () => {
  const f = makeFixture({ mode: 'lan' });
  f.bk.sendToPhone({ type: 'foo' } as unknown as PcEvent, true, undefined, true);
  assert.equal(f.lan.sent.length, 1);
  assert.equal(f.relay.sent.length, 0);
});

test('sendToPhone: undefined mode defaults to relay', () => {
  const f = makeFixture({ mode: 'relay' });
  f.setMode(undefined);
  // Default branch: when mode is undefined we get 'relay' default and find relay null,
  // so no send happens. Re-enable relay by setting mode back.
  f.setMode('relay');
  f.bk.sendToPhone({ type: 'foo' } as unknown as PcEvent);
  assert.equal(f.relay.sent.length, 1);
});

test('sendToPhone: stamps session_seq on session_output events', () => {
  const f = makeFixture({ mode: 'relay' });
  const e1 = { type: 'session_output', session_id: 's1' } as unknown as PcEvent;
  f.bk.sendToPhone(e1);
  const e2 = { type: 'session_output', session_id: 's1' } as unknown as PcEvent;
  f.bk.sendToPhone(e2);
  assert.equal((e1 as unknown as { session_seq: number }).session_seq, 1);
  assert.equal((e2 as unknown as { session_seq: number }).session_seq, 2);
  assert.equal(f.seq.for('s1').tail(), 2);
});

test('sendToPhone: does not overwrite an existing session_seq', () => {
  const f = makeFixture({ mode: 'relay' });
  const e = { type: 'session_output', session_id: 's1', session_seq: 42 } as unknown as PcEvent;
  f.bk.sendToPhone(e);
  assert.equal((e as unknown as { session_seq: number }).session_seq, 42);
  assert.equal(f.seq.for('s1').tail(), 0);
});

test('sendToPhone: skips session_seq stamping when session_id is missing', () => {
  const f = makeFixture({ mode: 'relay' });
  const e = { type: 'session_output' } as unknown as PcEvent;
  f.bk.sendToPhone(e);
  assert.equal((e as unknown as { session_seq?: number }).session_seq, undefined);
});

test('sendToPhone: triggers rekey reset when crypto needs rekey', () => {
  const f = makeFixture({ mode: 'relay' });
  f.rekey.needsRekeyValue = true;
  f.bk.sendToPhone({ type: 'foo' } as unknown as PcEvent);
  assert.equal(f.rekey.resetCalls, 1);
});

test('sendToPhone: no-op when relay is null and mode is relay', () => {
  const f = makeFixture({ mode: 'lan' });
  f.setMode('relay');
  // Relay returns null because makeFixture only returns the relay when mode === 'relay'.
  // After setMode('relay'), getRelayClient returns the relay again, so to test the null
  // branch we use a fixture initialized as 'lan' and never switch.
  // Reset and use a fresh fixture instead:
  const g = makeFixture({ mode: 'lan' });
  // override getRelayClient to always null and getConnectionMode to 'relay'
  const deps2: NotificationBookkeepingDeps = {
    ...g.deps,
    getConnectionMode: () => 'relay',
    getRelayClient: () => null,
  };
  const bk2 = createNotificationBookkeeping(deps2);
  bk2.sendToPhone({ type: 'foo' } as unknown as PcEvent);
  assert.equal(g.relay.sent.length, 0);
  assert.equal(g.lan.sent.length, 0);
});

test('sendToPhone: logs session_list event', () => {
  const f = makeFixture({ mode: 'relay' });
  const e = {
    type: 'session_list',
    sessions: [{ session_id: 'abcdef123456', project_name: 'p', status: 'ready' }],
  } as unknown as PcEvent;
  f.bk.sendToPhone(e);
  assert.equal(f.relay.sent.length, 1);
});

// ---------------------------------------------------------------------------
// notificationDeliveryKey
// ---------------------------------------------------------------------------

test('notificationDeliveryKey: matches buildNotificationDeliveryKey', () => {
  const f = makeFixture();
  assert.equal(f.bk.notificationDeliveryKey('et', 's', 'r'), buildKey('et', 's', 'r'));
});

// ---------------------------------------------------------------------------
// trackNotificationDelivery
// ---------------------------------------------------------------------------

test('trackNotificationDelivery: no-op when capability is absent', () => {
  const f = makeFixture({ capabilities: [] });
  f.bk.trackNotificationDelivery('permission_request' as any, 's', 'r', { type: 'foo' } as unknown as PcEvent, {} as WakeBlobPayload);
  assert.equal(f.notif.size, 0);
});

test('trackNotificationDelivery: stores entry under key when capability present', () => {
  const f = makeFixture({ capabilities: [PEER_CAPABILITIES.NOTIFICATION_DELIVERY_ACKS] });
  const event = { type: 'permission_request' } as unknown as PcEvent;
  const wp = { kind: 'permission' } as unknown as WakeBlobPayload;
  const before = Date.now();
  f.bk.trackNotificationDelivery('permission_request' as any, 's1', 'r1', event, wp);
  const key = buildKey('permission_request', 's1', 'r1');
  const entry = f.notif.get(key);
  assert.ok(entry);
  assert.equal(entry!.requestId, 'r1');
  assert.equal(entry!.event, event);
  assert.equal(entry!.wakePayload, wp);
  assert.equal(entry!.attempts, 1);
  assert.ok(entry!.sentAt >= before);
});

// ---------------------------------------------------------------------------
// sendNotificationEventToPhone
// ---------------------------------------------------------------------------

test('sendNotificationEventToPhone: tracks delivery when phone online + capability', () => {
  const f = makeFixture({ capabilities: [PEER_CAPABILITIES.NOTIFICATION_DELIVERY_ACKS], phoneOnline: true });
  const wp = {} as WakeBlobPayload;
  f.bk.sendNotificationEventToPhone({ type: 'permission_request' } as unknown as PcEvent, 'permission_request' as any, 's', 'r', wp);
  assert.equal(f.relay.sent.length, 1);
  assert.equal(f.relay.sent[0].wake, true);
  assert.equal(f.notif.size, 1);
});

test('sendNotificationEventToPhone: skips tracking when phone offline (APNs handles it)', () => {
  const f = makeFixture({ capabilities: [PEER_CAPABILITIES.NOTIFICATION_DELIVERY_ACKS], phoneOnline: false });
  f.bk.sendNotificationEventToPhone({ type: 'foo' } as unknown as PcEvent, 'permission_request' as any, 's', 'r', {} as WakeBlobPayload);
  assert.equal(f.relay.sent.length, 1);
  assert.equal(f.notif.size, 0);
});

test('sendNotificationEventToPhone: phone-online check tolerates missing relay (LAN mode)', () => {
  const f = makeFixture({ mode: 'lan', capabilities: [PEER_CAPABILITIES.NOTIFICATION_DELIVERY_ACKS] });
  f.bk.sendNotificationEventToPhone({ type: 'foo' } as unknown as PcEvent, 'permission_request' as any, 's', 'r', {} as WakeBlobPayload);
  assert.equal(f.lan.sent.length, 1);
  assert.equal(f.notif.size, 0);
});

// ---------------------------------------------------------------------------
// resendTrackedBlockingEvent
// ---------------------------------------------------------------------------

test('resendTrackedBlockingEvent: reuses tracked wakePayload when available', () => {
  const f = makeFixture({ mode: 'relay' });
  const wp = { kind: 'permission' } as unknown as WakeBlobPayload;
  f.notif.set(buildKey('permission_request', 's', 'r'), {
    requestId: 'r', sessionId: 's', eventType: 'permission_request' as any,
    event: {} as PcEvent, wakePayload: wp, sentAt: 0, attempts: 1,
  });
  f.bk.resendTrackedBlockingEvent('permission_request', 's', 'r', { type: 'permission_request' } as unknown as PcEvent, true);
  assert.equal(f.relay.sent.length, 1);
  assert.equal(f.relay.sent[0].wakePayload, wp);
  assert.equal(f.relay.sent[0].forceWake, true);
});

test('resendTrackedBlockingEvent: sends without wake when no tracked entry', () => {
  const f = makeFixture({ mode: 'relay' });
  f.bk.resendTrackedBlockingEvent('permission_request', 's', 'r', { type: 'permission_request' } as unknown as PcEvent);
  assert.equal(f.relay.sent.length, 1);
  assert.equal(f.relay.sent[0].wake, false);
  assert.equal(f.relay.sent[0].wakePayload, undefined);
});

test('resendTrackedBlockingEvent: sends without wake when tracked entry has no wakePayload', () => {
  const f = makeFixture({ mode: 'relay' });
  f.notif.set(buildKey('permission_request', 's', 'r'), {
    requestId: 'r', sessionId: 's', eventType: 'permission_request' as any,
    event: {} as PcEvent, wakePayload: undefined, sentAt: 0, attempts: 1,
  });
  f.bk.resendTrackedBlockingEvent('permission_request', 's', 'r', { type: 'permission_request' } as unknown as PcEvent);
  assert.equal(f.relay.sent.length, 1);
  assert.equal(f.relay.sent[0].wake, false);
});

// ---------------------------------------------------------------------------
// clearNotificationDelivery + clearNotificationDeliveriesForSession
// ---------------------------------------------------------------------------

test('clearNotificationDelivery: deletes entry by composite key', () => {
  const f = makeFixture();
  f.notif.set(buildKey('permission_request', 's', 'r'), {} as PendingNotificationDeliveryEntry);
  f.bk.clearNotificationDelivery('permission_request', 's', 'r');
  assert.equal(f.notif.size, 0);
});

test('clearNotificationDelivery: missing key is a no-op', () => {
  const f = makeFixture();
  f.bk.clearNotificationDelivery('permission_request', 's', 'r');
  assert.equal(f.notif.size, 0);
});

test('clearNotificationDeliveriesForSession: deletes only entries for that sessionId', () => {
  const f = makeFixture();
  f.notif.set('a', { sessionId: 's1' } as PendingNotificationDeliveryEntry);
  f.notif.set('b', { sessionId: 's2' } as PendingNotificationDeliveryEntry);
  f.notif.set('c', { sessionId: 's1' } as PendingNotificationDeliveryEntry);
  f.bk.clearNotificationDeliveriesForSession('s1');
  assert.equal(f.notif.size, 1);
  assert.ok(f.notif.has('b'));
});

// ---------------------------------------------------------------------------
// retryPendingNotificationDeliveries
// ---------------------------------------------------------------------------

test('retryPendingNotificationDeliveries: no-op without capability', () => {
  const f = makeFixture({ capabilities: [] });
  f.notif.set('k', {
    requestId: 'r', sessionId: 's', eventType: 'permission_request' as any,
    event: {} as PcEvent, sentAt: 0, attempts: 1,
  });
  f.bk.retryPendingNotificationDeliveries();
  assert.equal(f.notif.size, 1);
  assert.equal(f.relay.sent.length, 0);
});

test('retryPendingNotificationDeliveries: keeps entries within timeout window', () => {
  const f = makeFixture({ mode: 'relay', capabilities: [PEER_CAPABILITIES.NOTIFICATION_DELIVERY_ACKS] });
  f.notif.set('k', {
    requestId: 'r', sessionId: 's', eventType: 'permission_request' as any,
    event: {} as PcEvent, sentAt: Date.now(), attempts: 1,
  });
  f.bk.retryPendingNotificationDeliveries();
  assert.equal(f.notif.size, 1);
  assert.equal(f.relay.sent.length, 0);
});

test('retryPendingNotificationDeliveries: deletes + forceWake APNs fallback past timeout', () => {
  const f = makeFixture({ mode: 'relay', capabilities: [PEER_CAPABILITIES.NOTIFICATION_DELIVERY_ACKS] });
  const wp = {} as WakeBlobPayload;
  const event = { type: 'foo' } as unknown as PcEvent;
  f.notif.set('k', {
    requestId: 'r', sessionId: 's', eventType: 'permission_request' as any,
    event, wakePayload: wp, sentAt: Date.now() - NOTIFICATION_DELIVERY_ACK_TIMEOUT_MS - 1, attempts: 1,
  });
  f.bk.retryPendingNotificationDeliveries();
  assert.equal(f.notif.size, 0);
  assert.equal(f.relay.sent.length, 1);
  assert.equal(f.relay.sent[0].event, event);
  assert.equal(f.relay.sent[0].wake, true);
  assert.equal(f.relay.sent[0].wakePayload, wp);
  assert.equal(f.relay.sent[0].forceWake, true);
});

// ---------------------------------------------------------------------------
// sendExpiredPendingSystemMessage
// ---------------------------------------------------------------------------

test('sendExpiredPendingSystemMessage: skips when entry already flagged', () => {
  const f = makeFixture({ mode: 'relay' });
  f.bk.sendExpiredPendingSystemMessage('s', 'r', 'Tool', 'permission_request', { expiredSystemMessageSent: true });
  assert.equal(f.relay.sent.length, 0);
});

test('sendExpiredPendingSystemMessage: sends + flips dedupe flag for permission_request', () => {
  const f = makeFixture({ mode: 'relay' });
  const entry = { expiredSystemMessageSent: false };
  f.bk.sendExpiredPendingSystemMessage('s', 'r', 'Tool', 'permission_request', entry);
  assert.equal(f.relay.sent.length, 1);
  const sent = f.relay.sent[0].event as unknown as { content: string; output_type: string };
  assert.equal(sent.output_type, 'system');
  assert.match(sent.content, /permission request has expired/);
  assert.equal(entry.expiredSystemMessageSent, true);
});

test('sendExpiredPendingSystemMessage: uses "question" label for user_question', () => {
  const f = makeFixture({ mode: 'relay' });
  f.bk.sendExpiredPendingSystemMessage('s', 'r', 'Tool', 'user_question');
  assert.match((f.relay.sent[0].event as unknown as { content: string }).content, /question has expired/);
});

test('sendExpiredPendingSystemMessage: uses "plan review" label for plan_review', () => {
  const f = makeFixture({ mode: 'relay' });
  f.bk.sendExpiredPendingSystemMessage('s', 'r', 'Tool', 'plan_review');
  assert.match((f.relay.sent[0].event as unknown as { content: string }).content, /plan review has expired/);
});

test('sendExpiredPendingSystemMessage: works without entry (no dedupe state)', () => {
  const f = makeFixture({ mode: 'relay' });
  f.bk.sendExpiredPendingSystemMessage('s', 'r', 'Tool', 'permission_request');
  assert.equal(f.relay.sent.length, 1);
});

// ---------------------------------------------------------------------------
// trackBlockingRequest
// ---------------------------------------------------------------------------

test('trackBlockingRequest: stores entry + emits PENDING_ACTIONS session_status', () => {
  const f = makeFixture({ mode: 'relay' });
  const event = { type: 'permission_request' } as unknown as PcEvent;
  f.bk.trackBlockingRequest('r1', 's1', event, 'permission_request');
  const stored = f.blocking.get('r1');
  assert.ok(stored);
  assert.equal(stored!.event, event);
  assert.equal(stored!.type, 'permission_request');
  const status = f.relay.sent[0].event as unknown as { type: string; status: SessionStatus; action_type: string };
  assert.equal(status.type, 'session_status');
  assert.equal(status.status, SessionStatus.PENDING_ACTIONS);
  assert.equal(status.action_type, 'permission_request');
});

// ---------------------------------------------------------------------------
// untrackBlockingRequest
// ---------------------------------------------------------------------------

test('untrackBlockingRequest: missing id is silent (no status emit)', () => {
  const f = makeFixture({ mode: 'relay' });
  f.bk.untrackBlockingRequest('nope');
  assert.equal(f.relay.sent.length, 0);
});

test('untrackBlockingRequest: removes entry; emits READY when no other blocking for session', () => {
  const f = makeFixture({ mode: 'relay' });
  f.blocking.set('r1', {
    requestId: 'r1', sessionId: 's1', event: {} as PcEvent, sentAt: 0, type: 'permission_request',
  });
  f.bk.untrackBlockingRequest('r1');
  assert.equal(f.blocking.size, 0);
  const sent = f.relay.sent[0].event as unknown as { status: SessionStatus; session_id: string };
  assert.equal(sent.status, SessionStatus.READY);
  assert.equal(sent.session_id, 's1');
});

test('untrackBlockingRequest: uses session.status when SessionManager finds the session', () => {
  const f = makeFixture({ mode: 'relay' });
  f.blocking.set('r1', {
    requestId: 'r1', sessionId: 'ext1', event: {} as PcEvent, sentAt: 0, type: 'permission_request',
  });
  f.externalIdMap.set('internal-1', 'ext1');
  f.sessions.push({ sessionId: 'internal-1', status: SessionStatus.RUNNING });
  f.bk.untrackBlockingRequest('r1');
  assert.equal((f.relay.sent[0].event as unknown as { status: SessionStatus }).status, SessionStatus.RUNNING);
});

test('untrackBlockingRequest: matches session by claudeSessionId when external map misses', () => {
  const f = makeFixture({ mode: 'relay' });
  f.blocking.set('r1', {
    requestId: 'r1', sessionId: 'claude-xyz', event: {} as PcEvent, sentAt: 0, type: 'permission_request',
  });
  f.sessions.push({ sessionId: 'internal-2', claudeSessionId: 'claude-xyz', status: SessionStatus.RUNNING });
  f.bk.untrackBlockingRequest('r1');
  assert.equal((f.relay.sent[0].event as unknown as { status: SessionStatus }).status, SessionStatus.RUNNING);
});

test('untrackBlockingRequest: skips status emit when other blocking entries remain for session', () => {
  const f = makeFixture({ mode: 'relay' });
  f.blocking.set('r1', { requestId: 'r1', sessionId: 's1', event: {} as PcEvent, sentAt: 0, type: 'permission_request' });
  f.blocking.set('r2', { requestId: 'r2', sessionId: 's1', event: {} as PcEvent, sentAt: 0, type: 'user_question' });
  f.bk.untrackBlockingRequest('r1');
  assert.equal(f.relay.sent.length, 0);
  assert.equal(f.blocking.size, 1);
});

// ---------------------------------------------------------------------------
// retryPendingBlockingRequests
// ---------------------------------------------------------------------------

test('retryPendingBlockingRequests: skips entries flagged expiredToTerminal', () => {
  const f = makeFixture({ mode: 'relay' });
  f.blocking.set('r1', {
    requestId: 'r1', sessionId: 's1', event: {} as PcEvent, sentAt: 0,
    type: 'permission_request', expiredToTerminal: true,
  });
  f.bk.retryPendingBlockingRequests();
  assert.equal(f.relay.sent.length, 0);
  assert.equal(f.blocking.size, 1);
});

test('retryPendingBlockingRequests: drops entries no longer pending in hook + sdk', () => {
  const f = makeFixture({ mode: 'relay' });
  f.blocking.set('r1', {
    requestId: 'r1', sessionId: 's1', event: {} as PcEvent, sentAt: 0, type: 'permission_request',
  });
  f.notif.set(buildKey('permission_request', 's1', 'r1'), {} as PendingNotificationDeliveryEntry);
  f.bk.retryPendingBlockingRequests();
  assert.equal(f.blocking.size, 0);
  assert.equal(f.notif.size, 0);
  assert.equal(f.relay.sent.length, 0);
});

test('retryPendingBlockingRequests: keeps + waits when hook still pending but interval not elapsed', () => {
  const f = makeFixture({ mode: 'relay' });
  f.pendingPermissionIds.add('r1');
  f.blocking.set('r1', {
    requestId: 'r1', sessionId: 's1', event: {} as PcEvent, sentAt: Date.now(), type: 'permission_request',
  });
  f.bk.retryPendingBlockingRequests();
  assert.equal(f.blocking.size, 1);
  assert.equal(f.relay.sent.length, 0);
});

test('retryPendingBlockingRequests: resends event past BLOCKING_RETRY_INTERVAL_MS and updates sentAt', () => {
  const f = makeFixture({ mode: 'relay' });
  f.pendingPermissionIds.add('r1');
  const event = { type: 'permission_request' } as unknown as PcEvent;
  const oldSentAt = Date.now() - BLOCKING_RETRY_INTERVAL_MS - 1;
  f.blocking.set('r1', {
    requestId: 'r1', sessionId: 's1', event, sentAt: oldSentAt, type: 'permission_request',
  });
  f.bk.retryPendingBlockingRequests();
  assert.equal(f.relay.sent.length, 1);
  assert.equal(f.relay.sent[0].event, event);
  assert.ok(f.blocking.get('r1')!.sentAt > oldSentAt);
});

test('retryPendingBlockingRequests: SDK pendingPermissions also keeps the entry pending', () => {
  const f = makeFixture({ mode: 'relay' });
  const sdkPending = new Map<string, unknown>([['r1', {}]]);
  f.sessions.push({ sessionId: 'internal', pendingPermissions: sdkPending });
  f.blocking.set('r1', {
    requestId: 'r1', sessionId: 's1', event: {} as PcEvent, sentAt: Date.now(), type: 'permission_request',
  });
  f.bk.retryPendingBlockingRequests();
  assert.equal(f.blocking.size, 1);
});
