import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { ClaudeEvent } from '../shared/index.js';
import { codexHistoryMessageToEvent, parseCodexHistoryEntry, parseCodexLifecycleEntry } from '../discovery/codex-discovery.js';
import { logger } from '../logger.js';

export interface CodexObserverEvents {
  output: [event: ClaudeEvent];
  status_change: [status: 'running' | 'ready'];
  completed: [summary?: string];
  error: [error: Error];
}

export class CodexObserver extends EventEmitter {
  private sessionId: string;
  private rolloutPath: string;
  private offset = 0;
  private active = false;
  private buffer = '';

  constructor(sessionId: string, rolloutPath: string) {
    super();
    this.sessionId = sessionId;
    this.rolloutPath = rolloutPath;
  }

  start(skipExisting = true): void {
    if (this.active) return;
    this.active = true;
    try {
      if (skipExisting && fs.existsSync(this.rolloutPath)) {
        this.offset = fs.statSync(this.rolloutPath).size;
      }
    } catch {
      this.offset = 0;
    }

    fs.watchFile(this.rolloutPath, { interval: 500 }, () => this.readNewEntries());
    logger.debug('codex-observer', `Watching ${this.rolloutPath}`, { sessionId: this.sessionId, offset: this.offset });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    fs.unwatchFile(this.rolloutPath);
  }

  isActive(): boolean {
    return this.active;
  }

  getRolloutPath(): string {
    return this.rolloutPath;
  }

  private readNewEntries(): void {
    if (!this.active) return;
    try {
      const stat = fs.statSync(this.rolloutPath);
      if (stat.size <= this.offset) return;

      const fd = fs.openSync(this.rolloutPath, 'r');
      const bytesToRead = stat.size - this.offset;
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, this.offset);
      fs.closeSync(fd);
      this.offset = stat.size;

      this.buffer += buf.toString('utf-8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          this.processEntry(entry);
        } catch {
          logger.warn('codex-observer', 'Failed to parse rollout line', { sessionId: this.sessionId, preview: line.slice(0, 120) });
        }
      }
    } catch (err) {
      if (this.active) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private processEntry(entry: Record<string, unknown>): void {
    const lifecycle = parseCodexLifecycleEntry(entry);
    if (lifecycle?.type === 'turn_completed') {
      this.emit('status_change', 'ready');
      this.emit('completed', lifecycle.summary);
      return;
    }
    if (lifecycle?.type === 'turn_failed') {
      this.emit('error', new Error(lifecycle.message));
      return;
    }

    const messages = parseCodexHistoryEntry(entry);
    if (messages.length === 0) return;
    this.emit('status_change', 'running');
    for (const message of messages) {
      const event = codexHistoryMessageToEvent(message);
      if (event) this.emit('output', event);
    }
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (entry.type === 'event_msg' && payload?.type === 'exec_command_end') {
      this.emit('status_change', 'ready');
    }
  }
}
