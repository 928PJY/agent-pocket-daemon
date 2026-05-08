// Agent Pocket — Codex hook payload parser (Step 2.3b)
//
// Extracted from hook-server.ts. Pure normalization of Codex hook JSON
// payloads (which use a few different naming conventions per event) into a
// single `CodexHookRequest` shape consumed by the daemon.

export interface CodexHookRequest {
  sessionId: string;
  threadId?: string;
  turnId?: string;
  cwd: string;
  transcriptPath: string;
  hookEventName: string;
  source?: string;
  prompt?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  hookPid?: number;
  codexPid?: number;
}

export function pickString(json: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = json[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export function pickNumber(json: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = json[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

export function parseCodexHookRequest(json: Record<string, unknown>): CodexHookRequest {
  const sessionId = pickString(json, ['session_id', 'thread_id', 'conversation_id']) ?? '';
  const hookEventName = pickString(json, ['hook_event_name', 'hookEventName']) ?? 'CodexHook';
  const toolInput = json.tool_input && typeof json.tool_input === 'object' && !Array.isArray(json.tool_input)
    ? json.tool_input as Record<string, unknown>
    : undefined;
  return {
    sessionId,
    threadId: pickString(json, ['thread_id', 'session_id']),
    turnId: pickString(json, ['turn_id']),
    cwd: pickString(json, ['cwd']) ?? '',
    transcriptPath: pickString(json, ['transcript_path', 'rollout_path']) ?? '',
    hookEventName,
    source: pickString(json, ['source']),
    prompt: pickString(json, ['prompt']),
    toolUseId: pickString(json, ['tool_use_id', 'call_id']),
    toolName: pickString(json, ['tool_name', 'name']),
    toolInput,
    hookPid: pickNumber(json, ['agent_pocket_hook_pid', 'hook_pid']),
    codexPid: pickNumber(json, ['agent_pocket_codex_pid', 'codex_pid']),
  };
}
