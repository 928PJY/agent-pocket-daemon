import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import {
  registerPermissionRequestPassthrough,
  registerToolResultHandler,
  registerErrorHandler,
  registerSubagentStartHandler,
  registerSubagentStopHandler,
  registerApiSessionsHandler,
  registerApiStatusHandler,
  type HookGateway,
  type ToolResultDeps,
  type SubagentDeps,
  type ApiInspectionDeps,
} from '../src/wiring/hook-handlers.js';

// ---------------------------------------------------------------------------
// Fake HookServer: an EventEmitter with the same .on() signature plus a
// resolvePermissionEmpty spy.
// ---------------------------------------------------------------------------

interface FakeHookServer extends HookGateway {
  emit(event: string, ...args: unknown[]): boolean;
  resolveCalls: string[];
}

function makeHooks(): FakeHookServer {
  const ee = new EventEmitter();
  const calls: string[] = [];
  return Object.assign(ee, {
    resolvePermissionEmpty(toolUseId: string): boolean {
      calls.push(toolUseId);
      return true;
    },
    resolveCalls: calls,
  }) as unknown as FakeHookServer;
}

// ---------------------------------------------------------------------------
// permission_request — passthrough
// ---------------------------------------------------------------------------

test('registerPermissionRequestPassthrough resolves with empty body using the toolUseId', () => {
  const hooks = makeHooks();
  registerPermissionRequestPassthrough(hooks);
  hooks.emit('permission_request', { toolUseId: 'tu_1', sessionId: 's', toolName: 'Bash', toolInput: {}, cwd: '/tmp', transcriptPath: '' });
  assert.deepEqual(hooks.resolveCalls, ['tu_1']);
});

test('registerPermissionRequestPassthrough resolves once per fired event', () => {
  const hooks = makeHooks();
  registerPermissionRequestPassthrough(hooks);
  hooks.emit('permission_request', { toolUseId: 'a' });
  hooks.emit('permission_request', { toolUseId: 'b' });
  hooks.emit('permission_request', { toolUseId: 'c' });
  assert.deepEqual(hooks.resolveCalls, ['a', 'b', 'c']);
});

// ---------------------------------------------------------------------------
// tool_result
// ---------------------------------------------------------------------------

interface ToolResultHarness {
  deps: ToolResultDeps;
  sentEvents: unknown[];
  resolveExternalCalls: string[];
  findByClaudeSessionIdCalls: string[];
}

function makeToolResultHarness(opts: {
  showToolUse?: boolean;
  internalSessionId?: string | null;
  externalIdMapping?: Record<string, string>;
} = {}): ToolResultHarness {
  const showToolUse = opts.showToolUse ?? true;
  const internalSessionId = opts.internalSessionId === null ? null : opts.internalSessionId ?? 'internal-1';
  const externalIdMapping = opts.externalIdMapping ?? { 'internal-1': 'external-1' };
  const sent: unknown[] = [];
  const resolveCalls: string[] = [];
  const findCalls: string[] = [];
  return {
    sentEvents: sent,
    resolveExternalCalls: resolveCalls,
    findByClaudeSessionIdCalls: findCalls,
    deps: {
      prefs: { showToolUse },
      sessionManager: {
        findByClaudeSessionId(claudeSessionId: string) {
          findCalls.push(claudeSessionId);
          if (internalSessionId === null) return undefined;
          return { sessionId: internalSessionId } as never;
        },
      },
      resolveExternalSessionId(internalId: string) {
        resolveCalls.push(internalId);
        return externalIdMapping[internalId] ?? internalId;
      },
      sendToPhone(event) { sent.push(event); },
    },
  };
}

test('registerToolResultHandler skips events when prefs.showToolUse is false', () => {
  const hooks = makeHooks();
  const h = makeToolResultHarness({ showToolUse: false });
  registerToolResultHandler(hooks, h.deps);
  hooks.emit('tool_result', { sessionId: 'cs', toolUseId: 'tu', toolName: 'Bash', toolInput: {}, toolResponse: 'ok', cwd: '/tmp' });
  assert.equal(h.sentEvents.length, 0);
  // Also: shouldn't even ask the SessionManager / external-id resolver.
  assert.equal(h.findByClaudeSessionIdCalls.length, 0);
});

