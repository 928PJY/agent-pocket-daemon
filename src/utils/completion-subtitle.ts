// Build the "Session Completed" subtitle that lives on the session_completed
// notification + the chat-side metrics chip. Returns undefined when the turn
// produced nothing worth reporting (no tools, sub-second, no token usage).

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

function formatTokens(total: number): string {
  if (total < 1000) return `${total} tok`;
  if (total < 1_000_000) return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k tok`;
  return `${(total / 1_000_000).toFixed(1)}M tok`;
}

export interface CompletionSummary {
  toolUseCount: number;
  totalTokens: number;
  durationSec: number;
}

export function formatCompletionSubtitle(summary: CompletionSummary): string | undefined {
  const parts: string[] = [];
  if (summary.toolUseCount > 0) {
    parts.push(`${summary.toolUseCount} ${summary.toolUseCount === 1 ? 'tool' : 'tools'}`);
  }
  if (summary.durationSec >= 1) parts.push(formatDuration(summary.durationSec));
  if (summary.totalTokens > 0) parts.push(formatTokens(summary.totalTokens));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
