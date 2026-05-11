// Agent Pocket — JSONL parser (Step 2.1a)
//
// Extracted from session-discovery.ts. These three functions form a pure-data
// cluster: they consume a JSONL transcript row (or a content block) and emit
// HistoryMessage[] without touching the filesystem or any class state.
//
//   parseHistoryEntry      one JSONL row → 0..N HistoryMessage entries
//   detectInterruptReason  predicate: was a user/tool_result a synthetic
//                          interrupt marker, and which kind?
//   isInternalMessage      predicate: is the text a Claude Code protocol
//                          envelope (<system-reminder>, <command-name>, …)?
//
// The truncateToolInput helper is also colocated here because it's only
// called from parseHistoryEntry. Cap constants stay co-located too — they
// describe a property of the parser, not of the discovery class.

import { detectInterruptText, interruptMessageText } from '../utils/interrupt-messages.js';
import { parseLocalCommandUserText } from '../utils/local-command-parse.js';

// Subset of HistoryMessage used by parseHistoryEntry. Kept here to avoid an
// import cycle with session-discovery.ts (which re-exports the full type).
type ParsedMessage = {
  role:
    | 'user'
    | 'assistant'
    | 'tool_use'
    | 'tool_result'
    | 'subagent'
    | 'system'
    | 'local_command_invoke'
    | 'local_command_output'
    | 'compact_boundary'
    | 'compact_summary';
  content: string;
  sdkUuid?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown>;
  timestamp?: string;
  /** local_command_invoke: command name without leading slash. */
  localCommandName?: string;
  /** local_command_invoke: raw `<command-args>` body if present. */
  localCommandArgs?: string;
  /** local_command_output: true when sourced from `<local-command-stderr>`. */
  localCommandIsStderr?: boolean;
};

const HISTORY_TOOL_INPUT_VALUE_CAP = 2000;

export function truncateToolInput(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > HISTORY_TOOL_INPUT_VALUE_CAP) {
      out[k] = v.slice(0, HISTORY_TOOL_INPUT_VALUE_CAP) + `… [+${v.length - HISTORY_TOOL_INPUT_VALUE_CAP} chars]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function parseHistoryEntry(entry: Record<string, unknown>): ParsedMessage[] {
  const type = entry.type as string | undefined;
  const timestamp = entry.timestamp as string | undefined;

  if (type === 'user') {
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (!message?.content) return [];

    const reason = detectInterruptReason(message.content);
    if (reason) {
      return [{ role: 'system', content: interruptMessageText(reason), timestamp }];
    }

    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? (message.content as Array<{ type?: string; text?: string }>)
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('')
        : '';
    if (!content) return [];

    // Slash-command artifacts (`<command-name>` invoke, `<local-command-stdout>`
    // output, caveats) — surface as structured rows so the phone can pair
    // them into a card on history replay, matching the live observer pipeline.
    const localCmd = parseLocalCommandUserText(content);
    if (localCmd === 'drop') return [];
    if (localCmd?.type === 'local_command_invoke') {
      return [{
        role: 'local_command_invoke',
        content: '',
        localCommandName: localCmd.name,
        localCommandArgs: localCmd.args,
        timestamp,
      }];
    }
    if (localCmd?.type === 'local_command_output') {
      return [{
        role: 'local_command_output',
        content: localCmd.stdout,
        localCommandIsStderr: localCmd.is_stderr === true ? true : undefined,
        timestamp,
      }];
    }

    // /compact summary lives on a `type: 'user'` row with `isCompactSummary`.
    if (entry.isCompactSummary === true) {
      return [{ role: 'compact_summary', content, timestamp }];
    }

    if (isInternalMessage(content)) return [];
    const sdkUuid = typeof entry.uuid === 'string' ? entry.uuid : undefined;
    return [{ role: 'user', content, timestamp, sdkUuid }];
  }

  if (type === 'system') {
    // /compact boundary marker between pre-compact transcript and the summary.
    if (entry.subtype === 'compact_boundary') {
      return [{ role: 'compact_boundary', content: '', timestamp }];
    }
    // Some Claude Code releases emit local-command stdout/stderr as `system`
    // rows with `subtype: 'local_command'` and the wrapped tag in `content`.
    // Parse via the same shared regex so card rendering on history matches
    // live behavior.
    if (entry.subtype === 'local_command' && typeof entry.content === 'string') {
      const localCmd = parseLocalCommandUserText(entry.content);
      if (localCmd === 'drop') return [];
      if (localCmd?.type === 'local_command_output') {
        return [{
          role: 'local_command_output',
          content: localCmd.stdout,
          localCommandIsStderr: localCmd.is_stderr === true ? true : undefined,
          timestamp,
        }];
      }
      if (localCmd?.type === 'local_command_invoke') {
        return [{
          role: 'local_command_invoke',
          content: '',
          localCommandName: localCmd.name,
          localCommandArgs: localCmd.args,
          timestamp,
        }];
      }
    }
    return [];
  }

  if (type === 'assistant') {
    const message = entry.message as { content?: Array<{ type: string; text?: string; thinking?: string; name?: string; id?: string; input?: unknown }> } | undefined;
    if (!message?.content || !Array.isArray(message.content)) return [];

    const results: ParsedMessage[] = [];

    const textParts: string[] = [];
    let interruptedInAssistant = false;
    for (const block of message.content) {
      if (block.type === 'text' && block.text) {
        if (detectInterruptText(block.text)) {
          interruptedInAssistant = true;
        } else {
          textParts.push(block.text);
        }
      }
    }
    if (textParts.length > 0) {
      results.push({ role: 'assistant', content: textParts.join('\n'), timestamp });
    }
    if (interruptedInAssistant) {
      // Offset by 1ms so the interrupt marker sorts AFTER any synthesized
      // plan_review / user_question cards that share the tool_use timestamp.
      const bumped = timestamp ? new Date(new Date(timestamp).getTime() + 1).toISOString() : timestamp;
      results.push({ role: 'system', content: interruptMessageText('tool_use'), timestamp: bumped });
    }

    for (const block of message.content) {
      if (block.type === 'tool_use') {
        results.push({
          role: 'tool_use',
          content: '',
          toolName: block.name,
          toolId: block.id,
          toolInput: truncateToolInput(block.input as Record<string, unknown> | undefined),
          timestamp,
        });
      }
    }

    return results;
  }

  return [];
}

export function detectInterruptReason(content: unknown): 'streaming' | 'tool_use' | null {
  if (typeof content === 'string') {
    return detectInterruptText(content);
  }
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        const r = detectInterruptText(block.text);
        if (r) return r;
      }
      if (block?.type === 'tool_result') {
        const inner = (block as { content?: unknown }).content;
        if (typeof inner === 'string') {
          const r = detectInterruptText(inner);
          if (r) return r;
        } else if (Array.isArray(inner)) {
          for (const b of inner as Array<Record<string, unknown>>) {
            if (b?.type === 'text' && typeof b.text === 'string') {
              const r = detectInterruptText(b.text);
              if (r) return r;
            }
          }
        }
      }
    }
  }
  return null;
}

export function isInternalMessage(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('<')) return false;
  return /^<(teammate-message|system-reminder|task-notification|command-name|command-message|command-args|local-command-caveat|local-command-stdout|local-command-stderr|local-command|user-prompt-submit-hook)[\s>]/.test(trimmed);
}