test('registerToolResultHandler reads prefs live so a toggle takes effect on the next event', () => {
  const hooks = makeHooks();
  const h = makeToolResultHarness({ showToolUse: false });
  registerToolResultHandler(hooks, h.deps);
  hooks.emit('tool_result', { sessionId: 'cs', toolUseId: 'tu', toolName: 'Bash', toolInput: {}, toolResponse: 'ok', cwd: '/tmp' });
  assert.equal(h.sentEvents.length, 0);
  h.deps.prefs.showToolUse = true;
  hooks.emit('tool_result', { sessionId: 'cs', toolUseId: 'tu', toolName: 'Bash', toolInput: {}, toolResponse: 'ok', cwd: '/tmp' });
  assert.equal(h.sentEvents.length, 1);
});

test('registerToolResultHandler maps internal session id through resolveExternalSessionId when session is tracked', () => {
  const hooks = makeHooks();
  const h = makeToolResultHarness();
  registerToolResultHandler(hooks, h.deps);
  hooks.emit('tool_result', { sessionId: 'cs', toolUseId: 'tu', toolName: 'Bash', toolInput: {}, toolResponse: 'ok', cwd: '/tmp' });
  assert.equal(h.sentEvents.length, 1);
  assert.equal((h.sentEvents[0] as { session_id: string }).session_id, 'external-1');
  assert.deepEqual(h.resolveExternalCalls, ['internal-1']);
});

test('registerToolResultHandler falls back to the raw claude session id when no SessionManager match', () => {
  const hooks = makeHooks();
  const h = makeToolResultHarness({ internalSessionId: null });
  registerToolResultHandler(hooks, h.deps);
  hooks.emit('tool_result', { sessionId: 'cs-unknown', toolUseId: 'tu', toolName: 'Bash', toolInput: {}, toolResponse: 'ok', cwd: '/tmp' });
  assert.equal((h.sentEvents[0] as { session_id: string }).session_id, 'cs-unknown');
  // No external-id resolution because there was no internal session.
  assert.equal(h.resolveExternalCalls.length, 0);
});

test('registerToolResultHandler stringifies non-string toolResponse, leaves strings untouched', () => {
  const hooks = makeHooks();
  const h = makeToolResultHarness();
  registerToolResultHandler(hooks, h.deps);
  hooks.emit('tool_result', { sessionId: 'cs', toolUseId: 'tu', toolName: 'Bash', toolInput: {}, toolResponse: 'plain-string', cwd: '/tmp' });
  hooks.emit('tool_result', { sessionId: 'cs', toolUseId: 'tu2', toolName: 'Bash', toolInput: {}, toolResponse: { ok: true, n: 42 }, cwd: '/tmp' });
  hooks.emit('tool_result', { sessionId: 'cs', toolUseId: 'tu3', toolName: 'Bash', toolInput: {}, toolResponse: undefined, cwd: '/tmp' });
  const outputs = h.sentEvents.map(e => (e as { output: string }).output);
  assert.deepEqual(outputs, ['plain-string', '{"ok":true,"n":42}', '""']);
});

test('registerToolResultHandler emits the canonical session_output shape with is_error=false and a fresh timestamp', () => {
  const hooks = makeHooks();
  const h = makeToolResultHarness();
  registerToolResultHandler(hooks, h.deps);
  const before = Date.now();
  hooks.emit('tool_result', { sessionId: 'cs', toolUseId: 'tu', toolName: 'Bash', toolInput: {}, toolResponse: 'ok', cwd: '/tmp' });
  const after = Date.now();
  const evt = h.sentEvents[0] as { type: string; tool_use_id: string; output_type: string; is_error: boolean; timestamp: number };
  assert.equal(evt.type, 'session_output');
  assert.equal(evt.output_type, 'tool_result');
  assert.equal(evt.tool_use_id, 'tu');
  assert.equal(evt.is_error, false);
  assert.ok(evt.timestamp >= before && evt.timestamp <= after);
});

// ---------------------------------------------------------------------------
// error
// ---------------------------------------------------------------------------

test('registerErrorHandler invokes restartHookServer on every error event', () => {
  const hooks = makeHooks();
  let restarts = 0;
  registerErrorHandler(hooks, { restartHookServer: () => { restarts++; } });
  hooks.emit('error', new Error('boom'));
  hooks.emit('error', new Error('again'));
  assert.equal(restarts, 2);
});

