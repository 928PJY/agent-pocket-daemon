// Synthetic messages Claude Code injects into JSONL when the user interrupts.
// Source: claude-code src/utils/messages.ts (INTERRUPT_MESSAGE,
// INTERRUPT_MESSAGE_FOR_TOOL_USE, CANCEL_MESSAGE, '[Tool use interrupted]').

export const INTERRUPT_MESSAGE = '[Request interrupted by user]';
export const INTERRUPT_MESSAGE_FOR_TOOL_USE = '[Request interrupted by user for tool use]';
export const TOOL_USE_INTERRUPTED_PLACEHOLDER = '[Tool use interrupted]';
export const CANCEL_MESSAGE =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";

export type InterruptReason = 'streaming' | 'tool_use';

export function detectInterruptText(text: string): InterruptReason | null {
  const trimmed = text.trim();
  if (trimmed === INTERRUPT_MESSAGE) return 'streaming';
  if (trimmed === INTERRUPT_MESSAGE_FOR_TOOL_USE) return 'tool_use';
  if (trimmed === TOOL_USE_INTERRUPTED_PLACEHOLDER) return 'tool_use';
  if (trimmed === CANCEL_MESSAGE) return 'tool_use';
  return null;
}

/** Human-readable text to show as a system message when an interrupt is observed. */
export function interruptMessageText(reason: InterruptReason): string {
  return reason === 'tool_use'
    ? 'Interrupted by user (tool use).'
    : 'Interrupted by user.';
}
