// Agent Pocket — Capability-info command handlers
//
// These five handlers all share the same shape:
//   1. reject Codex sessions with NOT_SUPPORTED
//   2. resolve internal session id (fall back to the input)
//   3. call sessionManager.getX(internalId)
//   4. map SDK shape to wire shape
//   5. send the typed event back, or send `error` on failure
//
// Extracted from AgentPocketDaemon as part of Step 1.4a. Each handler
// takes a CommandContext and the typed PhoneCommand, and is independently
// unit-testable (the tests in test/commands-capability-info.test.ts
// pass a small mock context — no daemon required).

import type { PcEvent } from 'agent-pocket-protocol';
import type {
  GetSupportedModelsCommand,
  GetContextUsageCommand,
  GetSupportedCommandsCommand,
  GetSupportedAgentsCommand,
  GetMcpServerStatusCommand,
} from 'agent-pocket-protocol';
import { isCodexSessionId } from '../../discovery/codex-discovery.js';
import type { CommandContext } from '../command-context.js';
import { STATIC_MODEL_CATALOG } from './model-catalog.js';

/**
 * Shared scaffolding: reject Codex, resolve id, run the SDK call, map the
 * result, push the event. Centralises the try/catch + NOT_SUPPORTED-prefix
 * detection so each handler stays a four-line declaration.
 */
async function runCapabilityRequest<T>(
  ctx: CommandContext,
  args: {
    sessionId: string;
    requestId: string;
    name: string;             // human-readable for the Codex reject message
    errorCode: string;        // wire error code on unexpected failure
    fetch: (internalId: string) => Promise<T>;
    buildEvent: (data: T) => PcEvent;
  },
): Promise<void> {
  if (isCodexSessionId(args.sessionId)) {
    ctx.sendError(args.requestId, `${args.name} is not supported for Codex sessions`, 'NOT_SUPPORTED');
    return;
  }
  try {
    const internalId = ctx.resolveInternalSessionId(args.sessionId) ?? args.sessionId;
    const data = await args.fetch(internalId);
    ctx.sendToPhone(args.buildEvent(data));
  } catch (err) {
    const message = (err as Error).message;
    const code = message.startsWith('not_supported') ? 'NOT_SUPPORTED' : args.errorCode;
    ctx.sendError(args.requestId, message, code);
  }
}

// ---------------------------------------------------------------------------
// get_supported_models
// ---------------------------------------------------------------------------

export async function handleGetSupportedModels(
  ctx: CommandContext,
  command: GetSupportedModelsCommand,
): Promise<void> {
  if (isCodexSessionId(command.session_id)) {
    ctx.sendError(command.request_id, 'get_supported_models is not supported for Codex sessions', 'NOT_SUPPORTED');
    return;
  }
  try {
    const internalId = ctx.resolveInternalSessionId(command.session_id) ?? command.session_id;
    const sdkModels = await ctx.sessionManager.getSupportedModels(internalId);
    let currentModel: string | undefined;
    try {
      const usage = await ctx.sessionManager.getContextUsage(internalId);
      currentModel = usage.model || undefined;
    } catch {
      currentModel = undefined;
    }
    const models = sdkModels.map(m => ({
      value: m.value,
      display_name: m.displayName,
      description: m.description,
      supports_effort: m.supportsEffort,
      supported_effort_levels: m.supportedEffortLevels,
      supports_adaptive_thinking: m.supportsAdaptiveThinking,
      supports_fast_mode: m.supportsFastMode,
      supports_auto_mode: m.supportsAutoMode,
    }));
    ctx.sendToPhone({
      type: 'supported_models',
      request_id: command.request_id,
      session_id: command.session_id,
      models,
      current_model: currentModel,
      model_catalog: STATIC_MODEL_CATALOG,
    } as unknown as PcEvent);
  } catch (err) {
    const message = (err as Error).message;
    const code = message.startsWith('not_supported') ? 'NOT_SUPPORTED' : 'GET_SUPPORTED_MODELS_ERROR';
    ctx.sendError(command.request_id, message, code);
  }
}

// ---------------------------------------------------------------------------
// get_context_usage
// ---------------------------------------------------------------------------

