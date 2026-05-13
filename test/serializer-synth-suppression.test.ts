import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  sendSessionHistory,
  type SendSessionHistoryDeps,
} from '../src/wiring/session-output-serializer.js';
import type { PcEvent } from 'agent-pocket-protocol';

// ---------------------------------------------------------------------------
// Helper: build a fake SendSessionHistoryDeps for suppression tests
// ---------------------------------------------------------------------------

function makeSuppDeps(opts: {
  messages: Array<Record<string, unknown>>;
  synthLog: Array<{ name: string; args: string; syntheticAtMs: number }>;
}): { deps: SendSessionHistoryDeps; sent: PcEvent[] } {
  const sent: PcEvent[] = [];
  const deps: SendSessionHistoryDeps = {
    sessionDiscovery: {
      getSessionHistory: (() => ({
        messages: opts.messages,
        totalCount: opts.messages.length,
        offset: 0,
        hasMore: false,
        tailSeq: opts.messages.length,
      })) as unknown as SendSessionHistoryDeps['sessionDiscovery']['getSessionHistory'],
    },
    codexDiscovery: {
      getSessionHistory: (() => ({
        messages: [], totalCount: 0, offset: 0, hasMore: false, tailSeq: 0,
      })) as unknown as SendSessionHistoryDeps['codexDiscovery']['getSessionHistory'],
    },
    phonePreferences: { showToolUse: true },
    sendToPhone: (e) => sent.push(e),
    hasPeerCapability: () => true,
    getControllerSlashSynthLog: () => opts.synthLog,
  };
  return { deps, sent };
}

function getMessages(sent: PcEvent[]): Array<Record<string, unknown>> {
  return (sent[0] as unknown as { messages: Array<Record<string, unknown>> }).messages;
}

// ---------------------------------------------------------------------------
// Case A: single match — both invoke and output suppressed
// ---------------------------------------------------------------------------

test('serializer suppression: single synth match suppresses invoke + output', () => {
  const T = Date.now();
  const { deps, sent } = makeSuppDeps({
    messages: [
      { role: 'local_command_invoke', content: '', localCommandName: 'cost', localCommandArgs: '', sdkUuid: 'inv1', timestamp: new Date(T).toISOString() },
      { role: 'local_command_output', content: 'Total: $0', parentInvokeSdkUuid: 'inv1', sdkUuid: 'out1' },
    ],
    synthLog: [{ name: 'cost', args: '', syntheticAtMs: T }],
  });

  sendSessionHistory(deps, 'claude-sess-1');
  const msgs = getMessages(sent);
  assert.equal(msgs.length, 0);
});

// ---------------------------------------------------------------------------
// Case B: outside +/-10s window — both pass through
// ---------------------------------------------------------------------------

test('serializer suppression: outside 10s window passes through', () => {
  const T = Date.now();
  const { deps, sent } = makeSuppDeps({
    messages: [
      { role: 'local_command_invoke', content: '', localCommandName: 'cost', localCommandArgs: '', sdkUuid: 'inv2', timestamp: new Date(T + 11_000).toISOString() },
      { role: 'local_command_output', content: 'Total: $0', parentInvokeSdkUuid: 'inv2', sdkUuid: 'out2' },
    ],
    synthLog: [{ name: 'cost', args: '', syntheticAtMs: T }],
  });

  sendSessionHistory(deps, 'claude-sess-2');
  const msgs = getMessages(sent);
  assert.equal(msgs.length, 2);
});

// ---------------------------------------------------------------------------
// Case C: two calls 200ms apart, one synth record — first suppressed, second passes
// ---------------------------------------------------------------------------

test('serializer suppression: consume-once — two invokes, one synth → first suppressed, second passes', () => {
  const T = Date.now();
  const { deps, sent } = makeSuppDeps({
    messages: [
      { role: 'local_command_invoke', content: '', localCommandName: 'cost', localCommandArgs: '', sdkUuid: 'inv3a', timestamp: new Date(T).toISOString() },
      { role: 'local_command_output', content: 'Total: $0', parentInvokeSdkUuid: 'inv3a', sdkUuid: 'out3a' },
      { role: 'local_command_invoke', content: '', localCommandName: 'cost', localCommandArgs: '', sdkUuid: 'inv3b', timestamp: new Date(T + 200).toISOString() },
      { role: 'local_command_output', content: 'Total: $0.50', parentInvokeSdkUuid: 'inv3b', sdkUuid: 'out3b' },
    ],
    synthLog: [{ name: 'cost', args: '', syntheticAtMs: T }],
  });

  sendSessionHistory(deps, 'claude-sess-3');
  const msgs = getMessages(sent);
  // First pair suppressed, second pair passes
  assert.equal(msgs.length, 2);
  assert.equal((msgs[0] as { sdkUuid: string }).sdkUuid, 'inv3b');
  assert.equal((msgs[1] as { sdkUuid: string }).sdkUuid, 'out3b');
});

// ---------------------------------------------------------------------------
// Case D: name mismatch — passes through
// ---------------------------------------------------------------------------

test('serializer suppression: name mismatch passes through', () => {
  const T = Date.now();
  const { deps, sent } = makeSuppDeps({
    messages: [
      { role: 'local_command_invoke', content: '', localCommandName: 'status', localCommandArgs: '', sdkUuid: 'inv4', timestamp: new Date(T).toISOString() },
      { role: 'local_command_output', content: 'Ready', parentInvokeSdkUuid: 'inv4', sdkUuid: 'out4' },
    ],
    synthLog: [{ name: 'cost', args: '', syntheticAtMs: T }],
  });

  sendSessionHistory(deps, 'claude-sess-4');
  const msgs = getMessages(sent);
  assert.equal(msgs.length, 2);
});

// ---------------------------------------------------------------------------
// Case E: output without parentInvokeSdkUuid (legacy) passes through
// ---------------------------------------------------------------------------

test('serializer suppression: output without parentInvokeSdkUuid passes through even if invoke is suppressed', () => {
  const T = Date.now();
  const { deps, sent } = makeSuppDeps({
    messages: [
      { role: 'local_command_invoke', content: '', localCommandName: 'cost', localCommandArgs: '', sdkUuid: 'inv5', timestamp: new Date(T).toISOString() },
      // Legacy output: no parentInvokeSdkUuid
      { role: 'local_command_output', content: 'Total: $0', sdkUuid: 'out5-legacy' },
    ],
    synthLog: [{ name: 'cost', args: '', syntheticAtMs: T }],
  });

  sendSessionHistory(deps, 'claude-sess-5');
  const msgs = getMessages(sent);
  // invoke is suppressed (matches synth), but output without parentInvokeSdkUuid passes
  assert.equal(msgs.length, 1);
  assert.equal((msgs[0] as { sdkUuid: string }).sdkUuid, 'out5-legacy');
});
