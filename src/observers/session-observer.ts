// Agent Pocket -- Session Observer
// Tails a Claude Code JSONL session file to observe real-time output.
// Parses new entries and emits ClaudeEvent-compatible events that can
// be forwarded to the phone, making the terminal and phone see the same output.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type {
  ClaudeEvent,
  SubagentEvent,
  ThinkingEvent,
  AssistantMessageEvent,
  ToolUseEvent,
  ToolResultEvent,
  UserMessageEvent,
  SystemMessageEvent,
} from 'agent-pocket-protocol';
import { SubagentObserver } from './subagent-observer.js';
import { logger } from '../logger.js';
import { detectInterruptText, interruptMessageText, type InterruptReason } from '../utils/interrupt-messages.js';

function isMissingFileError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

// ============================================================================
// Types
// ============================================================================

export interface SessionObserverEvents {
  output: [event: ClaudeEvent];
  title: [title: string, isCustom: boolean];
  status_change: [status: 'running' | 'ready'];
  interrupted: [reason: InterruptReason];
  error: [error: Error];
}

// ============================================================================
// SessionObserver
// ============================================================================

export class SessionObserver extends EventEmitter {
  private sessionId: string;
  private jsonlPath: string;
  private offset: number = 0;
  private justInterrupted: boolean = false;

