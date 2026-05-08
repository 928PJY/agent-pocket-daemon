import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionDecision } from 'agent-pocket-protocol';
import type { CommandContext } from '../src/commands/command-context.js';
import {
  handlePermissionResponse,
  handleQuestionResponse,
  type HookGateway,
  type ResponseDeps,
} from '../src/commands/handlers/responses.js';
import type { CryptoVerifier } from '../src/commands/handlers/acks.js';

interface SentError { requestId?: string; message: string; code: string; }

interface FakeSessionManager {
  respondPermission?: (id: string, requestId: string, decision: string, updatedInput?: Record<string, unknown>) => void;
  getSession?: (id: string) => { pendingPermissions: Map<string, { toolInput?: Record<string, unknown> }> } | undefined;
}

function makeCtx(overrides: {
  sessionManager?: FakeSessionManager;
  resolveInternalSessionId?: (id: string) => string | undefined;
} = {}) {
  const sentErrors: SentError[] = [];
  const ctx: CommandContext = {
    sendToPhone: () => { /* unused */ },
    sendError: (requestId, message, code) => { sentErrors.push({ requestId, message, code }); },
    resolveInternalSessionId: overrides.resolveInternalSessionId ?? ((id) => id),
    resolveExternalSessionId: (id) => id,
    sendSessionHistory: () => undefined,
    sessionManager: (overrides.sessionManager ?? {}) as unknown as CommandContext['sessionManager'],
    sessionIdMap: new Map(),
    pendingSessionRequests: new Map(),
  };
  return { ctx, sentErrors };
}

interface ResolveCall {
  toolUseId: string;
  decision: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: Array<Record<string, unknown>>;
}

function makeHooks(overrides: {
  hasPending?: boolean | ((id: string) => boolean);
  toolName?: string;
  toolInput?: Record<string, unknown>;
  suggestions?: unknown[];
} = {}) {
  const resolves: ResolveCall[] = [];
  const hooks: HookGateway = {
    hasPendingPermission: typeof overrides.hasPending === 'function'
      ? overrides.hasPending
      : () => overrides.hasPending ?? false,
    getPendingToolInput: () => overrides.toolInput,
    getPendingToolName: () => overrides.toolName,
    getPendingPermissionSuggestions: () => overrides.suggestions,
    resolvePermissionPrompt: (toolUseId, decision, updatedInput, updatedPermissions) => {
      resolves.push({ toolUseId, decision, updatedInput, updatedPermissions });
    },
  };
  return { hooks, resolves };
}

function makeCrypto(overrides: Partial<CryptoVerifier> = {}): CryptoVerifier {
  return { hasSessionKeys: () => true, verifyPeer: () => true, ...overrides };
}

interface DepsHarness {
  deps: ResponseDeps;
  untrackedIds: string[];
  cleared: Array<{ eventType: string; sessionId: string; requestId: string }>;
}

function makeDeps(): DepsHarness {
  const untrackedIds: string[] = [];
  const cleared: Array<{ eventType: string; sessionId: string; requestId: string }> = [];
  const deps: ResponseDeps = {
    untrackBlockingRequest: (id) => { untrackedIds.push(id); },
    clearNotificationDelivery: (eventType, sessionId, requestId) => {
      cleared.push({ eventType, sessionId, requestId });
    },
  };
  return { deps, untrackedIds, cleared };
}

const baseCmd = (extra: Record<string, unknown> = {}) => ({
  type: 'permission_response',
  request_id: 'req-1',
  session_id: 'sess-1',
  decision: PermissionDecision.APPROVE,
  ...extra,
});

// ---------------------------------------------------------------------------
// permission_response — cross-cutting cleanup
// ---------------------------------------------------------------------------

