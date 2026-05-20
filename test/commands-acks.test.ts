import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PcEvent } from 'agent-pocket-protocol';
import type { CommandContext } from '../src/commands/command-context.js';
import {
  handleEmergencyAbort,
  handleSessionOutputAck,
  handleNotificationDeliveryAck,
  handleVerifyHistory,
  notificationDeliveryKey,
  type CryptoVerifier,
  type VerifyHistoryDeps,
} from '../src/commands/handlers/acks.js';
import type { HistoryPage, HistoryMessage } from '../src/discovery/session-discovery.js';

interface SentEvent { event: PcEvent; }
interface SentError { requestId?: string; message: string; code: string; }

interface FakeSessionManager {
  emergencyAbort?: () => void;
}

function makeCtx(overrides: { sessionManager?: FakeSessionManager } = {}) {
  const sentEvents: SentEvent[] = [];
  const sentErrors: SentError[] = [];
  const ctx: CommandContext = {
    sendToPhone: (event) => { sentEvents.push({ event }); },
    sendError: (requestId, message, code) => { sentErrors.push({ requestId, message, code }); },
    resolveInternalSessionId: (id) => id,
    resolveExternalSessionId: (id) => id,
    sendSessionHistory: () => undefined,
    sessionManager: (overrides.sessionManager ?? {}) as unknown as CommandContext['sessionManager'],
    sessionIdMap: new Map(),
    pendingSessionRequests: new Map(),
  };
  return { ctx, sentEvents, sentErrors };
}

