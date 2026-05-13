// Agent Pocket -- Subagent Observer
// Watches <sessionId>/subagents/ for new agent-*.jsonl files and tails them
// to observe real-time subagent output. Emits SubagentEvent wrapping inner events.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';
import { PEER_CAPABILITIES } from 'agent-pocket-protocol';
import type {
  SubagentEvent,
  ThinkingEvent,
  AssistantMessageEvent,
  ToolUseEvent,
  ToolResultEvent,
} from 'agent-pocket-protocol';

// ============================================================================
// Types
// ============================================================================

interface SubagentMeta {
  agentType: string;
  description: string;
}

interface ActiveSubagent {
  agentId: string;
  meta: SubagentMeta;
  jsonlPath: string;
  offset: number;
  buffer: string;
  lastEmittedTextLength: number;
  lastEmittedThinkingLength: number;
  emittedToolUseIds: Set<string>;
  toolUseCount: number;
  tokenCount: number;
  status: 'running' | 'idle' | 'done';
  lastActivityAt: number;
  doneEmitted: boolean;
  /** Earliest entry timestamp seen in the JSONL stream (epoch ms). */
  firstEventAt: number | null;
  /** Latest entry timestamp seen in the JSONL stream (epoch ms). */
  lastEventAt: number | null;
}

// Activity-based fallback for marking a subagent done. Only kicks in when
// the SubagentStop hook fails to fire (subagent killed mid-run, daemon
// restart between Stop and re-registration, etc.). Long-running tools (deep
// codebase Explore, network fetches, big bash commands) can sit silent for
// minutes between assistant turns, so this needs to be generous — false
// "done" while the agent is actually still running is much worse than a
// late "done" on the rare killed-agent path.
const DONE_TIMEOUT_MS = 120_000;

export interface SubagentObserverEvents {
  output: [event: SubagentEvent];
  error: [error: Error];
}

// ============================================================================
// SubagentObserver
// ============================================================================

export class SubagentObserver extends EventEmitter {
  private subagentsDir: string;
  private active: boolean = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeAgents: Map<string, ActiveSubagent> = new Map();
  private knownFiles: Set<string> = new Set();
  private getPeerCapability: (name: string) => boolean;

  constructor(
    subagentsDir: string,
    options?: { hasPeerCapability?: (name: string) => boolean },
  ) {
    super();
    this.subagentsDir = subagentsDir;
    this.getPeerCapability = options?.hasPeerCapability ?? (() => false);
  }

  start(): void {
    if (this.active) return;
    this.active = true;

    // Initial scan — skip existing content (history API handles past data)
    this.scanForNewAgents(true);

    // Poll for new subagent files and new content every 500ms
    this.pollTimer = setInterval(() => {
      if (!this.active) return;
      this.scanForNewAgents(false);
      this.readAllAgents();
      this.checkDoneTimeouts();
    }, 500);

    logger.debug('subagent', `Watching ${this.subagentsDir}`);
  }