test('handlePermissionResponse always untracks the request and clears permission_request + plan_review deliveries', () => {
  const { ctx } = makeCtx({ sessionManager: { respondPermission: () => {} } });
  const { hooks } = makeHooks();
  const { deps, untrackedIds, cleared } = makeDeps();
  handlePermissionResponse(ctx, hooks, makeCrypto(), deps, baseCmd() as never);

  assert.deepEqual(untrackedIds, ['req-1']);
  assert.deepEqual(cleared, [
    { eventType: 'permission_request', sessionId: 'sess-1', requestId: 'req-1' },
    { eventType: 'plan_review', sessionId: 'sess-1', requestId: 'req-1' },
  ]);
});

// ---------------------------------------------------------------------------
// permission_response — signature verification
// ---------------------------------------------------------------------------

test('handlePermissionResponse rejects an invalid signature with SIGNATURE_INVALID', () => {
  const { ctx, sentErrors } = makeCtx({ sessionManager: { respondPermission: () => {} } });
  const { hooks, resolves } = makeHooks();
  const { deps } = makeDeps();
  handlePermissionResponse(
    ctx, hooks, makeCrypto({ verifyPeer: () => false }), deps,
    baseCmd({ phone_signature: 'bad' }) as never,
  );

  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'SIGNATURE_INVALID');
  assert.equal(resolves.length, 0);
});

test('handlePermissionResponse skips signature verification when no session keys are set up', () => {
  let verified = false;
  const { ctx, sentErrors } = makeCtx({ sessionManager: { respondPermission: () => {} } });
  const { hooks } = makeHooks();
  const { deps } = makeDeps();
  handlePermissionResponse(
    ctx, hooks,
    makeCrypto({ hasSessionKeys: () => false, verifyPeer: () => { verified = true; return true; } }),
    deps,
    baseCmd({ phone_signature: 'sig' }) as never,
  );

  assert.equal(verified, false);
  assert.equal(sentErrors.length, 0);
});

// ---------------------------------------------------------------------------
// permission_response — hook path
// ---------------------------------------------------------------------------

test('handlePermissionResponse routes ExitPlanMode allow to acceptEdits with merged input', () => {
  const { ctx } = makeCtx();
  const { hooks, resolves } = makeHooks({
    hasPending: true,
    toolName: 'ExitPlanMode',
    toolInput: { plan: 'do X' },
  });
  const { deps } = makeDeps();
  handlePermissionResponse(ctx, hooks, makeCrypto({ hasSessionKeys: () => false }), deps, baseCmd() as never);

  assert.equal(resolves.length, 1);
  assert.equal(resolves[0].decision, 'allow');
  assert.deepEqual(resolves[0].updatedInput, { plan: 'do X' });
  assert.deepEqual(resolves[0].updatedPermissions, [
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ]);
});

test('handlePermissionResponse routes ExitPlanMode approve_manual to allow with empty allowedPrompts', () => {
  const { ctx } = makeCtx();
  const { hooks, resolves } = makeHooks({
    hasPending: true,
    toolName: 'ExitPlanMode',
    toolInput: { plan: 'do X' },
  });
  const { deps } = makeDeps();
  handlePermissionResponse(
    ctx, hooks, makeCrypto({ hasSessionKeys: () => false }), deps,
    baseCmd({ decision: PermissionDecision.APPROVE_MANUAL }) as never,
  );

  assert.equal(resolves.length, 1);
  assert.equal(resolves[0].decision, 'allow');
  assert.deepEqual(resolves[0].updatedInput, { plan: 'do X', allowedPrompts: [] });
  assert.equal(resolves[0].updatedPermissions, undefined);
});

test('handlePermissionResponse routes ExitPlanMode deny to deny with no extra args', () => {
  const { ctx } = makeCtx();
  const { hooks, resolves } = makeHooks({
    hasPending: true,
    toolName: 'ExitPlanMode',
  });
  const { deps } = makeDeps();
  handlePermissionResponse(
    ctx, hooks, makeCrypto({ hasSessionKeys: () => false }), deps,
    baseCmd({ decision: PermissionDecision.DENY }) as never,
  );

  assert.equal(resolves.length, 1);
  assert.equal(resolves[0].decision, 'deny');
  assert.equal(resolves[0].updatedInput, undefined);
  assert.equal(resolves[0].updatedPermissions, undefined);
});

