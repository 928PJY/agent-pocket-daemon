import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discoverAndObserveSessions,
  discoverAndObserveCodexSessions,
  type ClaudeDiscoveryDeps,
  type CodexDiscoveryDeps,
  type CodexObserverEntry,
} from '../src/wiring/session-discovery-loop.js';
import { SessionStatus, type PcEvent } from 'agent-pocket-protocol';

// ---------------------------------------------------------------------------
// Test harness — fakes for SessionDiscovery / SessionManager / session-map
// ---------------------------------------------------------------------------

interface FakeRunningCli {
  pid: number;
  sessionId: string;
  cwd: string;
  terminalTarget?: { type: string; target: string };
  entrypoint: string;
}

interface FakeDiscoveredSession {
  sessionId: string;
  projectDir: string;
  lastModified: number;
  filePath: string;
  customTitle?: string;
}

interface FakeObserverState {
  jsonlPath: string;
}

interface FakeSession {
  sessionId: string;        // internal id
  claudeSessionId?: string;
  isObserved?: boolean;
  terminalPid?: number;
  workingDirectory?: string;
  terminalTarget?: { type: string; target: string };
  entrypoint?: string;
  observer?: FakeObserverState;
  lastActivity?: number;
}

interface ObserveCall {
  claudeSessionId: string;
  filePath: string;
  cwd: string;
  pid: number;
  customTitle?: string;
  terminalTarget?: { type: string; target: string };
  entrypoint?: string;
  internalId: string;
}

interface ClaudeFixture {
  deps: ClaudeDiscoveryDeps;
  sentEvents: PcEvent[];
  historyCalls: string[];
  observeCalls: ObserveCall[];
  removeCalls: string[];
  markedHistory: string[];
  sessions: FakeSession[];
  sessionIdMap: Map<string, string>;
  replacedSessionIds: Set<string>;
  sessionMap: Record<string, { pid?: number; cwd: string; timestamp: number }>;
  removedMapEntries: string[][];
  fakeStat: Map<string, { mtimeMs: number }>;
  alivePids: Set<number>;
  initialDone: boolean;
  setInitialDone(v: boolean): void;
  internalIdCounter: number;
}