function makeCrypto(overrides: Partial<CryptoVerifier> = {}): CryptoVerifier {
  return {
    hasSessionKeys: () => true,
    verifyPeer: () => true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleEmergencyAbort
// ---------------------------------------------------------------------------

test('handleEmergencyAbort aborts and emits EMERGENCY_ABORT_COMPLETE on a valid signature', () => {
  let aborted = false;
  const { ctx, sentEvents, sentErrors } = makeCtx({
    sessionManager: { emergencyAbort: () => { aborted = true; } },
  });
  handleEmergencyAbort(ctx, makeCrypto(), {
    type: 'emergency_abort',
    phone_signature: 'sig',
  } as never);

  assert.equal(aborted, true);
  assert.equal(sentErrors.length, 0);
  assert.equal(sentEvents.length, 1);
  const ev = sentEvents[0].event as unknown as { type: string; code: string };
  assert.equal(ev.type, 'error');
  assert.equal(ev.code, 'EMERGENCY_ABORT_COMPLETE');
});

test('handleEmergencyAbort skips signature verification when no session keys are set up', () => {
  let aborted = false;
  let verified = false;
  const { ctx, sentEvents } = makeCtx({
    sessionManager: { emergencyAbort: () => { aborted = true; } },
  });
  handleEmergencyAbort(ctx, makeCrypto({
    hasSessionKeys: () => false,
    verifyPeer: () => { verified = true; return true; },
  }), {
    type: 'emergency_abort',
    phone_signature: 'sig',
  } as never);

  assert.equal(aborted, true);
  assert.equal(verified, false);
  assert.equal(sentEvents.length, 1);
});

test('handleEmergencyAbort proceeds without verification when no signature is provided', () => {
  let aborted = false;
  let verified = false;
  const { ctx } = makeCtx({
    sessionManager: { emergencyAbort: () => { aborted = true; } },
  });
  handleEmergencyAbort(ctx, makeCrypto({
    verifyPeer: () => { verified = true; return true; },
  }), { type: 'emergency_abort' } as never);

  assert.equal(aborted, true);
  assert.equal(verified, false);
});

test('handleEmergencyAbort rejects an invalid signature with SIGNATURE_INVALID', () => {
  let aborted = false;
  const { ctx, sentErrors, sentEvents } = makeCtx({
    sessionManager: { emergencyAbort: () => { aborted = true; } },
  });
  handleEmergencyAbort(ctx, makeCrypto({ verifyPeer: () => false }), {
    type: 'emergency_abort',
    phone_signature: 'bad',
  } as never);

  assert.equal(aborted, false);
  assert.equal(sentEvents.length, 0);
  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'SIGNATURE_INVALID');
});

// ---------------------------------------------------------------------------
// handleSessionOutputAck
// ---------------------------------------------------------------------------

test('handleSessionOutputAck advances the per-session last seq when newer', () => {
  const map = new Map<string, number>([['sess-1', 5]]);
  handleSessionOutputAck(map, {
    type: 'session_output_ack',
    session_id: 'sess-1',
    last_seq: 7,
  } as never);
  assert.equal(map.get('sess-1'), 7);
});

test('handleSessionOutputAck does not regress on stale acks', () => {
  const map = new Map<string, number>([['sess-1', 5]]);
  handleSessionOutputAck(map, {
    type: 'session_output_ack',
    session_id: 'sess-1',
    last_seq: 3,
  } as never);
  assert.equal(map.get('sess-1'), 5);
});

test('handleSessionOutputAck initializes a new session entry from the implicit zero baseline', () => {
  const map = new Map<string, number>();
  handleSessionOutputAck(map, {
    type: 'session_output_ack',
    session_id: 'sess-new',
    last_seq: 1,
  } as never);
  assert.equal(map.get('sess-new'), 1);
});

// ---------------------------------------------------------------------------
// notificationDeliveryKey + handleNotificationDeliveryAck
// ---------------------------------------------------------------------------

test('notificationDeliveryKey produces a stable composite key', () => {
  assert.equal(notificationDeliveryKey('permission_request', 's', 'r'), 'permission_request|s|r');
});

test('handleNotificationDeliveryAck removes the matching pending entry', () => {
  const pending = new Map([
    [notificationDeliveryKey('permission_request', 's', 'r'), { attempts: 2 }],
  ]);
  handleNotificationDeliveryAck(pending, {
    type: 'notification_delivery_ack',
    event_type: 'permission_request',
    session_id: 's',
    request_id: 'r',
  } as never);
  assert.equal(pending.size, 0);
});

test('handleNotificationDeliveryAck is a no-op for an untracked event', () => {
  const pending = new Map([
    [notificationDeliveryKey('permission_request', 's', 'r'), { attempts: 1 }],
  ]);
  handleNotificationDeliveryAck(pending, {
    type: 'notification_delivery_ack',
    event_type: 'user_question',
    session_id: 's',
    request_id: 'r',
  } as never);
  assert.equal(pending.size, 1);
});

// ---------------------------------------------------------------------------
// handleVerifyHistory
// ---------------------------------------------------------------------------

function makeHistoryPage(messages: Partial<HistoryMessage>[], tailSeq?: number, tailMs?: number): HistoryPage {
  return {
    messages: messages as HistoryMessage[],
    totalCount: messages.length,
    offset: 0,
    hasMore: false,
    tailSeq,
    tailMs,
  };
}

function makeVerifyDeps(
  page: HistoryPage,
  showToolUse = true,
  routedTo: 'sdk' | 'codex' = 'sdk',
): VerifyHistoryDeps {
  return {
    getSdkHistory: routedTo === 'sdk' ? () => page : () => makeHistoryPage([]),
    getCodexHistory: routedTo === 'codex' ? () => page : () => makeHistoryPage([]),
    phonePreferences: { showToolUse },
    hasPeerCapability: () => true,
  };
}

test('handleVerifyHistory stays silent when count and tail_seq match', () => {
  const page = makeHistoryPage([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ], 42);
  const { ctx, sentEvents } = makeCtx();
  handleVerifyHistory(ctx, makeVerifyDeps(page), {
    type: 'verify_history',
    session_id: 'sess-1',
    count: 2,
    tail_seq: 42,
  } as never);
  assert.equal(sentEvents.length, 0);
});

test('handleVerifyHistory emits history_divergence on tail_seq mismatch', () => {
  const page = makeHistoryPage([
    { role: 'user', content: 'hi' },
  ], 42);
  const { ctx, sentEvents } = makeCtx();
  handleVerifyHistory(ctx, makeVerifyDeps(page), {
    type: 'verify_history',
    session_id: 'sess-1',
    count: 1,
    tail_seq: 41,
  } as never);
  assert.equal(sentEvents.length, 1);
  const ev = sentEvents[0].event as unknown as {
    type: string; reason: string; expected_count: number; expected_tail_seq?: number;
  };
  assert.equal(ev.type, 'history_divergence');
  assert.equal(ev.reason, 'tail_seq_mismatch');
  assert.equal(ev.expected_count, 1);
  assert.equal(ev.expected_tail_seq, 42);
});

test('handleVerifyHistory tolerates phone tail_ms ahead of daemon tail_ms', () => {
  const page = makeHistoryPage([
    { role: 'user', content: 'hi' },
  ], 42, 1_778_912_805_691);
  const { ctx, sentEvents } = makeCtx();
  handleVerifyHistory(ctx, makeVerifyDeps(page), {
    type: 'verify_history',
    session_id: 'sess-1',
    count: 1,
    tail_ms: 1_778_912_806_000,
  } as never);
  assert.equal(sentEvents.length, 0);
});

test('handleVerifyHistory emits history_divergence when phone tail_ms is behind daemon tail_ms', () => {
  const page = makeHistoryPage([
    { role: 'user', content: 'hi' },
  ], 42, 1_778_912_805_691);
  const { ctx, sentEvents } = makeCtx();
  handleVerifyHistory(ctx, makeVerifyDeps(page), {
    type: 'verify_history',
    session_id: 'sess-1',
    count: 1,
    tail_ms: 1_778_912_805_000,
  } as never);
  assert.equal(sentEvents.length, 1);
  const ev = sentEvents[0].event as unknown as {
    type: string; reason: string; expected_tail_ms?: number;
  };
  assert.equal(ev.type, 'history_divergence');
  assert.equal(ev.reason, 'tail_ms_mismatch');
  assert.equal(ev.expected_tail_ms, 1_778_912_805_691);
});

test('handleVerifyHistory emits history_divergence on count mismatch', () => {
  const page = makeHistoryPage([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ], 10);
  const { ctx, sentEvents } = makeCtx();
  handleVerifyHistory(ctx, makeVerifyDeps(page), {
    type: 'verify_history',
    session_id: 'sess-1',
    count: 1,
    tail_seq: 10,
  } as never);
  assert.equal(sentEvents.length, 1);
  const ev = sentEvents[0].event as unknown as { reason: string };
  assert.equal(ev.reason, 'count_mismatch');
});

test('handleVerifyHistory tolerates count divergence when phone reports max_count == count', () => {
  const page = makeHistoryPage(Array.from({ length: 50 }, () => ({ role: 'assistant' as const, content: 'x' })), 50);
  const { ctx, sentEvents } = makeCtx();
  handleVerifyHistory(ctx, makeVerifyDeps(page), {
    type: 'verify_history',
    session_id: 'sess-1',
    count: 20,
    max_count: 20,
    tail_seq: 50,
  } as never);
  // Phone is trimming; count divergence ignored as long as tail matches.
  assert.equal(sentEvents.length, 0);
});

test('handleVerifyHistory tolerates count divergence when phone holds a partial window (scoped sync)', () => {
  // Daemon has 100 messages with seqs 1..100. Phone — after a scoped sync
  // that only delivered messages after_seq=96 — holds only the last 4.
  const messages: Partial<HistoryMessage>[] = Array.from({ length: 100 }, (_, i) => ({
    role: 'assistant' as const,
    content: `m${i + 1}`,
    seq: i + 1,
  }));
  const page = makeHistoryPage(messages, 100);
  const { ctx, sentEvents } = makeCtx();
  handleVerifyHistory(ctx, makeVerifyDeps(page), {
    type: 'verify_history',
    session_id: 'sess-1',
    count: 4,
    head_seq: 97,   // phone's earliest seq > daemon's earliest seq (1)
    tail_seq: 100,
    max_count: 1000,
  } as never);
  // Phone explicitly tells us it holds the [97, 100] window. tail_seq matches
  // so the window is in sync; do not flag count divergence.
  assert.equal(sentEvents.length, 0);
});

test('handleVerifyHistory still flags real loss even when head_seq > daemon head (tail divergence wins)', () => {
  // Phone holds a partial window claim (head_seq=97) but its tail_seq is
  // behind the daemon — that's a real loss, not an intentional window.
  const messages: Partial<HistoryMessage>[] = Array.from({ length: 100 }, (_, i) => ({
    role: 'assistant' as const,
    content: `m${i + 1}`,
    seq: i + 1,
  }));
  const page = makeHistoryPage(messages, 100);
  const { ctx, sentEvents } = makeCtx();
  handleVerifyHistory(ctx, makeVerifyDeps(page), {
    type: 'verify_history',
    session_id: 'sess-1',
    count: 2,
    head_seq: 97,
    tail_seq: 98,   // phone is missing the last 2
    max_count: 1000,
  } as never);
  assert.equal(sentEvents.length, 1);
  const ev = sentEvents[0].event as unknown as { reason: string };
  assert.equal(ev.reason, 'tail_seq_mismatch');
});

test('handleVerifyHistory drops empty user / blank assistant / unknown-role messages from the expected count', () => {
  const page = makeHistoryPage([
    { role: 'user', content: '' },         // dropped
    { role: 'user', content: 'hi' },       // kept
    { role: 'assistant', content: '   ' }, // dropped
    { role: 'assistant', content: 'ok' },  // kept
    { role: 'tool_use', content: 'bash' },  // kept
    { role: 'tool_result', content: 'x' },  // dropped (when showToolUse=false)
    { role: 'subagent', content: 'p' },    // kept
  ], 9);
  const { ctx, sentEvents } = makeCtx();
  handleVerifyHistory(ctx, makeVerifyDeps(page, /*showToolUse=*/ false), {
    type: 'verify_history',
    session_id: 'sess-1',
    count: 4,
    tail_seq: 9,
  } as never);
  // user(hi), assistant(ok), subagent — tool_use and tool_result both filtered
  // by showToolUse=false; user(empty) and assistant(blank) by phone-side rules.
  assert.equal(sentEvents.length, 1);
  const ev = sentEvents[0].event as unknown as { reason: string; expected_count: number };
  assert.equal(ev.reason, 'count_mismatch');
  assert.equal(ev.expected_count, 3);
});

test('handleVerifyHistory routes codex sessions through getCodexHistory', () => {
  let sdkCalls = 0;
  let codexCalls = 0;
  const deps: VerifyHistoryDeps = {
    getSdkHistory: () => { sdkCalls++; return makeHistoryPage([]); },
    getCodexHistory: () => { codexCalls++; return makeHistoryPage([{ role: 'user', content: 'hi' }], 1); },
    phonePreferences: { showToolUse: true },
    hasPeerCapability: () => true,
  };
  const { ctx } = makeCtx();
  handleVerifyHistory(ctx, deps, {
    type: 'verify_history',
    session_id: 'codex:thread-1',
    count: 1,
    tail_seq: 1,
  } as never);
  assert.equal(codexCalls, 1);
  assert.equal(sdkCalls, 0);
});

test('handleVerifyHistory ignores tail_seq mismatch when the daemon has no tailSeq for the session', () => {
  const page = makeHistoryPage([{ role: 'user', content: 'hi' }] /* tailSeq undefined */);
  const { ctx, sentEvents } = makeCtx();
  handleVerifyHistory(ctx, makeVerifyDeps(page), {
    type: 'verify_history',
    session_id: 'sess-1',
    count: 1,
    tail_seq: 99,
  } as never);
  // Match on count, no tail to compare against -> silent.
  assert.equal(sentEvents.length, 0);
});

// ---------------------------------------------------------------------------
// Regression: long sessions where daemon's full history exceeds the wire
// tail-window. #250 round 2 dropped the default tail window from 200 to 30
// to bound first-look fan-out, which created a class of bug: phones whose
// in-memory window had been trimmed reported in-memory count + tail to
// `verify_history`, daemon read it as "phone is missing 200+ messages",
// fired `history_divergence`, phone re-fetched a 30-message window that
// couldn't close the gap, repeat. iOS-side fix is to report DISK count/tail
// (PEER_CAPABILITIES.MESSAGES_PRECISE_DIVERGENCE). The contract this test
// pins down: when the phone's report matches daemon's full history,
// `handleVerifyHistory` MUST stay silent — no matter how big the session.
// Without this regression test future refactors of the daemon's tail-window
// default could silently re-introduce the divergence loop.
test('handleVerifyHistory is silent when phone reports full disk truth (337-msg session)', () => {
  // 337 visible messages, tail_seq=466 (matches the production scenario
  // captured in the daemon log that motivated this fix).
  const messages = Array.from({ length: 337 }, (_, i) => ({
    role: 'user' as const,
    content: `m${i}`,
    seq: i + 130,
  }));
  const page = makeHistoryPage(messages, 466);
  const { ctx, sentEvents } = makeCtx();
  handleVerifyHistory(ctx, makeVerifyDeps(page), {
    type: 'verify_history',
    session_id: 'sess-long',
    count: 337,
    head_seq: 130,
    tail_seq: 466,
  } as never);
  assert.equal(sentEvents.length, 0,
    'phone reporting disk-truth count/tail must converge — divergence here re-creates the iOS refetch loop');
});

test('handleVerifyHistory still flags real loss in long sessions (phone behind by 1 tail msg)', () => {
  const messages = Array.from({ length: 337 }, (_, i) => ({
    role: 'user' as const,
    content: `m${i}`,
    seq: i + 130,
  }));
  const page = makeHistoryPage(messages, 466);
  const { ctx, sentEvents } = makeCtx();
  handleVerifyHistory(ctx, makeVerifyDeps(page), {
    type: 'verify_history',
    session_id: 'sess-long',
    count: 336,
    head_seq: 130,
    tail_seq: 465,
  } as never);
  assert.equal(sentEvents.length, 1, 'genuine 1-msg loss must still trigger divergence');
  const ev = sentEvents[0].event as unknown as { reason: string; expected_tail_seq?: number };
  assert.equal(ev.reason, 'tail_seq_mismatch');
  assert.equal(ev.expected_tail_seq, 466);
});