test('handlePermissionResponse forwards always_allow suggestions as updatedPermissions', () => {
  const { ctx } = makeCtx();
  const suggestions = [{ type: 'addRule', rule: 'bash:ls' }];
  const { hooks, resolves } = makeHooks({
    hasPending: true,
    toolName: 'Bash',
    suggestions,
  });
  const { deps } = makeDeps();
  handlePermissionResponse(
    ctx, hooks, makeCrypto({ hasSessionKeys: () => false }), deps,
    baseCmd({ decision: PermissionDecision.ALWAYS_ALLOW }) as never,
  );

  assert.equal(resolves.length, 1);
  assert.equal(resolves[0].decision, 'allow');
  assert.equal(resolves[0].updatedInput, undefined);
  assert.deepEqual(resolves[0].updatedPermissions, suggestions);
});

test('handlePermissionResponse forwards always_allow with no suggestions as undefined', () => {
  const { ctx } = makeCtx();
  const { hooks, resolves } = makeHooks({
    hasPending: true,
    toolName: 'Bash',
    suggestions: undefined,
  });
  const { deps } = makeDeps();
  handlePermissionResponse(
    ctx, hooks, makeCrypto({ hasSessionKeys: () => false }), deps,
    baseCmd({ decision: PermissionDecision.ALWAYS_ALLOW }) as never,
  );

  assert.equal(resolves.length, 1);
  assert.equal(resolves[0].decision, 'allow');
  assert.equal(resolves[0].updatedPermissions, undefined);
});

test('handlePermissionResponse falls back to plain allow/deny for ordinary tools', () => {
  const { ctx } = makeCtx();
  const { hooks, resolves } = makeHooks({
    hasPending: true,
    toolName: 'Read',
  });
  const { deps } = makeDeps();
  handlePermissionResponse(
    ctx, hooks, makeCrypto({ hasSessionKeys: () => false }), deps,
    baseCmd({ decision: PermissionDecision.DENY }) as never,
  );

  assert.equal(resolves.length, 1);
  assert.equal(resolves[0].decision, 'deny');
  assert.equal(resolves[0].updatedInput, undefined);
  assert.equal(resolves[0].updatedPermissions, undefined);
});

// ---------------------------------------------------------------------------
// permission_response — SDK path
// ---------------------------------------------------------------------------

test('handlePermissionResponse approve_manual converts to APPROVE with empty allowedPrompts on SDK path', () => {
  const calls: Array<{ id: string; requestId: string; decision: string; updated?: Record<string, unknown> }> = [];
  const { ctx } = makeCtx({
    sessionManager: {
      respondPermission: (id, requestId, decision, updated) => {
        calls.push({ id, requestId, decision, updated });
      },
    },
    resolveInternalSessionId: (id) => id === 'sess-1' ? 'sess_internal_1' : undefined,
  });
  const { hooks } = makeHooks();
  const { deps } = makeDeps();
  handlePermissionResponse(
    ctx, hooks, makeCrypto({ hasSessionKeys: () => false }), deps,
    baseCmd({ decision: PermissionDecision.APPROVE_MANUAL }) as never,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'sess_internal_1');
  assert.equal(calls[0].decision, PermissionDecision.APPROVE);
  assert.deepEqual(calls[0].updated, { allowedPrompts: [] });
});

test('handlePermissionResponse passes other SDK decisions through unchanged', () => {
  const calls: Array<{ decision: string; updated?: Record<string, unknown> }> = [];
  const { ctx } = makeCtx({
    sessionManager: {
      respondPermission: (_id, _r, decision, updated) => { calls.push({ decision, updated }); },
    },
  });
  const { hooks } = makeHooks();
  const { deps } = makeDeps();
  handlePermissionResponse(
    ctx, hooks, makeCrypto({ hasSessionKeys: () => false }), deps,
    baseCmd({ decision: PermissionDecision.DENY }) as never,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].decision, PermissionDecision.DENY);
  assert.equal(calls[0].updated, undefined);
});