function makeClaudeFixture(opts: {
  runningCli: FakeRunningCli[];
  discovered: FakeDiscoveredSession[];
  sessions?: FakeSession[];
  sessionIdMap?: Array<[string, string]>;
  replacedSessionIds?: string[];
  sessionMap?: Record<string, { pid?: number; cwd: string; timestamp: number }>;
  fakeStat?: Map<string, { mtimeMs: number }>;
  alivePids?: number[];
  initialDone?: boolean;
  now?: number;
  throwOnDiscoverSessions?: boolean;
  skipOverridePid?: number;
}): ClaudeFixture {
  const sentEvents: PcEvent[] = [];
  const historyCalls: string[] = [];
  const observeCalls: ObserveCall[] = [];
  const removeCalls: string[] = [];
  const markedHistory: string[] = [];
  const sessions: FakeSession[] = opts.sessions ?? [];
  const sessionIdMap = new Map<string, string>(opts.sessionIdMap ?? []);
  const replacedSessionIds = new Set<string>(opts.replacedSessionIds ?? []);
  const sessionMap = opts.sessionMap ?? {};
  const removedMapEntries: string[][] = [];
  const fakeStat = opts.fakeStat ?? new Map();
  const alivePids = new Set<number>(opts.alivePids ?? []);
  let initialDone = opts.initialDone ?? false;
  let counter = 1;

  const deps: ClaudeDiscoveryDeps = {
    sessionDiscovery: {
      getRunningAllSessions: () => opts.runningCli as never,
      discoverSessions: async () => {
        if (opts.throwOnDiscoverSessions) throw new Error('discover boom');
        return opts.discovered as never;
      },
    },
    sessionManager: {
      getAllSessions: () => sessions.map(s => ({
        ...s,
        observer: s.observer
          ? { ...s.observer, getJsonlPath: () => s.observer!.jsonlPath }
          : undefined,
      })) as never,
      findByClaudeSessionId: (csid: string) => {
        const s = sessions.find(x => x.claudeSessionId === csid);
        if (!s) return undefined as never;
        return ({ ...s, observer: s.observer ? { ...s.observer, getJsonlPath: () => s.observer!.jsonlPath } : undefined }) as never;
      },
      findByTerminalPid: (pid: number) => {
        const s = sessions.find(x => x.terminalPid === pid);
        if (!s) return undefined as never;
        return ({ ...s, observer: s.observer ? { ...s.observer, getJsonlPath: () => s.observer!.jsonlPath } : undefined }) as never;
      },
      observeSession: ((csid, fp, cwd, pid, title, target, entrypoint) => {
        const internalId = `internal-${counter++}`;
        observeCalls.push({ claudeSessionId: csid, filePath: fp, cwd, pid, customTitle: title, terminalTarget: target as never, entrypoint, internalId });
        sessions.push({
          sessionId: internalId,
          claudeSessionId: csid,
          isObserved: true,
          terminalPid: pid,
          workingDirectory: cwd,
          observer: { jsonlPath: fp },
          terminalTarget: target as never,
          entrypoint,
        });
        return internalId;
      }) as never,
      removeSession: (id: string) => {
        removeCalls.push(id);
        const idx = sessions.findIndex(s => s.sessionId === id);
        if (idx >= 0) sessions.splice(idx, 1);
      },
      markObservedSessionHistory: (id: string) => { markedHistory.push(id); },
    },
    sessionIdMap,
    replacedSessionIds,
    isInitialDiscoveryDone: () => initialDone,
    sendToPhone: (e) => sentEvents.push(e),
    sendSessionHistory: (id) => { historyCalls.push(id); },
    readSessionMap: () => sessionMap,
    getLatestSessionMapEntryForPid: (pid: number) => {
      if (opts.skipOverridePid === pid) return undefined;
      let latest: { sessionId: string; cwd: string; timestamp: number } | undefined;
      for (const [sid, v] of Object.entries(sessionMap)) {
        if (v.pid !== pid) continue;
        if (!latest || v.timestamp > latest.timestamp) latest = { sessionId: sid, cwd: v.cwd, timestamp: v.timestamp };
      }
      return latest ? { sessionId: latest.sessionId, cwd: latest.cwd } : undefined;
    },
    removeSessionMapEntries: (ids: string[]) => { removedMapEntries.push(ids); },
    statSyncFn: (p: string) => {
      const s = fakeStat.get(p);
      if (!s) throw new Error('ENOENT');
      return s;
    },
    killFn: (pid: number) => {
      if (!alivePids.has(pid)) throw new Error('ESRCH');
    },
    nowFn: () => opts.now ?? 1_000_000_000,
  };

  return {
    deps, sentEvents, historyCalls, observeCalls, removeCalls, markedHistory,
    sessions, sessionIdMap, replacedSessionIds, sessionMap, removedMapEntries,
    fakeStat, alivePids,
    get initialDone() { return initialDone; },
    setInitialDone(v: boolean) { initialDone = v; },
    internalIdCounter: counter,
  };
}

// ---------------------------------------------------------------------------
// discoverAndObserveSessions — Claude
// ---------------------------------------------------------------------------

test('claude discovery: no running CLI sessions short-circuits before discoverSessions()', async () => {
  let discoverCalled = false;
  const f = makeClaudeFixture({ runningCli: [], discovered: [] });
  // Replace discoverSessions to detect call
  f.deps.sessionDiscovery = {
    getRunningAllSessions: () => [] as never,
    discoverSessions: async () => { discoverCalled = true; return []; },
  };
  await discoverAndObserveSessions(f.deps);
  assert.equal(discoverCalled, false);
  assert.equal(f.observeCalls.length, 0);
});

test('claude discovery: fresh observation creates session and maps internal->external', async () => {
  const f = makeClaudeFixture({
    runningCli: [{ pid: 1234, sessionId: 'claude-uuid-1', cwd: '/proj', entrypoint: 'claude' }],
    discovered: [{ sessionId: 'claude-uuid-1', projectDir: '/proj', lastModified: 100, filePath: '/proj/.claude/abc.jsonl' }],
    initialDone: true,
  });
  await discoverAndObserveSessions(f.deps);
  assert.equal(f.observeCalls.length, 1);
  assert.equal(f.observeCalls[0].claudeSessionId, 'claude-uuid-1');
  assert.equal(f.sessionIdMap.get(f.observeCalls[0].internalId), 'claude-uuid-1');
  assert.deepEqual(f.historyCalls, ['claude-uuid-1']);
});

