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
import {
  isCodexSessionId,
  type CodexDiscovery,
} from '../discovery/codex-discovery.js';
import type { SessionDiscovery } from '../discovery/session-discovery.js';
import { consumeInjectedMessage } from '../codex/codex-handler.js';
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
      if (agentEvent.sdkUuid) flat.sdk_uuid = agentEvent.sdkUuid;
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

    default:
      flat.output_type = (agentEvent as { type: string }).type;
      flat.content = JSON.stringify(agentEvent);
      break;
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
}

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
}

export function sendSessionHistory(
  deps: SendSessionHistoryDeps,
  claudeSessionId: string,
  options?: { since?: string; sinceSeq?: number; offset?: number; limit?: number },
): number | undefined {
  const incremental = options?.since !== undefined || options?.sinceSeq !== undefined;
  const defaultLimit = incremental ? 200 : 2000;
  const isFullHistory = !incremental && !options?.offset;

  const result = isCodexSessionId(claudeSessionId)
    ? deps.codexDiscovery.getSessionHistory(claudeSessionId, {
        offset: options?.offset ?? 0,
        limit: options?.limit ?? defaultLimit,
        since: options?.since,
        sinceSeq: options?.sinceSeq,
      })
    : deps.sessionDiscovery.getSessionHistory(claudeSessionId, {
        offset: options?.offset ?? 0,
        limit: options?.limit ?? defaultLimit,
        since: options?.since,
        sinceSeq: options?.sinceSeq,
      });

  const truncated = result.messages.map((m) => ({
    ...m,
    content: m.content.slice(0, 5000),
  }));

  const filtered = deps.phonePreferences.showToolUse
    ? truncated
    : truncated.filter(m => m.role !== 'tool_use' && m.role !== 'tool_result');

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
  };

  deps.sendToPhone(event as unknown as PcEvent);
  return result.tailSeq;
}