  stop(): void {
    this.active = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.activeAgents.clear();
    this.knownFiles.clear();
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Mark a subagent as done (triggered by SubagentStop hook).
   * Emits a status-only event so iOS clients can update UI immediately
   * instead of waiting for the activity timeout.
   */
  markAgentDone(agentId: string): void {
    const agent = this.activeAgents.get(agentId);
    if (!agent) return;
    if (agent.doneEmitted) return;
    // Drain any buffered file content before snapshotting metrics.
    this.readNewEntries(agent);
    agent.status = 'done';
    agent.doneEmitted = true;
    this.writeArchive(agent);
    this.emitStatusOnly(agent);
    logger.debug('subagent', `Agent ${agentId} marked done (SubagentStop hook)`);
  }

  /**
   * Pre-register a subagent from SubagentStart hook so iOS sees it before
   * the first message arrives (file polling has up to 500ms latency).
   */
  markAgentStart(agentId: string, agentType: string): void {
    if (this.activeAgents.has(agentId)) return;
    const jsonlPath = path.join(this.subagentsDir, `agent-${agentId}.jsonl`);
    // SDK writes the meta file at agent launch — usually before our hook
    // fires, but not always. Read it eagerly when present so the description
    // (a one-line summary of the dispatched task) flows through to the UI.
    const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
    let meta: SubagentMeta = { agentType, description: agentType };
    try {
      if (fs.existsSync(metaPath)) {
        const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Partial<SubagentMeta>;
        meta = {
          agentType: parsed.agentType ?? agentType,
          description: parsed.description ?? agentType,
        };
      }
    } catch {
      // Fall back to hook-supplied agentType
    }
    const agent: ActiveSubagent = {
      agentId,
      meta,
      jsonlPath,
      offset: 0,
      buffer: '',
      lastEmittedTextLength: 0,
      lastEmittedThinkingLength: 0,
      emittedToolUseIds: new Set(),
      toolUseCount: 0,
      tokenCount: 0,
      status: 'running',
      lastActivityAt: Date.now(),
      doneEmitted: false,
      firstEventAt: null,
      lastEventAt: null,
    };
    this.activeAgents.set(agentId, agent);
    this.knownFiles.add(`agent-${agentId}.jsonl`);
    this.emitStatusOnly(agent);
    logger.debug('subagent', `Agent ${agentId} pre-registered (SubagentStart hook): ${agentType}`);
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private scanForNewAgents(skipExisting: boolean): void {
    if (!fs.existsSync(this.subagentsDir)) return;

    let entries: string[];
    try {
      entries = fs.readdirSync(this.subagentsDir);
    } catch {
      return;
    }

    let newCount = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;

      const agentId = entry.replace('agent-', '').replace('.jsonl', '');
      const jsonlPath = path.join(this.subagentsDir, entry);
      const metaPath = path.join(this.subagentsDir, entry.replace('.jsonl', '.meta.json'));

      // If the agent was preregistered by SubagentStart hook, the meta file
      // may not have existed yet — read it now and upgrade the placeholder
      // description to the real summary, then keep going (don't re-create).
      if (this.knownFiles.has(entry)) {
        const existing = this.activeAgents.get(agentId);
        if (existing && existing.meta.description === existing.meta.agentType) {
          try {
            if (fs.existsSync(metaPath)) {
              const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Partial<SubagentMeta>;
              if (parsed.description) existing.meta.description = parsed.description;
              if (parsed.agentType) existing.meta.agentType = parsed.agentType;
            }
          } catch {
            // Keep placeholder
          }
        }
        continue;
      }
      this.knownFiles.add(entry);

      let meta: SubagentMeta = { agentType: 'unknown', description: 'Subagent' };
      try {
        if (fs.existsSync(metaPath)) {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        }
      } catch {
        // Use default meta
      }

      let offset = 0;
      if (skipExisting) {
        try {
          const stat = fs.statSync(jsonlPath);
          offset = stat.size;
        } catch {
          // File may not exist yet
        }
      }

      // If we previously archived this agent (SubagentStop fired in a past
      // daemon run), pre-seed the in-memory state so we don't reset metrics
      // back to zero or revive a "running" status on restart.
      const archivePath = jsonlPath.replace(/\.jsonl$/, '.archive.json');
      let initialStatus: 'running' | 'idle' | 'done' = 'running';
      let initialToolUseCount = 0;
      let initialTokenCount = 0;
      let initialFirst: number | null = null;
      let initialLast: number | null = null;
      let initialDoneEmitted = false;
      if (fs.existsSync(archivePath)) {
        try {
          const a = JSON.parse(fs.readFileSync(archivePath, 'utf-8')) as {
            status?: string; toolUseCount?: number; tokenCount?: number;
            firstEventAt?: number | null; lastEventAt?: number | null;
          };
          if (a.status === 'done') { initialStatus = 'done'; initialDoneEmitted = true; }
          if (typeof a.toolUseCount === 'number') initialToolUseCount = a.toolUseCount;
          if (typeof a.tokenCount === 'number') initialTokenCount = a.tokenCount;
          if (typeof a.firstEventAt === 'number') initialFirst = a.firstEventAt;
          if (typeof a.lastEventAt === 'number') initialLast = a.lastEventAt;
        } catch {
          // Ignore corrupt archive
        }
      } else if (skipExisting) {
        // Initial daemon scan, no archive: agent finished BEFORE we started
        // running (or before the archive feature shipped). Replay the entire
        // JSONL once to derive final metrics/lifecycle, then write an archive
        // so subsequent restarts hit the fast path above. Without this the
        // panel would show running/0/0 and the elapsed-time clock would tick
        // forever for an already-finished agent.
        const replayed = this.replayHistoricJsonl(jsonlPath);
        if (replayed) {
          initialToolUseCount = replayed.toolUseCount;
          initialTokenCount = replayed.tokenCount;
          initialFirst = replayed.firstEventAt;
          initialLast = replayed.lastEventAt;
          // Heuristic: if the last assistant turn ended with end_turn and the
          // file has been quiet for at least DONE_TIMEOUT_MS, the agent is
          // done. We don't have the SubagentStop signal for past runs.
          let stableMtime = 0;
          try { stableMtime = fs.statSync(jsonlPath).mtimeMs; } catch { /* ignore */ }
          const quietFor = Date.now() - stableMtime;
          if (replayed.endedWithEndTurn && quietFor >= DONE_TIMEOUT_MS) {
            initialStatus = 'done';
            initialDoneEmitted = true;
          }
        }
      }

      const newAgent: ActiveSubagent = {
        agentId,
        meta,
        jsonlPath,
        offset,
        buffer: '',
        lastEmittedTextLength: 0,
        lastEmittedThinkingLength: 0,
        emittedToolUseIds: new Set(),
        toolUseCount: initialToolUseCount,
        tokenCount: initialTokenCount,
        status: initialStatus,
        lastActivityAt: Date.now(),
        doneEmitted: initialDoneEmitted,
        firstEventAt: initialFirst,
        lastEventAt: initialLast,
      };
      this.activeAgents.set(agentId, newAgent);

      // If the replay path concluded the agent is already done, persist an
      // archive now so subsequent restarts hit the fast path and history
      // queries can stamp the metrics onto replayed messages.
      if (initialStatus === 'done' && !fs.existsSync(archivePath)) {
        this.writeArchive(newAgent);
      }

      // Only log individual discoveries during polling, not initial scan
      if (!skipExisting) {
        logger.debug('subagent', `Discovered agent: ${meta.description} (${agentId})`);
      }
      newCount++;
    }

    // Summarize initial scan instead of logging each agent
    if (skipExisting && newCount > 0) {
      logger.debug('subagent', `Found ${newCount} existing subagent(s)`);
    }
  }

  private readAllAgents(): void {
    for (const agent of this.activeAgents.values()) {
      this.readNewEntries(agent);
    }
  }

  private readNewEntries(agent: ActiveSubagent): void {
    try {
      const stat = fs.statSync(agent.jsonlPath);
      if (stat.size <= agent.offset) return;

      const fd = fs.openSync(agent.jsonlPath, 'r');
      const bytesToRead = stat.size - agent.offset;
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, agent.offset);
      fs.closeSync(fd);

      agent.offset = stat.size;
      agent.buffer += buf.toString('utf-8');
      agent.lastActivityAt = Date.now();

      const lines = agent.buffer.split('\n');
      agent.buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          this.processEntry(agent, entry);
        } catch {
          // Skip unparseable lines
        }
      }
    } catch {
      // File may have been deleted or moved
    }
  }

  private processEntry(agent: ActiveSubagent, entry: Record<string, unknown>): void {
    const type = entry.type as string | undefined;

    const ts = entry.timestamp as string | undefined;
    if (ts) {
      const ms = Date.parse(ts);
      if (!Number.isNaN(ms)) {
        if (agent.firstEventAt === null || ms < agent.firstEventAt) agent.firstEventAt = ms;
        if (agent.lastEventAt === null || ms > agent.lastEventAt) agent.lastEventAt = ms;
      }
    }

    // Track token usage from assistant messages.
    // Match Claude Code terminal's "X tokens" display, which reads the
    // *latest* assistant turn's usage and sums all components:
    //   cache_creation_input + cache_read_input + input + output
    // (see claude-code/src/tools/AgentTool/UI.tsx line 642).
    // We overwrite each turn instead of summing, so this stays consistent
    // with what users see in the terminal when the same subagent runs.
    if (type === 'assistant') {
      const message = entry.message as {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      } | undefined;
      if (message?.usage) {
        const u = message.usage;
        agent.tokenCount =
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.input_tokens ?? 0) +
          (u.output_tokens ?? 0);
      }
      // Check for stop_reason to detect completion
      const stopReason = (entry.message as { stop_reason?: string } | undefined)?.stop_reason;
      if (stopReason === 'end_turn') {
        agent.status = 'idle';
      }
    }

    if (type === 'user') {
      agent.status = 'running';
      // New user turn — reset delta tracking
      agent.lastEmittedTextLength = 0;
      agent.lastEmittedThinkingLength = 0;
      agent.emittedToolUseIds.clear();

      const entryUuid = typeof entry.uuid === 'string' ? entry.uuid : undefined;

      // Check for tool_result blocks
      const message = entry.message as { content?: unknown } | undefined;
      if (Array.isArray(message?.content)) {
        for (const block of message!.content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const innerEvent: ToolResultEvent = {
              type: 'tool_result',
              tool_id: block.tool_use_id as string,
              status: block.is_error ? 'error' : 'success',
              output: typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content ?? ''),
              ...(entryUuid ? { sdkUuid: entryUuid } : {}),
            };
            this.emitSubagentEvent(agent, innerEvent, entryUuid);
          }
        }
      }
      return;
    }

    if (type === 'assistant') {
      const message = entry.message as {
        content?: Array<{
          type: string;
          text?: string;
          thinking?: string;
          id?: string;
          name?: string;
          input?: unknown;
        }>;
      } | undefined;
      if (!message?.content || !Array.isArray(message.content)) return;

      const entryUuid = typeof entry.uuid === 'string' ? entry.uuid : undefined;
      const fullTextEmit = this.getPeerCapability(PEER_CAPABILITIES.STABLE_SDK_UUID);

      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
        const block = message.content[blockIndex];
        switch (block.type) {
          case 'thinking': {
            const fullText = block.thinking ?? '';
            if (fullText.length <= agent.lastEmittedThinkingLength) break;
            const payload = fullTextEmit ? fullText : fullText.slice(agent.lastEmittedThinkingLength);
            agent.lastEmittedThinkingLength = fullText.length;
            if (payload.length === 0) break;
            const innerEvent: ThinkingEvent = {
              type: 'thinking',
              thinking: payload,
              ...(entryUuid ? { sdkUuid: entryUuid, sdkBlockIndex: blockIndex } : {}),
            };
            this.emitSubagentEvent(agent, innerEvent, entryUuid, blockIndex);
            break;
          }

          case 'text': {
            const fullText = block.text ?? '';
            if (fullText.length <= agent.lastEmittedTextLength) break;
            const payload = fullTextEmit ? fullText : fullText.slice(agent.lastEmittedTextLength);
            agent.lastEmittedTextLength = fullText.length;
            if (payload.length === 0) break;
            const innerEvent: AssistantMessageEvent = {
              type: 'assistant_message',
              message: payload,
              ...(entryUuid ? { sdkUuid: entryUuid, sdkBlockIndex: blockIndex } : {}),
            };
            this.emitSubagentEvent(agent, innerEvent, entryUuid, blockIndex);
            break;
          }

          case 'tool_use': {
            const toolId = block.id ?? 'unknown';
            if (agent.emittedToolUseIds.has(toolId)) break;
            agent.emittedToolUseIds.add(toolId);
            agent.toolUseCount++;
            const innerEvent: ToolUseEvent = {
              type: 'tool_use',
              tool_id: toolId,
              tool_name: block.name ?? 'unknown',
              tool_input: (block.input as Record<string, unknown>) ?? {},
              ...(entryUuid ? { sdkUuid: entryUuid, sdkBlockIndex: blockIndex } : {}),
            };
            this.emitSubagentEvent(agent, innerEvent, entryUuid, blockIndex);
            break;
          }
        }
      }
    }
  }

  private emitSubagentEvent(
    agent: ActiveSubagent,
    innerEvent: ThinkingEvent | AssistantMessageEvent | ToolUseEvent | ToolResultEvent,
    sdkUuid?: string,
    sdkBlockIndex?: number,
  ): void {
    const event: SubagentEvent = {
      type: 'subagent_event',
      agent_id: agent.agentId,
      agent_name: agent.meta.description,
      agent_type: agent.meta.agentType,
      inner_event: innerEvent,
      tool_use_count: agent.toolUseCount,
      token_count: agent.tokenCount,
      agent_status: agent.status,
      ...(sdkUuid ? { sdkUuid } : {}),
      ...(sdkBlockIndex !== undefined ? { sdkBlockIndex } : {}),
    };
    this.emit('output', event);
  }

  private emitStatusOnly(agent: ActiveSubagent): void {
    const event: SubagentEvent = {
      type: 'subagent_event',
      agent_id: agent.agentId,
      agent_name: agent.meta.description,
      agent_type: agent.meta.agentType,
      tool_use_count: agent.toolUseCount,
      token_count: agent.tokenCount,
      agent_status: agent.status,
    };
    this.emit('output', event);
  }

  private checkDoneTimeouts(): void {
    const now = Date.now();
    for (const agent of this.activeAgents.values()) {
      if (agent.doneEmitted) continue;
      if (agent.status === 'done') continue;
      if (now - agent.lastActivityAt < DONE_TIMEOUT_MS) continue;
      agent.status = 'done';
      agent.doneEmitted = true;
      this.writeArchive(agent);
      this.emitStatusOnly(agent);
      logger.debug('subagent', `Agent ${agent.agentId} marked done (timeout)`);
    }
  }

  /**
   * Walk an entire historic JSONL once to derive final metrics and lifecycle
   * for an agent that finished before the daemon started (no archive yet).
   * Mirrors the relevant parts of processEntry but without emitting events.
   */
  private replayHistoricJsonl(jsonlPath: string): {
    toolUseCount: number;
    tokenCount: number;
    firstEventAt: number | null;
    lastEventAt: number | null;
    endedWithEndTurn: boolean;
  } | null {
    let raw: string;
    try {
      raw = fs.readFileSync(jsonlPath, 'utf-8');
    } catch {
      return null;
    }

    let toolUseCount = 0;
    let tokenCount = 0;
    let firstEventAt: number | null = null;
    let lastEventAt: number | null = null;
    let endedWithEndTurn = false;
    const seenToolUseIds = new Set<string>();

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const ts = entry.timestamp as string | undefined;
      if (ts) {
        const ms = Date.parse(ts);
        if (!Number.isNaN(ms)) {
          if (firstEventAt === null || ms < firstEventAt) firstEventAt = ms;
          if (lastEventAt === null || ms > lastEventAt) lastEventAt = ms;
        }
      }

      if (entry.type !== 'assistant') continue;

      const message = entry.message as {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
        stop_reason?: string;
        content?: Array<{ type: string; id?: string }>;
      } | undefined;

      if (message?.usage) {
        const u = message.usage;
        tokenCount =
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.input_tokens ?? 0) +
          (u.output_tokens ?? 0);
      }

      endedWithEndTurn = message?.stop_reason === 'end_turn';

      if (Array.isArray(message?.content)) {
        for (const block of message!.content) {
          if (block.type === 'tool_use') {
            const id = block.id ?? '';
            if (!seenToolUseIds.has(id)) {
              seenToolUseIds.add(id);
              toolUseCount++;
            }
          }
        }
      }
    }

    return { toolUseCount, tokenCount, firstEventAt, lastEventAt, endedWithEndTurn };
  }

  /**
   * Persist a final snapshot of the subagent's lifecycle + metrics so that
   * `getSubagentHistory` can stamp them onto replayed messages without
   * re-walking the JSONL. Written once when the agent transitions to done
   * (either via the SubagentStop hook or the activity timeout).
   */
  private writeArchive(agent: ActiveSubagent): void {
    const archivePath = agent.jsonlPath.replace(/\.jsonl$/, '.archive.json');
    try {
      const payload = {
        agentId: agent.agentId,
        agentType: agent.meta.agentType,
        agentName: agent.meta.description,
        status: 'done' as const,
        toolUseCount: agent.toolUseCount,
        tokenCount: agent.tokenCount,
        firstEventAt: agent.firstEventAt,
        lastEventAt: agent.lastEventAt,
        archivedAt: Date.now(),
      };
      fs.writeFileSync(archivePath, JSON.stringify(payload, null, 2));
    } catch (err) {
      logger.warn('subagent', `Failed to write archive for ${agent.agentId}: ${(err as Error).message}`);
    }
  }
}
