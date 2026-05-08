// Agent Pocket — PreToolUse correlator (Step 2.3a)
//
// Extracted from hook-server.ts. Owns the FIFO queue that maps Claude Code's
// PreToolUse hook (which carries a tool_use_id) to the immediately-following
// PermissionRequest hook (which historically did not). Keyed by
// `${sessionId}:${toolName}`; each queue entry stores the toolUseId, the
// toolInput snapshot (for input-equality matching when many of the same tool
// are queued), and a creation timestamp used for TTL pruning.

const MAX_PRE_TOOL_USE_QUEUE_SIZE = 32;

interface QueuedPreToolUse {
  toolUseId: string;
  toolInput: Record<string, unknown>;
  createdAt: number;
}

export interface CorrelatorDeps {
  nowFn?: () => number;
  ttlMs: number;
}

export function sameToolInput(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class PreToolUseCorrelator {
  private queues: Map<string, QueuedPreToolUse[]> = new Map();
  private readonly nowFn: () => number;
  private readonly ttlMs: number;

  constructor(deps: CorrelatorDeps) {
    this.nowFn = deps.nowFn ?? Date.now;
    this.ttlMs = deps.ttlMs;
  }

  enqueue(key: string, toolUseId: string, toolInput: Record<string, unknown>): void {
    const queue = this.prune(key) ?? [];
    queue.push({ toolUseId, toolInput, createdAt: this.nowFn() });
    while (queue.length > MAX_PRE_TOOL_USE_QUEUE_SIZE) {
      queue.shift();
    }
    this.queues.set(key, queue);
  }

  /**
   * Remove and return the queued toolUseId that matches the given
   * input snapshot; falls back to the head of the queue if no input matches.
   */
  shift(key: string, toolInput: Record<string, unknown>): string | undefined {
    const queue = this.prune(key);
    if (!queue || queue.length === 0) return undefined;

    let entry: QueuedPreToolUse | undefined;
    const matchingIndex = queue.findIndex((c) => sameToolInput(c.toolInput, toolInput));
    if (matchingIndex >= 0) {
      [entry] = queue.splice(matchingIndex, 1);
    } else {
      entry = queue.shift();
    }
    if (queue.length === 0) {
      this.queues.delete(key);
    }
    return entry?.toolUseId;
  }

  /**
   * Remove the entry whose toolUseId matches exactly. Returns the id if found.
   */
  remove(key: string, toolUseId: string): string | undefined {
    const queue = this.prune(key);
    if (!queue) return undefined;

    const index = queue.findIndex((entry) => entry.toolUseId === toolUseId);
    if (index === -1) return undefined;

    const [entry] = queue.splice(index, 1);
    if (queue.length === 0) {
      this.queues.delete(key);
    }
    return entry.toolUseId;
  }

  /** TTL-prune `key`'s queue. Returns the live entries or undefined when empty. */
  private prune(key: string): QueuedPreToolUse[] | undefined {
    const queue = this.queues.get(key);
    if (!queue) return undefined;

    const cutoff = this.nowFn() - this.ttlMs;
    const fresh = queue.filter((e) => e.createdAt >= cutoff);
    if (fresh.length === 0) {
      this.queues.delete(key);
      return undefined;
    }
    if (fresh.length !== queue.length) {
      this.queues.set(key, fresh);
    }
    return fresh;
  }
}
