// Agent Pocket — session-output serializer (Step 1.8)
//
// Extracted from sendFlattenedSessionOutput + sendSessionHistory in
// src/index.ts. Both functions translate Claude/Codex agent output into
// wire-format events (session_output / session_history) and dispatch them
// via sendToPhone. They share no state with each other, but both depend on
// sendToPhone, so they're co-located in a single module.
//
// flattenAgentEvent is exposed as a pure function (no I/O) so it can be
// tested in isolation; sendFlattenedSessionOutput layers on the codex
// injected-message dedupe + sendToPhone dispatch.

import type {
  PcEvent,
  ClaudeEvent,
  AgentType,
} from 'agent-pocket-protocol';
import { PEER_CAPABILITIES } from 'agent-pocket-protocol';
import {
  isCodexSessionId,
  type CodexDiscovery,
} from '../discovery/codex-discovery.js';
import type { SessionDiscovery } from '../discovery/session-discovery.js';
import { consumeInjectedMessage } from '../codex/codex-handler.js';
import { logger } from '../logger.js';
import type { PhonePreferences } from '../commands/handlers/preferences-and-peer.js';

// ---------------------------------------------------------------------------
// flattenAgentEvent — pure variant flattening, no I/O
// ---------------------------------------------------------------------------

export function flattenAgentEvent(
  sessionId: string,
  agentEvent: ClaudeEvent,
  agentType: AgentType,
): Record<string, unknown> {
  const flat: Record<string, unknown> = {
    type: 'session_output',
    session_id: sessionId,
    agent_type: agentType,
    timestamp: Date.now(),
  };

  switch (agentEvent.type) {
    case 'thinking':
      flat.output_type = 'thinking';
      flat.content = agentEvent.thinking;
      flat.is_complete = false;
      break;

    case 'assistant_message':
      flat.output_type = 'assistant_message';
      flat.content = agentEvent.message;
      flat.is_complete = false;
      break;

    case 'tool_use':
      flat.output_type = 'tool_use';
      flat.tool_name = agentEvent.tool_name;
      flat.tool_input = agentEvent.tool_input;
      flat.tool_use_id = agentEvent.tool_id;
      break;

    case 'tool_result':
      flat.output_type = 'tool_result';
      flat.tool_use_id = agentEvent.tool_id;
      flat.output = agentEvent.output;
      flat.is_error = agentEvent.status === 'error';
      break;

    case 'user_message':
      flat.output_type = 'user_message';
      flat.content = agentEvent.message;
      break;

    case 'system_message':
      flat.output_type = 'system_message';
      flat.content = agentEvent.message;
      break;

    case 'subagent_event':
      flat.output_type = 'subagent_event';
      flat.agent_id = agentEvent.agent_id;
      flat.agent_name = agentEvent.agent_name;
      flat.agent_type = agentEvent.agent_type;
      flat.inner_event = agentEvent.inner_event;
      flat.tool_use_count = agentEvent.tool_use_count;
      flat.token_count = agentEvent.token_count;
      flat.agent_status = agentEvent.agent_status;
      break;

    case 'local_command_invoke':
      flat.output_type = 'local_command_invoke';
      flat.name = agentEvent.name;
      flat.args = agentEvent.args;
      if (agentEvent.timestamp) flat.timestamp = new Date(agentEvent.timestamp).getTime();
      break;

    case 'local_command_output':
      flat.output_type = 'local_command_output';
      flat.stdout = agentEvent.stdout;
      if (agentEvent.is_stderr) flat.is_stderr = true;
      if (agentEvent.timestamp) flat.timestamp = new Date(agentEvent.timestamp).getTime();
      if (agentEvent.parent_invoke_sdk_uuid) flat.parent_invoke_sdk_uuid = agentEvent.parent_invoke_sdk_uuid;
      break;

    case 'compact_boundary':
      flat.output_type = 'compact_boundary';
      if (agentEvent.timestamp) flat.timestamp = new Date(agentEvent.timestamp).getTime();
      break;

    case 'compact_summary':
      flat.output_type = 'compact_summary';
      flat.summary = agentEvent.summary;
      if (agentEvent.timestamp) flat.timestamp = new Date(agentEvent.timestamp).getTime();
      break;

    default:
      flat.output_type = (agentEvent as { type: string }).type;
      flat.content = JSON.stringify(agentEvent);
      break;
  }

  // Mirror sdkUuid + sdkBlockIndex onto the flattened wire envelope so the
  // phone can read them at the top level without unwrapping the discriminated
  // event union. Set on every variant that carries them (user_message,
  // thinking, assistant_message, tool_use, tool_result, system_message,
  // subagent_event, local_command_*, compact_*).
  if ('sdkUuid' in agentEvent && typeof agentEvent.sdkUuid === 'string') {
    flat.sdk_uuid = agentEvent.sdkUuid;
  }
  if ('sdkBlockIndex' in agentEvent && typeof agentEvent.sdkBlockIndex === 'number') {
    flat.sdk_block_index = agentEvent.sdkBlockIndex;
  }

  return flat;
}

