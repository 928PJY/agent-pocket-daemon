import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PcEvent } from 'agent-pocket-protocol';
import { SessionStatus } from 'agent-pocket-protocol';
import type { CommandContext, SendSessionHistoryOptions } from '../src/commands/command-context.js';
import {
  handleNewSession,
  handleResumeSession,
  handleKillSession,
  handleInterruptSession,
  handleRewindSession,
  type CodexLifecycleDeps,
} from '../src/commands/handlers/session-lifecycle.js';

interface SentEvent { event: PcEvent; }
interface SentError { requestId?: string; message: string; code: string; }

interface FakeSessionManager {
  createSession?: (cfg: unknown) => string;
  resumeSession?: (claudeId: string, opts: unknown) => string;
  findByClaudeSessionId?: (id: string) => { sessionId: string; terminalPid?: number } | undefined;
  markObservedSessionHistory?: (id: string) => void;
  killSession?: (id: string) => Promise<void>;
  interruptSession?: (id: string) => Promise<void>;
  rewindSession?: (id: string, msgId: string, dryRun: boolean) => Promise<{
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
    newSessionId?: string;
  }>;
}

function makeCtx(overrides: {
  sessionManager?: FakeSessionManager;
  resolveInternalSessionId?: (id: string) => string | undefined;
  resolveExternalSessionId?: (id: string) => string;
  sendSessionHistory?: (id: string, opts?: SendSessionHistoryOptions) => number | undefined;
} = {}) {
  const sentEvents: SentEvent[] = [];
  const sentErrors: SentError[] = [];
  const sessionIdMap = new Map<string, string>();
  const pendingSessionRequests = new Map<string, string>();
  const ctx: CommandContext = {
    sendToPhone: (event) => { sentEvents.push({ event }); },
    sendError: (requestId, message, code) => { sentErrors.push({ requestId, message, code }); },
    resolveInternalSessionId: overrides.resolveInternalSessionId ?? ((id) => id),
    resolveExternalSessionId: overrides.resolveExternalSessionId ?? ((id) => id),
    sendSessionHistory: overrides.sendSessionHistory ?? (() => undefined),
    sessionManager: (overrides.sessionManager ?? {}) as unknown as CommandContext['sessionManager'],
    sessionIdMap,
    pendingSessionRequests,
  };
  return { ctx, sentEvents, sentErrors, sessionIdMap, pendingSessionRequests };
}

interface CodexHarness {
  deps: CodexLifecycleDeps;
  observers: CodexLifecycleDeps['codexObservers'];
  interrupts: unknown[];
  resolveTarget: (id: string) => { target?: unknown } | undefined;
}

function makeCodex(overrides: {
  observers?: Map<string, { status: SessionStatus; observer: { stop(): void; stopped?: boolean } }>;
  resolveTarget?: (id: string) => { target?: unknown } | undefined;
  sendTerminalInterrupt?: (target: unknown) => void;
} = {}): CodexHarness {
  const interrupts: unknown[] = [];
  const observers = overrides.observers ?? new Map();
  const resolveTarget = overrides.resolveTarget ?? (() => undefined);
  const deps: CodexLifecycleDeps = {
    codexObservers: observers,
    resolveCodexTerminalTarget: resolveTarget,
    sendTerminalInterrupt: overrides.sendTerminalInterrupt
      ?? ((t) => { interrupts.push(t); }),
  };
  return { deps, observers, interrupts, resolveTarget };
}

// ---------------------------------------------------------------------------
// handleNewSession
// ---------------------------------------------------------------------------

test('handleNewSession creates a session and tracks the request_id', () => {
  let receivedCfg: unknown;
  const { ctx, sentErrors, pendingSessionRequests } = makeCtx({
    sessionManager: {
      createSession: (cfg) => { receivedCfg = cfg; return 'sess_internal_1'; },
    },
  });
  handleNewSession(ctx, {
    type: 'new_session',
    request_id: 'req-1',
    config: {
      name: 'My Session',
      agent_type: 'claude_code',
      working_directory: '/tmp/x',
      model: 'opus',
      system_prompt: 'sp',
      allowed_tools: ['bash'],
      dangerously_skip_permissions: false,
    },
  } as never);

  assert.equal(sentErrors.length, 0);
  assert.equal(pendingSessionRequests.get('req-1'), 'sess_internal_1');
  assert.deepEqual(receivedCfg, {
    name: 'My Session',
    agent_type: 'claude_code',
    working_directory: '/tmp/x',
    model: 'opus',
    system_prompt: 'sp',
    allowed_tools: ['bash'],
    dangerously_skip_permissions: false,
  });
});