test('claude discovery: skips sendSessionHistory while initial discovery in flight', async () => {
  const f = makeClaudeFixture({
    runningCli: [{ pid: 1234, sessionId: 'claude-uuid-1', cwd: '/proj', entrypoint: 'claude' }],
    discovered: [{ sessionId: 'claude-uuid-1', projectDir: '/proj', lastModified: 100, filePath: '/proj/.claude/abc.jsonl' }],
    initialDone: false,
  });
  await discoverAndObserveSessions(f.deps);
  assert.equal(f.observeCalls.length, 1);
  assert.deepEqual(f.historyCalls, []);
});

test('claude discovery: skips already-observed (same claudeSessionId)', async () => {
  const f = makeClaudeFixture({
    runningCli: [{ pid: 1234, sessionId: 'claude-uuid-1', cwd: '/proj', entrypoint: 'claude' }],
    discovered: [{ sessionId: 'claude-uuid-1', projectDir: '/proj', lastModified: 100, filePath: '/proj/.claude/abc.jsonl' }],
    sessions: [{ sessionId: 'internal-existing', claudeSessionId: 'claude-uuid-1' }],
  });
  await discoverAndObserveSessions(f.deps);
  assert.equal(f.observeCalls.length, 0);
});

test('claude discovery: session-map.json overrides PID JSON when entry exists with different sessionId', async () => {
  const f = makeClaudeFixture({
    runningCli: [{ pid: 1234, sessionId: 'pid-stale', cwd: '/proj', entrypoint: 'claude' }],
    discovered: [{ sessionId: 'map-fresh', projectDir: '/proj-real', lastModified: 200, filePath: '/proj-real/.claude/x.jsonl' }],
    sessionMap: { 'map-fresh': { pid: 1234, cwd: '/proj-real', timestamp: 999 } },
    initialDone: true,
  });
  await discoverAndObserveSessions(f.deps);
  assert.ok(f.replacedSessionIds.has('pid-stale'));
  assert.equal(f.observeCalls.length, 1);
  assert.equal(f.observeCalls[0].claudeSessionId, 'map-fresh');
  assert.equal(f.observeCalls[0].cwd, '/proj-real');
});

test('claude discovery: PID mismatch re-observes (drops old, creates new) without sending session_ended', async () => {
  const existing: FakeSession = {
    sessionId: 'internal-old', claudeSessionId: 'old-claude', terminalPid: 5555,
    isObserved: true, workingDirectory: '/proj', observer: { jsonlPath: '/proj/.claude/old.jsonl' },
  };
  const f = makeClaudeFixture({
    runningCli: [{ pid: 5555, sessionId: 'new-claude', cwd: '/proj', entrypoint: 'claude' }],
    discovered: [{ sessionId: 'new-claude', projectDir: '/proj', lastModified: 200, filePath: '/proj/.claude/new.jsonl' }],
    sessions: [existing],
  });
  await discoverAndObserveSessions(f.deps);
  assert.deepEqual(f.markedHistory, ['internal-old']);
  assert.deepEqual(f.removeCalls, ['internal-old']);
  assert.ok(f.replacedSessionIds.has('old-claude'));
  assert.equal(f.observeCalls.length, 1);
  assert.equal(f.observeCalls[0].claudeSessionId, 'new-claude');
  // No session_ended event for stale id
  assert.equal(f.sentEvents.filter(e => (e as { type?: string }).type === 'session_ended').length, 0);
});

test('claude discovery: PID mismatch where new sessionId already in replacedSessionIds → existingByPid wins (skip)', async () => {
  const existing: FakeSession = {
    sessionId: 'internal-old', claudeSessionId: 'old-claude', terminalPid: 5555,
    isObserved: true, workingDirectory: '/proj', observer: { jsonlPath: '/proj/.claude/old.jsonl' },
  };
  const f = makeClaudeFixture({
    runningCli: [{ pid: 5555, sessionId: 'replaced-claude', cwd: '/proj', entrypoint: 'claude' }],
    discovered: [{ sessionId: 'replaced-claude', projectDir: '/proj', lastModified: 200, filePath: '/proj/.claude/y.jsonl' }],
    sessions: [existing],
    replacedSessionIds: ['replaced-claude'],
  });
  await discoverAndObserveSessions(f.deps);
  // replaced-claude is in replacedSet, so PID-mismatch path is skipped (still goes to existingByPid==current) and continues
  assert.equal(f.observeCalls.length, 0);
});

