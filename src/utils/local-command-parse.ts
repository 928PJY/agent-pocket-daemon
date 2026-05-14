// Agent Pocket — local-command JSONL tag parser.
//
// Shared by the live observer pipeline (`SessionObserver.processEntry`)
// and the historical replay pipeline (`parseHistoryEntry` in
// `discovery/jsonl-parser.ts`). Co-locating it here avoids a circular
// import between the two and keeps the regex table in one place.
//
// The match is by tag shape only — no command-name whitelist — so SDK
// skills, plugin commands, `~/.claude/commands/*.md`, and future
// builtins flow through without daemon updates.

import type {
  LocalCommandInvokeEvent,
  LocalCommandOutputEvent,
} from 'agent-pocket-protocol';

export type LocalCommandParseResult =
  | LocalCommandInvokeEvent
  | LocalCommandOutputEvent
  | 'drop'
  | null;

/**
 * Parse a JSONL `type: 'user'` text payload that wraps a CLI slash-command
 * artifact. Returns:
 *   - LocalCommandInvokeEvent for `<command-name>…</command-name>` rows
 *     (also extracts the sibling `<command-args>…</command-args>`).
 *   - LocalCommandOutputEvent for `<local-command-stdout>…</local-command-stdout>`
 *     and `<local-command-stderr>…</local-command-stderr>` rows.
 *   - 'drop' for `<local-command-caveat>…</local-command-caveat>` rows
 *     (caveat text is for the model, not the user — silently swallow).
 *   - null for anything else, so the caller falls back to the regular
 *     user_message path / isInternalMessage filter.
 */
export function parseLocalCommandUserText(text: string): LocalCommandParseResult {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('<')) return null;

  if (trimmed.startsWith('<local-command-caveat')) return 'drop';

  const stdoutMatch = trimmed.match(/^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (stdoutMatch) return { type: 'local_command_output', stdout: stdoutMatch[1] };

  const stderrMatch = trimmed.match(/^<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/);
  if (stderrMatch) return { type: 'local_command_output', stdout: stderrMatch[1], is_stderr: true };

  const nameMatch = trimmed.match(/^<command-name>([\s\S]*?)<\/command-name>/);
  if (nameMatch) {
    const argsMatch = trimmed.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const rawName = nameMatch[1].trim();
    const name = rawName.startsWith('/') ? rawName.slice(1) : rawName;
    return { type: 'local_command_invoke', name, args: argsMatch ? argsMatch[1].trim() : '' };
  }

  return null;
}