// ---------------------------------------------------------------------------
// subagent_start / subagent_stop
// ---------------------------------------------------------------------------

interface SubagentObserverSpy {
  doneCalls: string[];
  startCalls: Array<{ id: string; type: string }>;
}

interface SubagentSession {
  observer: { markSubagentDone: (id: string) => void; markSubagentStart: (id: string, type: string) => void } | undefined;
}

function makeSubagentDeps(opts: {
  matchedSession?: SubagentSession | undefined;
  allSessions?: SubagentSession[];
} = {}): { deps: SubagentDeps; spy: SubagentObserverSpy; allSpies: SubagentObserverSpy[]; findCalls: string[] } {
  const findCalls: string[] = [];
  const spy: SubagentObserverSpy = { doneCalls: [], startCalls: [] };
  const allSpies = (opts.allSessions ?? []).map(() => ({ doneCalls: [], startCalls: [] } as SubagentObserverSpy));
  const matched = opts.matchedSession;
  if (matched && matched.observer) {
    matched.observer.markSubagentDone = (id: string) => { spy.doneCalls.push(id); };
    matched.observer.markSubagentStart = (id: string, type: string) => { spy.startCalls.push({ id, type }); };
  }
  const allSessions = (opts.allSessions ?? []).map((s, idx) => {
    if (s.observer) {
      s.observer.markSubagentDone = (id: string) => { allSpies[idx].doneCalls.push(id); };
      s.observer.markSubagentStart = (id: string, type: string) => { allSpies[idx].startCalls.push({ id, type }); };
    }
    return s;
  });
  return {
    deps: {
      sessionManager: {
        findByClaudeSessionId(claudeSessionId: string) {
          findCalls.push(claudeSessionId);
          return matched as never;
        },
        getAllSessions() {
          return allSessions as never;
        },
      },
    },
    spy,
    allSpies,
    findCalls,
  };
}

test('registerSubagentStopHandler forwards markSubagentDone to the matched session observer', () => {
  const hooks = makeHooks();
  const observer = { markSubagentDone: () => {}, markSubagentStart: () => {} };
  const { deps, spy } = makeSubagentDeps({ matchedSession: { observer } });
  registerSubagentStopHandler(hooks, deps);
  hooks.emit('subagent_stop', 'cs1', 'agent-7', 'general-purpose', '/tmp/transcript.jsonl');
  assert.deepEqual(spy.doneCalls, ['agent-7']);
});

test('registerSubagentStopHandler broadcasts to every observer when no session matches', () => {
  const hooks = makeHooks();
  const o1 = { markSubagentDone: () => {}, markSubagentStart: () => {} };
  const o2 = { markSubagentDone: () => {}, markSubagentStart: () => {} };
  const o3 = { markSubagentDone: () => {}, markSubagentStart: () => {} };
  const { deps, allSpies } = makeSubagentDeps({
    matchedSession: undefined,
    allSessions: [{ observer: o1 }, { observer: undefined }, { observer: o2 }, { observer: o3 }],
  });
  registerSubagentStopHandler(hooks, deps);
  hooks.emit('subagent_stop', 'unknown', 'agent-9', 'general-purpose', '');
  assert.deepEqual(allSpies[0].doneCalls, ['agent-9']);
  // index 1 has no observer — silently skipped, no throw
  assert.deepEqual(allSpies[2].doneCalls, ['agent-9']);
  assert.deepEqual(allSpies[3].doneCalls, ['agent-9']);
});

test('registerSubagentStopHandler is a no-op when matched session has no observer', () => {
  const hooks = makeHooks();
  const { deps, allSpies } = makeSubagentDeps({
    matchedSession: { observer: undefined },
    allSessions: [{ observer: { markSubagentDone: () => {}, markSubagentStart: () => {} } }],
  });
  registerSubagentStopHandler(hooks, deps);
  hooks.emit('subagent_stop', 'cs', 'agent-11', 'general-purpose', '');
  // Should not broadcast — only broadcast path is when *no* session matched.
  assert.deepEqual(allSpies[0].doneCalls, []);
});

