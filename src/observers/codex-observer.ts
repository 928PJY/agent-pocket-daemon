import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { ClaudeEvent } from 'agent-pocket-protocol';
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
  /**
   * Last collaboration_mode value emitted to phone. Codex writes
   * task_started on every turn; without this diff every turn would
   * surface its own mode banner. Only transitions emit.
   */
  private lastEmittedMode: string | undefined;

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
    if (lifecycle?.type === 'turn_aborted') {
      this.emit('status_change', 'ready');
      return;
    }
    if (lifecycle?.type === 'turn_failed') {
      this.emit('error', new Error(lifecycle.message));
      return;
    }

    const messages = parseCodexHistoryEntry(entry);
    if (messages.length > 0) {
      this.emit('status_change', 'running');
      for (const message of messages) {
        const ev = (message as { codexMetaEvent?: { type?: string; mode?: string } }).codexMetaEvent;
        if (message.role === 'codex_meta' && ev?.type === 'codex_collaboration_mode') {
          if (ev.mode === this.lastEmittedMode) continue;
          this.lastEmittedMode = ev.mode;
        }
        const event = codexHistoryMessageToEvent(message);
        if (event) {
          // Mirror sdkUuid/sdkBlockIndex onto the event so the serializer's
          // wire flattener picks them up at line 140. Without this the live
          // emit path ships rows with no sdk_uuid/session_seq, the phone
          // fingerprints them as `local|<random-uuid>`, and on reconnect the
          // history-replay copy (which DOES carry a seq) lands as a duplicate.
          const m = message as { sdkUuid?: string; sdkBlockIndex?: number };
          const target = event as unknown as Record<string, unknown>;
          if (m.sdkUuid) target.sdkUuid = m.sdkUuid;
          if (typeof m.sdkBlockIndex === 'number') target.sdkBlockIndex = m.sdkBlockIndex;
          this.emit('output', event);
        }
      }
      if (messages.some((message) => message.role === 'system' && message.content === 'Interrupted by user.')) {
        this.emit('status_change', 'ready');
      }
    }
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (entry.type === 'event_msg' && (payload?.type === 'exec_command_end' || payload?.type === 'turn_completed')) {
      this.emit('status_change', 'ready');
    }
  }
}