// ---------------------------------------------------------------------------
// sendFlattenedSessionOutput — codex echo dedupe + dispatch
// ---------------------------------------------------------------------------

export interface SendFlattenedSessionOutputDeps {
  /** Live reference to per-session injected-message counters (codex echoes). */
  codexInjectedMessages: Map<string, Map<string, number>>;
  sendToPhone(event: PcEvent): void;
  /**
   * Returns true when the phone peer has announced support for the named
   * capability. Used here to gate `local_command_*` / `compact_*` events on
   * `PEER_CAPABILITIES.LOCAL_COMMAND` so old iOS builds continue to receive
   * nothing for these (matches today's silent-drop behavior).
   */
  hasPeerCapability(name: string): boolean;
}

const LOCAL_COMMAND_EVENT_TYPES = new Set([
  'local_command_invoke',
  'local_command_output',
  'compact_boundary',
  'compact_summary',
]);

export function sendFlattenedSessionOutput(
  deps: SendFlattenedSessionOutputDeps,
  sessionId: string,
  agentEvent: ClaudeEvent,
  agentType: AgentType,
): void {
  if (agentType === 'codex' && agentEvent.type === 'user_message') {
    const injected = deps.codexInjectedMessages.get(sessionId);
    if (consumeInjectedMessage(injected, agentEvent.message)) {
      return;
    }
  }

  if (LOCAL_COMMAND_EVENT_TYPES.has(agentEvent.type)) {
    const has = deps.hasPeerCapability(PEER_CAPABILITIES.LOCAL_COMMAND);
    logger.info('serializer-debug', 'local_command event reached serializer', {
      type: agentEvent.type,
      hasCap: has,
      sessionId,
    });
    if (!has) return;
  }

  const flat = flattenAgentEvent(sessionId, agentEvent, agentType);
  deps.sendToPhone(flat as unknown as PcEvent);
}

// ---------------------------------------------------------------------------
// sendSessionHistory — paginate + filter + dispatch
// ---------------------------------------------------------------------------

export interface SendSessionHistoryDeps {
  sessionDiscovery: Pick<SessionDiscovery, 'getSessionHistory'>;
  codexDiscovery: Pick<CodexDiscovery, 'getSessionHistory'>;
  /** Live reference — read at call time so showToolUse stays current. */
  phonePreferences: Pick<PhonePreferences, 'showToolUse'>;
  sendToPhone(event: PcEvent): void;
  hasPeerCapability(name: string): boolean;
  /** Recent controller-mode slash command synths (live-emitted invoke +
   *  output pairs that JSONL will also contain as `<command-name>` echoes).
   *  Empty array means no suppression for this session. */
  getControllerSlashSynthLog(claudeSessionId: string): Array<{ name: string; args: string; syntheticAtMs: number }>;
}

/**
 * Hard upper bound for a single session_history page. Phones can request more
 * via paginated `get_history` calls, but no single send may exceed this — a
 * defensive guard against accidental "full history" pulls that previously
 * caused #250's 30s sync_complete timeouts.
 */
export const MAX_SESSION_HISTORY_LIMIT = 200;

/**
 * Default page size when the caller doesn't specify `limit`. Picked to cover
 * a fresh chat's first screen (~10–20 messages) with headroom. The phone can
 * always ask for more via paginated `get_history`.
 */
export const DEFAULT_SESSION_HISTORY_LIMIT = 30;

const LOCAL_COMMAND_HISTORY_ROLES = new Set([
  'local_command_invoke',
  'local_command_output',
  'compact_boundary',
  'compact_summary',
]);

/** Window between a controller-mode synth and its JSONL echo. Wide enough to
 *  absorb SDK-side write delay; narrow enough that two real `/cost` calls a
 *  few seconds apart still each surface (the consume-once semantics handles
 *  pairing within the window). */
const SYNTH_SUPPRESS_WINDOW_MS = 10_000;