test('registerSubagentStartHandler forwards markSubagentStart with id + type', () => {
  const hooks = makeHooks();
  const observer = { markSubagentDone: () => {}, markSubagentStart: () => {} };
  const { deps, spy } = makeSubagentDeps({ matchedSession: { observer } });
  registerSubagentStartHandler(hooks, deps);
  hooks.emit('subagent_start', 'cs', 'agent-3', 'code-reviewer', '');
  assert.deepEqual(spy.startCalls, [{ id: 'agent-3', type: 'code-reviewer' }]);
});

test('registerSubagentStartHandler is a no-op when no session or no observer (no broadcast fallback)', () => {
  const hooks = makeHooks();
  const o = { markSubagentDone: () => {}, markSubagentStart: () => {} };
  const { deps, allSpies } = makeSubagentDeps({
    matchedSession: undefined,
    allSessions: [{ observer: o }],
  });
  registerSubagentStartHandler(hooks, deps);
  // Doesn't throw and doesn't fan out
  hooks.emit('subagent_start', 'cs', 'agent-3', 'code-reviewer', '');
  assert.deepEqual(allSpies[0].startCalls, []);
});

// ---------------------------------------------------------------------------
// api_sessions
// ---------------------------------------------------------------------------

test('registerApiSessionsHandler responds with mapped session info, preferring claudeSessionId over internal id', () => {
  const hooks = makeHooks();
  const sessions = [
    { sessionId: 'int-1', claudeSessionId: 'cs-1', status: 'running', terminalPid: 111, workingDirectory: '/a', isObserved: true, customTitle: 'Foo', entrypoint: 'claude', lastActivity: 1234 },
    { sessionId: 'int-2', claudeSessionId: undefined, status: 'ready', terminalPid: undefined, workingDirectory: '/b', isObserved: false, customTitle: undefined, entrypoint: undefined, lastActivity: 5678 },
  ];
  registerApiSessionsHandler(hooks, { sessionManager: { getAllSessions: () => sessions as never } });
  let captured: unknown;
  hooks.emit('api_sessions', (out: unknown) => { captured = out; });
  assert.deepEqual(captured, [
    { sessionId: 'cs-1', status: 'running', pid: 111, cwd: '/a', isObserved: true, customTitle: 'Foo', entrypoint: 'claude', lastActivity: 1234 },
    { sessionId: 'int-2', status: 'ready', pid: undefined, cwd: '/b', isObserved: false, customTitle: undefined, entrypoint: undefined, lastActivity: 5678 },
  ]);
});

test('registerApiSessionsHandler returns an empty list when no sessions are tracked', () => {
  const hooks = makeHooks();
  registerApiSessionsHandler(hooks, { sessionManager: { getAllSessions: () => [] as never } });
  let captured: unknown;
  hooks.emit('api_sessions', (out: unknown) => { captured = out; });
  assert.deepEqual(captured, []);
});

// ---------------------------------------------------------------------------
// api_status
// ---------------------------------------------------------------------------

test('registerApiStatusHandler reports "not configured" / false / 0 when relayClient is null', () => {
  const hooks = makeHooks();
  const deps: ApiInspectionDeps = {
    sessionManager: { getAllSessions: () => [{}, {}, {}] as never },
    getRelayClient: () => null,
  };
  registerApiStatusHandler(hooks, deps);
  let captured: unknown;
  hooks.emit('api_status', (out: unknown) => { captured = out; });
  assert.deepEqual(captured, { relay: 'not configured', phone: false, offlineQueue: 0, sessions: 3 });
});

test('registerApiStatusHandler reads relay client live so a swap-in is reflected on the next event', () => {
  const hooks = makeHooks();
  let relay: { getConnectionState(): string; getPhonePeerOnline(): boolean; getOfflineQueueSize(): number } | null = null;
  const deps: ApiInspectionDeps = {
    sessionManager: { getAllSessions: () => [] as never },
    getRelayClient: () => relay as never,
  };
  registerApiStatusHandler(hooks, deps);

  let captured: unknown;
  hooks.emit('api_status', (out: unknown) => { captured = out; });
  assert.equal((captured as { relay: string }).relay, 'not configured');

  relay = {
    getConnectionState: () => 'connected',
    getPhonePeerOnline: () => true,
    getOfflineQueueSize: () => 4,
  };
  hooks.emit('api_status', (out: unknown) => { captured = out; });
  assert.deepEqual(captured, { relay: 'connected', phone: true, offlineQueue: 4, sessions: 0 });
});
