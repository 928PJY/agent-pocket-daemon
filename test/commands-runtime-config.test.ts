import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PcEvent } from 'agent-pocket-protocol';
import type { CommandContext } from '../src/commands/command-context.js';
import {
  handleSetPermissionMode,
  handleSetModel,
} from '../src/commands/handlers/runtime-config.js';

interface SentEvent { event: PcEvent; }
interface SentError { requestId?: string; message: string; code: string; }

interface FakeSessionManager {
  setPermissionMode?: (id: string, mode: string) => Promise<void>;
  setModel?: (id: string, model: string) => Promise<void>;
}

function makeCtx(overrides: {
  sessionManager?: FakeSessionManager;
  resolveInternalSessionId?: (id: string) => string | undefined;
} = {}) {
  const sentEvents: SentEvent[] = [];
  const sentErrors: SentError[] = [];
  const ctx: CommandContext = {
    sendToPhone: (event) => { sentEvents.push({ event }); },
    sendError: (requestId, message, code) => { sentErrors.push({ requestId, message, code }); },
    resolveInternalSessionId: overrides.resolveInternalSessionId ?? ((id) => id),
    resolveExternalSessionId: (id) => id,
    sendSessionHistory: () => undefined,
    sessionManager: (overrides.sessionManager ?? {}) as unknown as CommandContext['sessionManager'],
    sessionIdMap: new Map(),
    pendingSessionRequests: new Map(),
  };
  return { ctx, sentEvents, sentErrors };
}

// ---------------------------------------------------------------------------
// handleSetPermissionMode
// ---------------------------------------------------------------------------

test('handleSetPermissionMode applies the mode and emits command_ack', async () => {
  const calls: Array<{ id: string; mode: string }> = [];
  const { ctx, sentEvents, sentErrors } = makeCtx({
    sessionManager: {
      setPermissionMode: async (id, mode) => { calls.push({ id, mode }); },
    },
    resolveInternalSessionId: (id) => id === 'ext-1' ? 'sess_internal_1' : undefined,
  });
  await handleSetPermissionMode(ctx, {
    type: 'set_permission_mode',
    request_id: 'req-1',
    session_id: 'ext-1',
    mode: 'acceptEdits',
  } as never);

  assert.equal(sentErrors.length, 0);
  assert.deepEqual(calls, [{ id: 'sess_internal_1', mode: 'acceptEdits' }]);
  assert.equal(sentEvents.length, 1);
  const ev = sentEvents[0].event as unknown as {
    type: string;
    request_id: string;
    session_id: string;
    command: string;
  };
  assert.equal(ev.type, 'command_ack');
  assert.equal(ev.request_id, 'req-1');
  assert.equal(ev.session_id, 'ext-1');
  assert.equal(ev.command, 'set_permission_mode');
});

test('handleSetPermissionMode rejects Codex sessions with NOT_SUPPORTED', async () => {
  const { ctx, sentEvents, sentErrors } = makeCtx({
    sessionManager: { setPermissionMode: async () => { throw new Error('should not call'); } },
  });
  await handleSetPermissionMode(ctx, {
    type: 'set_permission_mode',
    request_id: 'req-2',
    session_id: 'codex:thread-1',
    mode: 'acceptEdits',
  } as never);

  assert.equal(sentEvents.length, 0);
  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'NOT_SUPPORTED');
  assert.equal(sentErrors[0].requestId, 'req-2');
  assert.match(sentErrors[0].message, /set_permission_mode is not supported for Codex/);
});

test('handleSetPermissionMode maps not_supported error prefix to NOT_SUPPORTED', async () => {
  const { ctx, sentErrors } = makeCtx({
    sessionManager: {
      setPermissionMode: async () => { throw new Error('not_supported: SDK build too old'); },
    },
  });
  await handleSetPermissionMode(ctx, {
    type: 'set_permission_mode',
    request_id: 'req-3',
    session_id: 'ext-1',
    mode: 'plan',
  } as never);

  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'NOT_SUPPORTED');
  assert.match(sentErrors[0].message, /SDK build too old/);
});

