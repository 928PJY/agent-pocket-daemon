import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionStatus } from 'agent-pocket-protocol';
import type { PcEvent, ListSessionsCommand } from 'agent-pocket-protocol';
import type { CommandContext } from '../src/commands/command-context.js';
import {
  handleListSessions,
  type ListSessionsDeps,
  type PendingBlockingEntry,
  type CodexObserverInfo,
} from '../src/commands/handlers/list-sessions.js';
import type {
  DiscoveredSession,
  HistoryPage,
  RunningCliSession,
} from '../src/discovery/session-discovery.js';
import type { CodexSession, CodexLiveSession } from '../src/discovery/codex-discovery.js';
import type { SessionState } from '../src/sessions/session-manager.js';
import type { CodexTerminalTargetEntry } from '../src/codex/codex-handler.js';

interface SentError { requestId?: string; message: string; code: string; }

function makeCtx() {
  const sentEvents: PcEvent[] = [];
  const sentErrors: SentError[] = [];
  const ctx: CommandContext = {
    sendToPhone: (event) => { sentEvents.push(event); },
    sendError: (requestId, message, code) => { sentErrors.push({ requestId, message, code }); },
    resolveInternalSessionId: (id) => id,
    resolveExternalSessionId: (id) => id, // identity for tests
    sendSessionHistory: () => undefined,
    sessionManager: {} as unknown as CommandContext['sessionManager'],
    sessionIdMap: new Map(),
    pendingSessionRequests: new Map(),
  };
  return { ctx, sentEvents, sentErrors };
}

function emptyHistory(): HistoryPage {
  return { messages: [], totalCount: 0, offset: 0, hasMore: false };
}

function makeDeps(overrides: Partial<ListSessionsDeps> = {}): ListSessionsDeps {
  return {
    getCachedSessions: () => [],
    discoverSessions: async () => [],
    getRunningAllSessions: () => [],
    getSessionHistory: () => emptyHistory(),
    discoverCodexSessions: () => [],
    discoverCodexLiveSessions: () => new Map(),
    getCodexHistory: () => emptyHistory(),
    resolveCodexTerminalTarget: () => undefined,
    getCodexCapabilities: () => ['observe'],
    getCodexObserver: () => undefined,
    getAllTrackedSessions: () => [],
    pendingBlockingRequests: new Map(),
    replacedSessionIds: new Set(),
    claudeAgentVersion: '4.0.0',
    ...overrides,
  };
}

const baseCmd = (extra: Partial<ListSessionsCommand> = {}): ListSessionsCommand => ({
  type: 'list_sessions',
  request_id: 'req-1',
  ...extra,
});

function lastSessionListEvent(events: PcEvent[]): {
  request_id: string;
  sessions: Array<Record<string, unknown>>;
  total_count: number;
  offset: number;
  has_more: boolean;
} {
  const event = events.find((e) => (e as { type: string }).type === 'session_list');
  assert.ok(event, 'no session_list event was sent');
  return event as unknown as ReturnType<typeof lastSessionListEvent>;
}

function makeTracked(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: 'sess-internal',
    status: SessionStatus.READY,
    workingDirectory: '/work',
    createdAt: 1,
    lastActivity: 1000,
    isObserved: true,
    terminalPid: 1234,
    claudeSessionId: 'claude-1',
    ...overrides,
  } as unknown as SessionState;
}

function makeRunning(overrides: Partial<RunningCliSession> = {}): RunningCliSession {
  return {
    pid: 5555,
    sessionId: 'pid-sess',
    cwd: '/work2',
    entrypoint: 'claude',
    ...overrides,
  };
}

function makeDiscovered(overrides: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    sessionId: 'disc-sess',
    projectDir: '/projects/foo',
    lastModified: 500,
    filePath: '/path/to/disc.jsonl',
    ...overrides,
  };
}

