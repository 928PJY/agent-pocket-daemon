// Agent Pocket -- Session Manager
// Manages Claude Code sessions via the Claude Agent SDK.
// Uses query() with streaming input for persistent sessions and canUseTool
// callback for interactive permission approval from the phone.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { query, forkSession } from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
  Options as SDKQueryOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { StreamInputController } from './stream-input-controller.js';
import {
  resolveClaudeExecutable,
  expandPath,
  assertWorkingDirectoryExists,
} from './path-utils.js';

export { StreamInputController } from './stream-input-controller.js';
export { resolveClaudeExecutable, expandPath } from './path-utils.js';

export type QueryFactory = (args: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: SDKQueryOptions;
}) => Query;
import type {
  ClaudeEvent,
  ThinkingEvent,
  AssistantMessageEvent,
  ToolUseEvent,
  ToolResultEvent,
  PermissionMode,
} from 'agent-pocket-protocol';
import { PermissionDecision, SessionStatus } from 'agent-pocket-protocol';
import { SessionObserver } from '../observers/session-observer.js';
import { sendMessage as terminalSendMessage, sendInterrupt as terminalSendInterrupt } from '../pty/tmux-injector.js';
import type { TerminalTarget } from '../pty/tmux-injector.js';
import { logger } from '../logger.js';

// ============================================================================
// Types
// ============================================================================

export interface SessionConfig {
  name?: string;
  agent_type?: 'claude_code' | 'codex';
  working_directory?: string;
  model?: string;
  system_prompt?: string;
  allowed_tools?: string[];
  /**
   * Launch the SDK Query with `allowDangerouslySkipPermissions: true`. Required
   * for the session to switch into `bypassPermissions` mode later.
   */
  dangerously_skip_permissions?: boolean;
}

export interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  timer?: ReturnType<typeof setTimeout>;
  createdAt: number;
}

export interface SessionState {
  sessionId: string;
  abortController: AbortController;
  inputController: StreamInputController;
  queryHandle: Query | null;
  status: SessionStatus;
  pendingPermissions: Map<string, PendingPermission>;
  pendingPermissionResolvers: Map<string, (result: PermissionResult) => void>;
  alwaysAllowedTools: Set<string>;
  workingDirectory: string;
  createdAt: number;
  lastActivity: number;
  /** Claude Code's own session ID (from init/result), used for --resume */
  claudeSessionId?: string;
  /** User-supplied session name shown in the phone session list. */
  name?: string;
  /** Config used to create this session, needed for respawning */
  config?: SessionConfig;
  messageQueue: string[];
  /** Messages injected via terminal — used to suppress duplicate echo back to phone */
  injectedMessages: Set<string>;
  /** Whether session_started has been emitted at least once */
  hasEmittedStarted: boolean;
  /** Whether the current title was set by the user (custom-title) — locks out
   *  subsequent ai-title overrides from Claude Code's per-turn regeneration. */
  titleIsCustom: boolean;
  /** Track last emitted text length per content type to compute deltas */
  lastEmittedTextLength: number;
  lastEmittedThinkingLength: number;
  /** Track emitted tool_use IDs to avoid duplicates */
  emittedToolUseIds: Set<string>;
  /** Whether this session is observed (tailing JSONL) rather than controlled (SDK) */
  isObserved: boolean;
  /** Current SDK permission mode for controller-mode sessions. Undefined for observed. */
  permissionMode?: PermissionMode;
  /** The SessionObserver instance for observed sessions */
  observer?: SessionObserver;
  /** PID of the terminal Claude process (for observed sessions) */
  terminalPid?: number;
  /** Custom title from the JSONL file or discovery */
  customTitle?: string;
  /** Terminal injection target (iTerm2 or tmux) */
  terminalTarget?: TerminalTarget;
  /** Where the session was started: "cli", "claude-vscode", etc. */
  entrypoint?: string;
  /** Whether the session observer has received at least one event since observation started.
   *  Used to distinguish "went stale while we were watching" from "was already stale on discovery". */
  hasReceivedEvents: boolean;
}

export interface SessionManagerConfig {
  default_working_directory?: string;
  default_model?: string;
  max_concurrent_sessions?: number;
  /** Override the SDK query() factory. Used by tests to inject a fake Query
   *  without spawning the Claude binary. */
  queryFactory?: QueryFactory;
}

export interface SessionManagerEvents {
  session_started: [sessionId: string, workingDirectory: string, customTitle?: string];
  session_output: [sessionId: string, event: ClaudeEvent];
  session_ended: [sessionId: string, exitCode: number];
  session_status: [sessionId: string, status: SessionStatus];
  session_interrupted: [sessionId: string, reason: 'streaming' | 'tool_use', source: 'sdk' | 'observer'];
  permission_request: [sessionId: string, requestId: string, toolName: string, toolInput: Record<string, unknown>];
  permission_mode_changed: [sessionId: string, mode: PermissionMode];
  error: [sessionId: string, error: Error];
}

// ============================================================================
// SessionManager
// ============================================================================

export class SessionManager extends EventEmitter {
  private sessions: Map<string, SessionState> = new Map();
  private config: SessionManagerConfig;
  private sessionCounter: number = 0;
  private queryFactory: QueryFactory;