export async function handleGetContextUsage(
  ctx: CommandContext,
  command: GetContextUsageCommand,
): Promise<void> {
  await runCapabilityRequest(ctx, {
    sessionId: command.session_id,
    requestId: command.request_id,
    name: 'get_context_usage',
    errorCode: 'GET_CONTEXT_USAGE_ERROR',
    fetch: (id) => ctx.sessionManager.getContextUsage(id),
    buildEvent: (sdk) => ({
      type: 'context_usage',
      request_id: command.request_id,
      session_id: command.session_id,
      usage: {
        categories: sdk.categories.map(c => ({ name: c.name, tokens: c.tokens, color: c.color, is_deferred: c.isDeferred })),
        total_tokens: sdk.totalTokens,
        max_tokens: sdk.maxTokens,
        raw_max_tokens: sdk.rawMaxTokens,
        percentage: sdk.percentage,
        model: sdk.model,
        memory_files: sdk.memoryFiles?.map(f => ({ path: f.path, type: f.type, tokens: f.tokens })),
        mcp_tools: sdk.mcpTools?.map(t => ({ name: t.name, server_name: t.serverName, tokens: t.tokens, is_loaded: t.isLoaded })),
        deferred_builtin_tools: sdk.deferredBuiltinTools?.map(t => ({ name: t.name, tokens: t.tokens, is_loaded: t.isLoaded })),
      },
    } as unknown as PcEvent),
  });
}

// ---------------------------------------------------------------------------
// get_supported_commands
// ---------------------------------------------------------------------------

export async function handleGetSupportedCommands(
  ctx: CommandContext,
  command: GetSupportedCommandsCommand,
): Promise<void> {
  await runCapabilityRequest(ctx, {
    sessionId: command.session_id,
    requestId: command.request_id,
    name: 'get_supported_commands',
    errorCode: 'GET_SUPPORTED_COMMANDS_ERROR',
    fetch: (id) => ctx.sessionManager.getSupportedCommands(id),
    buildEvent: (sdk) => ({
      type: 'supported_commands',
      request_id: command.request_id,
      session_id: command.session_id,
      commands: sdk.map(c => ({
        name: c.name,
        description: c.description,
        argument_hint: c.argumentHint,
        aliases: c.aliases,
      })),
    } as unknown as PcEvent),
  });
}

// ---------------------------------------------------------------------------
// get_supported_agents
// ---------------------------------------------------------------------------

export async function handleGetSupportedAgents(
  ctx: CommandContext,
  command: GetSupportedAgentsCommand,
): Promise<void> {
  await runCapabilityRequest(ctx, {
    sessionId: command.session_id,
    requestId: command.request_id,
    name: 'get_supported_agents',
    errorCode: 'GET_SUPPORTED_AGENTS_ERROR',
    fetch: (id) => ctx.sessionManager.getSupportedAgents(id),
    buildEvent: (sdk) => ({
      type: 'supported_agents',
      request_id: command.request_id,
      session_id: command.session_id,
      agents: sdk.map(a => ({
        name: a.name,
        description: a.description,
        model: a.model,
      })),
    } as unknown as PcEvent),
  });
}

// ---------------------------------------------------------------------------
// get_mcp_server_status
// ---------------------------------------------------------------------------

export async function handleGetMcpServerStatus(
  ctx: CommandContext,
  command: GetMcpServerStatusCommand,
): Promise<void> {
  await runCapabilityRequest(ctx, {
    sessionId: command.session_id,
    requestId: command.request_id,
    name: 'get_mcp_server_status',
    errorCode: 'GET_MCP_SERVER_STATUS_ERROR',
    fetch: (id) => ctx.sessionManager.getMcpServerStatus(id),
    buildEvent: (sdk) => ({
      type: 'mcp_server_status',
      request_id: command.request_id,
      session_id: command.session_id,
      servers: sdk.map(s => ({
        name: s.name,
        status: s.status,
        scope: s.scope,
        error: s.error,
        server_version: s.serverInfo?.version,
        tools: s.tools?.map(t => ({ name: t.name, description: t.description })),
      })),
    } as unknown as PcEvent),
  });
}
