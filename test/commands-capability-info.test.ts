import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PcEvent } from 'agent-pocket-protocol';
import type { CommandContext } from '../src/commands/command-context.js';
import {
  handleGetSupportedModels,
  handleGetContextUsage,
  handleGetSupportedCommands,
  handleGetSupportedAgents,
  handleGetMcpServerStatus,
} from '../src/commands/handlers/capability-info.js';
import { STATIC_MODEL_CATALOG } from '../src/commands/handlers/model-catalog.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

interface SentEvent { event: PcEvent; }
interface SentError { requestId?: string; message: string; code: string; }

interface MockSessionManagerOverrides {
  getSupportedModels?: (id: string) => Promise<unknown[]>;
  getContextUsage?: (id: string) => Promise<unknown>;
  getSupportedCommands?: (id: string) => Promise<unknown[]>;
  getSupportedAgents?: (id: string) => Promise<unknown[]>;
  getMcpServerStatus?: (id: string) => Promise<unknown[]>;
  getSession?: (id: string) => unknown;
}

function makeCtx(overrides: MockSessionManagerOverrides & {
  resolveInternalSessionId?: (id: string) => string | undefined;
} = {}) {
  const sentEvents: SentEvent[] = [];
  const sentErrors: SentError[] = [];
  const ctx: CommandContext = {
    sendToPhone: (event) => { sentEvents.push({ event }); },
    sendError: (requestId, message, code) => { sentErrors.push({ requestId, message, code }); },
    resolveInternalSessionId: overrides.resolveInternalSessionId ?? ((id) => id),
    sessionManager: {
      getSupportedModels: overrides.getSupportedModels ?? (async () => []),
      getContextUsage: overrides.getContextUsage ?? (async () => ({})),
      getSupportedCommands: overrides.getSupportedCommands ?? (async () => []),
      getSupportedAgents: overrides.getSupportedAgents ?? (async () => []),
      getMcpServerStatus: overrides.getMcpServerStatus ?? (async () => []),
      getSession: overrides.getSession ?? (() => undefined),
    } as unknown as CommandContext['sessionManager'],
  };
  return { ctx, sentEvents, sentErrors };
}

// ---------------------------------------------------------------------------
// Codex rejection (uniform across all 5 handlers)
// ---------------------------------------------------------------------------

const handlerCases = [
  { name: 'get_supported_models', fn: handleGetSupportedModels },
  { name: 'get_context_usage', fn: handleGetContextUsage },
  { name: 'get_supported_commands', fn: handleGetSupportedCommands },
  { name: 'get_supported_agents', fn: handleGetSupportedAgents },
  { name: 'get_mcp_server_status', fn: handleGetMcpServerStatus },
] as const;

for (const { name, fn } of handlerCases) {
  test(`${name} rejects Codex sessions with NOT_SUPPORTED`, async () => {
    const { ctx, sentEvents, sentErrors } = makeCtx();
    await (fn as (ctx: CommandContext, command: { session_id: string; request_id: string }) => Promise<void>)(
      ctx,
      { session_id: 'codex:thread-1', request_id: 'req-1' },
    );
    assert.equal(sentEvents.length, 0);
    assert.equal(sentErrors.length, 1);
    assert.equal(sentErrors[0].code, 'NOT_SUPPORTED');
    assert.equal(sentErrors[0].requestId, 'req-1');
    assert.match(sentErrors[0].message, new RegExp(`${name}.*Codex`));
  });
}

// ---------------------------------------------------------------------------
// handleGetSupportedModels
// ---------------------------------------------------------------------------

test('handleGetSupportedModels emits supported_models with the static catalog and current_model', async () => {
  const { ctx, sentEvents, sentErrors } = makeCtx({
    getSupportedModels: async () => [
      {
        value: 'sonnet-4-6',
        displayName: 'Sonnet 4.6',
        description: 'desc',
        supportsEffort: false,
        supportedEffortLevels: [],
        supportsAdaptiveThinking: false,
        supportsFastMode: false,
        supportsAutoMode: false,
      },
    ],
    getContextUsage: async () => ({ model: 'sonnet-4-6' }),
  });
  await handleGetSupportedModels(ctx, { type: 'get_supported_models', session_id: 's1', request_id: 'r1' } as never);
  assert.equal(sentErrors.length, 0);
  assert.equal(sentEvents.length, 1);
  const ev = sentEvents[0].event as unknown as {
    type: string;
    request_id: string;
    session_id: string;
    models: Array<{ display_name: string; value: string }>;
    current_model: string;
    model_catalog: typeof STATIC_MODEL_CATALOG;
  };
  assert.equal(ev.type, 'supported_models');
  assert.equal(ev.request_id, 'r1');
  assert.equal(ev.session_id, 's1');
  assert.equal(ev.models[0].value, 'sonnet-4-6');
  assert.equal(ev.models[0].display_name, 'Sonnet 4.6');
  assert.equal(ev.current_model, 'sonnet-4-6');
  assert.equal(ev.model_catalog, STATIC_MODEL_CATALOG);
});

