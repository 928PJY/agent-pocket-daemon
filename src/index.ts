// Agent Pocket -- AgentPocketDaemon
// Main orchestrator that wires SessionManager, RelayClient, CryptoEngine,
// and SessionDiscovery together. Handles all PhoneCommand types from the relay.

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SessionManager } from './sessions/session-manager.js';
import type { SessionConfig } from './sessions/session-manager.js';
import { RelayClient } from './relay/relay-client.js';
import { CryptoEngine } from './crypto/crypto-engine.js';
import { rawEd25519ToSpki } from './crypto/key-format.js';
import { SessionDiscovery } from './discovery/session-discovery.js';
import { isProcessSuspendedOrZombie } from './discovery/session-discovery.js';
import { CodexDiscovery, isCodexSessionId } from './discovery/codex-discovery.js';
import type { CodexSession } from './discovery/codex-discovery.js';
import { CodexObserver } from './observers/codex-observer.js';
import { HookServer } from './hooks/hook-server.js';
import type { HookPermissionRequest, HookToolResult, HookPermissionPrompt, HookPermissionExpired } from './hooks/hook-server.js';
import { findTerminalForPid, sendInterrupt as terminalSendInterrupt, sendMessage as terminalSendMessage } from './pty/tmux-injector.js';
import { LanServer } from './lan/lan-server.js';
import { BonjourAdvertiser } from './lan/bonjour-advertiser.js';
import { formatTimestamp, logger } from './logger.js';
import { readLastTurnSummary } from './utils/transcript-reader.js';
import type {
  PhoneCommand,
  ConnectionMode,
  NewSessionCommand,
  ResumeSessionCommand,
  SendMessageCommand,
  PermissionResponseCommand,
  QuestionResponseCommand,
  KillSessionCommand,
  InterruptSessionCommand,
  ListSessionsCommand,
  ReadFileCommand,
  EmergencyAbortCommand,
  GetHistoryCommand,
  SetPreferencesCommand,
  SessionOutputAckCommand,
  VerifyHistoryCommand,
  PcEvent,
  SessionStartedEvent,
  SessionOutputEvent,
  SessionEndedEvent,
  PermissionRequestEvent,
  SessionListEvent,
  FileContentEvent,
  ErrorEvent,
  MessageAckEvent,
  HistoryDivergenceEvent,
  ClaudeEvent,
  PeerHello,
  SessionInfo,
  AgentType,
  WakeBlobPayload,
} from './shared/index.js';
import {
  RISK_CLASSIFICATION,
  RiskLevel,
  PermissionDecision,
  HOOK_HOLD_TIMEOUT_SECONDS,
  DAEMON_DEFAULT_PORT,
  SessionStatus,
  HOOK_SERVER_PORT,
  VERSION,
  WIRE_VERSION_CURRENT,
  CURRENT_PEER_CAPABILITIES,
  BLOCKING_RETRY_INTERVAL_MS,
  BLOCKING_RETRY_CHECK_INTERVAL_MS,
} from './shared/index.js';

// ============================================================================
// Types
// ============================================================================

export interface DaemonConfig {
  relayUrl: string;
  pairId: string;
  authToken: string;
  defaultWorkingDirectory?: string;
  defaultModel?: string;
  maxConcurrentSessions?: number;
  connectionMode?: ConnectionMode;
  lanPort?: number;
  phoneIdentityPublicKey?: string; // base64 Ed25519 public key of paired phone (for LAN auth)
  // E2E encryption session keys (base64)
  sessionSendKey?: string;
  sessionRecvKey?: string;
  sessionSasKey?: string;
}

// ============================================================================
// AgentPocketDaemon
// ============================================================================

/** Format seconds as a compact human-readable duration: "12s", "1m23s", "1h05m". */
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