test('handlePermissionResponse maps respondPermission errors to PERMISSION_RESPONSE_ERROR', () => {
  const { ctx, sentErrors } = makeCtx({
    sessionManager: { respondPermission: () => { throw new Error('boom'); } },
  });
  const { hooks } = makeHooks();
  const { deps } = makeDeps();
  handlePermissionResponse(ctx, hooks, makeCrypto({ hasSessionKeys: () => false }), deps, baseCmd() as never);

  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'PERMISSION_RESPONSE_ERROR');
  assert.match(sentErrors[0].message, /boom/);
});

// ---------------------------------------------------------------------------
// question_response
// ---------------------------------------------------------------------------

test('handleQuestionResponse on hook path resolves with merged input.answers', () => {
  const { ctx } = makeCtx();
  const { hooks, resolves } = makeHooks({
    hasPending: true,
    toolInput: { question: 'pick' },
  });
  const { deps, untrackedIds, cleared } = makeDeps();
  handleQuestionResponse(ctx, hooks, deps, {
    type: 'question_response',
    request_id: 'req-1',
    session_id: 'sess-1',
    answers: [{ id: 'a' }],
  } as never);

  assert.deepEqual(untrackedIds, ['req-1']);
  assert.deepEqual(cleared, [{ eventType: 'user_question', sessionId: 'sess-1', requestId: 'req-1' }]);
  assert.equal(resolves.length, 1);
  assert.equal(resolves[0].decision, 'allow');
  assert.deepEqual(resolves[0].updatedInput, { question: 'pick', answers: [{ id: 'a' }] });
});

test('handleQuestionResponse on SDK path passes original toolInput merged with answers', () => {
  const calls: Array<{ id: string; updated?: Record<string, unknown> }> = [];
  const { ctx } = makeCtx({
    sessionManager: {
      respondPermission: (id, _r, _d, updated) => { calls.push({ id, updated }); },
      getSession: (id) => id === 'sess_internal_1'
        ? { pendingPermissions: new Map([['req-1', { toolInput: { question: 'pick' } }]]) }
        : undefined,
    },
    resolveInternalSessionId: (id) => id === 'sess-1' ? 'sess_internal_1' : undefined,
  });
  const { hooks } = makeHooks();
  const { deps } = makeDeps();
  handleQuestionResponse(ctx, hooks, deps, {
    type: 'question_response',
    request_id: 'req-1',
    session_id: 'sess-1',
    answers: [{ id: 'b' }],
  } as never);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'sess_internal_1');
  assert.deepEqual(calls[0].updated, { question: 'pick', answers: [{ id: 'b' }] });
});

test('handleQuestionResponse SDK path tolerates missing session (uses empty input)', () => {
  const calls: Array<{ updated?: Record<string, unknown> }> = [];
  const { ctx } = makeCtx({
    sessionManager: {
      respondPermission: (_id, _r, _d, updated) => { calls.push({ updated }); },
      getSession: () => undefined,
    },
  });
  const { hooks } = makeHooks();
  const { deps } = makeDeps();
  handleQuestionResponse(ctx, hooks, deps, {
    type: 'question_response',
    request_id: 'req-1',
    session_id: 'sess-1',
    answers: [{ id: 'c' }],
  } as never);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].updated, { answers: [{ id: 'c' }] });
});

test('handleQuestionResponse maps errors to QUESTION_RESPONSE_ERROR', () => {
  const { ctx, sentErrors } = makeCtx({
    sessionManager: { respondPermission: () => { throw new Error('boom'); } },
  });
  const { hooks } = makeHooks();
  const { deps } = makeDeps();
  handleQuestionResponse(ctx, hooks, deps, {
    type: 'question_response',
    request_id: 'req-1',
    session_id: 'sess-1',
    answers: [],
  } as never);

  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'QUESTION_RESPONSE_ERROR');
});