  constructor(config: SessionManagerConfig = {}) {
    super();
    this.config = config;
    this.queryFactory = config.queryFactory ?? ((args) => query(args));
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all active sessions.
   */
  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get the count of active (non-ended) sessions.
   */
  getActiveSessionCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.status !== SessionStatus.HISTORY && session.status !== SessionStatus.ERROR) {
        count++;
      }
    }
    return count;
  }

  /**
   * Create a new Claude Code session via the Agent SDK.
   */
  createSession(config: SessionConfig): string {
    const maxSessions = this.config.max_concurrent_sessions ?? 5;
    if (this.getActiveSessionCount() >= maxSessions) {
      throw new Error(`Maximum concurrent sessions (${maxSessions}) reached`);
    }

    const sessionId = this.generateSessionId();
    const workingDir = expandPath(config.working_directory ?? this.config.default_working_directory ?? process.cwd());
    assertWorkingDirectoryExists(workingDir);
    // Pre-generate the Claude session UUID and pass it to the SDK via
    // `options.sessionId` so the external id is stable from the very first
    // emitted event — avoids a window where the phone sees an internal id and
    // then output frames arrive under the real claudeSessionId.
    const claudeSessionId = randomUUID();
    const abortController = new AbortController();
    const inputController = new StreamInputController();
    inputController.ownerSessionId = sessionId;

    const state: SessionState = {
      sessionId,
      claudeSessionId,
      name: config.name,
      abortController,
      inputController,
      queryHandle: null,
      status: SessionStatus.STARTING,
      pendingPermissions: new Map(),
      pendingPermissionResolvers: new Map(),
      alwaysAllowedTools: new Set(),
      workingDirectory: workingDir,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      config,
      messageQueue: [],
      injectedMessages: new Set(),
      hasEmittedStarted: false,
      customTitle: config.name,
      titleIsCustom: config.name ? true : false,
      lastEmittedTextLength: 0,
      lastEmittedThinkingLength: 0,
      emittedToolUseIds: new Set(),
      isObserved: false,
      permissionMode: 'default',
      hasReceivedEvents: false,
    };

    this.sessions.set(sessionId, state);

    // Start the SDK query
    const handle = this.queryFactory({
      prompt: inputController.stream(),
      options: this.buildQueryOptions(state, config, true),
    });
    state.queryHandle = handle;

    // Consume messages in the background
    this.consumeQueryStream(state);

    return sessionId;
  }

  /**
   * Resume an existing session by Claude session ID.
   */
  resumeSession(claudeSessionId: string, config: SessionConfig = {}): string {
    const maxSessions = this.config.max_concurrent_sessions ?? 5;
    if (this.getActiveSessionCount() >= maxSessions) {
      throw new Error(`Maximum concurrent sessions (${maxSessions}) reached`);
    }

    const sessionId = this.generateSessionId();
    const workingDir = expandPath(config.working_directory ?? this.config.default_working_directory ?? process.cwd());
    assertWorkingDirectoryExists(workingDir);
    const abortController = new AbortController();
    const inputController = new StreamInputController();
    inputController.ownerSessionId = sessionId;

    const state: SessionState = {
      sessionId,
      abortController,
      inputController,
      queryHandle: null,
      status: SessionStatus.STARTING,
      pendingPermissions: new Map(),
      pendingPermissionResolvers: new Map(),
      alwaysAllowedTools: new Set(),
      workingDirectory: workingDir,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      claudeSessionId,
      config,
      messageQueue: [],
      injectedMessages: new Set(),
      hasEmittedStarted: false,
      customTitle: config.name,
      titleIsCustom: config.name ? true : false,
      lastEmittedTextLength: 0,
      lastEmittedThinkingLength: 0,
      emittedToolUseIds: new Set(),
      isObserved: false,
      permissionMode: 'default',
      hasReceivedEvents: false,
    };

    this.sessions.set(sessionId, state);

    const handle = this.queryFactory({
      prompt: inputController.stream(),
      options: {
        ...this.buildQueryOptions(state, config),
        resume: claudeSessionId,
      },
    });
    state.queryHandle = handle;

    this.consumeQueryStream(state);

    return sessionId;
  }

  /**
   * Send a user message to an active session.
   */
  async sendMessage(sessionId: string, message: string): Promise<{ sdkUuid?: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.status === 'error') {
      throw new Error(`Session ${sessionId} is in error state`);
    }

    // Observer mode: inject messages via tmux into the terminal
    if (session.isObserved) {
      // Check if the terminal process is still alive
      let terminalAlive = false;
      if (session.terminalPid) {
        try {
          process.kill(session.terminalPid, 0);
          terminalAlive = true;
        } catch {
          // PID is dead
        }
      }

      if (!terminalAlive) {
        throw new Error('Terminal session has ended. Please restart Claude in the terminal.');
      }

      if (!session.terminalTarget) {
        throw new Error('Cannot send message — terminal not detected. Please run Claude in iTerm2 or tmux.');
      }

      // Always inject directly — Claude Code manages its own input queue internally.
      logger.debug('session-manager', 'Injecting message into terminal', {
        sessionId,
        claudeSessionId: session.claudeSessionId,
        terminalPid: session.terminalPid,
        targetType: session.terminalTarget.type,
        target: session.terminalTarget.target,
      });

      // Track this message so the JSONL echo can be suppressed (the phone
      // already rendered it locally). Then inject once via tmux/iTerm2.
      // We do NOT block ack on JSONL confirmation: when Claude is in
      // pending_actions or otherwise not in input mode, the keystrokes are
      // buffered into Claude's own input queue and won't appear in JSONL until
      // accepted. Retrying would cause duplicate messages.
      session.injectedMessages.add(message);
      try {
        terminalSendMessage(session.terminalTarget, message);
      } catch (err) {
        session.injectedMessages.delete(message);
        throw new Error(`Failed to inject message into terminal: ${(err as Error).message}`);
      }
      logger.debug('session-manager', 'Message injected into terminal', { sessionId });

      // Best-effort post-inject probe: if the echo never lands within the
      // window, log a warn so silent failures (osascript "ok" but text never
      // reached iTerm2 — e.g. iTerm hung, TTY race) leave a breadcrumb. We
      // do not retry and do not change the ack — the phone already saw
      // committed and any retry risks duplicates.
      const probeTimeoutMs = 1500;
      setTimeout(() => {
        if (session.injectedMessages.has(message)) {
          logger.warn('session-manager', 'No JSONL echo for injected message within probe window', {
            sessionId,
            timeoutMs: probeTimeoutMs,
          });
        }
      }, probeTimeoutMs).unref();
      // Observed-mode echo carries sdkUuid via session_output user_message;
      // no need to wait for it here.
      return {};
    }

    // Controller mode: pre-generate the SDK transcript uuid and stamp it on
    // the pushed SDKUserMessage. The SDK accepts a caller-provided uuid on
    // streaming-input pushes (per the Agent SDK docs), so we can return it
    // synchronously instead of awaiting an echo frame.
    const sdkUuid = randomUUID();

    // If the query is still alive, push directly
    if (session.queryHandle && !session.inputController.closed) {
      session.inputController.push({
        type: 'user',
        uuid: sdkUuid,
        message: { role: 'user', content: message },
        parent_tool_use_id: null,
      } as SDKUserMessage);
      session.status = SessionStatus.RUNNING;
      session.lastActivity = Date.now();
      this.emit('session_status', sessionId, SessionStatus.RUNNING);
      logger.trace('session-manager', 'Pushed user message', { sessionId, sdkUuid });
      return { sdkUuid };
    }

    // Query ended — resume with a new query
    this.resumeWithMessage(session, message, sdkUuid);
    return { sdkUuid };
  }

  /**
   * Respond to a pending permission request.
   * Resolves the canUseTool promise so the SDK can continue.
   */
  respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: Record<string, unknown>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const pending = session.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission with request ID: ${requestId}`);
    }

    // Clear the auto-deny timer (no-op for controller-mode entries)
    if (pending.timer) clearTimeout(pending.timer);
    session.pendingPermissions.delete(requestId);

    // Resolve the canUseTool promise
    const resolver = session.pendingPermissionResolvers.get(requestId);
    if (resolver) {
      session.pendingPermissionResolvers.delete(requestId);
      const allowed = decision === PermissionDecision.APPROVE || decision === PermissionDecision.ALWAYS_ALLOW;

      if (decision === PermissionDecision.ALWAYS_ALLOW) {
        session.alwaysAllowedTools.add(pending.toolName);
      }

      if (allowed) {
        resolver({ behavior: 'allow', updatedInput: updatedInput ?? pending.toolInput });
      } else {
        resolver({ behavior: 'deny', message: 'User denied permission' });
      }
    }

    session.lastActivity = Date.now();

    // Update status if no more pending permissions
    if (session.pendingPermissions.size === 0 && session.status === 'pending_actions') {
      session.status = SessionStatus.RUNNING;
    }
  }

  /**
   * Observe an existing terminal Claude session by tailing its JSONL file.
   * The daemon watches output and forwards it to the phone, but does not
   * control the session — permissions are handled via HTTP hooks.
   */
  observeSession(
    claudeSessionId: string,
    jsonlPath: string,
    workingDirectory: string,
    terminalPid: number,
    customTitle?: string,
    terminalTarget?: TerminalTarget,
    entrypoint?: string,
  ): string {
    // Evict any stale prior observation of the same claudeSessionId. This
    // happens when discovery initially mapped the session to the wrong PID
    // (e.g. PID files lag behind /clear) and later sees it under the right
    // PID — without eviction, findByClaudeSessionId hits the older stale
    // entry first and routes phone messages to the wrong terminal.
    //
    // We do NOT emit `session_ended` here: the Claude session itself is
    // still alive (we're just rebinding our internal handle to the right
    // PID), and the phone would otherwise render a misleading "Session
    // ended" line in the middle of an ongoing chat.
    for (const [oldSessionId, oldState] of this.sessions) {
      if (oldState.claudeSessionId === claudeSessionId && oldState.isObserved) {
        logger.debug('session-manager', 'Evicting stale observed session for claudeSessionId', {
          oldSessionId,
          claudeSessionId,
          oldTerminalPid: oldState.terminalPid,
          newTerminalPid: terminalPid,
        });
        this.cleanupSession(oldState);
        this.sessions.delete(oldSessionId);
      }
    }

    const sessionId = this.generateSessionId();
    const abortController = new AbortController();
    const inputController = new StreamInputController();
    inputController.ownerSessionId = sessionId;

    const observer = new SessionObserver(claudeSessionId, jsonlPath);

    // Use the JSONL file's mtime as initial lastActivity (more accurate than Date.now())
    let initialLastActivity = Date.now();
    try {
      const stat = fs.statSync(jsonlPath);
      initialLastActivity = stat.mtimeMs;
    } catch {
      // Fall back to Date.now() if file can't be stat'd
    }

    const state: SessionState = {
      sessionId,
      abortController,
      inputController,
      queryHandle: null,
      status: SessionStatus.READY,
      pendingPermissions: new Map(),
      pendingPermissionResolvers: new Map(),
      alwaysAllowedTools: new Set(),
      workingDirectory,
      createdAt: Date.now(),
      lastActivity: initialLastActivity,
      claudeSessionId,
      messageQueue: [],
      injectedMessages: new Set(),
      hasEmittedStarted: false,
      titleIsCustom: false,
      lastEmittedTextLength: 0,
      lastEmittedThinkingLength: 0,
      emittedToolUseIds: new Set(),
      isObserved: true,
      observer,
      terminalPid,
      customTitle,
      terminalTarget,
      entrypoint,
      hasReceivedEvents: false,
    };

    this.sessions.set(sessionId, state);

    // Wire observer events to session manager events
    observer.on('output', (event: ClaudeEvent) => {
      state.lastActivity = Date.now();
      state.hasReceivedEvents = true;

      // Suppress user_message events for messages we injected from the phone
      // (the phone already shows them locally — echoing causes duplicates)
      if (event.type === 'user_message' && state.injectedMessages.delete(event.message)) {
        return;
      }

      this.emit('session_output', sessionId, event);
    });

    observer.on('title', (title: string, isCustom: boolean) => {
      // Once a custom title is set, ignore subsequent ai-title entries —
      // Claude Code regenerates ai-title every turn and would otherwise
      // clobber the user's chosen title.
      if (!isCustom && state.titleIsCustom) return;
      state.customTitle = title;
      if (isCustom) state.titleIsCustom = true;
      if (!state.hasEmittedStarted) {
        state.hasEmittedStarted = true;
        this.emit('session_started', sessionId, workingDirectory, title);
      } else {
        // Title arrived after session_started — notify separately
        this.emit('session_title', sessionId, title);
      }
    });

    observer.on('error', (err: Error) => {
      this.emit('error', sessionId, err);
    });

    observer.on('status_change', (status: 'running' | 'ready') => {
      const newStatus = status as SessionStatus;
      // Don't let observer override pending_actions in session state —
      // but still emit the event so daemon can decide (it checks pendingBlockingRequests)
      if (state.status === SessionStatus.PENDING_ACTIONS) {
        this.emit('session_status', sessionId, newStatus);
        return;
      }
      if (state.status !== newStatus) {
        state.status = newStatus;
        state.lastActivity = Date.now();
        state.hasReceivedEvents = true;
        this.emit('session_status', sessionId, newStatus);
      }
    });

    observer.on('interrupted', (reason: 'streaming' | 'tool_use') => {
      state.status = SessionStatus.READY;
      state.lastActivity = Date.now();
      state.hasReceivedEvents = true;
      this.emit('session_interrupted', sessionId, reason, 'observer');
    });

    // Start tailing
    observer.start();

    if (!state.hasEmittedStarted) {
      state.hasEmittedStarted = true;
      this.emit('session_started', sessionId, workingDirectory, customTitle);
    }

    // Check if JSONL indicates the session is already waiting for user input
    // (e.g., daemon started after Claude was already showing a permission dialog)
    const pendingCheck = SessionObserver.isPendingUserAction(jsonlPath);
    if (pendingCheck.pending) {
      state.status = SessionStatus.PENDING_ACTIONS;
      this.emit('session_status', sessionId, SessionStatus.PENDING_ACTIONS);
      this.emit('pending_action_detected', sessionId, pendingCheck.toolName);
      logger.info('session-manager', 'Session detected as pending user action on startup', { sessionId, toolName: pendingCheck.toolName });
    } else {
      // Start as ready — the observer will emit 'running' when it sees activity
      this.emit('session_status', sessionId, SessionStatus.READY);
    }

    logger.info('session-manager', 'Observing terminal session', {
      sessionId,
      claudeSessionId,
      terminalPid,
      targetType: terminalTarget?.type,
      target: terminalTarget?.target,
    });

    return sessionId;
  }

  /**
   * Clear pending_actions status on a session (called by daemon when
   * the blocking request is resolved).
   */
  clearPendingActions(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.status === SessionStatus.PENDING_ACTIONS) {
      session.status = SessionStatus.READY;
      this.emit('session_status', sessionId, SessionStatus.READY);
    }
  }

  /**
   * Check if a session is in observer mode (tailing terminal JSONL).
   */
  isObservedSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.isObserved ?? false;
  }

  /**
   * Find a session by its Claude session ID (not the internal session ID).
   */
  findByClaudeSessionId(claudeSessionId: string): SessionState | undefined {
    for (const session of this.sessions.values()) {
      if (session.claudeSessionId === claudeSessionId) return session;
    }
    return undefined;
  }

  /**
   * Find an observed session by its terminal PID.
   */
  findByTerminalPid(pid: number): SessionState | undefined {
    for (const session of this.sessions.values()) {
      if (session.isObserved && session.terminalPid === pid) return session;
    }
    return undefined;
  }

  /**
   * Mark an observed session as history (terminal PID exited).
   * Stops the observer and notifies the phone. Does NOT take over the session.
   */
  markObservedSessionHistory(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isObserved) return;

    session.observer?.stop();
    session.isObserved = false;
    session.observer = undefined;
    session.terminalPid = undefined;
    session.terminalTarget = undefined;
    session.status = SessionStatus.HISTORY;
    this.emit('session_status', sessionId, SessionStatus.HISTORY);
    logger.debug('session-manager', 'Terminal exited for observed session', { sessionId });

    // Discard any queued messages — terminal is gone
    if (session.messageQueue.length > 0) {
      logger.warn('session-manager', 'Discarding queued messages for ended session', { sessionId, count: session.messageQueue.length });
      session.messageQueue = [];
    }
  }

  /**
   * Remove a session from tracking entirely (e.g. after /clear replaces it).
   */
  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.cleanupSession(session);
    this.sessions.delete(sessionId);
  }

  /**
   * Kill a specific session.
   */
  async killSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.cleanupSession(session);
    if (session.isObserved) {
      session.status = SessionStatus.HISTORY;
      this.emit('session_ended', sessionId, 0);
    } else {
      session.abortController.abort();
    }
  }

  /**
   * Interrupt a session.
   * Observed sessions: send ESC via terminal injection.
   * SDK sessions: call Query.interrupt(), which stops the current turn but
   * keeps the query alive so the next user message lands on the same query
   * (no resume + STARTING gap).
   */
  async interruptSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.isObserved && session.terminalTarget) {
      logger.debug('session-manager', 'Sending ESC interrupt to terminal', { sessionId });
      terminalSendInterrupt(session.terminalTarget);
      return;
    }

    if (session.isObserved) {
      throw new Error('Cannot interrupt — no terminal target available');
    }

    if (!session.queryHandle) {
      logger.debug('session-manager', 'Interrupt requested but no live query', { sessionId });
      return;
    }

    logger.debug('session-manager', 'Interrupting SDK query', { sessionId });
    try {
      await session.queryHandle.interrupt();
      session.lastActivity = Date.now();
      this.emit('session_interrupted', sessionId, 'streaming', 'sdk');
    } catch (err) {
      // Fall back to abort if the SDK rejects the interrupt (e.g. query already
      // settling). abort() ends the session entirely, matching the old behaviour.
      logger.warn('session-manager', `Query.interrupt() failed, falling back to abort: ${(err as Error).message}`, { sessionId });
      session.abortController.abort();
    }
  }

  /**
   * Switch the active permission mode on a controller-mode session's SDK Query.
   * Throws for observer-mode sessions or sessions with no live query handle.
   */
  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.isObserved) throw new Error('not_supported: observed sessions cannot change permission mode');
    if (!session.queryHandle) throw new Error('No live query — session is not currently controllable');
    await session.queryHandle.setPermissionMode(mode);
    session.permissionMode = mode;
    session.lastActivity = Date.now();
    this.emit('permission_mode_changed', sessionId, mode);
    logger.debug('session-manager', 'Set permission mode', { sessionId, mode });
  }

  /**
   * Switch the active model on a controller-mode session's SDK Query.
   * Pass `undefined` to reset to the SDK's default model.
   */
  async setModel(sessionId: string, model: string | undefined): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.isObserved) throw new Error('not_supported: observed sessions cannot change model');
    if (!session.queryHandle) throw new Error('No live query — session is not currently controllable');
    await session.queryHandle.setModel(model);
    session.lastActivity = Date.now();
    logger.debug('session-manager', 'Set model', { sessionId, model });
  }

  /**
   * Enumerate the SDK Query's supportedModels(). Controller-mode only.
   */
  async getSupportedModels(sessionId: string): Promise<Awaited<ReturnType<NonNullable<SessionState['queryHandle']>['supportedModels']>>> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.isObserved) throw new Error('not_supported: observed sessions cannot query supported models');
    if (!session.queryHandle) throw new Error('No live query — session is not currently controllable');
    return await session.queryHandle.supportedModels();
  }

  /**
   * Snapshot the SDK Query's current context-window usage. Controller-mode only.
   */
  async getContextUsage(sessionId: string): Promise<Awaited<ReturnType<NonNullable<SessionState['queryHandle']>['getContextUsage']>>> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.isObserved) throw new Error('not_supported: observed sessions cannot query context usage');
    if (!session.queryHandle) throw new Error('No live query — session is not currently controllable');
    return await session.queryHandle.getContextUsage();
  }

  /**
   * Enumerate the slash commands the SDK Query knows about. Controller-mode only.
   */
  async getSupportedCommands(sessionId: string): Promise<Awaited<ReturnType<NonNullable<SessionState['queryHandle']>['supportedCommands']>>> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.isObserved) throw new Error('not_supported: observed sessions cannot query supported commands');
    if (!session.queryHandle) throw new Error('No live query — session is not currently controllable');
    return await session.queryHandle.supportedCommands();
  }

  /**
   * Enumerate the subagents the SDK Query can spawn. Controller-mode only.
   */
  async getSupportedAgents(sessionId: string): Promise<Awaited<ReturnType<NonNullable<SessionState['queryHandle']>['supportedAgents']>>> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.isObserved) throw new Error('not_supported: observed sessions cannot query supported agents');
    if (!session.queryHandle) throw new Error('No live query — session is not currently controllable');
    return await session.queryHandle.supportedAgents();
  }

  /**
   * Snapshot of MCP server connections for this session. Controller-mode only.
   */
  async getMcpServerStatus(sessionId: string): Promise<Awaited<ReturnType<NonNullable<SessionState['queryHandle']>['mcpServerStatus']>>> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.isObserved) throw new Error('not_supported: observed sessions cannot query MCP status');
    if (!session.queryHandle) throw new Error('No live query — session is not currently controllable');
    return await session.queryHandle.mcpServerStatus();
  }

  /**
   * Rewind a session to a given user message.
   *
   * Two-phase. `dryRun: true` only previews file changes (`filesChanged` /
   * `insertions` / `deletions`) — disk untouched, no fork happens, the
   * session keeps running. The phone uses dry-run to populate the
   * confirmation sheet.
   *
   * `dryRun: false` performs the real rewind:
   *   1. `Query.rewindFiles(uuid)` restores tracked files. **Must run on
   *      the live (pre-fork) query** — fork drops the checkpoint history
   *      ("Forked sessions start without undo history").
   *   2. `forkSession(claudeSessionId, { upToMessageId: uuid })` slices
   *      the SDK transcript inclusive of the target message and returns a
   *      new claudeSessionId. The source session's query keeps running so
   *      the user can continue the original timeline in parallel.
   *   3. A new internal session is created via `resumeSession(...)` against
   *      the fork's claude session id, inheriting the original's working
   *      directory + config.
   *
   * The returned `newSessionId` is the new internal id the phone should
   * navigate to. Controller-mode only — observer sessions throw
   * `not_supported`. If `rewindFiles` reports `canRewind: false` the
   * fork is skipped and `newSessionId` is omitted.
   */
  async rewindSession(
    sessionId: string,
    userMessageId: string,
    dryRun: boolean,
  ): Promise<{
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
    newSessionId?: string;
  }> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.isObserved) throw new Error('not_supported: observed sessions cannot be rewound');
    if (!session.queryHandle) throw new Error('No live query — session is not currently controllable');
    if (!session.claudeSessionId) throw new Error('Session has no claudeSessionId — cannot fork');

    const fileResult = await session.queryHandle.rewindFiles(userMessageId, { dryRun });

    if (dryRun || !fileResult.canRewind) {
      logger.debug('session-manager', 'rewindSession (preview/denied)', {
        sessionId,
        userMessageId,
        dryRun,
        canRewind: fileResult.canRewind,
        filesChanged: fileResult.filesChanged?.length ?? 0,
      });
      return {
        canRewind: fileResult.canRewind,
        error: fileResult.error,
        filesChanged: fileResult.filesChanged,
        insertions: fileResult.insertions,
        deletions: fileResult.deletions,
      };
    }

    const sourceClaudeSessionId = session.claudeSessionId;
    const forkResult = await forkSession(sourceClaudeSessionId, { upToMessageId: userMessageId });

    // Keep the source query alive so the user can continue the original
    // timeline. fork returns a distinct claudeSessionId, so the two SDK
    // processes don't collide on hook routing.

    const newSessionId = this.resumeSession(forkResult.sessionId, {
      ...(session.config ?? {}),
      working_directory: session.workingDirectory,
      name: session.customTitle,
    });

    logger.info('session-manager', 'rewindSession applied', {
      sessionId,
      userMessageId,
      sourceClaudeSessionId,
      forkClaudeSessionId: forkResult.sessionId,
      newSessionId,
      filesChanged: fileResult.filesChanged?.length ?? 0,
    });

    return {
      canRewind: true,
      filesChanged: fileResult.filesChanged,
      insertions: fileResult.insertions,
      deletions: fileResult.deletions,
      newSessionId,
    };
  }

  /**
   * Emergency abort -- kill all sessions immediately.
   */
  emergencyAbort(): void {
    for (const session of this.sessions.values()) {
      this.cleanupSession(session);
      session.abortController.abort();
      session.status = SessionStatus.HISTORY;
    }
  }

  /**
   * Graceful shutdown -- kill all sessions.
   */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      this.cleanupSession(session);
      session.abortController.abort();
    }
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private generateSessionId(): string {
    this.sessionCounter++;
    return `session_${Date.now()}_${this.sessionCounter}`;
  }

  private buildQueryOptions(state: SessionState, config: SessionConfig, includeSessionId = false) {
    const model = config.model ?? this.config.default_model;
    const claudePath = resolveClaudeExecutable();
    return {
      cwd: state.workingDirectory,
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      ...(model ? { model } : {}),
      ...(config.system_prompt ? { systemPrompt: config.system_prompt } : {}),
      ...(includeSessionId && state.claudeSessionId ? { sessionId: state.claudeSessionId } : {}),
      ...(includeSessionId && state.customTitle ? { title: state.customTitle } : {}),
      permissionMode: 'default' as const,
      ...(config.dangerously_skip_permissions ? { allowDangerouslySkipPermissions: true } : {}),
      ...(config.allowed_tools?.length ? { allowedTools: config.allowed_tools } : {}),
      canUseTool: this.buildCanUseTool(state),
      abortController: state.abortController,
      // Enables Query.rewindFiles() — backs the phone's "Rewind to here"
      // affordance. SDK keeps per-file backups before each modifying tool
      // call; restoring is bounded by user-message id.
      enableFileCheckpointing: true,
    };
  }

  /**
   * Build a canUseTool callback for a session.
   * Bridges async SDK permission requests to our event-based respondPermission().
   */
  private buildCanUseTool(session: SessionState) {
    return async (
      toolName: string,
      toolInput: Record<string, unknown>,
      options: { signal: AbortSignal },
    ): Promise<PermissionResult> => {
      // Auto-allow if tool was previously marked as always-allow
      if (session.alwaysAllowedTools.has(toolName)) {
        return { behavior: 'allow', updatedInput: toolInput };
      }

      const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Create a promise that respondPermission() will resolve
      const permissionPromise = new Promise<PermissionResult>((resolve) => {
        session.pendingPermissionResolvers.set(requestId, resolve);
      });

      // Register with auto-deny timeout + emit event
      this.registerPermissionRequest(
        session.sessionId,
        requestId,
        toolName,
        toolInput,
      );

      // If abort signal fires, deny immediately
      options.signal.addEventListener('abort', () => {
        const resolver = session.pendingPermissionResolvers.get(requestId);
        if (resolver) {
          session.pendingPermissionResolvers.delete(requestId);
          resolver({ behavior: 'deny', message: 'Aborted' });
        }
      }, { once: true });

      return permissionPromise;
    };
  }

  /**
   * Register a permission request from the SDK canUseTool channel.
   *
   * No auto-deny timer: controller-mode permissions block the SDK query
   * indefinitely until the phone responds, the user aborts the session, or
   * cleanupSession() resolves the pending promise. This lets users leave
   * their phone for arbitrarily long without losing in-flight questions.
   */
  private registerPermissionRequest(
    sessionId: string,
    requestId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = SessionStatus.PENDING_ACTIONS;
    this.emit('session_status', sessionId, SessionStatus.PENDING_ACTIONS);

    session.pendingPermissions.set(requestId, {
      requestId,
      toolName,
      toolInput,
      createdAt: Date.now(),
    });

    this.emit('permission_request', sessionId, requestId, toolName, toolInput);
  }

  /**
   * Resume a session that has ended, creating a new query with --resume.
   */
  private resumeWithMessage(session: SessionState, message: string, sdkUuid?: string): void {
    if (!session.claudeSessionId) {
      throw new Error(`Session ${session.sessionId} has ended and no Claude session ID available for resume`);
    }

    logger.debug('session-manager', 'Resuming session', { sessionId: session.sessionId, claudeSessionId: session.claudeSessionId });

    const abortController = new AbortController();
    const inputController = new StreamInputController();
    inputController.ownerSessionId = session.sessionId;

    inputController.push({
      type: 'user',
      ...(sdkUuid ? { uuid: sdkUuid } : {}),
      message: { role: 'user', content: message },
      parent_tool_use_id: null,
    } as SDKUserMessage);

    session.abortController = abortController;
    session.inputController = inputController;
    session.status = SessionStatus.STARTING;
    session.lastActivity = Date.now();

    // Fresh SDK process: it won't replay prior assistant content over the
    // streaming-input channel, so start delta tracking at 0. (Initializing
    // these to MAX_SAFE_INTEGER would silently drop the first response
    // because slice(MAX) is "" and the resume path never sees a 'user'
    // frame to reset the counter back to 0.)
    session.lastEmittedTextLength = 0;
    session.lastEmittedThinkingLength = 0;
    // Don't clear emittedToolUseIds — old tool IDs should remain suppressed

    const handle = this.queryFactory({
      prompt: inputController.stream(),
      options: {
        ...this.buildQueryOptions(session, session.config ?? {}),
        resume: session.claudeSessionId,
        abortController,
      },
    });
    session.queryHandle = handle;

    this.consumeQueryStream(session);
  }

  /**
   * Consume the SDK AsyncGenerator and map messages to ClaudeEvent emissions.
   */
  private async consumeQueryStream(state: SessionState): Promise<void> {
    const { sessionId, queryHandle } = state;
    if (!queryHandle) return;

    try {
      // First-time spawn: surface the session immediately as READY (waiting
      // for user input). Re-entry (e.g. after sendMessage queues a turn)
      // transitions to RUNNING.
      if (!state.hasEmittedStarted) {
        state.hasEmittedStarted = true;
        state.status = SessionStatus.READY;
        this.emit('session_started', sessionId, state.workingDirectory, state.customTitle);
        this.emit('session_status', sessionId, SessionStatus.READY);
      } else {
        state.status = SessionStatus.RUNNING;
        this.emit('session_status', sessionId, SessionStatus.RUNNING);
      }

      for await (const message of queryHandle) {
        state.lastActivity = Date.now();
        this.handleSDKMessage(state, message);
      }

      // Generator ended normally — mark query as done so sendMessage uses resumeWithMessage
      state.queryHandle = null;
      state.inputController.close();
      state.status = SessionStatus.READY;
      this.emit('session_status', sessionId, SessionStatus.READY);
      logger.debug('session-manager', 'Query stream ended', { sessionId });

    } catch (err) {
      const e = err as Error;
      // Mark query as done
      state.queryHandle = null;
      state.inputController.close();

      if (e.name === 'AbortError') {
        state.status = SessionStatus.HISTORY;
        this.emit('session_ended', sessionId, 0);
        logger.debug('session-manager', 'Session aborted', { sessionId });
      } else {
        logger.error('session-manager', `Query stream error: ${e.message}`, { sessionId });
        this.emit('error', sessionId, err instanceof Error ? err : new Error(String(err)));
        if (state.claudeSessionId) {
          state.status = SessionStatus.READY;
          this.emit('session_status', sessionId, SessionStatus.READY);
        } else {
          state.status = SessionStatus.HISTORY;
          this.emit('session_ended', sessionId, 1);
        }
      }
    }
  }

  /**
   * Map a single SDK message to ClaudeEvent emissions.
   */
  private handleSDKMessage(state: SessionState, message: SDKMessage): void {
    const { sessionId } = state;

    switch (message.type) {
      case 'system': {
        if ('session_id' in message && message.session_id) {
          state.claudeSessionId = message.session_id;
          logger.debug('session-manager', 'Captured Claude session ID', { sessionId: state.sessionId, claudeSessionId: message.session_id });
        }
        break;
      }

      case 'assistant': {
        const betaMessage = (message as { message?: { content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }> } }).message;
        if (betaMessage?.content) {
          for (const block of betaMessage.content) {
            switch (block.type) {
              case 'thinking': {
                const fullText = block.thinking ?? '';
                // SDK sends full accumulated text; emit only the new delta
                const delta = fullText.slice(state.lastEmittedThinkingLength);
                state.lastEmittedThinkingLength = fullText.length;
                if (delta.length > 0) {
                  const event: ThinkingEvent = { type: 'thinking', thinking: delta };
                  state.status = SessionStatus.RUNNING;
                  this.emit('session_output', sessionId, event);
                }
                break;
              }
              case 'text': {
                const fullText = block.text ?? '';
                const delta = fullText.slice(state.lastEmittedTextLength);
                state.lastEmittedTextLength = fullText.length;
                if (delta.length > 0) {
                  const event: AssistantMessageEvent = { type: 'assistant_message', message: delta };
                  state.status = SessionStatus.RUNNING;
                  this.emit('session_output', sessionId, event);
                }
                break;
              }
              case 'tool_use': {
                const toolId = block.id ?? 'unknown';
                // Avoid emitting the same tool_use multiple times
                if (state.emittedToolUseIds.has(toolId)) break;
                state.emittedToolUseIds.add(toolId);
                const event: ToolUseEvent = {
                  type: 'tool_use',
                  tool_id: toolId,
                  tool_name: block.name ?? 'unknown',
                  tool_input: (block.input as Record<string, unknown>) ?? {},
                };
                state.status = SessionStatus.RUNNING;
                this.emit('session_output', sessionId, event);
                break;
              }
            }
          }
        }
        break;
      }

      case 'user': {
        // New user turn — reset delta tracking for the next assistant response
        state.lastEmittedTextLength = 0;
        state.lastEmittedThinkingLength = 0;
        state.emittedToolUseIds.clear();

        const userMessage = (message as { message?: { content?: unknown } }).message;
        const content = userMessage?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const event: ToolResultEvent = {
                type: 'tool_result',
                tool_id: block.tool_use_id,
                status: block.is_error ? 'error' : 'success',
                output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
              };
              state.status = SessionStatus.RUNNING;
              this.emit('session_output', sessionId, event);
            }
          }
        }
        break;
      }

      case 'result': {
        if ('session_id' in message && message.session_id) {
          state.claudeSessionId = message.session_id;
        }
        // Reset delta tracking for next turn
        state.lastEmittedTextLength = 0;
        state.lastEmittedThinkingLength = 0;
        state.emittedToolUseIds.clear();
        state.status = SessionStatus.READY;
        this.emit('session_status', sessionId, SessionStatus.READY);
        break;
      }

      default:
        // Ignore other SDK message types (stream_event, hook_*, etc.)
        break;
    }
  }

  /**
   * Clean up a session's pending state (permissions, timers).
   */
  private cleanupSession(session: SessionState): void {
    // Stop observer if present
    if (session.observer) {
      session.observer.stop();
    }

    // Clear all pending permission timeouts
    for (const pending of session.pendingPermissions.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    session.pendingPermissions.clear();

    // Resolve all pending permission promises with deny
    for (const resolver of session.pendingPermissionResolvers.values()) {
      resolver({ behavior: 'deny', message: 'Session killed' });
    }
    session.pendingPermissionResolvers.clear();

    session.inputController.close();
  }
}
