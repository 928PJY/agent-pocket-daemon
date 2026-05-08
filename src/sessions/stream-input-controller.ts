// Agent Pocket — StreamInputController (Step 2.4a)
//
// Extracted from session-manager.ts. Async-iterator queue that bridges
// daemon-side push() calls into the SDK's pull-based AsyncIterable<SDKUserMessage>
// stream input. The SDK pulls via stream(); the daemon pushes via push().
// close() wakes any waiting consumer so the generator can exit cleanly.

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../logger.js';

export class StreamInputController {
  private queue: SDKUserMessage[] = [];
  private waiting: ((msg: SDKUserMessage) => void) | null = null;
  private _closed = false;
  /** Tag for log correlation — set by SessionManager.create*() right after construction. */
  ownerSessionId?: string;

  get closed(): boolean {
    return this._closed;
  }

  push(msg: SDKUserMessage): void {
    if (this._closed) {
      logger.warn('stream-input', 'push() on closed controller — dropped', { sessionId: this.ownerSessionId?.substring(0, 8) });
      return;
    }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(msg);
    } else {
      this.queue.push(msg);
    }
  }

  close(): void {
    this._closed = true;
    // Wake up any waiting consumer so the generator can exit
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      // Resolve with a dummy message — the generator will check _closed and return
      resolve({ type: 'user', message: { role: 'user', content: '' }, parent_tool_use_id: null } as SDKUserMessage);
    }
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    while (!this._closed) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else {
        const msg = await new Promise<SDKUserMessage>((resolve) => {
          this.waiting = resolve;
        });
        if (this._closed) return;
        yield msg;
      }
    }
  }
}