test('handleNewSession rejects unsupported agent_type', () => {
  const { ctx, sentErrors, pendingSessionRequests } = makeCtx({
    sessionManager: { createSession: () => 'should-not-be-called' },
  });
  handleNewSession(ctx, {
    type: 'new_session',
    request_id: 'req-2',
    config: { agent_type: 'codex', working_directory: '/tmp' },
  } as never);

  assert.equal(pendingSessionRequests.size, 0);
  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'SESSION_CREATE_ERROR');
  assert.equal(sentErrors[0].requestId, 'req-2');
  assert.match(sentErrors[0].message, /not yet supported/);
});

test('handleNewSession surfaces createSession errors', () => {
  const { ctx, sentErrors, pendingSessionRequests } = makeCtx({
    sessionManager: {
      createSession: () => { throw new Error('disk full'); },
    },
  });
  handleNewSession(ctx, {
    type: 'new_session',
    request_id: 'req-3',
    config: { agent_type: 'claude_code', working_directory: '/tmp' },
  } as never);

  assert.equal(pendingSessionRequests.size, 0);
  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'SESSION_CREATE_ERROR');
  assert.match(sentErrors[0].message, /disk full/);
});

// ---------------------------------------------------------------------------
// handleResumeSession
// ---------------------------------------------------------------------------

test('handleResumeSession resumes and maps internal -> claude id', () => {
  const marked: string[] = [];
  const { ctx, sentErrors, sessionIdMap, pendingSessionRequests } = makeCtx({
    sessionManager: {
      findByClaudeSessionId: () => undefined,
      markObservedSessionHistory: (id) => { marked.push(id); },
      resumeSession: () => 'sess_internal_2',
    },
  });
  handleResumeSession(ctx, {
    type: 'resume_session',
    request_id: 'req-1',
    session_id: 'claude-abc',
  } as never);

  assert.equal(sentErrors.length, 0);
  assert.equal(marked.length, 0);
  assert.equal(sessionIdMap.get('sess_internal_2'), 'claude-abc');
  assert.equal(pendingSessionRequests.get('req-1'), 'sess_internal_2');
});

test('handleResumeSession stops an existing observer before resuming', () => {
  const marked: string[] = [];
  const { ctx } = makeCtx({
    sessionManager: {
      findByClaudeSessionId: (id) => id === 'claude-xyz'
        ? { sessionId: 'sess_old', terminalPid: 4242 }
        : undefined,
      markObservedSessionHistory: (id) => { marked.push(id); },
      resumeSession: () => 'sess_new',
    },
  });
  handleResumeSession(ctx, {
    type: 'resume_session',
    request_id: 'req-9',
    session_id: 'claude-xyz',
  } as never);

  assert.deepEqual(marked, ['sess_old']);
});

test('handleResumeSession surfaces resumeSession errors', () => {
  const { ctx, sentErrors, sessionIdMap, pendingSessionRequests } = makeCtx({
    sessionManager: {
      findByClaudeSessionId: () => undefined,
      resumeSession: () => { throw new Error('not found'); },
    },
  });
  handleResumeSession(ctx, {
    type: 'resume_session',
    request_id: 'req-7',
    session_id: 'claude-missing',
  } as never);

  assert.equal(sessionIdMap.size, 0);
  assert.equal(pendingSessionRequests.size, 0);
  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'SESSION_RESUME_ERROR');
  assert.match(sentErrors[0].message, /not found/);
});

// ---------------------------------------------------------------------------
// handleKillSession
// ---------------------------------------------------------------------------

test('handleKillSession kills a tracked SDK session via sessionManager', async () => {
  const killed: string[] = [];
  const { ctx, sentErrors } = makeCtx({
    sessionManager: { killSession: async (id) => { killed.push(id); } },
    resolveInternalSessionId: (id) => id === 'ext-1' ? 'sess_internal_1' : undefined,
  });
  const codex = makeCodex();
  await handleKillSession(ctx, codex.deps, { type: 'kill_session', session_id: 'ext-1' } as never);

  assert.deepEqual(killed, ['sess_internal_1']);
  assert.equal(sentErrors.length, 0);
});