test('handleGetSupportedModels tolerates getContextUsage throwing (current_model becomes undefined)', async () => {
  const { ctx, sentEvents } = makeCtx({
    getSupportedModels: async () => [],
    getContextUsage: async () => { throw new Error('boom'); },
  });
  await handleGetSupportedModels(ctx, { type: 'get_supported_models', session_id: 's1', request_id: 'r1' } as never);
  const ev = sentEvents[0].event as unknown as { current_model?: string };
  assert.equal(ev.current_model, undefined);
});

test('handleGetSupportedModels surfaces errors with GET_SUPPORTED_MODELS_ERROR code by default', async () => {
  const { ctx, sentErrors } = makeCtx({
    getSupportedModels: async () => { throw new Error('sdk down'); },
  });
  await handleGetSupportedModels(ctx, { type: 'get_supported_models', session_id: 's1', request_id: 'r1' } as never);
  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'GET_SUPPORTED_MODELS_ERROR');
  assert.equal(sentErrors[0].message, 'sdk down');
});

test('handleGetSupportedModels surfaces NOT_SUPPORTED when SDK error message starts with not_supported', async () => {
  const { ctx, sentErrors } = makeCtx({
    getSupportedModels: async () => { throw new Error('not_supported on this session'); },
  });
  await handleGetSupportedModels(ctx, { type: 'get_supported_models', session_id: 's1', request_id: 'r1' } as never);
  assert.equal(sentErrors[0].code, 'NOT_SUPPORTED');
});

test('handleGetSupportedModels uses resolveInternalSessionId to map external -> internal', async () => {
  const seenIds: string[] = [];
  const { ctx } = makeCtx({
    resolveInternalSessionId: () => 'internal-id',
    getSupportedModels: async (id) => { seenIds.push(id); return []; },
    getContextUsage: async (id) => { seenIds.push(id); return {}; },
  });
  await handleGetSupportedModels(ctx, { type: 'get_supported_models', session_id: 'external-id', request_id: 'r1' } as never);
  assert.deepEqual(seenIds, ['internal-id', 'internal-id']);
});

test('handleGetSupportedModels falls back to the input session_id when resolveInternalSessionId returns undefined', async () => {
  const seenIds: string[] = [];
  const { ctx } = makeCtx({
    resolveInternalSessionId: () => undefined,
    getSupportedModels: async (id) => { seenIds.push(id); return []; },
    getContextUsage: async (id) => { seenIds.push(id); return {}; },
  });
  await handleGetSupportedModels(ctx, { type: 'get_supported_models', session_id: 'unknown-id', request_id: 'r1' } as never);
  assert.deepEqual(seenIds, ['unknown-id', 'unknown-id']);
});

// ---------------------------------------------------------------------------
// handleGetContextUsage
// ---------------------------------------------------------------------------

test('handleGetContextUsage maps SDK shape to wire shape', async () => {
  const { ctx, sentEvents } = makeCtx({
    getContextUsage: async () => ({
      categories: [{ name: 'system', tokens: 100, color: 'red', isDeferred: false }],
      totalTokens: 100,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 0.0005,
      model: 'sonnet-4-6',
      memoryFiles: [{ path: '/x', type: 'project', tokens: 10 }],
      mcpTools: [{ name: 't', serverName: 's', tokens: 5, isLoaded: true }],
      deferredBuiltinTools: [{ name: 'b', tokens: 2, isLoaded: false }],
    }),
  });
  await handleGetContextUsage(ctx, { type: 'get_context_usage', session_id: 's', request_id: 'r' } as never);
  const ev = sentEvents[0].event as unknown as {
    type: string;
    usage: {
      categories: Array<{ is_deferred: boolean }>;
      memory_files?: Array<{ path: string }>;
      mcp_tools?: Array<{ server_name: string; is_loaded: boolean }>;
      deferred_builtin_tools?: Array<{ name: string }>;
      total_tokens: number;
      max_tokens: number;
    };
  };
  assert.equal(ev.type, 'context_usage');
  assert.equal(ev.usage.total_tokens, 100);
  assert.equal(ev.usage.max_tokens, 200000);
  assert.equal(ev.usage.categories[0].is_deferred, false);
  assert.equal(ev.usage.memory_files?.[0].path, '/x');
  assert.equal(ev.usage.mcp_tools?.[0].server_name, 's');
  assert.equal(ev.usage.mcp_tools?.[0].is_loaded, true);
  assert.equal(ev.usage.deferred_builtin_tools?.[0].name, 'b');
});