export function sendSessionHistory(
  deps: SendSessionHistoryDeps,
  claudeSessionId: string,
  options?: { since?: string; sinceSeq?: number; sinceMs?: number; offset?: number; limit?: number },
): { tailSeq?: number; tailMs?: number } {
  const incremental = options?.since !== undefined || options?.sinceSeq !== undefined || options?.sinceMs !== undefined;
  // Incremental backfill may legitimately need more (a long-running session
  // between phone disconnects), but we still cap it. For first-look / tail
  // reads we ship a short window and let the phone paginate.
  const incrementalDefault = MAX_SESSION_HISTORY_LIMIT;
  const tailDefault = DEFAULT_SESSION_HISTORY_LIMIT;
  const rawLimit = options?.limit ?? (incremental ? incrementalDefault : tailDefault);
  const limit = Math.min(rawLimit, MAX_SESSION_HISTORY_LIMIT);
  const isFullHistory = !incremental && !options?.offset && limit >= MAX_SESSION_HISTORY_LIMIT;

  const result = isCodexSessionId(claudeSessionId)
    ? deps.codexDiscovery.getSessionHistory(claudeSessionId, {
        offset: options?.offset ?? 0,
        limit,
        since: options?.since,
        sinceSeq: options?.sinceSeq,
        sinceMs: options?.sinceMs,
      })
    : deps.sessionDiscovery.getSessionHistory(claudeSessionId, {
        offset: options?.offset ?? 0,
        limit,
        since: options?.since,
        sinceSeq: options?.sinceSeq,
        sinceMs: options?.sinceMs,
      });

  const truncated = result.messages.map((m) => ({
    ...m,
    content: m.content.slice(0, 5000),
  }));

  const hasLocalCommandCap = deps.hasPeerCapability(PEER_CAPABILITIES.LOCAL_COMMAND);

  // Build a per-call set of JSONL invoke uuids that are echoes of a
  // controller-mode synthesis we already pushed live. We then drop those
  // invokes plus any output rows whose parentInvokeSdkUuid points at a
  // suppressed invoke. The synth log uses (name, args, ms) — we consume
  // each entry once, so two real /cost calls 200ms apart still both
  // surface (one suppressed, the next allowed through).
  const synthLog = deps.getControllerSlashSynthLog(claudeSessionId).map((s) => ({ ...s, used: false }));
  const suppressedInvokeUuids = new Set<string>();
  for (const m of truncated) {
    if (m.role !== 'local_command_invoke' || !m.sdkUuid) continue;
    const ts = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : Number(m.timestamp ?? 0);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const match = synthLog.find((s) => !s.used
      && s.name === m.localCommandName
      && (s.args ?? '') === (m.localCommandArgs ?? '')
      && Math.abs(ts - s.syntheticAtMs) <= SYNTH_SUPPRESS_WINDOW_MS);
    if (match) {
      match.used = true;
      suppressedInvokeUuids.add(m.sdkUuid);
      logger.info('history-debug', 'suppressing JSONL invoke echo of controller synth', {
        sessionId: claudeSessionId,
        name: m.localCommandName,
        args: m.localCommandArgs ?? '',
        deltaMs: ts - match.syntheticAtMs,
        sdkUuid: m.sdkUuid,
      });
    }
  }

  const filtered = truncated.filter((m) => {
    if (!deps.phonePreferences.showToolUse && (m.role === 'tool_use' || m.role === 'tool_result')) {
      return false;
    }
    if (!hasLocalCommandCap && LOCAL_COMMAND_HISTORY_ROLES.has(m.role)) {
      return false;
    }
    if (m.role === 'local_command_invoke' && m.sdkUuid && suppressedInvokeUuids.has(m.sdkUuid)) {
      return false;
    }
    if (m.role === 'local_command_output' && m.parentInvokeSdkUuid && suppressedInvokeUuids.has(m.parentInvokeSdkUuid)) {
      return false;
    }
    return true;
  });

  const rawCounts: Record<string, number> = {};
  for (const m of truncated) rawCounts[m.role] = (rawCounts[m.role] || 0) + 1;
  const filteredCounts: Record<string, number> = {};
  for (const m of filtered) filteredCounts[m.role] = (filteredCounts[m.role] || 0) + 1;
  logger.info('history-debug', 'sendSessionHistory', {
    sessionId: claudeSessionId,
    incremental,
    hasLocalCommandCap,
    rawTotal: truncated.length,
    filteredTotal: filtered.length,
    rawInvoke: rawCounts['local_command_invoke'] || 0,
    rawOutput: rawCounts['local_command_output'] || 0,
    filteredInvoke: filteredCounts['local_command_invoke'] || 0,
    filteredOutput: filteredCounts['local_command_output'] || 0,
  });

  const event = {
    type: 'session_history',
    session_id: claudeSessionId,
    agent_type: isCodexSessionId(claudeSessionId) ? 'codex' : 'claude_code',
    messages: filtered,
    total_count: result.totalCount,
    offset: result.offset,
    has_more: result.hasMore,
    is_full_history: isFullHistory,
    tail_seq: result.tailSeq,
    tail_ms: result.tailMs,
  };

  deps.sendToPhone(event as unknown as PcEvent);
  return { tailSeq: result.tailSeq, tailMs: result.tailMs };
}