test('claude discovery: stale PID file recovers via session-map.json fallback', async () => {
  // pidInfo.sessionId='pid-stale' is in replacedSet. There is no map entry for that pid that overrides
  // (we deliberately omit pid: 9999 from the override path). Then we hit the replacedSet recovery branch.
  const f = makeClaudeFixture({
    runningCli: [{ pid: 9999, sessionId: 'pid-stale', cwd: '/proj', entrypoint: 'claude' }],
    discovered: [{ sessionId: 'recovered', projectDir: '/proj', lastModified: 300, filePath: '/proj/.claude/recovered.jsonl' }],
    replacedSessionIds: ['pid-stale'],
    sessionMap: {
      // No pid match for getLatestSessionMapEntryForPid (different pid), so override skipped.
      // Recovery branch (readSessionMap) iterates these for pid match.
      'recovered': { pid: 9999, cwd: '/proj-actual', timestamp: 5000 },
      'older-stale': { pid: 9999, cwd: '/proj', timestamp: 100 },
    },
    initialDone: true,
    // Block the override path: skip getLatestSessionMapEntryForPid pid 9999 by overriding the dep.
    skipOverridePid: 9999,
  });
  await discoverAndObserveSessions(f.deps);
  assert.equal(f.observeCalls.length, 1);
  assert.equal(f.observeCalls[0].claudeSessionId, 'recovered');
  assert.equal(f.observeCalls[0].cwd, '/proj-actual');
  // older-stale evicted as a stale entry
  assert.deepEqual(f.removedMapEntries, [['older-stale']]);
  assert.deepEqual(f.historyCalls, ['recovered']);
});

test('claude discovery: stale PID file with no map fallback → no observe', async () => {
  const f = makeClaudeFixture({
    runningCli: [{ pid: 9999, sessionId: 'pid-stale', cwd: '/proj', entrypoint: 'claude' }],
    discovered: [],
    replacedSessionIds: ['pid-stale'],
    sessionMap: {},
  });
  await discoverAndObserveSessions(f.deps);
  assert.equal(f.observeCalls.length, 0);
});

test('claude discovery: prefers newer unclaimed JSONL over PID JSON match', async () => {
  const f = makeClaudeFixture({
    runningCli: [{ pid: 7777, sessionId: 'pid-claimed', cwd: '/proj', entrypoint: 'claude' }],
    discovered: [
      { sessionId: 'pid-claimed', projectDir: '/proj', lastModified: 100, filePath: '/proj/.claude/old.jsonl' },
      { sessionId: 'newer', projectDir: '/proj', lastModified: 500, filePath: '/proj/.claude/new.jsonl' },
    ],
  });
  await discoverAndObserveSessions(f.deps);
  assert.equal(f.observeCalls.length, 1);
  assert.equal(f.observeCalls[0].claudeSessionId, 'newer');
  assert.ok(f.replacedSessionIds.has('pid-claimed'));
});

test('claude discovery: skips newer JSONL claimed by another running PID', async () => {
  const f = makeClaudeFixture({
    runningCli: [
      { pid: 7777, sessionId: 'mine', cwd: '/proj', entrypoint: 'claude' },
      { pid: 8888, sessionId: 'theirs', cwd: '/proj', entrypoint: 'claude' },
    ],
    discovered: [
      { sessionId: 'mine', projectDir: '/proj', lastModified: 100, filePath: '/proj/.claude/mine.jsonl' },
      { sessionId: 'theirs', projectDir: '/proj', lastModified: 500, filePath: '/proj/.claude/theirs.jsonl' },
    ],
  });
  await discoverAndObserveSessions(f.deps);
  // 'mine' should observe 'mine' (not 'theirs', which belongs to other PID)
  const mineObserve = f.observeCalls.find(o => o.pid === 7777);
  assert.equal(mineObserve!.claudeSessionId, 'mine');
});

