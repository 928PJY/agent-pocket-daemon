// Agent Pocket -- NDJSON Protocol Handler
// Buffers chunks from Claude Code stdout, splits on newlines, parses JSON,
// and maps Claude Code stream-json events to typed ClaudeEvent objects.

import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';
import type {
  ClaudeEvent,
  ThinkingEvent,
  AssistantMessageEvent,
  ToolUseEvent,
  ToolResultEvent,
} from '../shared/index.js';

// ============================================================================
// Raw Claude Code stream-json event shapes
// ============================================================================

interface StreamContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: {
    type: 'thinking' | 'text' | 'tool_use';
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    text?: string;
    thinking?: string;
  };
}

interface StreamContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta: {
    type: 'thinking_delta' | 'text_delta' | 'input_json_delta';
    thinking?: string;
    text?: string;
    partial_json?: string;
  };
}

interface StreamContentBlockStop {
  type: 'content_block_stop';
  index: number;
}

interface StreamResult {
  type: 'result';
  result?: unknown;
  subtype?: string;
  duration_ms?: number;
  cost_usd?: number;
  session_id?: string;
  is_error?: boolean;
  total_cost_usd?: number;
}

interface StreamSystemMessage {
  type: 'system';
  subtype?: string;
  message?: string;
  session_id?: string;
}

type StreamEvent =
  | StreamContentBlockStart
  | StreamContentBlockDelta
  | StreamContentBlockStop
  | StreamResult
  | StreamSystemMessage
  | { type: string; [key: string]: unknown };

// ============================================================================
// NdjsonProtocolHandler
// ============================================================================

export interface NdjsonProtocolHandlerEvents {
  thinking: [ThinkingEvent];
  assistant_message: [AssistantMessageEvent];
  tool_use: [ToolUseEvent];
  tool_result: [ToolResultEvent];
  permission_request: [{ request_id: string; tool_name: string; tool_input: Record<string, unknown> }];
  result: [StreamResult];
  error: [Error];
}

/**
 * Buffers raw chunks from Claude Code stdout, splits on newlines,
 * parses each line as JSON, and maps stream-json events to typed
 * ClaudeEvent objects emitted as events.
 */
export class NdjsonProtocolHandler extends EventEmitter {
  private buffer: string = '';

  // Track active content blocks by index
  private activeBlocks: Map<number, {
    type: 'thinking' | 'text' | 'tool_use';
    id?: string;
    name?: string;
    accumulated: string;
  }> = new Map();

  constructor() {
    super();
  }