/** Format a token count compactly: "923 tok", "12.3k tok", "1.2M tok". */
function formatTokens(total: number): string {
  if (total < 1000) return `${total} tok`;
  if (total < 1_000_000) return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k tok`;
  return `${(total / 1_000_000).toFixed(1)}M tok`;
}

/** Build the Session Completed subtitle: "3 tools · 1m23s · 12.3k tok". */
function formatCompletionSubtitle(summary: { toolUseCount: number; totalTokens: number; durationSec: number }): string | undefined {
  const parts: string[] = [];
  if (summary.toolUseCount > 0) {
    parts.push(`${summary.toolUseCount} ${summary.toolUseCount === 1 ? 'tool' : 'tools'}`);
  }
  if (summary.durationSec >= 1) parts.push(formatDuration(summary.durationSec));
  if (summary.totalTokens > 0) parts.push(formatTokens(summary.totalTokens));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = '';
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf-8');
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}

function detectClaudeVersion(): string | undefined {
  try {
    const output = execFileSync('claude', ['--version'], { encoding: 'utf-8', timeout: 2000 }).trim();
    const match = output.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
    return match?.[1] ?? (output || undefined);
  } catch {
    return undefined;
  }
}

export class AgentPocketDaemon extends EventEmitter {
  private config: DaemonConfig;
  private sessionManager: SessionManager;
  private relayClient: RelayClient | null = null;
  private cryptoEngine: CryptoEngine;
  private sessionDiscovery: SessionDiscovery;
  private codexDiscovery: CodexDiscovery;
  private codexObservers: Map<string, { observer: CodexObserver; session: CodexSession; status: SessionStatus; lastActivity: number }> = new Map();
  private claudeAgentVersion?: string;
  private hookServer: HookServer;
  private lanServer: LanServer | null = null;
  private bonjourAdvertiser: BonjourAdvertiser | null = null;
  private pidCheckInterval: ReturnType<typeof setInterval> | null = null;
  // Hook server restart backoff state
  private hookRestartAttempts: number = 0;
  private hookRestartTimer: ReturnType<typeof setTimeout> | null = null;

  // Peer (phone) capability set learned from peer_hello. Empty until the
  // first peer_hello arrives over the E2E channel.
  private peerCapabilities: Set<string> = new Set();
  private peerProductVersion: string | null = null;
  private peerWireVersion: number | null = null;

  // Map internal session IDs to Claude session IDs (for resume)
  private sessionIdMap: Map<string, string> = new Map();
  // Claude session IDs that were replaced by /clear (stale PID files still reference them)
  private replacedSessionIds: Set<string> = new Set();
  // Temporary storage for terminal info between SessionEnd and SessionStart during /clear
  private pendingClearInfo: Map<string, { pid: number; cwd: string; target: import('./pty/tmux-injector.js').TerminalTarget | undefined; entrypoint?: string }> = new Map();
  // Reverse map: request_id -> internal session_id (for new_session responses)
  private pendingSessionRequests: Map<string, string> = new Map();
  // Sequence counter for signed messages
  private messageSeq: number = 0;
  // Per-session monotonic seq for session_output events (for phone gap detection)
  private sessionSeqCounters: Map<string, number> = new Map();
  // Last seq the phone has acked per session (best-effort telemetry)
  private lastAckedSeqs: Map<string, number> = new Map();
  // Phone preferences (sent via set_preferences command)
  private phonePreferences: { showToolUse: boolean; showCompletionMetrics: boolean } = {
    showToolUse: false,
    showCompletionMetrics: true,
  };
  // Suppress per-session events during initial discovery; phone uses list_sessions instead
  private initialDiscoveryDone = false;

  // Blocking request retry: track pending requests that block Claude's progress.
  // If no phone response within BLOCKING_RETRY_INTERVAL_MS, resend the event.
  private pendingBlockingRequests: Map<string, {
    requestId: string;
    sessionId: string;
    event: PcEvent;
    sentAt: number;
    type: 'permission_request' | 'user_question' | 'plan_review';
  }> = new Map();
  private blockingRetryInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: DaemonConfig) {
    super();
    this.config = config;

    // Initialize sub-components
    this.sessionManager = new SessionManager({
      default_working_directory: config.defaultWorkingDirectory,
      default_model: config.defaultModel,
      max_concurrent_sessions: config.maxConcurrentSessions,
    });

    this.cryptoEngine = new CryptoEngine();
    this.cryptoEngine.loadOrGenerateIdentityKeyPair();

    // Restore E2E session keys from saved config
    if (config.sessionSendKey && config.sessionRecvKey) {
      this.cryptoEngine.restoreSessionKeys(
        Buffer.from(config.sessionSendKey, 'base64'),
        Buffer.from(config.sessionRecvKey, 'base64'),
        config.sessionSasKey ? Buffer.from(config.sessionSasKey, 'base64') : undefined,
      );
      logger.info('daemon', 'E2E encryption enabled — session keys restored');
      logger.info('daemon', `Session keys: send=${config.sessionSendKey?.substring(0, 8)}... recv=${config.sessionRecvKey?.substring(0, 8)}...`);
    }

    // Restore phone signing key for signature verification
    if (config.phoneIdentityPublicKey) {
      try {
        this.cryptoEngine.setPeerIdentityPublicKey(rawEd25519ToSpki(config.phoneIdentityPublicKey));
      } catch { /* ignore if key format is already SPKI */ }
    }

    const mode = config.connectionMode ?? 'relay';

    if (mode === 'relay') {
      this.relayClient = new RelayClient({
        relayUrl: config.relayUrl,
        pairId: config.pairId,
        authToken: config.authToken,
        encrypt: this.cryptoEngine.hasSessionKeys()
          ? this.cryptoEngine.createEncryptFn()
          : undefined,
        decrypt: this.cryptoEngine.hasSessionKeys()
          ? this.cryptoEngine.createDecryptFn()
          : undefined,
        encryptWakeBlob: this.cryptoEngine.hasSessionKeys()
          ? this.cryptoEngine.createWakeBlobEncryptFn()
          : undefined,
      });
    }

    this.sessionDiscovery = new SessionDiscovery();
    this.codexDiscovery = new CodexDiscovery();
    this.claudeAgentVersion = detectClaudeVersion();
    this.hookServer = new HookServer(HOOK_SERVER_PORT);
  }

  /**
   * Start the daemon: wire events and connect to relay.
   */
  async start(): Promise<number> {
    // Start the hook server first so we know the port
    const hookPort = await this.hookServer.start();

    this.wireSessionManagerEvents();
    this.wireHookServerEvents();
    this.wirePermissionPromptEvents();

    const mode = this.config.connectionMode ?? 'relay';

    if (mode === 'lan') {
      const port = this.config.lanPort ?? DAEMON_DEFAULT_PORT;
      this.lanServer = new LanServer({
        port,
        cryptoEngine: this.cryptoEngine,
        pairId: this.config.pairId,
        phoneIdentityPublicKey: this.config.phoneIdentityPublicKey ?? '',
      });
      await this.lanServer.start();
      this.wireLanServerEvents();

      // Start Bonjour advertisement
      this.bonjourAdvertiser = new BonjourAdvertiser(
        port,
        this.config.pairId,
        os.hostname(),
        VERSION,
      );
      await this.bonjourAdvertiser.start();
    } else {
      this.wireRelayClientEvents();
      this.relayClient!.connect();
    }

    // Discover running CLI sessions and observe them
    await this.discoverAndObserveSessions();
    this.discoverAndObserveCodexSessions();
    this.initialDiscoveryDone = true;

    // Sweep stale session-map.json entries (e.g. CLIs that ended before this
    // daemon started, or PIDs reused by unrelated processes). One sweep at
    // startup is enough — entries written during this daemon's lifetime are
    // cleaned up by cleanSessionMap() on PID-death detection.
    this.gcSessionMap();

    // Periodically check observed PIDs and discover new CLI sessions
    this.pidCheckInterval = setInterval(() => {
      this.checkObservedSessionPids();
      this.discoverAndObserveSessions().catch((err) => {
        logger.error('daemon', `Periodic discovery error: ${(err as Error).message}`);
      });
      this.discoverAndObserveCodexSessions();
    }, 5000);

    // Periodically retry blocking requests that haven't received a phone response
    this.blockingRetryInterval = setInterval(() => {
      this.retryPendingBlockingRequests();
    }, BLOCKING_RETRY_CHECK_INTERVAL_MS);

    return hookPort;
  }

  /**
   * Stop the daemon gracefully.
   */
  async stop(): Promise<void> {
    if (this.pidCheckInterval) {
      clearInterval(this.pidCheckInterval);
      this.pidCheckInterval = null;
    }
    if (this.hookRestartTimer) {
      clearTimeout(this.hookRestartTimer);
      this.hookRestartTimer = null;
    }
    if (this.blockingRetryInterval) {
      clearInterval(this.blockingRetryInterval);
      this.blockingRetryInterval = null;
    }
    this.pendingBlockingRequests.clear();
    if (this.relayClient) {
      this.relayClient.disconnect();
    }
    if (this.lanServer) {
      await this.lanServer.stop();
      this.lanServer = null;
    }
    if (this.bonjourAdvertiser) {
      this.bonjourAdvertiser.stop();
      this.bonjourAdvertiser = null;
    }
    await this.hookServer.stop();
    for (const { observer } of this.codexObservers.values()) {
      observer.stop();
    }
    this.codexObservers.clear();
    await this.sessionManager.shutdown();
  }

  /**
   * Emergency abort: kill everything immediately.
   */
  emergencyAbort(): void {
    this.sessionManager.emergencyAbort();
    if (this.relayClient) {
      this.relayClient.disconnect();
    }
  }

  /**
   * Get the hook server port (for configuring Claude hooks).
   */
  getHookPort(): number {
    return this.hookServer.getPort();
  }

  // --------------------------------------------------------------------------
  // Event Wiring: SessionManager -> Relay
  // --------------------------------------------------------------------------

  private wireSessionManagerEvents(): void {
    this.sessionManager.on('session_started', (sessionId: string, workingDirectory: string, customTitle?: string) => {
      // During initial discovery, suppress individual session events.
      // The phone will get the full picture from the list_sessions response.
      if (!this.initialDiscoveryDone) return;

      const requestId = this.findRequestIdForSession(sessionId);
      const externalId = this.resolveExternalSessionId(sessionId);

      const event: SessionStartedEvent = {
        type: 'session_started',
        session_id: externalId,
        request_id: requestId ?? externalId,
        working_directory: workingDirectory,
        project_name: customTitle ?? path.basename(workingDirectory),
        agent_type: 'claude_code',
        agent_display_name: 'Claude Code',
        agent_version: this.claudeAgentVersion,
        capabilities: ['observe', 'terminal_remote_message', 'terminal_interrupt', 'permissions', 'plan_review', 'user_question'],
      };

      this.sendToPhone(event);
    });

    this.sessionManager.on('session_output', (sessionId: string, claudeEvent: ClaudeEvent) => {
      // Skip tool_use and tool_result events when phone has disabled tool use messages.
      // When skipping tool_use, send an empty is_complete=true assistant_message to
      // finalize the current streaming bubble, so the next text chunk starts a new bubble.
      if (!this.phonePreferences.showToolUse &&
          (claudeEvent.type === 'tool_use' || claudeEvent.type === 'tool_result')) {
        if (claudeEvent.type === 'tool_use') {
          const externalId = this.resolveExternalSessionId(sessionId);
          this.sendToPhone({
            type: 'session_output',
            session_id: externalId,
            timestamp: Date.now(),
            output_type: 'assistant_message',
            content: '',
            is_complete: true,
          } as unknown as PcEvent);
        }
        return;
      }

      this.sendFlattenedSessionOutput(this.resolveExternalSessionId(sessionId), claudeEvent, 'claude_code');
    });

    this.sessionManager.on('session_ended', (sessionId: string, exitCode: number) => {
      const externalId = this.resolveExternalSessionId(sessionId);
      const event: SessionEndedEvent = {
        type: 'session_ended',
        session_id: externalId,
        exit_code: exitCode,
        end_reason: exitCode === 0 ? 'completed' : 'error',
      };

      if (exitCode !== 0) {
        const sessionName = this.getSessionName(externalId);
        this.sendToPhone(event, true, {
          type: 'session_error',
          session_name: sessionName,
          body: `Session exited with code ${exitCode}`,
          subtitle: sessionName,
          sound: 'default',
          category: 'SESSION_ERROR',
          session_id: externalId,
        });
      } else {
        this.sendToPhone(event);
      }

      // Clean up mappings
      this.sessionIdMap.delete(sessionId);

      // Clean up any pending blocking requests for this session
      for (const [reqId, entry] of this.pendingBlockingRequests) {
        if (entry.sessionId === externalId) {
          this.pendingBlockingRequests.delete(reqId);
        }
      }
    });

    this.sessionManager.on(
      'permission_request',
      (sessionId: string, requestId: string, toolName: string, toolInput: Record<string, unknown>) => {
        const externalId = this.resolveExternalSessionId(sessionId);

        // AskUserQuestion: forward as interactive question, don't auto-approve.
        if (toolName === 'AskUserQuestion') {
          const questions = (toolInput.questions as Array<{ question?: string }>) ?? [];
          const questionPreview = questions[0]?.question ?? 'Claude has a question';
          const flat: Record<string, unknown> = {
            type: 'session_output',
            session_id: externalId,
            output_type: 'user_question',
            request_id: requestId,
            tool_input: toolInput,
            timestamp: new Date().toISOString(),
            ttl: HOOK_HOLD_TIMEOUT_SECONDS,
          };
          this.sendToPhone(flat as unknown as PcEvent, true, {
            type: 'user_question',
            session_name: this.getSessionName(externalId),
            body: truncateUtf8(questionPreview, 256),
            sound: 'default',
            category: 'USER_QUESTION',
            session_id: externalId,
            request_id: requestId,
          });
          this.trackBlockingRequest(requestId, externalId, flat as unknown as PcEvent, 'user_question');
          logger.debug('daemon', `Forwarded SDK AskUserQuestion as user_question for session ${externalId}`);
          return;
        }

        // Plan mode: auto-approve EnterPlanMode and plan file edits.
        // ExitPlanMode: send plan for phone review.
        if (this.isPlanModeTool(toolName, toolInput)) {
          if (toolName === 'ExitPlanMode') {
            const session = this.sessionManager.getSession(sessionId);
            const cwd = session?.workingDirectory ?? '';
            this.sendPlanForReview(externalId, requestId, toolInput, cwd);
            logger.debug('daemon', `SDK ExitPlanMode: sent plan to phone for review (${requestId})`);
            return;
          }
          this.sessionManager.respondPermission(sessionId, requestId, PermissionDecision.APPROVE);
          logger.debug('daemon', `SDK auto-approved plan mode tool: ${toolName} (${requestId})`);
          return;
        }

        // SDK sessions: the SDK itself decides when to fire permission_request,
        // so forward all other tools to the phone for approval.
        const riskLevel = (RISK_CLASSIFICATION[toolName] ?? RiskLevel.MEDIUM).toLowerCase();
        const context = this.buildPermissionContext(toolName, toolInput);

        // Sign the permission request
        const signaturePayload = JSON.stringify({
          session_id: sessionId,
          request_id: requestId,
          tool_name: toolName,
          seq: this.messageSeq,
          timestamp: Date.now(),
        });

        let pcSignature: string;
        try {
          pcSignature = this.cryptoEngine.sign(signaturePayload);
        } catch {
          pcSignature = '';
        }

        const event: PermissionRequestEvent = {
          type: 'permission_request',
          session_id: externalId,
          request_id: requestId,
          tool_name: toolName,
          tool_input: toolInput,
          risk_level: riskLevel as unknown as RiskLevel,
          context,
          pc_signature: pcSignature,
          seq: this.messageSeq++,
          timestamp: new Date().toISOString() as unknown as number,
          ttl: HOOK_HOLD_TIMEOUT_SECONDS,
        };

        this.sendToPhone(event);
        this.trackBlockingRequest(requestId, externalId, event, 'permission_request');
      },
    );

    this.sessionManager.on('error', (sessionId: string, error: Error) => {
      const event: ErrorEvent = {
        type: 'error',
        message: `Session ${sessionId}: ${error.message}`,
        code: 'SESSION_ERROR',
      };

      this.sendToPhone(event);
    });

    this.sessionManager.on('session_status', (sessionId: string, status: SessionStatus) => {
      if (!this.initialDiscoveryDone) return;

      const externalId = this.resolveExternalSessionId(sessionId);

      // If observer reports running/ready and we only have startup-synthetic pending
      // entries for this session, clean them up — the terminal user resolved it.
      if (status === SessionStatus.RUNNING || status === SessionStatus.READY) {
        const syntheticId = `startup_pending_${externalId}`;
        if (this.pendingBlockingRequests.has(syntheticId)) {
          this.pendingBlockingRequests.delete(syntheticId);
          // Also clear pending_actions in session-manager so handleListSessions picks it up
          const session = this.sessionManager.getAllSessions().find(
            s => this.resolveExternalSessionId(s.sessionId) === externalId
              || s.claudeSessionId === externalId,
          );
          if (session) {
            this.sessionManager.clearPendingActions(session.sessionId);
          }
          logger.debug('daemon', `Cleaned up startup synthetic pending for session ${externalId.slice(0, 8)} (observer=${status})`);
        }
      }

      // If session has pending blocking requests, keep showing pending_actions
      // regardless of what the observer reports (observer doesn't know about hooks).
      const hasPending = Array.from(this.pendingBlockingRequests.values()).some(
        e => e.sessionId === externalId,
      );
      const effectiveStatus = hasPending ? SessionStatus.PENDING_ACTIONS : status;

      logger.debug('daemon', `session_status: observer=${status} effective=${effectiveStatus}`, { sessionId: externalId, hasPending, pendingCount: this.pendingBlockingRequests.size });

      const event: Record<string, unknown> = {
        type: 'session_status',
        session_id: externalId,
        status: effectiveStatus,
      };

      // Include action_type when in pending_actions state
      if (hasPending) {
        const pendingEntry = Array.from(this.pendingBlockingRequests.values()).find(
          e => e.sessionId === externalId,
        );
        if (pendingEntry) {
          event.action_type = pendingEntry.type;
        }
      }

      this.sendToPhone(event as unknown as PcEvent);
    });

    // Session detected as pending user action on startup (JSONL analysis)
    this.sessionManager.on('pending_action_detected', (sessionId: string, toolName?: string) => {
      const externalId = this.resolveExternalSessionId(sessionId);
      const syntheticId = `startup_pending_${externalId}`;

      // Map tool name to action type
      let actionType: 'permission_request' | 'user_question' | 'plan_review' = 'permission_request';
      if (toolName === 'AskUserQuestion') actionType = 'user_question';
      else if (toolName === 'ExitPlanMode') actionType = 'plan_review';

      // Create a synthetic blocking request so session stays in pending_actions
      // until the user acts (observer status_change won't override it).
      // Mark as expiredToTerminal so retryPendingBlockingRequests doesn't clean it up.
      const entry: any = {
        requestId: syntheticId,
        sessionId: externalId,
        event: { type: 'session_status', session_id: externalId, status: SessionStatus.PENDING_ACTIONS } as unknown as PcEvent,
        sentAt: Date.now(),
        type: actionType,
        expiredToTerminal: true,
      };
      this.pendingBlockingRequests.set(syntheticId, entry);
      logger.info('daemon', `Startup pending action detected for session ${externalId.slice(0, 8)}, tool=${toolName}`);
    });

    this.sessionManager.on('session_title', (sessionId: string, title: string) => {
      const externalId = this.resolveExternalSessionId(sessionId);
      const event = {
        type: 'session_title',
        session_id: externalId,
        title,
      };
      this.sendToPhone(event as unknown as PcEvent);
    });

    // Terminal user pressed Esc/Ctrl+C — observer detected synthetic interrupt
    // message in JSONL. Clean up any pending blocking requests for this session
    // (the held hook HTTP connection may already be gone, but we also clear
    // the daemon-side retry tracking) and tell the phone the session is ready.
    this.sessionManager.on('session_interrupted', (sessionId: string, reason: 'streaming' | 'tool_use') => {
      const externalId = this.resolveExternalSessionId(sessionId);
      const session = this.sessionManager.getAllSessions().find(s => s.sessionId === sessionId);

      logger.info('daemon', `session_interrupted (${reason}) for ${externalId.slice(0, 8)}`);

      // Drop every pending blocking request targeting this session, and tell
      // the phone to remove the corresponding card so it doesn't keep ticking.
      for (const [reqId, entry] of this.pendingBlockingRequests) {
        if (entry.sessionId === externalId) {
          this.pendingBlockingRequests.delete(reqId);
          const ev = entry.event as any;
          const toolName = ev?.tool_name ?? '';
          this.sendToPhone({
            type: 'permission_dismissed',
            request_id: reqId,
            tool_name: toolName,
            session_id: externalId,
            cancelled: true,
          } as unknown as PcEvent);
        }
      }
      if (session) {
        this.sessionManager.clearPendingActions(session.sessionId);
      }

      this.sendToPhone({
        type: 'session_status',
        session_id: externalId,
        status: SessionStatus.READY,
      } as unknown as PcEvent);
    });
  }

  // --------------------------------------------------------------------------
  // Event Wiring: RelayClient -> Command Handling
  // --------------------------------------------------------------------------

  private wireRelayClientEvents(): void {
    this.relayClient!.on('message', (payload: unknown) => {
      const cmdType = (payload as { type?: string; request_id?: string })?.type;
      const reqId = (payload as { request_id?: string })?.request_id;
      logger.trace('daemon', 'IN relay command', { type: cmdType, requestId: reqId, preview: JSON.stringify(payload).slice(0, 100) });

      if (cmdType === 'peer_hello') {
        this.handlePeerHello(payload as PeerHello);
        return;
      }

      const command = payload as PhoneCommand;
      this.handleCommand(command).catch((err) => {
        logger.error('daemon', `Command handler error: ${(err as Error).message}`, { type: cmdType, requestId: reqId });
        const errorEvent: ErrorEvent = {
          type: 'error',
          request_id: (command as { request_id?: string }).request_id,
          message: `Command handler error: ${(err as Error).message}`,
          code: 'COMMAND_ERROR',
        };
        this.sendToPhone(errorEvent);
      });
    });

    this.relayClient!.on('connected', () => {
      logger.debug('daemon', '=== CONNECTED to relay ===');
      logger.info('daemon', 'Connected to relay');
      this.emit('connected');
    });

    this.relayClient!.on('phone_online', () => {
      logger.debug('daemon', 'Phone online, resending pending requests', { count: this.pendingBlockingRequests.size });

      // Send peer_hello over the encrypted channel so the phone can learn
      // our product version and capability set.
      this.sendPeerHello();

      // Send key fingerprint for E2E verification
      const fp = this.cryptoEngine.sendKeyFingerprint();
      if (fp) {
        this.relayClient!.sendControlFrame({ action: 'key_verify', key_fingerprint: fp });
      }

      let resent = 0;
      for (const [requestId, entry] of this.pendingBlockingRequests) {
        logger.debug('daemon', 'reconnect resend candidate', {
          requestId,
          sessionId: entry.sessionId,
          eventType: (entry.event as any)?.type,
          actionType: (entry as any).type,
          expiredToTerminal: !!(entry as any).expiredToTerminal,
        });
        // Expired-to-terminal entries: still resend so a freshly launched phone
        // (no in-memory cache) can rebuild the card. Then send a
        // permission_expired event so the card shows the timed-out banner.
        if ((entry as any).expiredToTerminal) {
          this.sendToPhone(entry.event);
          if ((entry.event as any)?.type === 'permission_request') {
            this.sendToPhone({
              type: 'permission_expired',
              session_id: entry.sessionId,
              request_id: requestId,
              tool_name: (entry.event as any).tool_name,
            } as unknown as PcEvent);
          }
          this.sendToPhone({
            type: 'session_status',
            session_id: entry.sessionId,
            status: SessionStatus.PENDING_ACTIONS,
            action_type: entry.type,
          } as unknown as PcEvent);
          resent++;
          continue;
        }

        const hookPending = this.hookServer.hasPendingPermission(requestId);
        const sdkPending = this.sessionManager.getAllSessions().some(
          s => s.pendingPermissions?.has(requestId),
        );
        if (hookPending || sdkPending) {
          this.sendToPhone(entry.event);
          entry.sentAt = Date.now();
          resent++;
        } else {
          this.pendingBlockingRequests.delete(requestId);
        }
      }
      logger.debug('daemon', `Resent ${resent} pending blocking requests`);
    });

    this.relayClient!.on('key_verify', (peerFingerprint: string) => {
      const expected = this.cryptoEngine.recvKeyFingerprint();
      if (!expected) return;
      if (peerFingerprint === expected) {
        logger.info('daemon', 'E2E key verification passed');
      } else {
        logger.error('daemon', 'E2E key mismatch — phone has stale keys', { expected, received: peerFingerprint });
        this.relayClient!.sendControlFrame({
          action: 'e2e_error',
          message: 'E2E key mismatch. Please re-pair the device.',
        });
      }
    });

    this.relayClient!.on('disconnected', (reason: string) => {
      logger.warn('daemon', `Disconnected from relay: ${reason}`);
      this.emit('disconnected', reason);
    });

    this.relayClient!.on('error', (error: Error) => {
      logger.error('daemon', `Relay error: ${error.message}`);
    });

    this.relayClient!.on('decrypt_error', (count: number) => {
      logger.warn('daemon', `E2E decrypt failed ${count} times — phone may need to re-pair`);
      if (count === 3) {
        this.relayClient!.sendControlFrame({
          action: 'e2e_error',
          message: 'Decryption failed. Please re-pair the device.',
        });
      }
    });
  }

  // --------------------------------------------------------------------------
  // Event Wiring: LanServer -> Command Handling
  // --------------------------------------------------------------------------

  private wireLanServerEvents(): void {
    this.lanServer!.on('message', (payload: unknown) => {
      const cmdType = (payload as { type?: string })?.type;
      const reqId = (payload as { request_id?: string })?.request_id;
      logger.trace('daemon', 'IN lan command', { type: cmdType, requestId: reqId, preview: JSON.stringify(payload).slice(0, 100) });

      if (cmdType === 'peer_hello') {
        this.handlePeerHello(payload as PeerHello);
        return;
      }

      const command = payload as PhoneCommand;
      this.handleCommand(command).catch((err) => {
        logger.error('daemon', `Command handler error (lan): ${(err as Error).message}`, { type: cmdType, requestId: reqId });
        const errorEvent: ErrorEvent = {
          type: 'error',
          request_id: (command as { request_id?: string }).request_id,
          message: `Command handler error: ${(err as Error).message}`,
          code: 'COMMAND_ERROR',
        };
        this.sendToPhone(errorEvent);
      });
    });

    this.lanServer!.on('connected', () => {
      logger.debug('daemon', '=== CONNECTED via LAN ===');
      logger.info('daemon', 'Connected via LAN');
      // LAN connect implies authenticated + E2E session keys ready, so we can
      // send peer_hello immediately.
      this.sendPeerHello();
      this.emit('connected');
    });

    this.lanServer!.on('disconnected', (reason: string) => {
      logger.warn('daemon', `Disconnected from LAN: ${reason}`);
      this.emit('disconnected', reason);
    });

    this.lanServer!.on('error', (error: Error) => {
      logger.error('daemon', `LAN error: ${error.message}`);
    });

    this.lanServer!.on('decrypt_error', (count: number) => {
      logger.warn('daemon', `E2E decrypt failed ${count} times (LAN) — phone may need to re-pair`);
      if (count === 3) {
        this.lanServer!.send({
          type: 'e2e_error',
          message: 'Decryption failed. Please re-pair the device.',
        });
      }
    });
  }

  // --------------------------------------------------------------------------
  // Event Wiring: HookServer -> Phone
  // --------------------------------------------------------------------------

  private wireHookServerEvents(): void {
    // PreToolUse hook: pass through everything. The hook exists only to establish
    // tool_use_id correlation for PermissionRequest matching and PostToolUse cleanup.
    // All actual permission handling happens in the PermissionRequest hook.
    this.hookServer.on('permission_request', (request: HookPermissionRequest) => {
      this.hookServer.resolvePermissionEmpty(request.toolUseId);
    });

    this.hookServer.on('tool_result', (result: HookToolResult) => {
      // Skip tool_result events when phone has disabled tool use messages
      if (!this.phonePreferences.showToolUse) return;

      const session = this.sessionManager.findByClaudeSessionId(result.sessionId);
      const externalId = session
        ? this.resolveExternalSessionId(session.sessionId)
        : result.sessionId;

      const flat: Record<string, unknown> = {
        type: 'session_output',
        session_id: externalId,
        timestamp: Date.now(),
        output_type: 'tool_result',
        tool_use_id: result.toolUseId,
        output: typeof result.toolResponse === 'string'
          ? result.toolResponse
          : JSON.stringify(result.toolResponse ?? ''),
        is_error: false,
      };

      this.sendToPhone(flat as unknown as PcEvent);
    });

    this.hookServer.on('error', (err: Error) => {
      logger.error('daemon', `Hook server error: ${err.message}`);
      this.restartHookServer();
    });

    this.hookServer.on('permission_expired', (expired: HookPermissionExpired) => {
      const session = this.sessionManager.findByClaudeSessionId(expired.sessionId);
      const externalId = session
        ? this.resolveExternalSessionId(session.sessionId)
        : expired.sessionId;

      const event = {
        type: 'permission_expired',
        session_id: externalId,
        request_id: expired.toolUseId,
        tool_name: expired.toolName,
      };

      this.sendToPhone(event as unknown as PcEvent);

      // Mark as expired but keep in pendingBlockingRequests so session list
      // still shows waitingPermission until terminal user acts.
      const blocking = this.pendingBlockingRequests.get(expired.toolUseId);
      if (blocking) {
        (blocking as any).expiredToTerminal = true;
      }
      logger.debug('daemon', `Permission expired for ${expired.toolName} (${expired.toolUseId})`);
    });

    // Local API: return tracked sessions for CLI `sessions` command
    this.hookServer.on('api_sessions', (respond: (sessions: unknown) => void) => {
      const sessions = this.sessionManager.getAllSessions().map(s => ({
        sessionId: s.claudeSessionId ?? s.sessionId,
        status: s.status,
        pid: s.terminalPid,
        cwd: s.workingDirectory,
        isObserved: s.isObserved,
        customTitle: s.customTitle,
        entrypoint: s.entrypoint,
        lastActivity: s.lastActivity,
      }));
      respond(sessions);
    });

    this.hookServer.on('api_status', (respond: (status: unknown) => void) => {
      respond({
        relay: this.relayClient?.getConnectionState() ?? 'not configured',
        phone: this.relayClient?.getPhonePeerOnline() ?? false,
        offlineQueue: this.relayClient?.getOfflineQueueSize() ?? 0,
        sessions: this.sessionManager.getAllSessions().length,
      });
    });

    // Stop hook: Claude finished a turn — update session status to ready
    this.hookServer.on('session_stop', async (claudeSessionId: string, transcriptPath?: string) => {
      const firedAt = Date.now();
      const session = this.sessionManager.findByClaudeSessionId(claudeSessionId);
      const externalId = session
        ? this.resolveExternalSessionId(session.sessionId)
        : claudeSessionId;

      const projectName = session?.customTitle ?? (session ? path.basename(session.workingDirectory) : 'Session');

      logger.debug('daemon', 'Stop hook fired', { sessionId: externalId });

      // Claude finished this turn — any pending blocking requests we were still
      // tracking for this session are stale (resolved, expired, or interrupted).
      // Drop them so retryPendingBlockingRequests / list refresh don't resurface
      // them as "Need action".
      let cleared = 0;
      for (const [reqId, entry] of this.pendingBlockingRequests) {
        if (entry.sessionId === externalId) {
          this.pendingBlockingRequests.delete(reqId);
          cleared++;
        }
      }
      if (cleared > 0) {
        logger.info('daemon', `Stop hook cleared ${cleared} stale pending blocking request(s)`, { sessionId: externalId });
      }
      if (session) {
        this.sessionManager.clearPendingActions(session.sessionId);
      }

      const event: Record<string, unknown> = {
        type: 'session_status',
        session_id: externalId,
        status: 'ready',
      };

      // Read the end-of-turn summary from the JSONL transcript. This is the
      // sole source of truth for completion text + per-turn metrics; if the
      // transcript doesn't yield an end_turn line we send an empty body and
      // no subtitle metrics.
      let completionBody = '';
      let subtitle: string | undefined;
      if (transcriptPath) {
        try {
          const summary = await readLastTurnSummary(transcriptPath);
          if (summary) {
            completionBody = summary.text;
            subtitle = formatCompletionSubtitle(summary);
            logger.debug('daemon', 'readLastTurnSummary ok', {
              sessionId: externalId,
              textLen: summary.text.length,
              tokens: summary.totalTokens,
              tools: summary.toolUseCount,
              durSec: summary.durationSec,
            });
          } else {
            logger.warn('daemon', 'readLastTurnSummary returned null', {
              sessionId: externalId,
              transcriptPath,
              firedAt,
            });
          }
        } catch (err) {
          logger.warn('daemon', 'readLastTurnSummary threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        logger.warn('daemon', 'Stop hook has no transcriptPath', { sessionId: externalId });
      }

      // Attach completion details so iOS can render the same body/subtitle
      // in the local notification when the app is foreground/background but
      // the relevant chat isn't on screen. is_completion marks this as the
      // authoritative end-of-turn event (vs. the observer path which can fire
      // a status=ready transition without any completion data).
      event.is_completion = true;
      event.completion_body = completionBody;
      if (subtitle) event.completion_subtitle = subtitle;

      this.sendToPhone(event as unknown as PcEvent, true, {
        type: 'session_completed',
        session_name: projectName,
        body: truncateUtf8(completionBody.trim() || 'Session finished', 256),
        subtitle,
        sound: 'completion.caf',
        category: 'SESSION_COMPLETED',
        session_id: externalId,
      });

      // Also append a chat-side metrics chip (rendered as a system message)
      // so the user can see this turn's cost retrospectively, even on the
      // active session where the push notification is suppressed. We delay
      // this slightly so the SDK-stream path has time to flush the final
      // assistant_message to the phone first — otherwise the metrics chip
      // appears above the message it's summarizing.
      if (subtitle && this.phonePreferences.showCompletionMetrics) {
        setTimeout(() => {
          this.sendToPhone({
            type: 'session_output',
            session_id: externalId,
            output_type: 'completion_metrics',
            content: subtitle,
            timestamp: Date.now(),
          } as unknown as PcEvent);
        }, 500);
      }
    });

    // StopFailure hook: Claude's turn ended via API error. Same cleanup as
    // Stop, but log the error and skip the "Session Complete" notification.
    this.hookServer.on('session_stop_failure', (claudeSessionId: string, error: string) => {
      const session = this.sessionManager.findByClaudeSessionId(claudeSessionId);
      const externalId = session
        ? this.resolveExternalSessionId(session.sessionId)
        : claudeSessionId;

      logger.warn('daemon', 'StopFailure hook', { sessionId: externalId, error });

      let cleared = 0;
      for (const [reqId, entry] of this.pendingBlockingRequests) {
        if (entry.sessionId === externalId) {
          this.pendingBlockingRequests.delete(reqId);
          cleared++;
        }
      }
      if (cleared > 0) {
        logger.info('daemon', `StopFailure cleared ${cleared} stale pending blocking request(s)`, { sessionId: externalId });
      }
      if (session) {
        this.sessionManager.clearPendingActions(session.sessionId);
      }

      this.sendToPhone({
        type: 'session_status',
        session_id: externalId,
        status: SessionStatus.READY,
      } as unknown as PcEvent);
    });

    // SessionEnd hook: fired when /clear runs (with the OLD session ID)
    this.hookServer.on('session_end', (claudeSessionId: string, reason: string, cwd: string, _transcriptPath: string) => {
      logger.info('daemon', 'SessionEnd hook', { claudeSessionId, reason });

      if (reason !== 'clear') return;

      const session = this.sessionManager.findByClaudeSessionId(claudeSessionId);
      if (!session) {
        logger.debug('daemon', `SessionEnd(clear): session ${claudeSessionId} not found, ignoring`);
        return;
      }

      const oldInternalId = session.sessionId;
      const externalId = this.resolveExternalSessionId(oldInternalId);

      // Store terminal info for the upcoming SessionStart
      if (session.terminalPid) {
        this.pendingClearInfo.set(cwd, {
          pid: session.terminalPid,
          cwd: session.workingDirectory,
          target: session.terminalTarget,
          entrypoint: session.entrypoint,
        });
        // Auto-clean after 30s in case SessionStart never arrives
        setTimeout(() => this.pendingClearInfo.delete(cwd), 30_000);
      }

      // Notify phone that old session ended
      const endEvent: SessionEndedEvent = {
        type: 'session_ended',
        session_id: externalId,
        exit_code: 0,
        end_reason: 'completed',
      };
      this.sendToPhone(endEvent);

      // Clean up old session
      this.sessionManager.markObservedSessionHistory(oldInternalId);
      this.sessionIdMap.delete(oldInternalId);
      this.sessionManager.removeSession(oldInternalId);
      this.replacedSessionIds.add(claudeSessionId);

      logger.debug('daemon', `SessionEnd(clear): ended old session ${externalId}, awaiting SessionStart`);
    });

    // SubagentStop hook: fired when a Task-dispatched subagent finishes.
    // Forward to the matching SessionObserver so its SubagentObserver can
    // mark the agent done immediately (instead of waiting for activity timeout).
    this.hookServer.on('subagent_stop', (claudeSessionId: string, agentId: string, agentType: string, _transcriptPath: string) => {
      logger.debug('daemon', `SubagentStop hook: session=${claudeSessionId}, agent=${agentId} (${agentType})`);
      const session = this.sessionManager.findByClaudeSessionId(claudeSessionId);
      if (!session) {
        logger.warn('daemon', `SubagentStop: no session found for ${claudeSessionId} — falling back to broadcast`);
        // Parent session may not yet be tracked when subagent finishes very
        // fast; fan out to every observer so whoever owns this agent picks it up.
        for (const s of this.sessionManager.getAllSessions()) {
          s.observer?.markSubagentDone(agentId);
        }
        return;
      }
      if (!session.observer) {
        logger.warn('daemon', `SubagentStop: session ${claudeSessionId} has no observer`);
        return;
      }
      session.observer.markSubagentDone(agentId);
    });

    // SubagentStart hook: fired when a Task-dispatched subagent is spawned.
    // Pre-registers the agent so iOS shows the placeholder before the first
    // jsonl message is polled (~500ms savings).
    this.hookServer.on('subagent_start', (claudeSessionId: string, agentId: string, agentType: string, _transcriptPath: string) => {
      logger.debug('daemon', `SubagentStart hook: session=${claudeSessionId}, agent=${agentId} (${agentType})`);
      const session = this.sessionManager.findByClaudeSessionId(claudeSessionId);
      session?.observer?.markSubagentStart(agentId, agentType);
    });

    // SessionStart hook: fired after /clear with the NEW session ID
    this.hookServer.on('session_start', (claudeSessionId: string, source: string, cwd: string, transcriptPath: string) => {
      logger.info('daemon', 'SessionStart hook', { claudeSessionId, source });

      if (source !== 'clear') return;

      // Already tracked? Skip.
      if (this.sessionManager.findByClaudeSessionId(claudeSessionId)) return;

      // Look up the terminal info from the preceding SessionEnd
      let clearInfo = this.pendingClearInfo.get(cwd);
      if (clearInfo) {
        this.pendingClearInfo.delete(cwd);
      } else {
        // SessionEnd may not have fired yet, or daemon restarted.
        // Use session-map.json to find the PID, then look up terminal info
        // from the currently observed session for that PID.
        const mapped = this.readSessionMap();
        const mapEntry = mapped[claudeSessionId];
        if (mapEntry?.pid) {
          const existing = this.sessionManager.findByTerminalPid(mapEntry.pid);
          if (existing) {
            clearInfo = {
              pid: mapEntry.pid,
              cwd: existing.workingDirectory,
              target: existing.terminalTarget,
              entrypoint: existing.entrypoint,
            };
            // Clean up the old session
            const oldInternalId = existing.sessionId;
            const oldClaudeId = existing.claudeSessionId;
            const externalId = this.resolveExternalSessionId(oldInternalId);
            const endEvent: SessionEndedEvent = {
              type: 'session_ended',
              session_id: externalId,
              exit_code: 0,
              end_reason: 'completed',
            };
            this.sendToPhone(endEvent);
            this.sessionManager.markObservedSessionHistory(oldInternalId);
            this.sessionIdMap.delete(oldInternalId);
            this.sessionManager.removeSession(oldInternalId);
            if (oldClaudeId) this.replacedSessionIds.add(oldClaudeId);
            logger.info('daemon', 'SessionStart(clear): replaced old session via session-map PID', { oldClaudeId, newClaudeId: claudeSessionId, pid: mapEntry.pid });
          }
        }
      }

      if (!clearInfo) {
        logger.debug('daemon', `SessionStart(clear): no pending clear info for cwd=${cwd}, will be picked up by polling`);
        return;
      }

      // Derive the JSONL path from transcript_path, or use the session ID
      const jsonlPath = transcriptPath || path.join(path.dirname(cwd), `${claudeSessionId}.jsonl`);

      // Start observing the new session
      const newInternalId = this.sessionManager.observeSession(
        claudeSessionId,
        jsonlPath,
        clearInfo.cwd,
        clearInfo.pid,
        undefined,
        clearInfo.target,
        clearInfo.entrypoint,
      );
      this.sessionIdMap.set(newInternalId, claudeSessionId);

      if (this.initialDiscoveryDone) {
        this.sendSessionHistory(claudeSessionId);
      }

      logger.debug('daemon', `SessionStart(clear): now observing ${claudeSessionId} (PID ${clearInfo.pid})`);
    });

    // When a PermissionRequest hook connection closes (terminal won the race),
    // tell the phone to dismiss the permission request.
    this.hookServer.on('permission_dismissed', (toolUseId: string, toolName: string, claudeSessionId: string, toolResponse?: unknown) => {
      logger.trace('daemon', 'permission_dismissed event', { toolName, toolUseId });
      this.untrackBlockingRequest(toolUseId);

      const session = this.sessionManager.findByClaudeSessionId(claudeSessionId);
      const externalId = session
        ? this.resolveExternalSessionId(session.sessionId)
        : claudeSessionId;

      const event: Record<string, unknown> = {
        type: 'permission_dismissed',
        request_id: toolUseId,
        tool_name: toolName,
        session_id: externalId,
      };
      // For AskUserQuestion, include the answers so the phone can show what was chosen
      if (toolName === 'AskUserQuestion' && toolResponse) {
        const resp = toolResponse as Record<string, unknown>;
        event.answers = resp.answers ?? resp;
      }
      this.sendToPhone(event as unknown as PcEvent);
      logger.debug('daemon', `Sent permission_dismissed for ${toolName} (${toolUseId})`);
    });
  }

  // --------------------------------------------------------------------------
  // Event Wiring: HookServer PermissionRequest -> Phone
  // --------------------------------------------------------------------------

  private wirePermissionPromptEvents(): void {
    // PermissionRequest hook: fires only when Claude's own permission system decides
    // it needs user approval. We forward these to the phone.
    this.hookServer.on('permission_prompt', (request: HookPermissionPrompt) => {
      const session = this.sessionManager.findByClaudeSessionId(request.sessionId);
      const externalId = session
        ? this.resolveExternalSessionId(session.sessionId)
        : request.sessionId;

      // ExitPlanMode: send plan to phone for review (same pattern as AskUserQuestion).
      // sendPlanForReview tracks the blocking request itself (with plan_content)
      // so the reconnect replay carries the plan body.
      if (request.toolName === 'ExitPlanMode') {
        this.sendPlanForReview(externalId, request.toolUseId, request.toolInput, request.cwd);
        logger.debug('daemon', `ExitPlanMode PermissionRequest: sent plan to phone for review (${request.toolUseId})`);
        return; // hook stays pending until phone responds
      }

      // AskUserQuestion: forward as interactive question to the phone.
      // The terminal also shows the question (PreToolUse passed through).
      // Whichever answers first wins the race.
      if (request.toolName === 'AskUserQuestion') {
        const hookQuestions = (request.toolInput.questions as Array<{ question?: string }>) ?? [];
        const hookQuestionPreview = hookQuestions[0]?.question ?? 'Claude has a question';
        const flat: Record<string, unknown> = {
          type: 'session_output',
          session_id: externalId,
          output_type: 'user_question',
          request_id: request.toolUseId,
          tool_input: request.toolInput,
          timestamp: new Date().toISOString(),
          ttl: HOOK_HOLD_TIMEOUT_SECONDS,
        };
        this.sendToPhone(flat as unknown as PcEvent, true, {
          type: 'user_question',
          session_name: this.getSessionName(externalId),
          body: truncateUtf8(hookQuestionPreview, 256),
          sound: 'default',
          category: 'USER_QUESTION',
          session_id: externalId,
          request_id: request.toolUseId,
        });
        this.trackBlockingRequest(request.toolUseId, externalId, flat as unknown as PcEvent, 'user_question');
        logger.debug('daemon', `AskUserQuestion PermissionRequest: forwarded to phone (${request.toolUseId})`);
        return; // hook stays pending until phone or terminal answers
      }

      // All other tools: Claude decided this needs user approval. Forward to phone.
      const riskLevel = (RISK_CLASSIFICATION[request.toolName] ?? RiskLevel.MEDIUM).toLowerCase();
      const context = this.buildPermissionContext(request.toolName, request.toolInput);

      const signaturePayload = JSON.stringify({
        session_id: externalId,
        request_id: request.toolUseId,
        tool_name: request.toolName,
        seq: this.messageSeq,
        timestamp: Date.now(),
      });

      let pcSignature: string;
      try {
        pcSignature = this.cryptoEngine.sign(signaturePayload);
      } catch {
        pcSignature = '';
      }

      const event: PermissionRequestEvent = {
        type: 'permission_request',
        session_id: externalId,
        request_id: request.toolUseId,
        tool_name: request.toolName,
        tool_input: request.toolInput,
        risk_level: riskLevel as unknown as RiskLevel,
        context,
        pc_signature: pcSignature,
        seq: this.messageSeq++,
        timestamp: new Date().toISOString() as unknown as number,
        ttl: HOOK_HOLD_TIMEOUT_SECONDS,
        has_always_allow: Array.isArray(request.permissionSuggestions) && request.permissionSuggestions.length > 0,
      };

      this.sendToPhone(event, true, {
        type: 'permission_request',
        session_name: this.getSessionName(externalId),
        body: truncateUtf8(`${request.toolName}: ${context}`, 256),
        sound: 'default',
        category: 'PERMISSION_REQUEST',
        session_id: externalId,
        request_id: request.toolUseId,
      });
      this.trackBlockingRequest(request.toolUseId, externalId, event, 'permission_request');
      logger.debug('daemon', 'Forwarded PermissionRequest', { tool: request.toolName, toolUseId: request.toolUseId, sessionId: request.sessionId });
    });
  }

  // --------------------------------------------------------------------------
  // Session Discovery & Observation
  // --------------------------------------------------------------------------

  /**
   * Discover running CLI Claude sessions and start observing them.
   */
  private async discoverAndObserveSessions(): Promise<void> {
    try {
      const runningCli = this.sessionDiscovery.getRunningAllSessions();
      if (runningCli.length === 0) return;

      // Discover JSONL files once (not per-session)
      const discovered = await this.sessionDiscovery.discoverSessions();

      // Detect /clear: when the user runs /clear, Claude Code creates a new session ID
      // and JSONL file but does NOT update the PID file. The daemon is stuck tailing
      // the old (frozen) JSONL. Detect this by checking if a newer JSONL file exists
      // in the same project directory for an observed session whose PID is still alive.
      //
      // IMPORTANT: The newer file must not belong to a different terminal process.
      // Multiple terminals can work in the same project directory, so finding a newer
      // JSONL doesn't necessarily mean /clear — it could be a different terminal.
      const observedSessions = this.sessionManager.getAllSessions().filter(s => s.isObserved && s.terminalPid);

      // Build a set of session IDs that are claimed by running CLI PIDs.
      // If a newer file is claimed by a different PID, it's a different terminal, not /clear.
      const sessionIdsByPid = new Map<string, number>();
      for (const cli of runningCli) {
        sessionIdsByPid.set(cli.sessionId, cli.pid);
      }

      for (const session of observedSessions) {
        if (!session.observer || !session.terminalPid) continue;

        // Check if PID is alive
        try { process.kill(session.terminalPid, 0); } catch { continue; }

        // Only consider /clear if the current session's JSONL has gone stale.
        // After /clear, Claude stops writing to the old file. If the file was
        // modified recently, the session is still active — not cleared.
        const currentJsonlPath = session.observer.getJsonlPath();
        try {
          const currentStat = fs.statSync(currentJsonlPath);
          if (Date.now() - currentStat.mtimeMs < 10_000) continue; // active within 10s
        } catch { continue; }

        const projectDir = path.dirname(currentJsonlPath);

        // Look for a newer JSONL file in the same directory that we're not observing
        const observedSessionIds = new Set(
          this.sessionManager.getAllSessions()
            .filter(s => s.claudeSessionId)
            .map(s => s.claudeSessionId!),
        );

        const newerFile = discovered.find(d =>
          path.dirname(d.filePath) === projectDir &&
          !observedSessionIds.has(d.sessionId) &&
          d.lastModified > (session.lastActivity || 0) &&
          d.filePath !== currentJsonlPath &&
          // Only treat as /clear if the newer file is NOT owned by a different PID
          (!sessionIdsByPid.has(d.sessionId) || sessionIdsByPid.get(d.sessionId) === session.terminalPid) &&
          // Don't replace if this session is in replacedSessionIds (already identified as stale)
          !this.replacedSessionIds.has(d.sessionId),
        );

        if (newerFile) {
          const pid = session.terminalPid!;
          const cwd = session.workingDirectory;
          const target = session.terminalTarget;

          logger.info('daemon', 'Detected /clear', { oldClaudeSessionId: session.claudeSessionId, newClaudeSessionId: newerFile.sessionId, pid });

          // End the old observation
          const oldInternalId = session.sessionId;
          const oldClaudeId = session.claudeSessionId;

          // Notify the phone that the old session ended (so it stops showing as "running")
          if (oldClaudeId) {
            const endEvent: SessionEndedEvent = {
              type: 'session_ended',
              session_id: oldClaudeId,
              exit_code: 0,
              end_reason: 'completed',
            };
            this.sendToPhone(endEvent);
          }

          this.sessionManager.markObservedSessionHistory(oldInternalId);
          this.sessionIdMap.delete(oldInternalId);
          this.sessionManager.removeSession(oldInternalId);
          if (oldClaudeId) this.replacedSessionIds.add(oldClaudeId);

          // Start observing the new session
          const newInternalId = this.sessionManager.observeSession(
            newerFile.sessionId,
            newerFile.filePath,
            cwd,
            pid,
            newerFile.customTitle,
            target,
            session.entrypoint,
          );
          this.sessionIdMap.set(newInternalId, newerFile.sessionId);
          if (this.initialDiscoveryDone) {
            this.sendSessionHistory(newerFile.sessionId);
          }

          const termInfo = target ? ` [${target.type}: ${target.target}]` : '';
          logger.debug('daemon', `Now observing ${newerFile.sessionId} (PID ${pid})${termInfo}`);
        }
      }

      for (const pidInfo of runningCli) {
        // Prefer session-map.json over PID JSON when it has a fresher entry
        // for this PID. This fixes two cases that survive daemon restart:
        //   1) PID JSON's sessionId is stale after /clear.
        //   2) PID JSON's cwd is wrong (e.g. parent of the worktree the
        //      process actually runs in), causing dir-based JSONL matching
        //      to pick a JSONL from a sibling project.
        const mapEntry = this.getLatestSessionMapEntryForPid(pidInfo.pid);
        if (mapEntry && mapEntry.sessionId !== pidInfo.sessionId) {
          this.replacedSessionIds.add(pidInfo.sessionId);
          pidInfo.sessionId = mapEntry.sessionId;
          pidInfo.cwd = mapEntry.cwd;
        }

        // Skip sessions already being observed or controlled
        if (this.sessionManager.findByClaudeSessionId(pidInfo.sessionId)) continue;

        // Check if this PID is already being observed for a different session.
        // This happens when the PID file was updated (e.g., after /clear) but
        // SessionManager still has the old session ID. We need to update it.
        // BUT: if the PID file's session ID is in replacedSessionIds, the PID file
        // is stale (not yet updated after /clear) — trust our current observation.
        const existingByPid = this.sessionManager.findByTerminalPid(pidInfo.pid);
        if (existingByPid && existingByPid.claudeSessionId !== pidInfo.sessionId
            && !this.replacedSessionIds.has(pidInfo.sessionId)) {
          logger.warn('daemon', 'PID session ID mismatch — re-observing', { pid: pidInfo.pid, observed: existingByPid.claudeSessionId, pidFile: pidInfo.sessionId });

          const match = discovered.find((s) => s.sessionId === pidInfo.sessionId);
          if (match) {
            // End the old observation
            const oldInternalId = existingByPid.sessionId;
            const oldClaudeId = existingByPid.claudeSessionId;

            // DON'T send session_ended for the stale session ID — this is just
            // correcting our internal tracking, not a real session end event.
            // The session is still running, we just had the wrong ID for it.

            this.sessionManager.markObservedSessionHistory(oldInternalId);
            this.sessionIdMap.delete(oldInternalId);
            this.sessionManager.removeSession(oldInternalId);
            if (oldClaudeId) this.replacedSessionIds.add(oldClaudeId);

            // Create new observation with correct session ID
            const newInternalId = this.sessionManager.observeSession(
              pidInfo.sessionId,
              match.filePath,
              pidInfo.cwd,
              pidInfo.pid,
              match.customTitle,
              pidInfo.terminalTarget,
              pidInfo.entrypoint,
            );
            this.sessionIdMap.set(newInternalId, pidInfo.sessionId);

            if (this.initialDiscoveryDone) {
              this.sendSessionHistory(pidInfo.sessionId);
            }

            const termInfo = pidInfo.terminalTarget ? ` [${pidInfo.terminalTarget.type}: ${pidInfo.terminalTarget.target}]` : ' [no terminal injection]';
            logger.debug('daemon', `Re-observing PID ${pidInfo.pid} with updated session ${pidInfo.sessionId}${termInfo}`);
          }
          continue;
        }

        // Skip if PID is already observed with the correct session ID
        if (existingByPid) continue;

        // If PID file still references a replaced session (stale after /clear),
        // check session-map.json for the correct new session ID
        if (this.replacedSessionIds.has(pidInfo.sessionId)) {
          const mapped = this.readSessionMap();
          // Find the most recent session-map entry for this PID
          let corrected: [string, { pid?: number; cwd: string; timestamp: number }] | undefined;
          const staleSids: string[] = [];
          for (const [sid, v] of Object.entries(mapped)) {
            if (v.pid !== pidInfo.pid) continue;
            if (this.sessionManager.findByClaudeSessionId(sid)) { staleSids.push(sid); continue; }
            if (this.replacedSessionIds.has(sid)) { staleSids.push(sid); continue; }
            if (!corrected || v.timestamp > corrected[1].timestamp) {
              if (corrected) staleSids.push(corrected[0]);
              corrected = [sid, v];
            } else {
              staleSids.push(sid);
            }
          }
          // Clean up stale entries for this PID
          if (staleSids.length > 0) {
            this.removeSessionMapEntries(staleSids);
          }
          if (!corrected) continue;
          const newSessionId = corrected[0];
          const mapEntry = corrected[1];
          const match = discovered.find((s) => s.sessionId === newSessionId);
          if (!match) continue;

          logger.info('daemon', 'Recovered session from session-map.json', { pid: pidInfo.pid, staleSessionId: pidInfo.sessionId, newSessionId });
          const newInternalId = this.sessionManager.observeSession(
            newSessionId,
            match.filePath,
            mapEntry.cwd,
            pidInfo.pid,
            match.customTitle,
            pidInfo.terminalTarget,
            pidInfo.entrypoint,
          );
          this.sessionIdMap.set(newInternalId, newSessionId);
          if (this.initialDiscoveryDone) {
            this.sendSessionHistory(newSessionId);
          }
          continue;
        }

        const match = discovered.find((s) => s.sessionId === pidInfo.sessionId);
        if (!match) continue;

        // PID JSON's sessionId may be stale (the user /clear-ed past it without
        // the PID file being updated). Prefer the newest unclaimed JSONL in the
        // project dir over PID JSON when it's actually newer — but never reject
        // a session purely on age. PIDs that are alive deserve to be tracked.
        let observeMatch = match;
        let observeSessionId = pidInfo.sessionId;
        const projectDir = path.dirname(match.filePath);
        const otherPidSids = new Set(
          runningCli.filter(c => c.pid !== pidInfo.pid).map(c => c.sessionId),
        );
        const newer = discovered
          .filter(d => path.dirname(d.filePath) === projectDir)
          .filter(d => !otherPidSids.has(d.sessionId))
          .filter(d => !this.replacedSessionIds.has(d.sessionId))
          .filter(d => d.lastModified > match.lastModified)
          .sort((a, b) => b.lastModified - a.lastModified)[0];
        if (newer) {
          observeMatch = newer;
          observeSessionId = newer.sessionId;
          this.replacedSessionIds.add(pidInfo.sessionId);
        }

        const sessionId = this.sessionManager.observeSession(
          observeSessionId,
          observeMatch.filePath,
          pidInfo.cwd,
          pidInfo.pid,
          observeMatch.customTitle,
          pidInfo.terminalTarget,
          pidInfo.entrypoint,
        );

        // Map internal -> external so events use the Claude session ID
        this.sessionIdMap.set(sessionId, observeSessionId);

        // Send existing conversation history so the phone sees prior messages
        if (this.initialDiscoveryDone) {
          this.sendSessionHistory(observeSessionId);
        }

        const termInfo = pidInfo.terminalTarget ? ` [${pidInfo.terminalTarget.type}: ${pidInfo.terminalTarget.target}]` : ' [no terminal injection]';
        logger.info('daemon', 'Observing CLI session', { claudeSessionId: observeSessionId, pid: pidInfo.pid });
      }
    } catch (err) {
      logger.error('daemon', `Error discovering sessions: ${(err as Error).message}`);
    }
  }

  private discoverAndObserveCodexSessions(): void {
    try {
      const sessions = this.codexDiscovery.discoverSessions();
      const liveSessions = this.codexDiscovery.discoverLiveSessions(sessions);
      for (const session of sessions) {
        const existing = this.codexObservers.get(session.sessionId);
        if (existing) {
          const live = liveSessions.has(session.sessionId);
          const nextStatus = live
            ? (existing.status === SessionStatus.RUNNING || existing.status === SessionStatus.PENDING_ACTIONS ? existing.status : SessionStatus.READY)
            : SessionStatus.HISTORY;
          if (existing.status !== nextStatus) {
            existing.status = nextStatus;
            existing.lastActivity = Date.now();
            if (this.initialDiscoveryDone) {
              this.sendToPhone({
                type: 'session_status',
                session_id: session.sessionId,
                status: nextStatus,
              } as unknown as PcEvent);
            }
          }
          continue;
        }
        const observer = new CodexObserver(session.sessionId, session.rolloutPath);
        const initialStatus = liveSessions.has(session.sessionId) ? SessionStatus.READY : SessionStatus.HISTORY;
        const tracked = {
          observer,
          session,
          status: initialStatus,
          lastActivity: session.updatedAtMs ?? Date.now(),
        };
        this.codexObservers.set(session.sessionId, tracked);

        observer.on('output', (codexEvent: ClaudeEvent) => {
          tracked.lastActivity = Date.now();
          this.sendFlattenedSessionOutput(session.sessionId, codexEvent, 'codex');
        });
        observer.on('status_change', (status: 'running' | 'ready') => {
          tracked.status = status as SessionStatus;
          tracked.lastActivity = Date.now();
          if (!this.initialDiscoveryDone) return;
          this.sendToPhone({
            type: 'session_status',
            session_id: session.sessionId,
            status: tracked.status,
          } as unknown as PcEvent);
        });
        observer.on('error', (err: Error) => {
          logger.warn('codex-observer', `Observer error: ${err.message}`, { sessionId: session.sessionId });
        });
        observer.start();
      }
    } catch (err) {
      logger.warn('codex-discovery', `Error discovering Codex sessions: ${(err as Error).message}`);
    }
  }

  // --------------------------------------------------------------------------
  // Hook Server Crash Monitoring
  // --------------------------------------------------------------------------

  private restartHookServer(): void {
    if (this.hookRestartTimer) return; // already scheduled

    const MAX_ATTEMPTS = 5;
    if (this.hookRestartAttempts >= MAX_ATTEMPTS) {
      logger.error('daemon', `Hook server failed ${MAX_ATTEMPTS} times, giving up`);
      this.sendError(undefined, 'Hook server crashed and could not be restarted', 'HOOK_SERVER_FATAL');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.hookRestartAttempts), 30000);
    this.hookRestartAttempts++;
    logger.debug('daemon', `Restarting hook server in ${delay}ms (attempt ${this.hookRestartAttempts}/${MAX_ATTEMPTS})`);

    this.hookRestartTimer = setTimeout(async () => {
      this.hookRestartTimer = null;
      try {
        try { await this.hookServer.stop(); } catch { /* already dead */ }
        this.hookServer.removeAllListeners();

        this.hookServer = new HookServer();
        const newPort = await this.hookServer.start();
        this.wireHookServerEvents();
        this.wirePermissionPromptEvents();

        this.installClaudeHooks(newPort);

        logger.debug('daemon', `Hook server restarted on port ${newPort}`);
        this.hookRestartAttempts = 0;
      } catch (err) {
        logger.error('daemon', `Hook server restart failed: ${(err as Error).message}`);
        this.restartHookServer();
      }
    }, delay);
  }

  private installClaudeHooks(hookPort: number): void {
    const settingsFile = path.join(os.homedir(), '.claude', 'settings.local.json');

    let settings: Record<string, unknown> = {};
    try {
      if (fs.existsSync(settingsFile)) {
        settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      }
    } catch {
      // Start fresh
    }

    const hooks: Record<string, unknown> = (settings.hooks as Record<string, unknown>) ?? {};

    hooks.PreToolUse = [
      { hooks: [{ type: 'http', url: `http://127.0.0.1:${hookPort}/hooks/permission-request`, timeout: 120 }] },
    ];
    hooks.PermissionRequest = [
      { hooks: [{ type: 'http', url: `http://127.0.0.1:${hookPort}/hooks/permission-prompt`, timeout: 120 }] },
    ];
    hooks.PostToolUse = [
      { hooks: [{ type: 'http', url: `http://127.0.0.1:${hookPort}/hooks/post-tool-use`, timeout: 10 }] },
    ];

    settings.hooks = hooks;

    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
    logger.debug('daemon', `Installed Claude hooks pointing to port ${hookPort}`);
  }

  /**
   * Check if observed session PIDs are still alive.
   * When a terminal exits, transition the session to history.
   */
  private checkObservedSessionPids(): void {
    const deadPids: number[] = [];

    for (const session of this.sessionManager.getAllSessions()) {
      if (!session.isObserved || !session.terminalPid) continue;

      try {
        // process.kill(pid, 0) throws if PID doesn't exist
        process.kill(session.terminalPid, 0);
        // Also check if process is suspended or zombie
        if (isProcessSuspendedOrZombie(session.terminalPid)) {
          logger.warn('daemon', 'Terminal PID suspended/zombie', { pid: session.terminalPid, sessionId: session.sessionId });
          this.sessionManager.markObservedSessionHistory(session.sessionId);
          deadPids.push(session.terminalPid);
        }
      } catch {
        // PID is dead — terminal exited
        logger.info('daemon', 'Terminal PID exited', { pid: session.terminalPid, sessionId: session.sessionId });
        this.sessionManager.markObservedSessionHistory(session.sessionId);
        deadPids.push(session.terminalPid);
      }
    }

    if (deadPids.length > 0) {
      this.cleanSessionMap(deadPids);
    }
  }

  // --------------------------------------------------------------------------
  // Command Dispatcher
  // --------------------------------------------------------------------------

  /**
   * Handle incoming PhoneCommand messages from the relay.
   * Dispatches to the appropriate handler based on command type.
   */
  async handleCommand(command: PhoneCommand): Promise<void> {
    switch (command.type) {
      case 'new_session':
        this.handleNewSession(command);
        break;

      case 'resume_session':
        this.handleResumeSession(command);
        break;

      case 'send_message':
        this.handleSendMessage(command);
        break;

      case 'permission_response':
        this.handlePermissionResponse(command);
        break;

      case 'question_response':
        this.handleQuestionResponse(command);
        break;

      case 'kill_session':
        await this.handleKillSession(command);
        break;

      case 'interrupt_session':
        this.handleInterruptSession(command as InterruptSessionCommand);
        break;

      case 'get_history':
        this.handleGetHistory(command);
        break;

      case 'list_sessions':
        fs.appendFileSync('/tmp/daemon-debug.log', `${formatTimestamp()} dispatch list_sessions\n`);
        await this.handleListSessions(command);
        break;

      case 'read_file':
        await this.handleReadFile(command);
        break;

      case 'emergency_abort':
        this.handleEmergencyAbort(command);
        break;

      case 'set_preferences':
        this.handleSetPreferences(command);
        break;

      case 'session_output_ack':
        this.handleSessionOutputAck(command);
        break;

      case 'verify_history':
        this.handleVerifyHistory(command);
        break;

      default:
        this.sendError(
          (command as { request_id?: string }).request_id,
          `Unknown command type: ${(command as { type: string }).type}`,
          'UNKNOWN_COMMAND',
        );
    }
  }

  // --------------------------------------------------------------------------
  // Command Handlers
  // --------------------------------------------------------------------------

  private handleNewSession(command: NewSessionCommand): void {
    try {
      const sessionConfig: SessionConfig = {
        working_directory: command.config.working_directory,
        model: command.config.model,
        system_prompt: command.config.system_prompt,
        allowed_tools: command.config.allowed_tools,
        initial_message: command.config.initial_message,
      };

      const sessionId = this.sessionManager.createSession(sessionConfig);

      // Track request_id -> session_id mapping
      this.pendingSessionRequests.set(command.request_id, sessionId);

    } catch (err) {
      this.sendError(
        command.request_id,
        `Failed to create session: ${(err as Error).message}`,
        'SESSION_CREATE_ERROR',
      );
    }
  }

  private handleResumeSession(command: ResumeSessionCommand): void {
    try {
      // If an observer already exists for this Claude session ID, stop and remove it
      // to prevent duplicate message emission when switching from observe to SDK control.
      const existing = this.sessionManager.findByClaudeSessionId(command.session_id);
      if (existing) {
        logger.debug('daemon', `Stopping existing observer ${existing.sessionId} before resuming session ${command.session_id}`);
        this.sessionManager.markObservedSessionHistory(existing.sessionId);
        this.cleanSessionMap([existing.terminalPid ?? -1]);
      }

      const sessionId = this.sessionManager.resumeSession(command.session_id, {});

      // Map internal session ID to Claude session ID
      this.sessionIdMap.set(sessionId, command.session_id);
      this.pendingSessionRequests.set(command.request_id, sessionId);

    } catch (err) {
      this.sendError(
        command.request_id,
        `Failed to resume session: ${(err as Error).message}`,
        'SESSION_RESUME_ERROR',
      );
    }
  }

  private async handleSendMessage(command: SendMessageCommand): Promise<void> {
    const clientMessageId = command.client_message_id;
    const cidShort = clientMessageId ? clientMessageId.substring(0, 8) : 'none';
    const sidShort = command.session_id.substring(0, 8);
    logger.debug('daemon', 'send_message received', {
      cid: cidShort,
      sessionId: sidShort,
      len: command.message.length,
    });

    if (clientMessageId) {
      this.sendMessageAck(clientMessageId, command.session_id, 'received');
    }

    if (isCodexSessionId(command.session_id)) {
      const liveCodex = this.codexDiscovery.discoverLiveSessions().get(command.session_id);
      const target = liveCodex ? findTerminalForPid(liveCodex.pid) : null;
      if (!target) {
        const msg = liveCodex
          ? `Codex terminal target not found for PID ${liveCodex.pid}.`
          : 'Codex session has no live terminal process.';
        if (clientMessageId) this.sendMessageAck(clientMessageId, command.session_id, 'failed', msg);
        this.sendError(undefined, msg, 'CODEX_TERMINAL_NOT_ATTACHED');
        return;
      }
      try {
        terminalSendMessage(target, command.message);
        if (clientMessageId) this.sendMessageAck(clientMessageId, command.session_id, 'committed');
        logger.debug('daemon', 'send_message committed (codex terminal)', { cid: cidShort, sessionId: sidShort, pid: liveCodex!.pid });
      } catch (err) {
        const msg = (err as Error).message;
        if (clientMessageId) this.sendMessageAck(clientMessageId, command.session_id, 'failed', msg);
        this.sendError(undefined, `Failed to send message to Codex session ${command.session_id}: ${msg}`, 'SEND_MESSAGE_ERROR');
      }
      return;
    }

    try {
      // Resolve the external session ID to our internal ID
      const internalId = this.resolveInternalSessionId(command.session_id);
      if (internalId) {
        await this.sessionManager.sendMessage(internalId, command.message);
        if (clientMessageId) {
          this.sendMessageAck(clientMessageId, command.session_id, 'committed');
        }
        logger.debug('daemon', 'send_message committed (tracked)', { cid: cidShort, sessionId: sidShort });
        return;
      }

      // Session not tracked — it's a discovered session from disk.
      // Try to observe it and inject the message via tmux.
      logger.debug('daemon', `Session ${command.session_id} not tracked, attempting to observe and inject`);

      // Check if there's a running terminal for this session
      const runningCli = this.sessionDiscovery.getRunningCliSessions();
      const pidInfo = runningCli.find((s) => s.sessionId === command.session_id);

      if (!pidInfo) {
        const msg = `Session ${command.session_id} has no running terminal. Please restart Claude in the terminal.`;
        if (clientMessageId) this.sendMessageAck(clientMessageId, command.session_id, 'failed', msg);
        this.sendError(undefined, msg, 'SESSION_NOT_RUNNING');
        return;
      }

      // Discover the JSONL file for this session
      const discovered = await this.sessionDiscovery.discoverSessions();
      const match = discovered.find((s) => s.sessionId === command.session_id);
      if (!match) {
        const msg = `Cannot find session file for ${command.session_id}`;
        if (clientMessageId) this.sendMessageAck(clientMessageId, command.session_id, 'failed', msg);
        this.sendError(undefined, msg, 'SESSION_FILE_NOT_FOUND');
        return;
      }

      // Start observing
      const sessionId = this.sessionManager.observeSession(
        pidInfo.sessionId,
        match.filePath,
        pidInfo.cwd,
        pidInfo.pid,
        match.customTitle,
        pidInfo.terminalTarget,
        pidInfo.entrypoint,
      );
      this.sessionIdMap.set(sessionId, pidInfo.sessionId);

      // Send session history
      this.sendSessionHistory(command.session_id);

      // Now send the message (will inject via tmux if available)
      await this.sessionManager.sendMessage(sessionId, command.message);
      if (clientMessageId) {
        this.sendMessageAck(clientMessageId, command.session_id, 'committed');
      }
      logger.debug('daemon', 'send_message committed (observed)', { cid: cidShort, sessionId: sidShort });
    } catch (err) {
      const msg = (err as Error).message;
      if (clientMessageId) this.sendMessageAck(clientMessageId, command.session_id, 'failed', msg);
      logger.error('daemon', 'send_message failed', { cid: cidShort, sessionId: sidShort, error: msg });
      this.sendError(
        undefined,
        `Failed to send message to session ${command.session_id}: ${msg}`,
        'SEND_MESSAGE_ERROR',
      );
    }
  }

  private sendMessageAck(
    clientMessageId: string,
    sessionId: string,
    status: 'received' | 'committed' | 'failed',
    error?: string,
  ): void {
    const ack: MessageAckEvent = {
      type: 'message_ack',
      client_message_id: clientMessageId,
      session_id: sessionId,
      status,
      ts: Date.now(),
      ...(error ? { error } : {}),
    };
    logger.debug('daemon', 'message_ack send', {
      cid: clientMessageId.substring(0, 8),
      sessionId: sessionId.substring(0, 8),
      status,
    });
    this.sendToPhone(ack);
  }

  private handlePermissionResponse(command: PermissionResponseCommand): void {
    logger.debug('daemon', `handlePermissionResponse: request_id=${command.request_id}, decision=${command.decision}, hasPending=${this.hookServer.hasPendingPermission(command.request_id)}`);
    this.untrackBlockingRequest(command.request_id);
    try {
      // Verify the phone signature if we have peer identity key
      if (command.phone_signature && this.cryptoEngine.hasSessionKeys()) {
        const signaturePayload = JSON.stringify({
          session_id: command.session_id,
          request_id: command.request_id,
          decision: command.decision,
          seq: command.seq,
          timestamp: command.timestamp,
        });

        const valid = this.cryptoEngine.verifyPeer(signaturePayload, command.phone_signature);
        if (!valid) {
          this.sendError(
            command.request_id,
            'Invalid permission response signature',
            'SIGNATURE_INVALID',
          );
          return;
        }
      }

      // Check if this is a hook-based permission (from observed terminal session)
      if (this.hookServer.hasPendingPermission(command.request_id)) {
        const isManual = command.decision === PermissionDecision.APPROVE_MANUAL;
        const allowed = command.decision === PermissionDecision.APPROVE
          || command.decision === PermissionDecision.ALWAYS_ALLOW
          || isManual;

        const pendingToolInput = this.hookServer.getPendingToolInput(command.request_id);
        const pendingToolName = this.hookServer.getPendingToolName(command.request_id);

        logger.debug('daemon', `Hook permission response for ${command.request_id}: tool=${pendingToolName}, decision=${command.decision}, isManual=${isManual}, allowed=${allowed}`);

        if (pendingToolName === 'ExitPlanMode') {
          // ExitPlanMode is now handled at PermissionRequest stage,
          // so we use resolvePermissionPrompt which supports updatedPermissions.
          if (allowed) {
            const updatedPermissions = isManual ? undefined : [
              { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
            ];
            const planInput = pendingToolInput ?? {};
            const exitInput = isManual
              ? { ...planInput, allowedPrompts: [] }
              : planInput;

            this.hookServer.resolvePermissionPrompt(
              command.request_id,
              'allow',
              exitInput,
              updatedPermissions,
            );
            logger.debug('daemon', `Resolved ExitPlanMode via PermissionRequest hook: ${isManual ? 'manual' : 'acceptEdits'}`);
          } else {
            this.hookServer.resolvePermissionPrompt(command.request_id, 'deny');
            logger.debug('daemon', `Denied ExitPlanMode via PermissionRequest hook`);
          }
          return;
        }

        // All other tools: resolve via PermissionRequest hook format
        if (allowed && command.decision === PermissionDecision.ALWAYS_ALLOW) {
          // "Always Allow" — pass the permission suggestions so Claude Code adds the rule
          const suggestions = this.hookServer.getPendingPermissionSuggestions(command.request_id);
          const updatedPermissions = Array.isArray(suggestions) ? suggestions as Array<Record<string, unknown>> : undefined;
          this.hookServer.resolvePermissionPrompt(
            command.request_id,
            'allow',
            undefined,
            updatedPermissions,
          );
          logger.debug('daemon', `Resolved PermissionRequest hook ${command.request_id} (${pendingToolName}): always_allow, updatedPermissions=${!!updatedPermissions}`);
        } else {
          this.hookServer.resolvePermissionPrompt(
            command.request_id,
            allowed ? 'allow' : 'deny',
          );
          logger.debug('daemon', `Resolved PermissionRequest hook ${command.request_id} (${pendingToolName}): ${allowed ? 'allow' : 'deny'}`);
        }
        return;
      }

      // Otherwise, it's an SDK-based permission
      const internalId = this.resolveInternalSessionId(command.session_id) ?? command.session_id;

      // For approve_manual: approve but override allowedPrompts to empty
      if (command.decision === PermissionDecision.APPROVE_MANUAL) {
        this.sessionManager.respondPermission(
          internalId,
          command.request_id,
          PermissionDecision.APPROVE,
          { allowedPrompts: [] },
        );
      } else {
        this.sessionManager.respondPermission(
          internalId,
          command.request_id,
          command.decision,
        );
      }
    } catch (err) {
      this.sendError(
        command.request_id,
        `Failed to respond to permission: ${(err as Error).message}`,
        'PERMISSION_RESPONSE_ERROR',
      );
    }
  }

  private handleQuestionResponse(command: QuestionResponseCommand): void {
    this.untrackBlockingRequest(command.request_id);
    try {
      // AskUserQuestion answers come back through the PermissionRequest hook system
      if (this.hookServer.hasPendingPermission(command.request_id)) {
        const originalInput = this.hookServer.getPendingToolInput(command.request_id) ?? {};
        // Use PermissionRequest format: allow with updatedInput containing answers
        this.hookServer.resolvePermissionPrompt(
          command.request_id,
          'allow',
          { ...originalInput, answers: command.answers },
        );
        logger.debug('daemon', `Resolved AskUserQuestion ${command.request_id} via PermissionRequest hook with answers: ${JSON.stringify(command.answers)}`);
        return;
      }

      // For SDK-based sessions, approve with updatedInput containing answers
      const internalId = this.resolveInternalSessionId(command.session_id) ?? command.session_id;
      const session = this.sessionManager.getSession(internalId);
      const pending = session?.pendingPermissions.get(command.request_id);
      const originalInput = pending?.toolInput ?? {};
      this.sessionManager.respondPermission(
        internalId,
        command.request_id,
        PermissionDecision.APPROVE,
        { ...originalInput, answers: command.answers },
      );
      logger.debug('daemon', `Resolved SDK AskUserQuestion ${command.request_id}`);
    } catch (err) {
      this.sendError(
        command.request_id,
        `Failed to respond to question: ${(err as Error).message}`,
        'QUESTION_RESPONSE_ERROR',
      );
    }
  }

  private async handleKillSession(command: KillSessionCommand): Promise<void> {
    if (isCodexSessionId(command.session_id)) {
      const observed = this.codexObservers.get(command.session_id);
      if (observed) {
        observed.observer.stop();
        observed.status = SessionStatus.HISTORY;
        this.sendToPhone({
          type: 'session_status',
          session_id: command.session_id,
          status: SessionStatus.HISTORY,
        } as unknown as PcEvent);
      }
      return;
    }
    try {
      const internalId = this.resolveInternalSessionId(command.session_id) ?? command.session_id;
      await this.sessionManager.killSession(internalId);
    } catch (err) {
      this.sendError(
        undefined,
        `Failed to kill session ${command.session_id}: ${(err as Error).message}`,
        'KILL_SESSION_ERROR',
      );
    }
  }

  private handleInterruptSession(command: InterruptSessionCommand): void {
    if (isCodexSessionId(command.session_id)) {
      const liveCodex = this.codexDiscovery.discoverLiveSessions().get(command.session_id);
      const target = liveCodex ? findTerminalForPid(liveCodex.pid) : null;
      if (!target) {
        this.sendError(undefined, 'Codex interrupt is not available because no live terminal target was found for this Codex session.', 'CODEX_TERMINAL_NOT_ATTACHED');
        return;
      }
      try {
        terminalSendInterrupt(target);
        logger.debug('daemon', `Interrupted Codex session ${command.session_id}`);
      } catch (err) {
        this.sendError(undefined, `Failed to interrupt Codex session ${command.session_id}: ${(err as Error).message}`, 'INTERRUPT_SESSION_ERROR');
      }
      return;
    }
    try {
      const internalId = this.resolveInternalSessionId(command.session_id) ?? command.session_id;
      this.sessionManager.interruptSession(internalId);
      logger.debug('daemon', `Interrupted session ${command.session_id}`);
    } catch (err) {
      this.sendError(
        undefined,
        `Failed to interrupt session ${command.session_id}: ${(err as Error).message}`,
        'INTERRUPT_SESSION_ERROR',
      );
    }
  }

  private async handleListSessions(command: ListSessionsCommand): Promise<void> {
    fs.appendFileSync('/tmp/daemon-debug.log', `${formatTimestamp()} handleListSessions CALLED\n`);
    try {
      const offset = command.offset ?? 0;
      const limit = command.limit ?? 20;

      const discoveredSessions = this.sessionDiscovery.getCachedSessions()
        ?? await this.sessionDiscovery.discoverSessions();

      const allSessions: Array<{ entry: Record<string, unknown>; historyKey: string }> = [];

      // ── Phase 1: Daemon-tracked sessions (SessionManager) ──
      // These have observers attached and carry rich status.
      const activeSessions = this.sessionManager.getAllSessions();
      fs.appendFileSync('/tmp/daemon-debug.log', `${formatTimestamp()} handleListSessions: Phase 1 has ${activeSessions.length} sessions: ${activeSessions.map(s => `${s.claudeSessionId?.slice(0,8)}(status=${s.status},pid=${s.terminalPid})`).join(', ')}\n`);
      const claimedPids = new Set<number>();
      const claimedSessionIds = new Set<string>();

      // Snapshot live PID metadata once so we can use the friendly `name`
      // (written by Claude Code 4.x into ~/.claude/sessions/<pid>.json) as a
      // title fallback in every phase.
      const runningAll = this.sessionDiscovery.getRunningAllSessions();
      const pidNameByPid = new Map<number, string>();
      for (const r of runningAll) {
        if (r.name) pidNameByPid.set(r.pid, r.name);
      }

      for (const active of activeSessions) {
        const externalId = this.resolveExternalSessionId(active.sessionId);
        const claudeId = active.claudeSessionId ?? externalId;

        // Check if this session has a pending permission in the hook server.
        // Real (non-synthetic) entries always win — they're live blocking requests.
        // Synthetic startup_pending_* entries are heuristic guesses from JSONL state
        // at startup; if the session has been silent for a long time, the user has
        // likely moved past it. Downgrade to ready instead of advertising a phantom
        // pending badge.
        let effectiveStatus = active.status as SessionStatus;
        let actionType: string | undefined;
        const realPending = Array.from(this.pendingBlockingRequests.entries()).find(
          ([reqId, entry]) =>
            entry.sessionId === externalId && !reqId.startsWith('startup_pending_'),
        );
        if (realPending) {
          effectiveStatus = SessionStatus.PENDING_ACTIONS;
          actionType = realPending[1].type;
        } else if (effectiveStatus === SessionStatus.PENDING_ACTIONS) {
          const idleMs = Date.now() - (active.lastActivity ?? 0);
          if (idleMs > 10 * 60 * 1000) {
            const syntheticId = `startup_pending_${externalId}`;
            if (this.pendingBlockingRequests.has(syntheticId)) {
              this.pendingBlockingRequests.delete(syntheticId);
            }
          }
          effectiveStatus = SessionStatus.READY;
        }

        allSessions.push({
          entry: {
            session_id: externalId,
            agent_type: 'claude_code',
            agent_display_name: 'Claude Code',
            agent_version: this.claudeAgentVersion,
            capabilities: ['observe', 'terminal_remote_message', 'terminal_interrupt', 'permissions', 'plan_review', 'user_question'],
            status: effectiveStatus,
            action_type: actionType,
            working_directory: active.workingDirectory,
            project_name: active.customTitle
              ?? (active.terminalPid ? pidNameByPid.get(active.terminalPid) : undefined)
              ?? path.basename(active.workingDirectory),
            last_activity: active.lastActivity,
            entrypoint: active.entrypoint,
            pid: active.terminalPid,
          },
          historyKey: claudeId,
        });
        if (active.terminalPid) claimedPids.add(active.terminalPid);
        claimedSessionIds.add(externalId);
        if (active.claudeSessionId) claimedSessionIds.add(active.claudeSessionId);
      }

      // ── Phase 2: Alive PIDs not claimed by Phase 1 ──
      // A live PID = an active session, even if the daemon hasn't attached an observer.
      fs.appendFileSync('/tmp/daemon-debug.log', `${formatTimestamp()} handleListSessions: Phase 2 has ${runningAll.length} running PIDs: ${runningAll.map(s => `pid=${s.pid},sid=${s.sessionId.slice(0,8)}`).join(', ')}\n`);
      for (const pidInfo of runningAll) {
        if (claimedPids.has(pidInfo.pid)) continue;

        // Override stale PID JSON metadata with the latest session-map entry,
        // matching the live discovery loop. Without this, restarted daemons
        // resolve the wrong sessionId for PIDs whose JSON wasn't updated
        // after /clear or whose cwd is wrong (e.g. worktree launches).
        const mapEntry = this.getLatestSessionMapEntryForPid(pidInfo.pid);
        if (mapEntry && mapEntry.sessionId !== pidInfo.sessionId) {
          pidInfo.sessionId = mapEntry.sessionId;
          pidInfo.cwd = mapEntry.cwd;
        }

        // Best-effort JSONL match: try PID file's sessionId first.
        // If JSONL is missing or stale, still emit the PID with its tracked
        // sessionId — long-idle sessions are still real sessions with valid
        // history. Mtime is not a reliable liveness signal.
        let historyKey = pidInfo.sessionId;
        let lastActivity: number | undefined;
        let customTitle: string | undefined;

        const exactMatch = discoveredSessions.find(d => d.sessionId === pidInfo.sessionId);
        if (exactMatch) {
          lastActivity = exactMatch.lastModified;
          customTitle = exactMatch.customTitle;
        }

        allSessions.push({
          entry: {
            session_id: pidInfo.sessionId,
            agent_type: 'claude_code',
            agent_display_name: 'Claude Code',
            agent_version: this.claudeAgentVersion,
            capabilities: ['observe', 'terminal_remote_message', 'terminal_interrupt', 'permissions', 'plan_review', 'user_question'],
            status: SessionStatus.READY,
            working_directory: pidInfo.cwd,
            project_name: customTitle ?? pidInfo.name ?? path.basename(pidInfo.cwd),
            last_activity: lastActivity,
            entrypoint: pidInfo.entrypoint,
            pid: pidInfo.pid,
          },
          historyKey,
        });
        claimedPids.add(pidInfo.pid);
        claimedSessionIds.add(pidInfo.sessionId);
        claimedSessionIds.add(historyKey);
      }

      // ── Phase 3: History sessions (discovered JSONL files not tied to a live PID) ──
      for (const discovered of discoveredSessions) {
        if (claimedSessionIds.has(discovered.sessionId)) continue;
        if (this.replacedSessionIds.has(discovered.sessionId)) continue;
        allSessions.push({
          entry: {
            session_id: discovered.sessionId,
            agent_type: 'claude_code',
            agent_display_name: 'Claude Code',
            agent_version: this.claudeAgentVersion,
            capabilities: ['observe'],
            status: SessionStatus.HISTORY,
            working_directory: discovered.projectDir,
            project_name: discovered.customTitle ?? path.basename(discovered.projectDir),
            last_activity: discovered.lastModified,
          },
          historyKey: discovered.sessionId,
        });
        claimedSessionIds.add(discovered.sessionId);
      }

      // ── Phase 4: Codex history/observe sessions ──
      const codexSessions = this.codexDiscovery.getCachedSessions() ?? this.codexDiscovery.discoverSessions();
      const liveCodexSessions = this.codexDiscovery.discoverLiveSessions(codexSessions);
      for (const codex of codexSessions) {
        if (claimedSessionIds.has(codex.sessionId)) continue;
        const observed = this.codexObservers.get(codex.sessionId);
        const liveCodex = liveCodexSessions.get(codex.sessionId);
        const codexStatus = liveCodex
          ? (observed?.status === SessionStatus.RUNNING || observed?.status === SessionStatus.PENDING_ACTIONS ? observed.status : SessionStatus.READY)
          : observed?.status ?? SessionStatus.HISTORY;
        if (observed && !liveCodex && observed.status === SessionStatus.RUNNING) {
          observed.status = SessionStatus.HISTORY;
        }
        const codexCapabilities = liveCodex ? ['observe', 'terminal_remote_message', 'terminal_interrupt'] : ['observe'];
        allSessions.push({
          entry: {
            session_id: codex.sessionId,
            agent_type: 'codex',
            agent_display_name: 'Codex',
            agent_version: codex.cliVersion,
            capabilities: codexCapabilities,
            status: codexStatus,
            working_directory: codex.cwd,
            project_name: codex.title ?? path.basename(codex.cwd),
            last_activity: observed?.lastActivity ?? codex.updatedAtMs,
            entrypoint: 'codex-cli',
            pid: liveCodex?.pid,
          },
          historyKey: codex.sessionId,
        });
        claimedSessionIds.add(codex.sessionId);
      }

      // Sort: active sessions first, then by last_activity descending
      allSessions.sort((a, b) => {
        const activeStatuses = new Set([SessionStatus.RUNNING, SessionStatus.PENDING_ACTIONS, SessionStatus.READY, SessionStatus.STARTING]);
        const aActive = activeStatuses.has(a.entry.status as SessionStatus) ? 1 : 0;
        const bActive = activeStatuses.has(b.entry.status as SessionStatus) ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return ((b.entry.last_activity as number) ?? 0) - ((a.entry.last_activity as number) ?? 0);
      });

      const totalCount = allSessions.length;
      const pageSlice = allSessions.slice(offset, offset + limit);

      // Only fetch history for sessions in the current page
      const sessions = pageSlice.map(({ entry, historyKey }) => {
        const historyPage = isCodexSessionId(historyKey)
          ? this.codexDiscovery.getSessionHistory(historyKey, { limit: 3 })
          : this.sessionDiscovery.getSessionHistory(historyKey, { limit: 3 });
        return {
          ...entry,
          recent_messages: historyPage.messages.map((m) => ({
            role: m.role,
            content: m.content.slice(0, 200),
            tool_name: m.toolName,
          })),
        };
      });

      // Debug: log final sessions with PIDs
      fs.appendFileSync('/tmp/daemon-debug.log', `${formatTimestamp()} handleListSessions: Returning ${sessions.length} sessions: ${sessions.map((s: any) => `${s.session_id.slice(0,8)}(pid=${s.pid ?? 'none'})`).join(', ')}\n`);

      const event = {
        type: 'session_list',
        request_id: command.request_id,
        sessions,
        total_count: totalCount,
        offset,
        has_more: offset + limit < totalCount,
      };

      this.sendToPhone(event as unknown as PcEvent);
    } catch (err) {
      this.sendError(
        command.request_id,
        `Failed to list sessions: ${(err as Error).message}`,
        'LIST_SESSIONS_ERROR',
      );
    }
  }

  private async handleReadFile(command: ReadFileCommand): Promise<void> {
    try {
      // Security: resolve to prevent path traversal
      const resolvedPath = path.resolve(command.path);

      // Check if file exists and is readable
      await fs.promises.access(resolvedPath, fs.constants.R_OK);

      const stat = await fs.promises.stat(resolvedPath);

      // Limit file size to 1MB
      const MAX_FILE_SIZE = 1024 * 1024;
      if (stat.size > MAX_FILE_SIZE) {
        this.sendError(
          command.request_id,
          `File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE})`,
          'FILE_TOO_LARGE',
        );
        return;
      }

      const content = await fs.promises.readFile(resolvedPath, 'utf-8');

      // Detect language from extension
      const ext = path.extname(resolvedPath).toLowerCase();
      const languageMap: Record<string, string> = {
        '.ts': 'typescript',
        '.tsx': 'typescript',
        '.js': 'javascript',
        '.jsx': 'javascript',
        '.py': 'python',
        '.rs': 'rust',
        '.go': 'go',
        '.java': 'java',
        '.c': 'c',
        '.cpp': 'cpp',
        '.h': 'c',
        '.hpp': 'cpp',
        '.rb': 'ruby',
        '.swift': 'swift',
        '.kt': 'kotlin',
        '.json': 'json',
        '.yaml': 'yaml',
        '.yml': 'yaml',
        '.toml': 'toml',
        '.md': 'markdown',
        '.html': 'html',
        '.css': 'css',
        '.sh': 'bash',
        '.sql': 'sql',
      };

      const event: FileContentEvent = {
        type: 'file_content',
        request_id: command.request_id,
        path: resolvedPath,
        content,
        language: languageMap[ext],
      };

      this.sendToPhone(event);
    } catch (err) {
      this.sendError(
        command.request_id,
        `Failed to read file ${command.path}: ${(err as Error).message}`,
        'READ_FILE_ERROR',
      );
    }
  }

  private handleEmergencyAbort(command: EmergencyAbortCommand): void {
    // Verify signature for emergency abort if peer key is available
    if (command.phone_signature && this.cryptoEngine.hasSessionKeys()) {
      const signaturePayload = JSON.stringify({
        type: 'emergency_abort',
      });

      const valid = this.cryptoEngine.verifyPeer(signaturePayload, command.phone_signature);
      if (!valid) {
        this.sendError(
          undefined,
          'Invalid emergency abort signature',
          'SIGNATURE_INVALID',
        );
        return;
      }
    }

    this.sessionManager.emergencyAbort();

    // Notify the phone that abort is complete
    const event: ErrorEvent = {
      type: 'error',
      message: 'Emergency abort completed -- all sessions terminated',
      code: 'EMERGENCY_ABORT_COMPLETE',
    };

    this.sendToPhone(event);
  }

  private handleGetHistory(command: GetHistoryCommand): void {
    this.sendSessionHistory(command.session_id, {
      since: command.since,
      sinceSeq: command.since_seq,
      offset: command.offset,
      limit: command.limit,
    });
  }

  private handleSessionOutputAck(command: SessionOutputAckCommand): void {
    const prev = this.lastAckedSeqs.get(command.session_id) ?? 0;
    if (command.last_seq > prev) {
      this.lastAckedSeqs.set(command.session_id, command.last_seq);
    }
    logger.trace('daemon', 'session_output_ack', { sessionId: command.session_id, lastSeq: command.last_seq });
  }

  private handleVerifyHistory(command: VerifyHistoryCommand): void {
    // Read entire history (limit large enough to cover any session) to compare
    // against the phone's claimed count/tail. Silence = match.
    const result = isCodexSessionId(command.session_id)
      ? this.codexDiscovery.getSessionHistory(command.session_id, {
          offset: 0,
          limit: 100_000,
        })
      : this.sessionDiscovery.getSessionHistory(command.session_id, {
      offset: 0,
      limit: 100_000,
    });

    // Apply the same phone-side filter (tool_use/tool_result hidden when pref is off).
    const visible = this.phonePreferences.showToolUse
      ? result.messages
      : result.messages.filter(m => m.role !== 'tool_use' && m.role !== 'tool_result');

    // Match phone-side parsing: skip empty user messages, blank assistant messages,
    // and unrecognized roles (phone only handles user/assistant/tool_use/subagent).
    const phoneVisible = visible.filter(m => {
      if (m.role === 'user') return m.content.length > 0;
      if (m.role === 'assistant') return m.content.trim().length > 0;
      if (m.role === 'tool_use' || m.role === 'subagent') return true;
      return false; // tool_result and unknown roles are skipped by phone
    });

    const expectedCount = phoneVisible.length;
    const expectedTailSeq = result.tailSeq;

    let reason: 'count_mismatch' | 'tail_seq_mismatch' | 'head_seq_mismatch' | null = null;
    if (command.tail_seq !== undefined && expectedTailSeq !== undefined && command.tail_seq !== expectedTailSeq) {
      reason = 'tail_seq_mismatch';
    } else if (command.count !== expectedCount) {
      // If the phone reports max_count and its count equals that max, it's trimming
      // older messages — only tail_seq matters, count divergence is expected.
      const phoneAtMax = (command as unknown as Record<string, unknown>).max_count !== undefined
        && command.count === (command as unknown as Record<string, unknown>).max_count;
      if (!phoneAtMax) {
        reason = 'count_mismatch';
      }
    }

    if (!reason) {
      logger.trace('daemon', 'verify_history match', { sessionId: command.session_id, count: expectedCount });
      return;
    }

    const event: HistoryDivergenceEvent = {
      type: 'history_divergence',
      session_id: command.session_id,
      expected_count: expectedCount,
      expected_tail_seq: expectedTailSeq,
      reason,
    };
    logger.info('daemon', 'history_divergence', { sessionId: command.session_id, reason, expectedCount, expectedTailSeq, phoneCount: command.count, phoneTail: command.tail_seq });
    this.sendToPhone(event);
  }

  private handleSetPreferences(command: SetPreferencesCommand): void {
    if (command.preferences.show_tool_use !== undefined) {
      this.phonePreferences.showToolUse = command.preferences.show_tool_use;
    }
    if (command.preferences.show_completion_metrics !== undefined) {
      this.phonePreferences.showCompletionMetrics = command.preferences.show_completion_metrics;
    }
    logger.debug('daemon', `Phone preferences updated: ${JSON.stringify(this.phonePreferences)}`);
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private sendToPhone(event: PcEvent, wake = false, wakePayload?: WakeBlobPayload): void {
    // Stamp per-session monotonic seq on session_output events so the phone
    // can detect gaps and request fill via get_history{since_seq}.
    if ((event as { type?: string })?.type === 'session_output') {
      const out = event as SessionOutputEvent;
      if (out.session_id && out.session_seq === undefined) {
        const next = (this.sessionSeqCounters.get(out.session_id) ?? 0) + 1;
        this.sessionSeqCounters.set(out.session_id, next);
        out.session_seq = next;
      }
    }

    logger.trace('daemon', 'OUT event', { type: (event as { type?: string })?.type, requestId: (event as { request_id?: string })?.request_id, preview: JSON.stringify(event).slice(0, 100) });

    const mode = this.config.connectionMode ?? 'relay';

    if (mode === 'lan' && this.lanServer) {
      this.lanServer.send(event);
    } else if (this.relayClient) {
      // Check for rekey before sending
      if (this.cryptoEngine.needsRekey()) {
        this.cryptoEngine.resetRekeyCounters();
      }
      this.relayClient.send(event, wake, wakePayload);
    }
  }

  private sendFlattenedSessionOutput(sessionId: string, agentEvent: ClaudeEvent, agentType: AgentType): void {
    const flat: Record<string, unknown> = {
      type: 'session_output',
      session_id: sessionId,
      agent_type: agentType,
      timestamp: Date.now(),
    };

    switch (agentEvent.type) {
      case 'thinking':
        flat.output_type = 'thinking';
        flat.content = agentEvent.thinking;
        flat.is_complete = false;
        break;

      case 'assistant_message':
        flat.output_type = 'assistant_message';
        flat.content = agentEvent.message;
        flat.is_complete = false;
        break;

      case 'tool_use':
        flat.output_type = 'tool_use';
        flat.tool_name = agentEvent.tool_name;
        flat.tool_input = agentEvent.tool_input;
        flat.tool_use_id = agentEvent.tool_id;
        break;

      case 'tool_result':
        flat.output_type = 'tool_result';
        flat.tool_use_id = agentEvent.tool_id;
        flat.output = agentEvent.output;
        flat.is_error = agentEvent.status === 'error';
        break;

      case 'user_message':
        flat.output_type = 'user_message';
        flat.content = agentEvent.message;
        break;

      case 'system_message':
        flat.output_type = 'system_message';
        flat.content = agentEvent.message;
        break;

      case 'subagent_event':
        flat.output_type = 'subagent_event';
        flat.agent_id = agentEvent.agent_id;
        flat.agent_name = agentEvent.agent_name;
        flat.agent_type = agentEvent.agent_type;
        flat.inner_event = agentEvent.inner_event;
        flat.tool_use_count = agentEvent.tool_use_count;
        flat.token_count = agentEvent.token_count;
        flat.agent_status = agentEvent.agent_status;
        break;

      default:
        flat.output_type = agentEvent.type;
        flat.content = JSON.stringify(agentEvent);
        break;
    }

    this.sendToPhone(flat as unknown as PcEvent);
  }

  private sendError(requestId: string | undefined, message: string, code: string): void {
    const event: ErrorEvent = {
      type: 'error',
      request_id: requestId,
      message,
      code,
    };
    this.sendToPhone(event);
  }

  /**
   * Send our peer_hello over the active E2E channel. Caller must ensure the
   * channel is up (relay phone_online or LAN connected). No-op otherwise.
   */
  private sendPeerHello(): void {
    const hello: PeerHello = {
      type: 'peer_hello',
      product: 'daemon',
      product_version: VERSION,
      wire_version: WIRE_VERSION_CURRENT,
      capabilities: [...CURRENT_PEER_CAPABILITIES],
      sent_at: Date.now(),
    };

    const mode = this.config.connectionMode ?? 'relay';
    if (mode === 'lan' && this.lanServer) {
      this.lanServer.send(hello);
    } else if (this.relayClient) {
      this.relayClient.send(hello);
    } else {
      return;
    }
    logger.debug('daemon', 'Sent peer_hello', { product_version: VERSION, wire: WIRE_VERSION_CURRENT, capabilities: [...CURRENT_PEER_CAPABILITIES] });
  }

  private handlePeerHello(hello: PeerHello): void {
    this.peerProductVersion = hello.product_version;
    this.peerWireVersion = hello.wire_version;
    this.peerCapabilities = new Set(Array.isArray(hello.capabilities) ? hello.capabilities : []);
    logger.debug('daemon', 'Received peer_hello', {
      product: hello.product,
      product_version: hello.product_version,
      wire: hello.wire_version,
      capabilities: Array.from(this.peerCapabilities),
    });
  }

  /**
   * True if the most recent peer_hello announced this capability.
   * Returns false if no peer_hello has been received yet.
   */
  hasPeerCapability(name: string): boolean {
    return this.peerCapabilities.has(name);
  }

  /**
   * Track a blocking request so we can retry if the phone doesn't respond.
   */
  private trackBlockingRequest(
    requestId: string,
    sessionId: string,
    event: PcEvent,
    type: 'permission_request' | 'user_question' | 'plan_review',
  ): void {
    this.pendingBlockingRequests.set(requestId, {
      requestId,
      sessionId,
      event,
      sentAt: Date.now(),
      type,
    });

    logger.debug('daemon', `trackBlockingRequest: ${type} ${requestId.slice(0,8)}`, { sessionId, totalPending: this.pendingBlockingRequests.size });

    // Notify phone that session is now pending action
    this.sendToPhone({
      type: 'session_status',
      session_id: sessionId,
      status: SessionStatus.PENDING_ACTIONS,
      action_type: type,
    } as unknown as PcEvent);
  }

  /**
   * Stop tracking a blocking request (phone responded or it was dismissed).
   */
  private untrackBlockingRequest(requestId: string): void {
    const entry = this.pendingBlockingRequests.get(requestId);
    this.pendingBlockingRequests.delete(requestId);

    // If no more blocking requests for this session, notify phone that
    // session is no longer waiting. Look up current session status.
    if (entry) {
      const hasOtherBlocking = Array.from(this.pendingBlockingRequests.values()).some(
        e => e.sessionId === entry.sessionId,
      );
      if (!hasOtherBlocking) {
        // Find the real session status (running/ready) or fall back to ready
        const session = this.sessionManager.getAllSessions().find(
          s => this.resolveExternalSessionId(s.sessionId) === entry.sessionId
            || s.claudeSessionId === entry.sessionId,
        );
        const status = session?.status ?? SessionStatus.READY;
        this.sendToPhone({
          type: 'session_status',
          session_id: entry.sessionId,
          status,
        } as unknown as PcEvent);
      }
    }
  }

  /**
   * Retry pending blocking requests that haven't received a response
   * within BLOCKING_RETRY_INTERVAL_MS.
   */
  private retryPendingBlockingRequests(): void {
    const now = Date.now();
    for (const [requestId, entry] of this.pendingBlockingRequests) {
      // Only retry if the request is still actually pending
      // (hook still holding the connection, or SDK still waiting).
      // Keep expired-to-terminal entries — they're waiting for PostToolUse.
      if ((entry as any).expiredToTerminal) continue;

      const isStillPending =
        this.hookServer.hasPendingPermission(requestId) ||
        this.sessionManager.getAllSessions().some(
          s => s.pendingPermissions?.has(requestId),
        );

      if (!isStillPending) {
        this.pendingBlockingRequests.delete(requestId);
        continue;
      }

      if (now - entry.sentAt >= BLOCKING_RETRY_INTERVAL_MS) {
        logger.warn('daemon', `Retrying blocking request`, { type: entry.type, requestId, waitedMs: now - entry.sentAt });
        this.sendToPhone(entry.event);
        entry.sentAt = now;
      }
    }
  }

  private findRequestIdForSession(sessionId: string): string | undefined {
    for (const [requestId, sid] of this.pendingSessionRequests.entries()) {
      if (sid === sessionId) {
        this.pendingSessionRequests.delete(requestId);
        return requestId;
      }
    }
    return undefined;
  }

  /**
   * Resolve an internal session ID to the external ID the phone knows.
   * If the session was resumed from a discovered session, the phone knows it
   * by the Claude session ID, not our internal session_xxxx_xx ID.
   */
  private resolveExternalSessionId(internalId: string): string {
    // Check sessionIdMap first
    const mapped = this.sessionIdMap.get(internalId);
    if (mapped) return mapped;

    // Fallback: check if the session state has a claudeSessionId (set during resume)
    const session = this.sessionManager.getSession(internalId);
    if (session?.claudeSessionId) {
      // Cache the mapping for future lookups
      this.sessionIdMap.set(internalId, session.claudeSessionId);
      return session.claudeSessionId;
    }

    return internalId;
  }

  /**
   * Resolve a session's display name (custom title or project dir basename).
   * Accepts either internal or external session IDs.
   */
  private getSessionName(sessionId: string): string {
    let session = this.sessionManager.getSession(sessionId);
    if (!session) {
      const all = this.sessionManager.getAllSessions();
      session = all.find(s => this.resolveExternalSessionId(s.sessionId) === sessionId);
    }
    if (!session) return 'Session';
    return session.customTitle ?? path.basename(session.workingDirectory);
  }

  /**
   * Find the most recent session-map.json entry for `pid` whose JSONL file
   * still exists on disk. Returns the corrected sessionId + cwd + transcript
   * path so callers can bypass the (potentially stale) PID JSON metadata.
   *
   * Why: ~/.claude/sessions/<pid>.json records `sessionId`/`cwd` from the
   * process's first session. After /clear (and sometimes after a worktree
   * launch where cwd is recorded incorrectly), it stops matching reality.
   * The SessionStart hook always writes the correct values to session-map,
   * which persists across daemon restarts.
   */
  private getLatestSessionMapEntryForPid(pid: number): { sessionId: string; cwd: string; transcriptPath?: string; timestamp: number } | undefined {
    const mapped = this.readSessionMap();
    let best: { sessionId: string; cwd: string; transcriptPath?: string; timestamp: number } | undefined;
    for (const [sid, v] of Object.entries(mapped)) {
      if (v.pid !== pid) continue;
      if (v.transcript_path && !fs.existsSync(v.transcript_path)) continue;
      if (!best || v.timestamp > best.timestamp) {
        best = { sessionId: sid, cwd: v.cwd, transcriptPath: v.transcript_path, timestamp: v.timestamp };
      }
    }
    return best;
  }

  /**
   * Read ~/.agent-pocket/session-map.json written by the SessionStart hook script.
   * Returns a map of sessionId → { source, cwd, transcript_path, pid, timestamp }.
   */
  private readSessionMap(): Record<string, { source: string; cwd: string; transcript_path?: string; pid?: number; timestamp: number }> {
    const mapFile = path.join(os.homedir(), '.agent-pocket', 'session-map.json');
    try {
      if (!fs.existsSync(mapFile)) return {};
      const raw = fs.readFileSync(mapFile, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, { source: string; cwd: string; transcript_path?: string; pid?: number; timestamp: number }>;
      // Defensive filter: subagent SessionStart events (older daemon versions
      // wrote them) share the parent Claude PID and would clobber the real
      // session-id mapping. Identify by transcript path under /subagents/.
      const filtered: typeof parsed = {};
      for (const [sid, v] of Object.entries(parsed)) {
        if (v.transcript_path && v.transcript_path.includes('/subagents/')) continue;
        filtered[sid] = v;
      }
      return filtered;
    } catch {
      return {};
    }
  }

  /**
   * Garbage-collect session-map.json: remove entries whose PID is no longer
   * alive or whose transcript file is gone. Catches entries that were never
   * observed by this daemon (e.g. CLIs that started+ended before launch) and
   * stale entries left behind by PID reuse.
   */
  private gcSessionMap(): void {
    const mapFile = path.join(os.homedir(), '.agent-pocket', 'session-map.json');
    try {
      if (!fs.existsSync(mapFile)) return;
      const raw = fs.readFileSync(mapFile, 'utf-8');
      const map = JSON.parse(raw) as Record<string, { pid?: number; transcript_path?: string }>;
      const removed: string[] = [];
      for (const [sid, entry] of Object.entries(map)) {
        let dead = false;
        // pid<=0 means the hook couldn't resolve a real Claude PID; the
        // entry can never match a live process, so drop it.
        if (!entry.pid || entry.pid <= 0) {
          dead = true;
        } else {
          try { process.kill(entry.pid, 0); } catch { dead = true; }
        }
        if (!dead && entry.transcript_path && !fs.existsSync(entry.transcript_path)) {
          dead = true;
        }
        if (dead) {
          delete map[sid];
          removed.push(sid);
        }
      }
      if (removed.length > 0) {
        fs.writeFileSync(mapFile, JSON.stringify(map), 'utf-8');
        logger.debug('daemon', 'GC session-map', { removed: removed.length });
      }
    } catch {
      // Best effort
    }
  }

  /**
   * Remove session-map.json entries whose PID has died.
   */
  private cleanSessionMap(deadPids: number[]): void {
    const mapFile = path.join(os.homedir(), '.agent-pocket', 'session-map.json');
    try {
      if (!fs.existsSync(mapFile)) return;
      const raw = fs.readFileSync(mapFile, 'utf-8');
      const map = JSON.parse(raw) as Record<string, { pid?: number }>;
      const deadSet = new Set(deadPids);
      let changed = false;
      for (const [sid, entry] of Object.entries(map)) {
        if (entry.pid && deadSet.has(entry.pid)) {
          delete map[sid];
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(mapFile, JSON.stringify(map), 'utf-8');
        logger.trace('daemon', 'Cleaned session-map entries for dead PIDs', { deadPids });
      }
    } catch {
      // Best effort
    }
  }

  /**
   * Remove specific session IDs from session-map.json.
   */
  private removeSessionMapEntries(sessionIds: string[]): void {
    const mapFile = path.join(os.homedir(), '.agent-pocket', 'session-map.json');
    try {
      if (!fs.existsSync(mapFile)) return;
      const raw = fs.readFileSync(mapFile, 'utf-8');
      const map = JSON.parse(raw) as Record<string, unknown>;
      let changed = false;
      for (const sid of sessionIds) {
        if (sid in map) {
          delete map[sid];
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(mapFile, JSON.stringify(map), 'utf-8');
        logger.trace('daemon', 'Removed stale session-map entries', { sessionIds });
      }
    } catch {
      // Best effort
    }
  }

  /**
   * Reverse lookup: given an external session ID the phone uses,
   * find the internal session ID in the session manager.
   */
  private resolveInternalSessionId(externalId: string): string | undefined {
    // Direct match — the external ID IS the internal ID
    if (this.sessionManager.getSession(externalId)) {
      return externalId;
    }
    // Reverse lookup in sessionIdMap: internal -> external
    for (const [internalId, extId] of this.sessionIdMap.entries()) {
      if (extId === externalId) {
        return internalId;
      }
    }
    return undefined;
  }

  private buildPermissionContext(toolName: string, toolInput: Record<string, unknown>): string {
    const parts: string[] = [`Tool: ${toolName}`];

    if (toolInput.command) {
      parts.push(`Command: ${String(toolInput.command)}`);
    }
    if (toolInput.description && toolName === 'Bash') {
      parts.push(`Description: ${String(toolInput.description)}`);
    }
    if (toolInput.file_path) {
      parts.push(`File: ${String(toolInput.file_path)}`);
    }
    if (toolInput.path) {
      parts.push(`Path: ${String(toolInput.path)}`);
    }
    if (toolInput.url) {
      parts.push(`URL: ${String(toolInput.url)}`);
    }
    if (toolInput.pattern) {
      parts.push(`Pattern: ${String(toolInput.pattern)}`);
    }
    if (toolInput.subject && (toolName === 'TaskCreate' || toolName === 'TaskUpdate')) {
      parts.push(`Subject: ${String(toolInput.subject)}`);
    }
    if (toolInput.taskId) {
      parts.push(`Task: #${String(toolInput.taskId)}`);
    }
    if (toolInput.status) {
      parts.push(`Status: ${String(toolInput.status)}`);
    }

    return parts.join(' | ');
  }

  /**
   * Try to find the working directory for a discovered session.
   * Falls back to the daemon's default working directory.
   */
  private findWorkingDirForSession(claudeSessionId: string): string {
    // Check cached discovered sessions
    const discovered = this.sessionDiscovery.getCachedSessions();
    if (discovered) {
      const match = discovered.find((s) => s.sessionId === claudeSessionId);
      if (match) return match.projectDir;
    }
    return this.config.defaultWorkingDirectory ?? process.cwd();
  }

  /**
   * Check if a tool call is a plan-mode operation that should be auto-approved
   * or handled specially (ExitPlanMode).
   */
  private isPlanModeTool(toolName: string, toolInput: Record<string, unknown>): boolean {
    if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') return true;
    // Edit/Write on .claude/plans/ files
    if (toolName === 'Edit' || toolName === 'Write') {
      const filePath = (toolInput.file_path as string) ?? '';
      if (filePath.includes('.claude/plans/')) return true;
    }
    return false;
  }

  /**
   * Read the plan file from ExitPlanMode and send it as a plan_review event
   * to the phone. The hook connection stays open until the phone responds.
   */
  private sendPlanForReview(
    sessionId: string,
    requestId: string,
    toolInput: Record<string, unknown>,
    cwd: string,
  ): void {
    let planContent = '';

    // Try to find the plan file. ExitPlanMode may include allowedPrompts
    // but the plan file path is in the session's plan file.
    // Best approach: find the most recently modified .md in .claude/plans/ under cwd
    const plansDir = path.join(cwd, '.claude', 'plans');
    try {
      if (fs.existsSync(plansDir)) {
        const files = fs.readdirSync(plansDir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => ({
            name: f,
            mtime: fs.statSync(path.join(plansDir, f)).mtimeMs,
          }))
          .sort((a, b) => b.mtime - a.mtime);

        if (files.length > 0) {
          const planPath = path.join(plansDir, files[0].name);
          planContent = fs.readFileSync(planPath, 'utf-8');
        }
      }
    } catch (err) {
      logger.warn('daemon', `Error reading plan file: ${(err as Error).message}`);
    }

    // Also check the global .claude/plans/ directory
    if (!planContent) {
      const globalPlansDir = path.join(
        os.homedir(),
        '.claude',
        'plans',
      );
      try {
        if (fs.existsSync(globalPlansDir)) {
          const files = fs.readdirSync(globalPlansDir)
            .filter((f) => f.endsWith('.md'))
            .map((f) => ({
              name: f,
              mtime: fs.statSync(path.join(globalPlansDir, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);

          if (files.length > 0) {
            const planPath = path.join(globalPlansDir, files[0].name);
            planContent = fs.readFileSync(planPath, 'utf-8');
          }
        }
      } catch (err) {
        logger.warn('daemon', `Error reading global plan file: ${(err as Error).message}`);
      }
    }

    const flat: Record<string, unknown> = {
      type: 'session_output',
      session_id: sessionId,
      output_type: 'plan_review',
      plan_content: planContent || '(Could not read plan file)',
      request_id: requestId,
      allowed_prompts: toolInput.allowedPrompts ?? [],
      timestamp: new Date().toISOString(),
      ttl: HOOK_HOLD_TIMEOUT_SECONDS,
    };

    this.sendToPhone(flat as unknown as PcEvent, true, {
      type: 'plan_review',
      session_name: this.getSessionName(sessionId),
      body: truncateUtf8(planContent || 'A plan is ready for your review', 256),
      sound: 'default',
      category: 'PLAN_REVIEW',
      session_id: sessionId,
      request_id: requestId,
    });
    this.trackBlockingRequest(requestId, sessionId, flat as unknown as PcEvent, 'plan_review');
  }

  /**
   * Read session history from disk and send it to the phone.
   * Supports pagination (offset/limit) and incremental fetch (since).
   */
  private sendSessionHistory(
    claudeSessionId: string,
    options?: { since?: string; sinceSeq?: number; offset?: number; limit?: number },
  ): void {
    // If no 'since' filter and no explicit offset, send all messages (up to 2000)
    // to ensure the phone gets complete history on first load.
    // When 'since'/'sinceSeq' is present, use smaller default limit for incremental updates.
    const incremental = options?.since !== undefined || options?.sinceSeq !== undefined;
    const defaultLimit = incremental ? 200 : 2000;
    const isFullHistory = !incremental && !options?.offset;

    const result = isCodexSessionId(claudeSessionId)
      ? this.codexDiscovery.getSessionHistory(claudeSessionId, {
          offset: options?.offset ?? 0,
          limit: options?.limit ?? defaultLimit,
          since: options?.since,
          sinceSeq: options?.sinceSeq,
        })
      : this.sessionDiscovery.getSessionHistory(claudeSessionId, {
      offset: options?.offset ?? 0,
      limit: options?.limit ?? defaultLimit,
      since: options?.since,
      sinceSeq: options?.sinceSeq,
    });

    // Truncate very long content to keep total message size reasonable
    const truncated = result.messages.map((m) => ({
      ...m,
      content: m.content.slice(0, 5000),
    }));

    // Filter tool_use/tool_result when phone has disabled tool use display
    const filtered = this.phonePreferences.showToolUse
      ? truncated
      : truncated.filter(m => m.role !== 'tool_use' && m.role !== 'tool_result');

    const event = {
      type: 'session_history',
      session_id: claudeSessionId,
      agent_type: isCodexSessionId(claudeSessionId) ? 'codex' : 'claude_code',
      messages: filtered,
      total_count: result.totalCount,
      offset: result.offset,
      has_more: result.hasMore,
      is_full_history: isFullHistory,
      tail_seq: result.tailSeq,
    };

    this.sendToPhone(event as unknown as PcEvent);
  }
}