test('claude discovery: catches errors and logs (does not throw)', async () => {
  const f = makeClaudeFixture({
    runningCli: [{ pid: 1, sessionId: 'a', cwd: '/p', entrypoint: 'claude' }],
    discovered: [],
    throwOnDiscoverSessions: true,
  });
  await discoverAndObserveSessions(f.deps);
  assert.equal(f.observeCalls.length, 0);
});

// ---------------------------------------------------------------------------
// /clear detection
// ---------------------------------------------------------------------------

test('claude /clear: detects new JSONL when current file is stale + PID alive', async () => {
  const observed: FakeSession = {
    sessionId: 'internal-old', claudeSessionId: 'old-claude', isObserved: true,
    terminalPid: 4242, workingDirectory: '/proj', lastActivity: 100,
    observer: { jsonlPath: '/proj/.claude/old.jsonl' },
    terminalTarget: { type: 'tmux', target: 's:0' },
  };
  const f = makeClaudeFixture({
    runningCli: [{ pid: 4242, sessionId: 'old-claude', cwd: '/proj', entrypoint: 'claude' }],
    discovered: [
      { sessionId: 'old-claude', projectDir: '/proj', lastModified: 100, filePath: '/proj/.claude/old.jsonl' },
      { sessionId: 'cleared-new', projectDir: '/proj', lastModified: 500, filePath: '/proj/.claude/new.jsonl' },
    ],
    sessions: [observed],
    fakeStat: new Map([['/proj/.claude/old.jsonl', { mtimeMs: 0 }]]),
    alivePids: [4242],
    now: 1_000_000_000,
    initialDone: true,
  });
  await discoverAndObserveSessions(f.deps);
  // session_ended emitted for old-claude
  assert.equal(f.sentEvents.length, 1);
  const ended = f.sentEvents[0] as unknown as { type: string; session_id: string };
  assert.equal(ended.type, 'session_ended');
  assert.equal(ended.session_id, 'old-claude');
  // Old session removed and replacement registered
  assert.ok(f.replacedSessionIds.has('old-claude'));
  // New observe call for cleared-new
  const cleared = f.observeCalls.find(o => o.claudeSessionId === 'cleared-new');
  assert.ok(cleared);
  // History sent
  assert.ok(f.historyCalls.includes('cleared-new'));
});

test('claude /clear: skipped when current JSONL was modified within 10s', async () => {
  const observed: FakeSession = {
    sessionId: 'internal-old', claudeSessionId: 'old-claude', isObserved: true,
    terminalPid: 4242, workingDirectory: '/proj', lastActivity: 100,
    observer: { jsonlPath: '/proj/.claude/old.jsonl' },
  };
  const f = makeClaudeFixture({
    runningCli: [{ pid: 4242, sessionId: 'old-claude', cwd: '/proj', entrypoint: 'claude' }],
    discovered: [
      { sessionId: 'old-claude', projectDir: '/proj', lastModified: 100, filePath: '/proj/.claude/old.jsonl' },
      { sessionId: 'maybe-new', projectDir: '/proj', lastModified: 500, filePath: '/proj/.claude/new.jsonl' },
    ],
    sessions: [observed],
    fakeStat: new Map([['/proj/.claude/old.jsonl', { mtimeMs: 999_995_000 }]]), // 5s ago
    alivePids: [4242],
    now: 1_000_000_000,
  });
  await discoverAndObserveSessions(f.deps);
  // No /clear handling
  assert.equal(f.sentEvents.length, 0);
  assert.equal(f.replacedSessionIds.has('old-claude'), false);
});

test('claude /clear: skipped when PID is dead', async () => {
  const observed: FakeSession = {
    sessionId: 'internal-old', claudeSessionId: 'old-claude', isObserved: true,
    terminalPid: 4242, workingDirectory: '/proj',
    observer: { jsonlPath: '/proj/.claude/old.jsonl' },
  };
  const f = makeClaudeFixture({
    runningCli: [],
    discovered: [],
    sessions: [observed],
    alivePids: [],
  });
  await discoverAndObserveSessions(f.deps);
  // runningCli is empty so we early-return; nothing happens
  assert.equal(f.sentEvents.length, 0);
});