function makeCodex(overrides: Partial<CodexSession> = {}): CodexSession {
  return {
    threadId: 'thread-1',
    sessionId: 'codex:thread-1',
    rolloutPath: '/codex/thread-1.jsonl',
    cwd: '/codex/work',
    cliVersion: '0.1.0',
    updatedAtMs: 800,
    title: 'Codex Project',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Empty / paging
// ---------------------------------------------------------------------------

test('handleListSessions emits an empty session_list when nothing is discovered', async () => {
  const { ctx, sentEvents } = makeCtx();
  await handleListSessions(ctx, makeDeps(), baseCmd());
  const list = lastSessionListEvent(sentEvents);
  assert.equal(list.total_count, 0);
  assert.equal(list.sessions.length, 0);
  assert.equal(list.has_more, false);
  assert.equal(list.offset, 0);
});

test('handleListSessions paginates with offset + limit and reports has_more correctly', async () => {
  const { ctx, sentEvents } = makeCtx();
  const tracked = [
    makeTracked({ sessionId: 'a', claudeSessionId: 'a-claude', terminalPid: 1, lastActivity: 100 }),
    makeTracked({ sessionId: 'b', claudeSessionId: 'b-claude', terminalPid: 2, lastActivity: 200 }),
    makeTracked({ sessionId: 'c', claudeSessionId: 'c-claude', terminalPid: 3, lastActivity: 300 }),
  ];
  await handleListSessions(
    ctx,
    makeDeps({ getAllTrackedSessions: () => tracked }),
    baseCmd({ offset: 1, limit: 1 }),
  );
  const list = lastSessionListEvent(sentEvents);
  assert.equal(list.total_count, 3);
  assert.equal(list.sessions.length, 1);
  assert.equal(list.offset, 1);
  assert.equal(list.has_more, true);
});

// ---------------------------------------------------------------------------
// Phase 1 — tracked sessions
// ---------------------------------------------------------------------------

test('handleListSessions exposes tracked SDK session fields including capabilities', async () => {
  const { ctx, sentEvents } = makeCtx();
  await handleListSessions(
    ctx,
    makeDeps({ getAllTrackedSessions: () => [makeTracked()] }),
    baseCmd(),
  );
  const list = lastSessionListEvent(sentEvents);
  const entry = list.sessions[0];
  assert.equal(entry.session_id, 'sess-internal');
  assert.equal(entry.agent_type, 'claude_code');
  assert.equal(entry.agent_version, '4.0.0');
  assert.deepEqual(entry.capabilities, [
    'observe', 'terminal_remote_message', 'terminal_interrupt',
    'permissions', 'plan_review', 'user_question',
  ]);
  assert.equal(entry.is_observed, true);
});

test('handleListSessions includes permission_mode + dangerously_skip_permissions only for SDK (non-observed) sessions', async () => {
  const { ctx, sentEvents } = makeCtx();
  const sdk = makeTracked({
    sessionId: 'sdk-1',
    isObserved: false,
    permissionMode: 'acceptEdits' as never,
    config: { dangerously_skip_permissions: true } as never,
  });
  await handleListSessions(
    ctx,
    makeDeps({ getAllTrackedSessions: () => [sdk] }),
    baseCmd(),
  );
  const entry = lastSessionListEvent(sentEvents).sessions[0];
  assert.equal(entry.permission_mode, 'acceptEdits');
  assert.equal(entry.dangerously_skip_permissions, true);
});

test('handleListSessions overlays PENDING_ACTIONS + action_type when a real blocking request exists', async () => {
  const { ctx, sentEvents } = makeCtx();
  const pending = new Map<string, PendingBlockingEntry>([
    ['req-x', { sessionId: 'sess-internal', type: 'permission_request' }],
  ]);
  await handleListSessions(
    ctx,
    makeDeps({
      getAllTrackedSessions: () => [makeTracked()],
      pendingBlockingRequests: pending,
    }),
    baseCmd(),
  );
  const entry = lastSessionListEvent(sentEvents).sessions[0];
  assert.equal(entry.status, SessionStatus.PENDING_ACTIONS);
  assert.equal(entry.action_type, 'permission_request');
});

test('handleListSessions ignores synthetic startup_pending_* entries when overlaying pending actions', async () => {
  const { ctx, sentEvents } = makeCtx();
  const pending = new Map<string, PendingBlockingEntry>([
    ['startup_pending_sess-internal', { sessionId: 'sess-internal', type: 'permission_request' }],
  ]);
  await handleListSessions(
    ctx,
    makeDeps({
      getAllTrackedSessions: () => [makeTracked()],
      pendingBlockingRequests: pending,
    }),
    baseCmd(),
  );
  const entry = lastSessionListEvent(sentEvents).sessions[0];
  assert.equal(entry.status, SessionStatus.READY); // not promoted
});

test('handleListSessions evicts long-idle synthetic startup_pending_* entries', async () => {
  const { ctx } = makeCtx();
  const pending = new Map<string, PendingBlockingEntry>([
    ['startup_pending_sess-internal', { sessionId: 'sess-internal', type: 'permission_request' }],
  ]);
  const tracked = makeTracked({
    status: SessionStatus.PENDING_ACTIONS,
    lastActivity: Date.now() - (11 * 60 * 1000), // > 10 min idle
  });
  await handleListSessions(
    ctx,
    makeDeps({
      getAllTrackedSessions: () => [tracked],
      pendingBlockingRequests: pending,
    }),
    baseCmd(),
  );
  assert.equal(pending.has('startup_pending_sess-internal'), false);
});

test('handleListSessions falls back to PID-name then basename for project_name on tracked sessions', async () => {
  const { ctx, sentEvents } = makeCtx();
  const tracked = makeTracked({
    customTitle: undefined as never,
    workingDirectory: '/code/cool-project',
    terminalPid: 999,
  });
  const running = [makeRunning({ pid: 999, sessionId: 'sess-internal', name: 'Cool' })];
  await handleListSessions(
    ctx,
    makeDeps({
      getAllTrackedSessions: () => [tracked],
      getRunningAllSessions: () => running,
    }),
    baseCmd(),
  );
  const entry = lastSessionListEvent(sentEvents).sessions[0];
  assert.equal(entry.project_name, 'Cool');
});

// ---------------------------------------------------------------------------
// Phase 2 — alive PIDs
// ---------------------------------------------------------------------------

test('handleListSessions includes alive PIDs that are not already claimed by Phase 1', async () => {
  const { ctx, sentEvents } = makeCtx();
  await handleListSessions(
    ctx,
    makeDeps({
      getRunningAllSessions: () => [makeRunning()],
    }),
    baseCmd(),
  );
  const list = lastSessionListEvent(sentEvents);
  assert.equal(list.total_count, 1);
  assert.equal(list.sessions[0].session_id, 'pid-sess');
  assert.equal(list.sessions[0].status, SessionStatus.READY);
  assert.equal(list.sessions[0].is_observed, true);
});

test('handleListSessions skips alive PIDs whose sessionId was already claimed via Phase 1', async () => {
  const { ctx, sentEvents } = makeCtx();
  const tracked = makeTracked({ sessionId: 'shared', claudeSessionId: 'shared' });
  const running = [makeRunning({ pid: 5556, sessionId: 'shared' })];
  await handleListSessions(
    ctx,
    makeDeps({
      getAllTrackedSessions: () => [tracked],
      getRunningAllSessions: () => running,
    }),
    baseCmd(),
  );
  const list = lastSessionListEvent(sentEvents);
  assert.equal(list.total_count, 1); // only Phase 1 entry
  assert.equal(list.sessions[0].session_id, 'shared');
});

test('handleListSessions enriches alive PIDs with discovered last_activity + customTitle when JSONL matches', async () => {
  const { ctx, sentEvents } = makeCtx();
  const running = [makeRunning({ sessionId: 'enriched-id' })];
  const discovered = [makeDiscovered({ sessionId: 'enriched-id', lastModified: 9999, customTitle: 'Pinned' })];
  await handleListSessions(
    ctx,
    makeDeps({
      getRunningAllSessions: () => running,
      getCachedSessions: () => discovered,
    }),
    baseCmd(),
  );
  const entry = lastSessionListEvent(sentEvents).sessions[0];
  assert.equal(entry.last_activity, 9999);
  assert.equal(entry.project_name, 'Pinned');
});

// ---------------------------------------------------------------------------
// Phase 3 — history sessions
// ---------------------------------------------------------------------------

test('handleListSessions emits HISTORY entries for discovered JSONL files with no live PID', async () => {
  const { ctx, sentEvents } = makeCtx();
  const discovered = [makeDiscovered()];
  await handleListSessions(
    ctx,
    makeDeps({ getCachedSessions: () => discovered }),
    baseCmd(),
  );
  const entry = lastSessionListEvent(sentEvents).sessions[0];
  assert.equal(entry.status, SessionStatus.HISTORY);
  assert.deepEqual(entry.capabilities, ['observe']);
});

test('handleListSessions hides discovered sessions that are in replacedSessionIds', async () => {
  const { ctx, sentEvents } = makeCtx();
  const discovered = [makeDiscovered({ sessionId: 'old-sess' })];
  await handleListSessions(
    ctx,
    makeDeps({
      getCachedSessions: () => discovered,
      replacedSessionIds: new Set(['old-sess']),
    }),
    baseCmd(),
  );
  assert.equal(lastSessionListEvent(sentEvents).total_count, 0);
});

test('handleListSessions falls back to discoverSessions() when cache is null', async () => {
  const { ctx, sentEvents } = makeCtx();
  let discoverCalled = 0;
  await handleListSessions(
    ctx,
    makeDeps({
      getCachedSessions: () => null,
      discoverSessions: async () => { discoverCalled++; return [makeDiscovered()]; },
    }),
    baseCmd(),
  );
  assert.equal(discoverCalled, 1);
  assert.equal(lastSessionListEvent(sentEvents).total_count, 1);
});

// ---------------------------------------------------------------------------
// Phase 4 — Codex
// ---------------------------------------------------------------------------

test('handleListSessions reports Codex sessions with HISTORY status when not live', async () => {
  const { ctx, sentEvents } = makeCtx();
  await handleListSessions(
    ctx,
    makeDeps({
      discoverCodexSessions: () => [makeCodex()],
    }),
    baseCmd(),
  );
  const entry = lastSessionListEvent(sentEvents).sessions[0];
  assert.equal(entry.agent_type, 'codex');
  assert.equal(entry.status, SessionStatus.HISTORY);
  assert.deepEqual(entry.capabilities, ['observe']);
  assert.equal(entry.entrypoint, 'codex-cli');
});

test('handleListSessions reports Codex live sessions with READY status and richer capabilities', async () => {
  const { ctx, sentEvents } = makeCtx();
  const codex = makeCodex();
  const live: CodexLiveSession = {
    sessionId: codex.sessionId, threadId: codex.threadId,
    pid: 7777, rolloutPath: codex.rolloutPath, lastActivityMs: 1234,
  };
  await handleListSessions(
    ctx,
    makeDeps({
      discoverCodexSessions: () => [codex],
      discoverCodexLiveSessions: () => new Map([[codex.sessionId, live]]),
      getCodexCapabilities: () => ['observe', 'terminal_remote_message'],
      resolveCodexTerminalTarget: () => ({ pid: 7777 } as CodexTerminalTargetEntry),
    }),
    baseCmd(),
  );
  const entry = lastSessionListEvent(sentEvents).sessions[0];
  assert.equal(entry.status, SessionStatus.READY);
  assert.equal(entry.pid, 7777);
  assert.deepEqual(entry.capabilities, ['observe', 'terminal_remote_message']);
});

test('handleListSessions promotes Codex status to RUNNING when the observer reports RUNNING', async () => {
  const { ctx, sentEvents } = makeCtx();
  const codex = makeCodex();
  const live: CodexLiveSession = {
    sessionId: codex.sessionId, threadId: codex.threadId,
    pid: 1, rolloutPath: codex.rolloutPath, lastActivityMs: 1,
  };
  const observer: CodexObserverInfo = { status: SessionStatus.RUNNING, lastActivity: 4242 };
  await handleListSessions(
    ctx,
    makeDeps({
      discoverCodexSessions: () => [codex],
      discoverCodexLiveSessions: () => new Map([[codex.sessionId, live]]),
      getCodexObserver: () => observer,
    }),
    baseCmd(),
  );
  const entry = lastSessionListEvent(sentEvents).sessions[0];
  assert.equal(entry.status, SessionStatus.RUNNING);
  assert.equal(entry.last_activity, 4242);
});

// ---------------------------------------------------------------------------
// Sort + history snippet
// ---------------------------------------------------------------------------

test('handleListSessions sorts active statuses ahead of HISTORY, then by last_activity desc', async () => {
  const { ctx, sentEvents } = makeCtx();
  const tracked = makeTracked({
    sessionId: 'active', claudeSessionId: 'active',
    status: SessionStatus.READY, lastActivity: 100, terminalPid: undefined as never,
  });
  const old = makeDiscovered({ sessionId: 'old', lastModified: 9999 });
  await handleListSessions(
    ctx,
    makeDeps({
      getAllTrackedSessions: () => [tracked],
      getCachedSessions: () => [old],
    }),
    baseCmd(),
  );
  const ids = lastSessionListEvent(sentEvents).sessions.map((s) => s.session_id);
  assert.deepEqual(ids, ['active', 'old']);
});

test('handleListSessions attaches truncated recent_messages and routes Codex history through getCodexHistory', async () => {
  const { ctx, sentEvents } = makeCtx();
  const longContent = 'a'.repeat(500);
  const claudeHistoryCalls: string[] = [];
  const codexHistoryCalls: string[] = [];

  const tracked = makeTracked({ sessionId: 'sess-c', claudeSessionId: 'sess-c-claude', lastActivity: 200 });
  const codex = makeCodex({ sessionId: 'codex:t', threadId: 't', updatedAtMs: 100 });

  await handleListSessions(
    ctx,
    makeDeps({
      getAllTrackedSessions: () => [tracked],
      discoverCodexSessions: () => [codex],
      getSessionHistory: (id) => {
        claudeHistoryCalls.push(id);
        return { messages: [{ role: 'user', content: longContent }], totalCount: 1, offset: 0, hasMore: false };
      },
      getCodexHistory: (id) => {
        codexHistoryCalls.push(id);
        return { messages: [{ role: 'assistant', content: 'codex out', toolName: 'Bash' }], totalCount: 1, offset: 0, hasMore: false };
      },
    }),
    baseCmd(),
  );
  const sessions = lastSessionListEvent(sentEvents).sessions;
  const claudeEntry = sessions.find((s) => s.session_id === 'sess-c') as Record<string, unknown>;
  const codexEntry = sessions.find((s) => s.session_id === 'codex:t') as Record<string, unknown>;
  const claudeMsgs = claudeEntry.recent_messages as Array<{ content: string }>;
  const codexMsgs = codexEntry.recent_messages as Array<{ content: string; tool_name?: string }>;
  assert.equal(claudeMsgs[0].content.length, 200); // truncated
  assert.deepEqual(claudeHistoryCalls, ['sess-c-claude']);
  assert.deepEqual(codexHistoryCalls, ['codex:t']);
  assert.equal(codexMsgs[0].tool_name, 'Bash');
});

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------

test('handleListSessions emits LIST_SESSIONS_ERROR when discovery throws', async () => {
  const { ctx, sentErrors } = makeCtx();
  await handleListSessions(
    ctx,
    makeDeps({
      getCachedSessions: () => null,
      discoverSessions: async () => { throw new Error('disk dead'); },
    }),
    baseCmd(),
  );
  assert.equal(sentErrors[0].code, 'LIST_SESSIONS_ERROR');
  assert.ok(sentErrors[0].message.includes('disk dead'));
  assert.equal(sentErrors[0].requestId, 'req-1');
});