test('handleKillSession surfaces sessionManager errors', async () => {
  const { ctx, sentErrors } = makeCtx({
    sessionManager: { killSession: async () => { throw new Error('boom'); } },
  });
  const codex = makeCodex();
  await handleKillSession(ctx, codex.deps, { type: 'kill_session', session_id: 'ext-99' } as never);

  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'KILL_SESSION_ERROR');
  assert.match(sentErrors[0].message, /boom/);
});

test('handleKillSession stops a tracked codex observer and emits status=HISTORY', async () => {
  let stopped = false;
  const observer = { stop: () => { stopped = true; } };
  const observers = new Map([
    ['codex:thread-1', { status: SessionStatus.RUNNING, observer }],
  ]);
  const { ctx, sentEvents, sentErrors } = makeCtx();
  const codex = makeCodex({ observers });

  await handleKillSession(ctx, codex.deps, {
    type: 'kill_session',
    session_id: 'codex:thread-1',
  } as never);

  assert.equal(stopped, true);
  assert.equal(observers.get('codex:thread-1')?.status, SessionStatus.HISTORY);
  assert.equal(sentErrors.length, 0);
  assert.equal(sentEvents.length, 1);
  const ev = sentEvents[0].event as unknown as { type: string; status: string };
  assert.equal(ev.type, 'session_status');
  assert.equal(ev.status, SessionStatus.HISTORY);
});

test('handleKillSession is a no-op for codex sessions without an observer', async () => {
  const { ctx, sentEvents, sentErrors } = makeCtx();
  const codex = makeCodex({ observers: new Map() });
  await handleKillSession(ctx, codex.deps, {
    type: 'kill_session',
    session_id: 'codex:thread-unknown',
  } as never);

  assert.equal(sentEvents.length, 0);
  assert.equal(sentErrors.length, 0);
});

// ---------------------------------------------------------------------------
// handleInterruptSession
// ---------------------------------------------------------------------------

test('handleInterruptSession interrupts a tracked SDK session', async () => {
  const interrupted: string[] = [];
  const { ctx, sentErrors } = makeCtx({
    sessionManager: { interruptSession: async (id) => { interrupted.push(id); } },
    resolveInternalSessionId: (id) => id === 'ext-1' ? 'sess_internal_1' : undefined,
  });
  const codex = makeCodex();
  await handleInterruptSession(ctx, codex.deps, {
    type: 'interrupt_session',
    session_id: 'ext-1',
  } as never);

  assert.deepEqual(interrupted, ['sess_internal_1']);
  assert.equal(sentErrors.length, 0);
});

test('handleInterruptSession surfaces sessionManager errors', async () => {
  const { ctx, sentErrors } = makeCtx({
    sessionManager: { interruptSession: async () => { throw new Error('busy'); } },
  });
  const codex = makeCodex();
  await handleInterruptSession(ctx, codex.deps, {
    type: 'interrupt_session',
    session_id: 'ext-1',
  } as never);

  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'INTERRUPT_SESSION_ERROR');
  assert.match(sentErrors[0].message, /busy/);
});

test('handleInterruptSession sends Ctrl-C to a codex terminal target', async () => {
  const { ctx, sentErrors } = makeCtx();
  const codex = makeCodex({
    resolveTarget: (id) => id === 'codex:thread-1' ? { target: 'tmux:0.1' } : undefined,
  });
  await handleInterruptSession(ctx, codex.deps, {
    type: 'interrupt_session',
    session_id: 'codex:thread-1',
  } as never);

  assert.deepEqual(codex.interrupts, ['tmux:0.1']);
  assert.equal(sentErrors.length, 0);
});

test('handleInterruptSession errors when codex session has no terminal attached', async () => {
  const { ctx, sentErrors } = makeCtx();
  const codex = makeCodex({ resolveTarget: () => undefined });
  await handleInterruptSession(ctx, codex.deps, {
    type: 'interrupt_session',
    session_id: 'codex:thread-x',
  } as never);

  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'CODEX_TERMINAL_NOT_ATTACHED');
});