test('claude /clear: skipped when newer JSONL belongs to a different running PID', async () => {
  const observed: FakeSession = {
    sessionId: 'internal-A', claudeSessionId: 'A', isObserved: true,
    terminalPid: 100, workingDirectory: '/proj', lastActivity: 100,
    observer: { jsonlPath: '/proj/A.jsonl' },
  };
  const f = makeClaudeFixture({
    runningCli: [
      { pid: 100, sessionId: 'A', cwd: '/proj', entrypoint: 'claude' },
      { pid: 200, sessionId: 'B', cwd: '/proj', entrypoint: 'claude' },
    ],
    discovered: [
      { sessionId: 'A', projectDir: '/proj', lastModified: 100, filePath: '/proj/A.jsonl' },
      { sessionId: 'B', projectDir: '/proj', lastModified: 500, filePath: '/proj/B.jsonl' },
    ],
    sessions: [observed],
    fakeStat: new Map([['/proj/A.jsonl', { mtimeMs: 0 }]]),
    alivePids: [100, 200],
    now: 1_000_000_000,
  });
  await discoverAndObserveSessions(f.deps);
  // Should NOT treat as /clear of A (B is owned by another PID).
  assert.equal(f.sentEvents.filter(e => (e as { type?: string }).type === 'session_ended').length, 0);
});

// ---------------------------------------------------------------------------
// discoverAndObserveCodexSessions — Codex
// ---------------------------------------------------------------------------

interface FakeCodexSession {
  sessionId: string;
  rolloutPath: string;
  updatedAtMs?: number;
}

function makeCodexFixture(opts: {
  sessions: FakeCodexSession[];
  liveSet: Set<string>;
  observers?: Array<[string, CodexObserverEntry]>;
  initialDone?: boolean;
  throwOnDiscover?: boolean;
}): {
  deps: CodexDiscoveryDeps;
  observers: Map<string, CodexObserverEntry>;
  sentEvents: PcEvent[];
  attached: CodexObserverEntry[];
  startedObservers: string[];
} {
  const observers = new Map<string, CodexObserverEntry>(opts.observers ?? []);
  const sentEvents: PcEvent[] = [];
  const attached: CodexObserverEntry[] = [];
  const startedObservers: string[] = [];

  const deps: CodexDiscoveryDeps = {
    codexDiscovery: {
      discoverSessions: () => {
        if (opts.throwOnDiscover) throw new Error('codex boom');
        return opts.sessions as never;
      },
      discoverLiveSessions: () => opts.liveSet as never,
    },
    codexObservers: observers,
    isInitialDiscoveryDone: () => opts.initialDone ?? false,
    sendToPhone: (e) => sentEvents.push(e),
    attachCodexObserverHandlers: (t) => attached.push(t),
    createObserver: (sid: string) => ({ start() { startedObservers.push(sid); } } as never),
    nowFn: () => 5_000,
  };

  return { deps, observers, sentEvents, attached, startedObservers };
}

test('codex discovery: creates new observer for unseen session and emits no status until initial done', () => {
  const f = makeCodexFixture({
    sessions: [{ sessionId: 'codex-1', rolloutPath: '/r/codex-1', updatedAtMs: 1234 }],
    liveSet: new Set(['codex-1']),
    initialDone: false,
  });
  discoverAndObserveCodexSessions(f.deps);
  assert.equal(f.observers.size, 1);
  const tracked = f.observers.get('codex-1')!;
  assert.equal(tracked.status, SessionStatus.READY);
  assert.equal(tracked.lastActivity, 1234);
  assert.deepEqual(f.attached, [tracked]);
  assert.deepEqual(f.startedObservers, ['codex-1']);
  // No status event because no existing entry to transition
  assert.equal(f.sentEvents.length, 0);
});

test('codex discovery: new observer for non-live session uses HISTORY status', () => {
  const f = makeCodexFixture({
    sessions: [{ sessionId: 'c1', rolloutPath: '/r/c1' }],
    liveSet: new Set(),
  });
  discoverAndObserveCodexSessions(f.deps);
  assert.equal(f.observers.get('c1')!.status, SessionStatus.HISTORY);
});

test('codex discovery: new observer without updatedAtMs falls back to nowFn()', () => {
  const f = makeCodexFixture({
    sessions: [{ sessionId: 'c1', rolloutPath: '/r/c1' }],
    liveSet: new Set(['c1']),
  });
  discoverAndObserveCodexSessions(f.deps);
  assert.equal(f.observers.get('c1')!.lastActivity, 5_000);
});