test('handleGetContextUsage surfaces error with GET_CONTEXT_USAGE_ERROR code', async () => {
  const { ctx, sentErrors } = makeCtx({
    getContextUsage: async () => { throw new Error('ctx fail'); },
  });
  await handleGetContextUsage(ctx, { type: 'get_context_usage', session_id: 's', request_id: 'r' } as never);
  assert.equal(sentErrors[0].code, 'GET_CONTEXT_USAGE_ERROR');
});

// ---------------------------------------------------------------------------
// handleGetSupportedCommands
// ---------------------------------------------------------------------------

test('handleGetSupportedCommands maps SDK shape to wire shape (camelCase -> snake_case)', async () => {
  const { ctx, sentEvents } = makeCtx({
    getSupportedCommands: async () => [
      { name: '/help', description: 'h', argumentHint: '<arg>', aliases: ['?'] },
    ],
  });
  await handleGetSupportedCommands(ctx, { type: 'get_supported_commands', session_id: 's', request_id: 'r' } as never);
  const ev = sentEvents[0].event as unknown as {
    type: string;
    commands: Array<{ name: string; argument_hint?: string; aliases?: string[] }>;
  };
  assert.equal(ev.type, 'supported_commands');
  assert.equal(ev.commands[0].argument_hint, '<arg>');
  assert.deepEqual(ev.commands[0].aliases, ['?']);
});

// ---------------------------------------------------------------------------
// handleGetSupportedAgents
// ---------------------------------------------------------------------------

test('handleGetSupportedAgents maps SDK shape to wire shape', async () => {
  const { ctx, sentEvents } = makeCtx({
    getSupportedAgents: async () => [{ name: 'reviewer', description: 'd', model: 'sonnet-4-6' }],
  });
  await handleGetSupportedAgents(ctx, { type: 'get_supported_agents', session_id: 's', request_id: 'r' } as never);
  const ev = sentEvents[0].event as unknown as {
    type: string;
    agents: Array<{ name: string; model: string }>;
  };
  assert.equal(ev.type, 'supported_agents');
  assert.equal(ev.agents[0].model, 'sonnet-4-6');
});

// ---------------------------------------------------------------------------
// handleGetMcpServerStatus
// ---------------------------------------------------------------------------

test('handleGetMcpServerStatus maps server tools and serverInfo.version to wire shape', async () => {
  const { ctx, sentEvents } = makeCtx({
    getMcpServerStatus: async () => [
      {
        name: 'srv1',
        status: 'connected',
        scope: 'user',
        error: null,
        serverInfo: { version: '1.2.3' },
        tools: [{ name: 'tool_a', description: 'da' }],
      },
    ],
  });
  await handleGetMcpServerStatus(ctx, { type: 'get_mcp_server_status', session_id: 's', request_id: 'r' } as never);
  const ev = sentEvents[0].event as unknown as {
    type: string;
    servers: Array<{ name: string; server_version?: string; tools?: Array<{ name: string }> }>;
  };
  assert.equal(ev.type, 'mcp_server_status');
  assert.equal(ev.servers[0].server_version, '1.2.3');
  assert.equal(ev.servers[0].tools?.[0].name, 'tool_a');
});

test('handleGetMcpServerStatus tolerates servers without serverInfo or tools', async () => {
  const { ctx, sentEvents } = makeCtx({
    getMcpServerStatus: async () => [{ name: 'srv1', status: 'failed', scope: 'project', error: 'oh no' }],
  });
  await handleGetMcpServerStatus(ctx, { type: 'get_mcp_server_status', session_id: 's', request_id: 'r' } as never);
  const ev = sentEvents[0].event as unknown as {
    servers: Array<{ server_version?: string; tools?: unknown }>;
  };
  assert.equal(ev.servers[0].server_version, undefined);
  assert.equal(ev.servers[0].tools, undefined);
});

// ---------------------------------------------------------------------------
// STATIC_MODEL_CATALOG
// ---------------------------------------------------------------------------

test('STATIC_MODEL_CATALOG contains the expected model families', () => {
  const families = new Set(STATIC_MODEL_CATALOG.entries.map(e => e.family));
  assert.ok(families.has('sonnet'));
  assert.ok(families.has('opus'));
  assert.ok(families.has('haiku'));
});

test('STATIC_MODEL_CATALOG opus 4-7 advertises its effort levels', () => {
  const opus47 = STATIC_MODEL_CATALOG.entries.find(e => e.family === 'opus' && e.version === '4-7');
  assert.ok(opus47);
  assert.deepEqual(opus47!.effort_levels, ['low', 'medium', 'high', 'xhigh', 'max']);
});