test('handleSetPermissionMode maps generic errors to SET_PERMISSION_MODE_ERROR', async () => {
  const { ctx, sentErrors } = makeCtx({
    sessionManager: {
      setPermissionMode: async () => { throw new Error('boom'); },
    },
  });
  await handleSetPermissionMode(ctx, {
    type: 'set_permission_mode',
    request_id: 'req-4',
    session_id: 'ext-1',
    mode: 'plan',
  } as never);

  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'SET_PERMISSION_MODE_ERROR');
  assert.match(sentErrors[0].message, /boom/);
});

test('handleSetPermissionMode falls back to the external id when resolveInternalSessionId returns undefined', async () => {
  const calls: Array<{ id: string; mode: string }> = [];
  const { ctx } = makeCtx({
    sessionManager: {
      setPermissionMode: async (id, mode) => { calls.push({ id, mode }); },
    },
    resolveInternalSessionId: () => undefined,
  });
  await handleSetPermissionMode(ctx, {
    type: 'set_permission_mode',
    request_id: 'req-5',
    session_id: 'ext-unknown',
    mode: 'plan',
  } as never);

  assert.deepEqual(calls, [{ id: 'ext-unknown', mode: 'plan' }]);
});

// ---------------------------------------------------------------------------
// handleSetModel
// ---------------------------------------------------------------------------

test('handleSetModel applies the model and emits command_ack', async () => {
  const calls: Array<{ id: string; model: string }> = [];
  const { ctx, sentEvents, sentErrors } = makeCtx({
    sessionManager: {
      setModel: async (id, model) => { calls.push({ id, model }); },
    },
    resolveInternalSessionId: (id) => id === 'ext-1' ? 'sess_internal_1' : undefined,
  });
  await handleSetModel(ctx, {
    type: 'set_model',
    request_id: 'req-1',
    session_id: 'ext-1',
    model: 'claude-opus-4-7',
  } as never);

  assert.equal(sentErrors.length, 0);
  assert.deepEqual(calls, [{ id: 'sess_internal_1', model: 'claude-opus-4-7' }]);
  assert.equal(sentEvents.length, 1);
  const ev = sentEvents[0].event as unknown as { type: string; command: string };
  assert.equal(ev.type, 'command_ack');
  assert.equal(ev.command, 'set_model');
});

test('handleSetModel rejects Codex sessions with NOT_SUPPORTED', async () => {
  const { ctx, sentEvents, sentErrors } = makeCtx({
    sessionManager: { setModel: async () => { throw new Error('should not call'); } },
  });
  await handleSetModel(ctx, {
    type: 'set_model',
    request_id: 'req-2',
    session_id: 'codex:thread-1',
    model: 'opus',
  } as never);

  assert.equal(sentEvents.length, 0);
  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'NOT_SUPPORTED');
  assert.match(sentErrors[0].message, /set_model is not supported for Codex/);
});

test('handleSetModel maps not_supported error prefix to NOT_SUPPORTED', async () => {
  const { ctx, sentErrors } = makeCtx({
    sessionManager: {
      setModel: async () => { throw new Error('not_supported: SDK lacks setModel'); },
    },
  });
  await handleSetModel(ctx, {
    type: 'set_model',
    request_id: 'req-3',
    session_id: 'ext-1',
    model: 'sonnet',
  } as never);

  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'NOT_SUPPORTED');
  assert.match(sentErrors[0].message, /SDK lacks setModel/);
});

test('handleSetModel maps generic errors to SET_MODEL_ERROR', async () => {
  const { ctx, sentErrors } = makeCtx({
    sessionManager: {
      setModel: async () => { throw new Error('boom'); },
    },
  });
  await handleSetModel(ctx, {
    type: 'set_model',
    request_id: 'req-4',
    session_id: 'ext-1',
    model: 'sonnet',
  } as never);

  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'SET_MODEL_ERROR');
  assert.match(sentErrors[0].message, /boom/);
});