test('codex discovery: existing observer transitions READY → HISTORY when no longer live; emits status when initial done', () => {
  const existing: CodexObserverEntry = {
    observer: { start() {} } as never,
    session: { sessionId: 'c1', rolloutPath: '/r/c1' } as never,
    status: SessionStatus.READY,
    lastActivity: 1,
  };
  const f = makeCodexFixture({
    sessions: [{ sessionId: 'c1', rolloutPath: '/r/c1' }],
    liveSet: new Set(),
    observers: [['c1', existing]],
    initialDone: true,
  });
  discoverAndObserveCodexSessions(f.deps);
  assert.equal(existing.status, SessionStatus.HISTORY);
  assert.equal(f.sentEvents.length, 1);
  const ev = f.sentEvents[0] as unknown as { type: string; status: SessionStatus; session_id: string };
  assert.equal(ev.type, 'session_status');
  assert.equal(ev.status, SessionStatus.HISTORY);
  assert.equal(ev.session_id, 'c1');
});

test('codex discovery: existing RUNNING observer with live=true keeps RUNNING (no transition)', () => {
  const existing: CodexObserverEntry = {
    observer: { start() {} } as never,
    session: { sessionId: 'c1', rolloutPath: '/r/c1' } as never,
    status: SessionStatus.RUNNING,
    lastActivity: 1,
  };
  const f = makeCodexFixture({
    sessions: [{ sessionId: 'c1', rolloutPath: '/r/c1' }],
    liveSet: new Set(['c1']),
    observers: [['c1', existing]],
    initialDone: true,
  });
  discoverAndObserveCodexSessions(f.deps);
  assert.equal(existing.status, SessionStatus.RUNNING);
  assert.equal(f.sentEvents.length, 0);
});

test('codex discovery: existing HISTORY observer that becomes live transitions to READY', () => {
  const existing: CodexObserverEntry = {
    observer: { start() {} } as never,
    session: { sessionId: 'c1', rolloutPath: '/r/c1' } as never,
    status: SessionStatus.HISTORY,
    lastActivity: 1,
  };
  const f = makeCodexFixture({
    sessions: [{ sessionId: 'c1', rolloutPath: '/r/c1' }],
    liveSet: new Set(['c1']),
    observers: [['c1', existing]],
    initialDone: true,
  });
  discoverAndObserveCodexSessions(f.deps);
  assert.equal(existing.status, SessionStatus.READY);
  assert.equal((f.sentEvents[0] as unknown as { status: SessionStatus }).status, SessionStatus.READY);
});

test('codex discovery: existing PENDING_ACTIONS observer with live=true keeps PENDING_ACTIONS', () => {
  const existing: CodexObserverEntry = {
    observer: { start() {} } as never,
    session: { sessionId: 'c1', rolloutPath: '/r/c1' } as never,
    status: SessionStatus.PENDING_ACTIONS,
    lastActivity: 1,
  };
  const f = makeCodexFixture({
    sessions: [{ sessionId: 'c1', rolloutPath: '/r/c1' }],
    liveSet: new Set(['c1']),
    observers: [['c1', existing]],
    initialDone: true,
  });
  discoverAndObserveCodexSessions(f.deps);
  assert.equal(existing.status, SessionStatus.PENDING_ACTIONS);
  assert.equal(f.sentEvents.length, 0);
});

test('codex discovery: status transition while initial discovery in flight does NOT emit', () => {
  const existing: CodexObserverEntry = {
    observer: { start() {} } as never,
    session: { sessionId: 'c1', rolloutPath: '/r/c1' } as never,
    status: SessionStatus.READY,
    lastActivity: 1,
  };
  const f = makeCodexFixture({
    sessions: [{ sessionId: 'c1', rolloutPath: '/r/c1' }],
    liveSet: new Set(),
    observers: [['c1', existing]],
    initialDone: false,
  });
  discoverAndObserveCodexSessions(f.deps);
  assert.equal(existing.status, SessionStatus.HISTORY);
  assert.equal(f.sentEvents.length, 0);
});

test('codex discovery: catches errors and logs (does not throw)', () => {
  const f = makeCodexFixture({
    sessions: [], liveSet: new Set(), throwOnDiscover: true,
  });
  discoverAndObserveCodexSessions(f.deps);
  assert.equal(f.observers.size, 0);
});