  /**
   * Check if a JSONL session file indicates the session is waiting for user input.
   * Reads the last few entries and checks if the last assistant message has
   * stop_reason=tool_use without a subsequent user message (tool_result).
   */
  static isPendingUserAction(jsonlPath: string): { pending: boolean; toolName?: string } {
    try {
      if (!fs.existsSync(jsonlPath)) return { pending: false };
      const content = fs.readFileSync(jsonlPath, 'utf-8');
      const lines = content.trim().split('\n');

      // Find the last assistant entry
      let lastAssistantIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'assistant') {
            lastAssistantIdx = i;
            break;
          }
          if (lines.length - i > 30) break;
        } catch { continue; }
      }

      if (lastAssistantIdx === -1) return { pending: false };

      // Check if stop_reason is tool_use
      try {
        const entry = JSON.parse(lines[lastAssistantIdx]);
        const message = entry.message as { stop_reason?: string; content?: Array<{ type: string; name?: string }> } | undefined;
        if (message?.stop_reason !== 'tool_use') return { pending: false };

        // Check if there's a 'user' entry AFTER this assistant (would contain tool_result)
        for (let i = lastAssistantIdx + 1; i < lines.length; i++) {
          try {
            const after = JSON.parse(lines[i]);
            if (after.type === 'user') return { pending: false };
          } catch { continue; }
        }

        // No user entry after the last tool_use assistant — session is pending
        const blocks = message.content ?? [];
        const lastToolUse = [...blocks].reverse().find(b => b.type === 'tool_use');
        return { pending: true, toolName: lastToolUse?.name };
      } catch {
        return { pending: false };
      }
    } catch {
      return { pending: false };
    }
  }
  private watcher: fs.StatWatcher | null = null;
  private active: boolean = false;
  private buffer: string = '';

  // Delta tracking — same logic as session-manager SDK handler
  private lastEmittedTextLength: number = 0;
  private lastEmittedThinkingLength: number = 0;
  private emittedToolUseIds: Set<string> = new Set();
  // tool_use ids we've emitted but have NOT yet seen a matching tool_result for.
  // Used to synthesize 'interrupted' tool_result events when Claude Code aborts.
  private pendingToolUseIds: Set<string> = new Set();

  // Subagent observation
  private subagentObserver: SubagentObserver | null = null;

  constructor(sessionId: string, jsonlPath: string) {
    super();
    this.sessionId = sessionId;
    this.jsonlPath = jsonlPath;
  }

  /**
   * Start observing. Reads from current end of file (skips existing content).
   * Pass skipExisting=false to read the entire file from the beginning.
   */
  start(skipExisting: boolean = true): void {
    if (this.active) return;
    this.active = true;

    try {
      if (skipExisting && fs.existsSync(this.jsonlPath)) {
        const stat = fs.statSync(this.jsonlPath);
        // Scan existing transcript for the most recent custom-title so we
        // don't lose it after a daemon restart (start position is end-of-file,
        // so live reads would never replay historical title entries).
        this.scanForExistingCustomTitle();
        this.offset = stat.size;
      }
    } catch {
      // File may not exist yet — start from 0
    }

    // Poll every 500ms for new content
    this.watcher = fs.watchFile(this.jsonlPath, { interval: 500 }, () => {
      this.readNewEntries();
    });

    // Start watching subagent files: <sessionId>/subagents/
    const jsonlDir = path.dirname(this.jsonlPath);
    const jsonlBasename = path.basename(this.jsonlPath, '.jsonl');
    const subagentsDir = path.join(jsonlDir, jsonlBasename, 'subagents');
    this.subagentObserver = new SubagentObserver(subagentsDir);
    this.subagentObserver.on('output', (event: SubagentEvent) => {
      this.emit('output', event);
    });
    this.subagentObserver.start();

    logger.debug('observer', `Watching ${this.jsonlPath}`, { sessionId: this.sessionId, offset: this.offset });
  }

  /**
   * Stop observing.
   */
  stop(): void {
    this.active = false;
    if (this.watcher) {
      fs.unwatchFile(this.jsonlPath);
      this.watcher = null;
    }
    if (this.subagentObserver) {
      this.subagentObserver.stop();
      this.subagentObserver = null;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Forward SubagentStop hook to the SubagentObserver.
   */
  markSubagentDone(agentId: string): void {
    this.subagentObserver?.markAgentDone(agentId);
  }

  /**
   * Forward SubagentStart hook to the SubagentObserver.
   */
  markSubagentStart(agentId: string, agentType: string): void {
    this.subagentObserver?.markAgentStart(agentId, agentType);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getJsonlPath(): string {
    return this.jsonlPath;
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private readNewEntries(): void {
    if (!this.active) return;

    try {
      const stat = fs.statSync(this.jsonlPath);
      if (stat.size <= this.offset) return;

      // Read new bytes
      const fd = fs.openSync(this.jsonlPath, 'r');
      const bytesToRead = stat.size - this.offset;
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, this.offset);
      fs.closeSync(fd);

      this.offset = stat.size;

      // Append to buffer and split on newlines
      this.buffer += buf.toString('utf-8');
      const lines = this.buffer.split('\n');

      // Keep the last element (may be incomplete)
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          logger.trace('observer', 'JSONL entry', { sessionId: this.sessionId, entryType: entry.type });
          this.processEntry(entry);
        } catch {
          logger.warn('observer', 'Failed to parse JSONL line', { sessionId: this.sessionId, preview: line.slice(0, 120) });
        }
      }
    } catch (err) {
      if (this.active) {
        if (isMissingFileError(err)) {
          logger.debug('observer', 'JSONL file disappeared; stopping observer', {
            sessionId: this.sessionId,
            path: this.jsonlPath,
          });
          this.stop();
          return;
        }
        logger.error('observer', `Read error: ${(err as Error).message}`, { sessionId: this.sessionId });
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private scanForExistingCustomTitle(): void {
    try {
      const content = fs.readFileSync(this.jsonlPath, 'utf-8');
      const lines = content.split('\n');
      let lastCustom: string | undefined;
      for (const line of lines) {
        if (!line || !line.includes('"custom-title"')) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
            lastCustom = entry.customTitle;
          }
        } catch {
          // skip malformed lines
        }
      }
      if (lastCustom) this.emit('title', lastCustom, true);
    } catch {
      // Best-effort; missing file is handled by start() catch.
    }
  }

  private processEntry(entry: Record<string, unknown>): void {
    const type = entry.type as string | undefined;

    if (type === 'custom-title' || type === 'ai-title') {
      const title = (entry.customTitle ?? entry.aiTitle) as string | undefined;
      if (title) this.emit('title', title, type === 'custom-title');
      return;
    }

    if (type === 'queue-operation' && entry.operation === 'enqueue' && typeof entry.content === 'string') {
      // Skip Claude Code's internal system reminders that ride the queue
      // channel (background task notifications, idle nudges, etc.) — they're
      // not real user input and would otherwise show up as user bubbles.
      const trimmed = entry.content.trimStart();
      if (trimmed.startsWith('<task-notification>') || trimmed.startsWith('<system-reminder>')) {
        return;
      }
      const event: UserMessageEvent = { type: 'user_message', message: entry.content };
      this.emit('output', event);
      return;
    }

    if (type === 'user') {
      // New user turn — reset delta tracking
      this.lastEmittedTextLength = 0;
      this.lastEmittedThinkingLength = 0;
      this.emittedToolUseIds.clear();
      // Don't clear pendingToolUseIds here — a real user turn follows a
      // resolved tool_result, so the set should already be empty. Leaving it
      // untouched preserves anything an interrupt handler hasn't drained yet.

      const message = entry.message as { content?: string | Array<{ type: string; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> } | undefined;

      // Detect synthetic interrupt messages Claude Code writes on Esc/Ctrl+C.
      // These are not real user input — emit 'interrupted' and render a small
      // system message to the phone so the user can see the turn was cut short.
      const interruptReason = this.detectInterrupt(message?.content);
      if (interruptReason) {
        this.justInterrupted = true;
        // Synthesize tool_result events for any tool_uses we told the phone about
        // but never saw a matching tool_result for. Without this the phone would
        // show the tool as still running.
        for (const toolId of this.pendingToolUseIds) {
          const event: ToolResultEvent = {
            type: 'tool_result',
            tool_id: toolId,
            status: 'error',
            output: '[Tool use interrupted]',
          };
          this.emit('output', event);
        }
        this.pendingToolUseIds.clear();
        const sysEvent: SystemMessageEvent = {
          type: 'system_message',
          message: interruptMessageText(interruptReason),
        };
        this.emit('output', sysEvent);
        this.emit('interrupted', interruptReason);
        return;
      }

      this.emit('status_change', 'running');

      if (!message?.content) return;

      // Emit user text message
      const sdkUuid = typeof entry.uuid === 'string' ? entry.uuid : undefined;
      if (typeof message.content === 'string') {
        // Skip internal protocol messages (XML-tagged: teammate, system, task, command)
        if (message.content.length > 0 && !this.isInternalMessage(message.content)) {
          const event: UserMessageEvent = { type: 'user_message', message: message.content, sdkUuid };
          this.emit('output', event);
        }
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text && !this.isInternalMessage(block.text)) {
            const event: UserMessageEvent = { type: 'user_message', message: block.text, sdkUuid };
            this.emit('output', event);
          } else if (block.type === 'tool_result' && block.tool_use_id) {
            this.pendingToolUseIds.delete(block.tool_use_id);
            const contentStr = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content ?? '');
            const isCancelled = detectInterruptText(contentStr) !== null;
            const event: ToolResultEvent = {
              type: 'tool_result',
              tool_id: block.tool_use_id,
              status: (block.is_error || isCancelled) ? 'error' : 'success',
              output: contentStr,
            };
            this.emit('output', event);
          }
        }
      }
      return;
    }

    if (type === 'assistant') {
      // If we just saw an interrupt marker, the next assistant entry is the
      // truncated/cancelled turn wrap-up — don't flip status back to running.
      if (!this.justInterrupted) {
        this.emit('status_change', 'running');
      } else {
        this.justInterrupted = false;
      }
      this.processAssistantMessage(entry);
      // Check if this is a completed turn (stop_reason = end_turn means Claude is ready)
      const message = entry.message as { stop_reason?: string } | undefined;
      if (message?.stop_reason === 'end_turn') {
        this.emit('status_change', 'ready');
      }
      return;
    }

    // Tool results come as 'user' type messages with tool_result content blocks
    // but we already returned above for 'user' type. The PostToolUse hook
    // handles tool results directly, so we skip them here.
  }

  private processAssistantMessage(entry: Record<string, unknown>): void {
    const message = entry.message as { content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }> } | undefined;
    if (!message?.content || !Array.isArray(message.content)) return;

    for (const block of message.content) {
      switch (block.type) {
        case 'thinking': {
          const fullText = block.thinking ?? '';
          const delta = fullText.slice(this.lastEmittedThinkingLength);
          this.lastEmittedThinkingLength = fullText.length;
          if (delta.length > 0) {
            const event: ThinkingEvent = { type: 'thinking', thinking: delta };
            this.emit('output', event);
          }
          break;
        }

        case 'text': {
          const fullText = block.text ?? '';
          // Skip the synthetic [Tool use interrupted] placeholder Claude Code
          // inserts when an orphaned tool_use gets recovered.
          if (detectInterruptText(fullText)) {
            this.lastEmittedTextLength = fullText.length;
            break;
          }
          const delta = fullText.slice(this.lastEmittedTextLength);
          this.lastEmittedTextLength = fullText.length;
          if (delta.length > 0) {
            const event: AssistantMessageEvent = { type: 'assistant_message', message: delta };
            this.emit('output', event);
          }
          break;
        }

        case 'tool_use': {
          const toolId = block.id ?? 'unknown';
          if (this.emittedToolUseIds.has(toolId)) break;
          this.emittedToolUseIds.add(toolId);
          this.pendingToolUseIds.add(toolId);
          const event: ToolUseEvent = {
            type: 'tool_use',
            tool_id: toolId,
            tool_name: block.name ?? 'unknown',
            tool_input: (block.input as Record<string, unknown>) ?? {},
          };
          this.emit('output', event);
          break;
        }
      }
    }
  }

  /** Check if a message is an internal Claude Code protocol message (not user-authored). */
  private isInternalMessage(text: string): boolean {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith('<')) return false;
    // Known internal XML-tagged messages
    return /^<(teammate-message|system-reminder|task-notification|command-name|local-command-caveat|local-command|user-prompt-submit-hook)[\s>]/.test(trimmed);
  }

  /**
   * Check if a user-type JSONL entry is a synthetic interrupt message Claude
   * Code injected on Esc/Ctrl+C. Returns the reason, or null if not an interrupt.
   * Covers: plain INTERRUPT_MESSAGE text, [Tool use interrupted] placeholder,
   * and tool_result blocks whose content is CANCEL_MESSAGE.
   */
  private detectInterrupt(content: unknown): 'streaming' | 'tool_use' | null {
    if (typeof content === 'string') {
      return detectInterruptText(content);
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          const reason = detectInterruptText(block.text);
          if (reason) return reason;
        }
        if (block?.type === 'tool_result') {
          if (typeof block.content === 'string') {
            const reason = detectInterruptText(block.content);
            if (reason) return reason;
          } else if (Array.isArray(block.content)) {
            for (const inner of block.content) {
              if (inner?.type === 'text' && typeof inner.text === 'string') {
                const reason = detectInterruptText(inner.text);
                if (reason) return reason;
              }
            }
          }
        }
      }
    }
    return null;
  }
}