test('handleInterruptSession surfaces terminal-injection errors for codex', async () => {
  const { ctx, sentErrors } = makeCtx();
  const codex = makeCodex({
    resolveTarget: () => ({ target: 'tmux:0.1' }),
    sendTerminalInterrupt: () => { throw new Error('tmux gone'); },
  });
  await handleInterruptSession(ctx, codex.deps, {
    type: 'interrupt_session',
    session_id: 'codex:thread-1',
  } as never);

  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'INTERRUPT_SESSION_ERROR');
  assert.match(sentErrors[0].message, /tmux gone/);
});

// ---------------------------------------------------------------------------
// handleRewindSession
// ---------------------------------------------------------------------------

test('handleRewindSession refuses codex sessions with NOT_SUPPORTED', async () => {
  const { ctx, sentErrors, sentEvents } = makeCtx();
  await handleRewindSession(ctx, {
    type: 'rewind_session',
    request_id: 'req-1',
    session_id: 'codex:thread-1',
    user_message_id: 'msg-1',
  } as never);

  assert.equal(sentEvents.length, 0);
  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'NOT_SUPPORTED');
  assert.equal(sentErrors[0].requestId, 'req-1');
});

test('handleRewindSession emits rewind_session_response with mapped new_session_id', async () => {
  const { ctx, sentEvents, sentErrors } = makeCtx({
    sessionManager: {
      rewindSession: async () => ({
        canRewind: true,
        filesChanged: ['a.ts'],
        insertions: 5,
        deletions: 2,
        newSessionId: 'sess_internal_new',
      }),
    },
    resolveInternalSessionId: (id) => id === 'ext-1' ? 'sess_internal_1' : undefined,
    resolveExternalSessionId: (id) => id === 'sess_internal_new' ? 'claude-new' : id,
  });
  await handleRewindSession(ctx, {
    type: 'rewind_session',
    request_id: 'req-2',
    session_id: 'ext-1',
    user_message_id: 'msg-1',
    dry_run: true,
  } as never);

  assert.equal(sentErrors.length, 0);
  assert.equal(sentEvents.length, 1);
  const ev = sentEvents[0].event as unknown as {
    type: string;
    request_id: string;
    can_rewind: boolean;
    dry_run: boolean;
    files_changed: string[];
    insertions: number;
    deletions: number;
    new_session_id?: string;
  };
  assert.equal(ev.type, 'rewind_session_response');
  assert.equal(ev.request_id, 'req-2');
  assert.equal(ev.can_rewind, true);
  assert.equal(ev.dry_run, true);
  assert.deepEqual(ev.files_changed, ['a.ts']);
  assert.equal(ev.insertions, 5);
  assert.equal(ev.deletions, 2);
  assert.equal(ev.new_session_id, 'claude-new');
});

test('handleRewindSession routes errors back via rewind_session_response', async () => {
  const { ctx, sentEvents, sentErrors } = makeCtx({
    sessionManager: {
      rewindSession: async () => { throw new Error('git stash failed'); },
    },
  });
  await handleRewindSession(ctx, {
    type: 'rewind_session',
    request_id: 'req-3',
    session_id: 'ext-1',
    user_message_id: 'msg-1',
  } as never);

  assert.equal(sentErrors.length, 0);
  assert.equal(sentEvents.length, 1);
  const ev = sentEvents[0].event as unknown as {
    type: string;
    can_rewind: boolean;
    dry_run: boolean;
    error: string;
  };
  assert.equal(ev.type, 'rewind_session_response');
  assert.equal(ev.can_rewind, false);
  assert.equal(ev.dry_run, false);
  assert.match(ev.error, /git stash failed/);
});

test('handleRewindSession omits new_session_id when sessionManager returns none', async () => {
  const { ctx, sentEvents } = makeCtx({
    sessionManager: {
      rewindSession: async () => ({ canRewind: true }),
    },
  });
  await handleRewindSession(ctx, {
    type: 'rewind_session',
    request_id: 'req-4',
    session_id: 'ext-1',
    user_message_id: 'msg-1',
  } as never);

  const ev = sentEvents[0].event as unknown as { new_session_id?: string };
  assert.equal(ev.new_session_id, undefined);
});