  /**
   * Feed raw data from Claude Code stdout into the handler.
   * Buffers partial lines and processes complete lines.
   */
  feed(chunk: string | Buffer): void {
    this.buffer += chunk.toString();

    const lines = this.buffer.split('\n');
    // Keep the last (possibly incomplete) line in the buffer
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      this.parseLine(trimmed);
    }
  }

  /**
   * Flush any remaining data in the buffer.
   * Call this when the process exits to handle any trailing content.
   */
  flush(): void {
    const trimmed = this.buffer.trim();
    this.buffer = '';
    if (trimmed.length > 0) {
      this.parseLine(trimmed);
    }
  }

  /**
   * Reset internal state. Use when starting a new session.
   */
  reset(): void {
    this.buffer = '';
    this.activeBlocks.clear();
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private parseLine(line: string): void {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch (err) {
      this.emit('error', new Error(`Failed to parse NDJSON line: ${line.substring(0, 200)}`));
      return;
    }

    try {
      this.handleEvent(event);
    } catch (err) {
      this.emit(
        'error',
        new Error(`Failed to handle event type=${event.type}: ${(err as Error).message}`),
      );
    }
  }

  private handleEvent(event: StreamEvent): void {
    switch (event.type) {
      case 'content_block_start':
        this.handleContentBlockStart(event as StreamContentBlockStart);
        break;

      case 'content_block_delta':
        this.handleContentBlockDelta(event as StreamContentBlockDelta);
        break;

      case 'content_block_stop':
        this.handleContentBlockStop(event as StreamContentBlockStop);
        break;

      case 'result':
        this.handleResult(event as StreamResult);
        break;

      case 'assistant':
        this.handleAssistant(event as { type: string; message?: { content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> }> }; [key: string]: unknown });
        break;

      case 'user':
        this.handleUser(event as { type: string; message?: { content?: Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }> }; tool_use_result?: { stdout?: string; stderr?: string } });
        break;

      case 'system':
        // System messages (e.g., init, hook events) are informational
        break;

      case 'control_request':
        this.handleControlRequest(event as { type: string; request_id?: string; request?: { subtype?: string; tool_name?: string; tool_input?: Record<string, unknown> } });
        break;

      default:
        // Unknown event type -- ignore silently to be forward-compatible
        break;
    }
  }

  private handleContentBlockStart(event: StreamContentBlockStart): void {
    const block = event.content_block;

    this.activeBlocks.set(event.index, {
      type: block.type,
      id: block.id,
      name: block.name,
      accumulated: '',
    });

    switch (block.type) {
      case 'thinking': {
        if (block.thinking) {
          // Some starts include initial thinking text
          const thinking = this.activeBlocks.get(event.index)!;
          thinking.accumulated = block.thinking;
          this.emitThinking(thinking.accumulated);
        }
        break;
      }

      case 'text': {
        if (block.text) {
          const textBlock = this.activeBlocks.get(event.index)!;
          textBlock.accumulated = block.text;
          this.emitAssistantMessage(textBlock.accumulated);
        }
        break;
      }

      case 'tool_use': {
        const toolUseEvent: ToolUseEvent = {
          type: 'tool_use',
          tool_id: block.id ?? `tool_${event.index}`,
          tool_name: block.name ?? 'unknown',
          tool_input: block.input ?? {},
        };
        this.emit('tool_use', toolUseEvent);
        break;
      }
    }
  }

  private handleContentBlockDelta(event: StreamContentBlockDelta): void {
    const block = this.activeBlocks.get(event.index);
    if (!block) return;

    switch (event.delta.type) {
      case 'thinking_delta': {
        if (event.delta.thinking) {
          block.accumulated += event.delta.thinking;
          this.emitThinking(block.accumulated);
        }
        break;
      }

      case 'text_delta': {
        if (event.delta.text) {
          block.accumulated += event.delta.text;
          this.emitAssistantMessage(block.accumulated);
        }
        break;
      }

      case 'input_json_delta': {
        if (event.delta.partial_json) {
          block.accumulated += event.delta.partial_json;
        }
        break;
      }
    }
  }

  private handleContentBlockStop(event: StreamContentBlockStop): void {
    const block = this.activeBlocks.get(event.index);
    if (!block) return;

    // For tool_use blocks, try to emit the accumulated input as final tool_use
    if (block.type === 'tool_use' && block.accumulated.length > 0) {
      try {
        const input = JSON.parse(block.accumulated) as Record<string, unknown>;
        const toolUseEvent: ToolUseEvent = {
          type: 'tool_use',
          tool_id: block.id ?? `tool_${event.index}`,
          tool_name: block.name ?? 'unknown',
          tool_input: input,
        };
        this.emit('tool_use', toolUseEvent);
      } catch {
        // Could not parse accumulated JSON -- already emitted start event
      }
    }

    this.activeBlocks.delete(event.index);
  }

  private handleAssistant(event: {
    type: string;
    message?: { content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> }> };
  }): void {
    const content = event.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      switch (block.type) {
        case 'text': {
          if (block.text) {
            this.emitAssistantMessage(block.text);
          }
          break;
        }

        case 'thinking': {
          if (block.thinking) {
            this.emitThinking(block.thinking);
          }
          break;
        }

        case 'tool_use': {
          const toolUseEvent: ToolUseEvent = {
            type: 'tool_use',
            tool_id: block.id ?? 'unknown',
            tool_name: block.name ?? 'unknown',
            tool_input: block.input ?? {},
          };
          this.emit('tool_use', toolUseEvent);
          break;
        }
      }
    }
  }

  private handleUser(event: {
    type: string;
    message?: { content?: Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }> };
    tool_use_result?: { stdout?: string; stderr?: string };
  }): void {
    const content = event.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const toolResultEvent: ToolResultEvent = {
          type: 'tool_result',
          tool_id: block.tool_use_id,
          status: block.is_error ? 'error' : 'success',
          output: block.content ?? event.tool_use_result?.stdout ?? '',
        };
        this.emit('tool_result', toolResultEvent);
      }
    }
  }

  private handleControlRequest(event: {
    type: string;
    request_id?: string;
    request?: { subtype?: string; tool_name?: string; tool_input?: Record<string, unknown> };
  }): void {
    if (event.request?.subtype === 'can_use_tool') {
      const requestId = event.request_id ?? `perm_${Date.now()}`;
      const toolName = event.request.tool_name ?? 'unknown';
      const toolInput = event.request.tool_input ?? {};

      logger.debug('ndjson', `Permission request: ${toolName} (request_id=${requestId})`);

      this.emit('permission_request', {
        request_id: requestId,
        tool_name: toolName,
        tool_input: toolInput,
      });
    }
    // Other control_request subtypes (e.g., initialize response) are ignored
  }

  private handleResult(event: StreamResult): void {
    this.emit('result', event);
  }

  private emitThinking(text: string): void {
    const thinking: ThinkingEvent = {
      type: 'thinking',
      thinking: text,
    };
    this.emit('thinking', thinking);
  }

  private emitAssistantMessage(text: string): void {
    const message: AssistantMessageEvent = {
      type: 'assistant_message',
      message: text,
    };
    this.emit('assistant_message', message);
  }
}
