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
import { CodexDiscovery, codexExternalSessionId, findOpenCodexRollouts, isCodexSessionId } from './discovery/codex-discovery.js';
import type { CodexLiveSession, CodexSession } from './discovery/codex-discovery.js';
import { CodexObserver } from './observers/codex-observer.js';
import { HookServer } from './hooks/hook-server.js';
import type { CodexHookRequest } from './hooks/hook-server.js';
import { findTerminalForPid, sendInterrupt as terminalSendInterrupt, sendMessage as terminalSendMessage } from './pty/tmux-injector.js';
import type { TerminalTarget } from './pty/tmux-injector.js';
import { LanServer } from './lan/lan-server.js';
import { BonjourAdvertiser } from './lan/bonjour-advertiser.js';
import { formatTimestamp, logger } from './logger.js';
import {
  readSessionMap,
  getLatestSessionMapEntryForPid,
  gcSessionMap,
  cleanSessionMap,
  removeSessionMapEntries,
} from './utils/session-map.js';
export { mergeSyncSessionIds } from './utils/session-map.js';
import {
  CodexStopHookDeduper,
  findCodexHookRolloutPath,
  getCodexCapabilities,
  refreshCodexTerminalTarget,
  resolveCodexExternalSessionId as resolveCodexExternalSessionIdHelper,
  type CodexTerminalTargetEntry,
} from './codex/codex-handler.js';
import {
  PeerCapabilities,
  NOTIFICATION_DELIVERY_RETRY_CHECK_INTERVAL_MS,
  type NotificationDeliveryEventType,
} from './relay/phone-transport.js';
import type { CommandContext } from './commands/command-context.js';
import { STATIC_MODEL_CATALOG } from './commands/handlers/model-catalog.js';
import {
  handleGetSupportedModels as handleGetSupportedModelsExternal,
  handleGetContextUsage as handleGetContextUsageExternal,
  handleGetSupportedCommands as handleGetSupportedCommandsExternal,
  handleGetSupportedAgents as handleGetSupportedAgentsExternal,
  handleGetMcpServerStatus as handleGetMcpServerStatusExternal,
} from './commands/handlers/capability-info.js';
import {
  handleReadFile as handleReadFileExternal,
  handleGetHistory as handleGetHistoryExternal,
  handleSyncRequest as handleSyncRequestExternal,
} from './commands/handlers/file-and-history.js';
import {
  handleNewSession as handleNewSessionExternal,
  handleResumeSession as handleResumeSessionExternal,
  handleKillSession as handleKillSessionExternal,
  handleInterruptSession as handleInterruptSessionExternal,
  handleRewindSession as handleRewindSessionExternal,
  type CodexLifecycleDeps,
} from './commands/handlers/session-lifecycle.js';
import {
  handleSetPermissionMode as handleSetPermissionModeExternal,
  handleSetModel as handleSetModelExternal,
} from './commands/handlers/runtime-config.js';
import {
  handleEmergencyAbort as handleEmergencyAbortExternal,
  handleSessionOutputAck as handleSessionOutputAckExternal,
  handleNotificationDeliveryAck as handleNotificationDeliveryAckExternal,
  handleVerifyHistory as handleVerifyHistoryExternal,
  type VerifyHistoryDeps,
} from './commands/handlers/acks.js';
import {
  handlePermissionResponse as handlePermissionResponseExternal,
  handleQuestionResponse as handleQuestionResponseExternal,
  type ResponseDeps,
} from './commands/handlers/responses.js';
import {
  handleSendMessage as handleSendMessageExternal,
  type SendMessageDeps,
} from './commands/handlers/send-message.js';
import {
  handleListSessions as handleListSessionsExternal,
  type ListSessionsDeps,
} from './commands/handlers/list-sessions.js';
import {
  handleSetPreferences as handleSetPreferencesExternal,
  handlePeerHello as handlePeerHelloExternal,
  type PhonePreferences,
} from './commands/handlers/preferences-and-peer.js';
import { DiscoveryLoop } from './discovery/discovery-orchestrator.js';
import {
  type MessageSeqRef,
} from './wiring/hook-handlers-codex.js';
import { wireHookServer } from './wiring/hook-server-wiring.js';
import {
  attachCodexObserverHandlers as attachCodexObserverHandlersExternal,
  sendCodexCompletion as sendCodexCompletionExternal,
  createCompletionRequestIdGenerator,
  type CodexObserverTracked,
} from './wiring/codex-event-bridge.js';
import {
  buildPermissionContext as buildPermissionContextExternal,
  isPlanModeTool as isPlanModeToolExternal,
  findWorkingDirForSession as findWorkingDirForSessionExternal,
  sendPlanForReview as sendPlanForReviewExternal,
} from './wiring/permission-ui.js';
import {
  registerSessionStartedHandler,
  registerPermissionModeChangedHandler,
  registerSessionOutputHandler,
  registerSessionEndedHandler,
  registerPermissionRequestHandler,
  registerSessionErrorHandler,
  registerSessionStatusHandler,
  registerPendingActionDetectedHandler,
  registerSessionTitleHandler,
  registerSessionInterruptedHandler,
} from './wiring/session-manager-handlers.js';
import {
  registerCommandMessageHandler,
  registerTransportErrorHandler,
  registerDecryptErrorHandler,
  registerRelayConnectedHandler,
  registerLanConnectedHandler,
  registerDisconnectedHandler,
  registerPhoneOnlineHandler,
  registerKeyVerifyHandler,
} from './wiring/transport-handlers.js';
import {
  createNotificationBookkeeping,
  type NotificationBookkeeping,
  type PendingBlockingRequestEntry,
  type PendingNotificationDeliveryEntry,
} from './wiring/notification-bookkeeping.js';
import {
  sendFlattenedSessionOutput as sendFlattenedSessionOutputExternal,
  sendSessionHistory as sendSessionHistoryExternal,
} from './wiring/session-output-serializer.js';
import {
  discoverAndObserveSessions as discoverAndObserveSessionsExternal,
  discoverAndObserveCodexSessions as discoverAndObserveCodexSessionsExternal,
} from './wiring/session-discovery-loop.js';
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
  SetPermissionModeCommand,
  SetModelCommand,
  GetSupportedModelsCommand,
  GetContextUsageCommand,
  GetSupportedCommandsCommand,
  GetSupportedAgentsCommand,
  GetMcpServerStatusCommand,
  RewindSessionCommand,
  ListSessionsCommand,
  ReadFileCommand,
  EmergencyAbortCommand,
  GetHistoryCommand,
  SetPreferencesCommand,
  SessionOutputAckCommand,
  VerifyHistoryCommand,
  SyncRequestCommand,
  NotificationDeliveryAckCommand,
  PcEvent,
  SessionListEvent,
  FileContentEvent,
  ErrorEvent,
  HistoryDivergenceEvent,
  SyncCompleteEvent,
  ClaudeEvent,
  PeerHello,
  SessionInfo,
  AgentType,
  WakeBlobPayload,
} from 'agent-pocket-protocol';
import {
  DAEMON_DEFAULT_PORT,
  SessionStatus,
  HOOK_SERVER_PORT,
  WIRE_VERSION_CURRENT,
  CURRENT_PEER_CAPABILITIES,
  PEER_CAPABILITIES,
  BLOCKING_RETRY_CHECK_INTERVAL_MS,
} from 'agent-pocket-protocol';
import { VERSION } from './version.js';

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

// CodexTerminalTargetEntry is imported above from './codex/codex-handler.js'.
// NotificationDeliveryEventType + NOTIFICATION_DELIVERY_* constants are
// imported above from './relay/phone-transport.js'.

// Static catalog of Claude model ids the SDK accepts. Verified by probing all
// 72 family×version×effort×1m combinations on SDK 0.2.129 — the SDK accepts
// any well-formed `claude-{family}-{ver}[-effort][1m]` string and reflects it
// back via getContextUsage().model. Query.supportedModels() on its own only
// lists 4 alias entries plus the launched build, so older versions and effort
// tiers are unreachable through the picker without this table.
// STATIC_MODEL_CATALOG moved to ./commands/handlers/model-catalog.ts

// ============================================================================
// AgentPocketDaemon
// ============================================================================

// formatDuration / formatTokens / formatCompletionSubtitle live in
// ./utils/completion-subtitle.ts (used only by hook-handlers-lifecycle now).

// truncateUtf8 lives in ./utils/truncate-utf8.ts; imported below alongside the
// other utils. Removing the duplicate local copy keeps a single source of
// truth for APNs body sizing.

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
  private codexInjectedMessages: Map<string, Map<string, number>> = new Map();
  private codexStopHookDeduper = new CodexStopHookDeduper();
  private completionRequestIdGen = createCompletionRequestIdGenerator();
  private claudeAgentVersion?: string;
  private codexTerminalTargets: Map<string, CodexTerminalTargetEntry> = new Map();
  private hookServer: HookServer;
  private lanServer: LanServer | null = null;
  private bonjourAdvertiser: BonjourAdvertiser | null = null;
  private discoveryLoop: DiscoveryLoop | null = null;
  // Hook server restart backoff state
  private hookRestartAttempts: number = 0;
  private hookRestartTimer: ReturnType<typeof setTimeout> | null = null;

  // Peer (phone) capability set learned from peer_hello. Empty until the
  // first peer_hello arrives over the E2E channel.
  private peers = new PeerCapabilities();

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
  // Read-then-increment view onto messageSeq, shared by every wiring module
  // that needs to sign with the current value AND emit it as the wire seq.
  private readonly messageSeqRef: MessageSeqRef = {
    peek: () => this.messageSeq,
    getAndIncrement: () => this.messageSeq++,
  };
  // Per-session monotonic seq for session_output events (for phone gap detection)
  private sessionSeqCounters: Map<string, number> = new Map();
  // Last seq the phone has acked per session (best-effort telemetry)
  private lastAckedSeqs: Map<string, number> = new Map();
  // Phone preferences (sent via set_preferences command)
  private phonePreferences: PhonePreferences = {
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
    toolName?: string;
    expiredToTerminal?: boolean;
    expiredSystemMessageSent?: boolean;
  }> = new Map();
  private pendingNotificationDeliveries: Map<string, {
    requestId: string;
    sessionId: string;
    eventType: NotificationDeliveryEventType;
    event: PcEvent;
    wakePayload?: WakeBlobPayload;
    sentAt: number;
    attempts: number;
  }> = new Map();
  private blockingRetryInterval: ReturnType<typeof setInterval> | null = null;
  private notificationDeliveryRetryInterval: ReturnType<typeof setInterval> | null = null;
  private bookkeeping!: NotificationBookkeeping;

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

    this.bookkeeping = createNotificationBookkeeping({
      sessionSeqCounters: this.sessionSeqCounters,
      pendingBlockingRequests: this.pendingBlockingRequests as unknown as Map<string, PendingBlockingRequestEntry>,
      pendingNotificationDeliveries: this.pendingNotificationDeliveries as unknown as Map<string, PendingNotificationDeliveryEntry>,
      getConnectionMode: () => this.config.connectionMode,
      getLanServer: () => this.lanServer ?? null,
      getRelayClient: () => this.relayClient ?? null,
      cryptoEngine: this.cryptoEngine,
      hasPeerCapability: (name) => this.hasPeerCapability(name),
      sessionManager: this.sessionManager,
      hookServer: this.hookServer,
      resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
    });
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
    gcSessionMap();

    // Periodically check observed PIDs and discover new CLI sessions
    this.discoveryLoop = new DiscoveryLoop({
      checkObservedSessionPids: () => this.checkObservedSessionPids(),
      discoverAndObserveSessions: () => this.discoverAndObserveSessions(),
      discoverAndObserveCodexSessions: () => this.discoverAndObserveCodexSessions(),
    });
    this.discoveryLoop.start();

    // Periodically retry blocking requests that haven't received a phone response
    this.blockingRetryInterval = setInterval(() => {
      this.retryPendingBlockingRequests();
    }, BLOCKING_RETRY_CHECK_INTERVAL_MS);
    this.notificationDeliveryRetryInterval = setInterval(() => {
      this.retryPendingNotificationDeliveries();
    }, NOTIFICATION_DELIVERY_RETRY_CHECK_INTERVAL_MS);

    return hookPort;
  }

  /**
   * Stop the daemon gracefully.
   */
  async stop(): Promise<void> {
    if (this.discoveryLoop) {
      this.discoveryLoop.stop();
      this.discoveryLoop = null;
    }
    if (this.hookRestartTimer) {
      clearTimeout(this.hookRestartTimer);
      this.hookRestartTimer = null;
    }
    if (this.blockingRetryInterval) {
      clearInterval(this.blockingRetryInterval);
      this.blockingRetryInterval = null;
    }
    if (this.notificationDeliveryRetryInterval) {
      clearInterval(this.notificationDeliveryRetryInterval);
      this.notificationDeliveryRetryInterval = null;
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
    const resolveExternalSessionId = (id: string) => this.resolveExternalSessionId(id);
    const sendToPhone = (event: PcEvent) => this.sendToPhone(event);
    const sendNotificationEventToPhone = (
      event: PcEvent,
      eventType: NotificationDeliveryEventType,
      sessionId: string,
      requestId: string,
      wakePayload: Record<string, unknown>,
    ) => this.sendNotificationEventToPhone(event, eventType, sessionId, requestId, wakePayload as unknown as WakeBlobPayload);
    const sendFlattenedSessionOutput = (sessionId: string, e: ClaudeEvent, agentType: AgentType) =>
      this.sendFlattenedSessionOutput(sessionId, e, agentType);
    const isInitialDiscoveryDone = () => this.initialDiscoveryDone;

    registerSessionStartedHandler(this.sessionManager, {
      sessionManager: this.sessionManager,
      resolveExternalSessionId,
      findRequestIdForSession: (id) => this.findRequestIdForSession(id),
      getClaudeAgentVersion: () => this.claudeAgentVersion,
      isInitialDiscoveryDone,
      sendToPhone,
    });

    registerPermissionModeChangedHandler(this.sessionManager, {
      resolveExternalSessionId,
      sendToPhone,
    });

    registerSessionOutputHandler(this.sessionManager, {
      resolveExternalSessionId,
      sendToPhone,
      sendFlattenedSessionOutput,
      prefs: this.phonePreferences,
    });

    registerSessionEndedHandler(this.sessionManager, {
      resolveExternalSessionId,
      getSessionName: (id) => this.getSessionName(id),
      sendToPhone,
      sendNotificationEventToPhone,
      sessionIdMap: this.sessionIdMap,
      pendingBlockingRequests: this.pendingBlockingRequests,
      clearNotificationDeliveriesForSession: (id) => this.clearNotificationDeliveriesForSession(id),
    });

    registerPermissionRequestHandler(this.sessionManager, {
      sessionManager: this.sessionManager,
      resolveExternalSessionId,
      isPlanModeTool: (name, input) => this.isPlanModeTool(name, input),
      sendPlanForReview: (sId, rId, input, cwd) => this.sendPlanForReview(sId, rId, input, cwd),
      buildPermissionContext: (name, input) => this.buildPermissionContext(name, input),
      getSessionName: (id) => this.getSessionName(id),
      cryptoEngine: this.cryptoEngine,
      messageSeq: this.messageSeqRef,
      sendToPhone,
      sendNotificationEventToPhone,
      trackBlockingRequest: (rId, sId, event, type) => this.trackBlockingRequest(rId, sId, event, type),
    });

    registerSessionErrorHandler(this.sessionManager, { sendToPhone });

    registerSessionStatusHandler(this.sessionManager, {
      sessionManager: this.sessionManager,
      resolveExternalSessionId,
      isInitialDiscoveryDone,
      pendingBlockingRequests: this.pendingBlockingRequests,
      sendToPhone,
    });

    registerPendingActionDetectedHandler(this.sessionManager, {
      resolveExternalSessionId,
      pendingBlockingRequests: this.pendingBlockingRequests,
    });

    registerSessionTitleHandler(this.sessionManager, {
      resolveExternalSessionId,
      sendToPhone,
    });

    registerSessionInterruptedHandler(this.sessionManager, {
      sessionManager: this.sessionManager,
      resolveExternalSessionId,
      pendingBlockingRequests: this.pendingBlockingRequests,
      sendToPhone,
      sendFlattenedSessionOutput,
    });
  }

  // --------------------------------------------------------------------------
  // Event Wiring: RelayClient -> Command Handling
  // --------------------------------------------------------------------------

  private wireRelayClientEvents(): void {
    const relay = this.relayClient!;
    const sendToPhone = (event: PcEvent) => this.sendToPhone(event);

    registerCommandMessageHandler(relay, {
      source: 'relay',
      handlePeerHello: (p) => this.handlePeerHello(p),
      handleCommand: (c) => this.handleCommand(c),
      sendToPhone,
    });

    registerRelayConnectedHandler(relay, {
      emitConnected: () => this.emit('connected'),
    });

    registerPhoneOnlineHandler(relay, {
      hookServer: this.hookServer,
      sessionManager: this.sessionManager,
      sendPeerHello: () => this.sendPeerHello(),
      getKeyFingerprint: () => this.cryptoEngine.sendKeyFingerprint(),
      sendControlFrame: (f) => relay.sendControlFrame(f),
      pendingBlockingRequests: this.pendingBlockingRequests,
      resendTrackedBlockingEvent: (type, sId, rId, event) =>
        this.resendTrackedBlockingEvent(type, sId, rId, event),
      sendToPhone,
      sendExpiredPendingSystemMessage: (sId, rId, tn, at, e) =>
        this.sendExpiredPendingSystemMessage(sId, rId, tn, at, e),
      clearNotificationDelivery: (et, sId, rId) =>
        this.clearNotificationDelivery(et, sId, rId),
    });

    registerKeyVerifyHandler(relay, {
      getExpectedFingerprint: () => this.cryptoEngine.recvKeyFingerprint(),
      sendControlFrame: (f) => relay.sendControlFrame(f),
    });

    registerDisconnectedHandler(relay, {
      source: 'relay',
      emitDisconnected: (reason) => { this.emit('disconnected', reason); },
    });

    registerTransportErrorHandler(relay, 'relay');

    registerDecryptErrorHandler(relay, {
      source: 'relay',
      sendE2EError: (message) => relay.sendControlFrame({ action: 'e2e_error', message }),
    });
  }

  // --------------------------------------------------------------------------
  // Event Wiring: LanServer -> Command Handling
  // --------------------------------------------------------------------------

  private wireLanServerEvents(): void {
    const lan = this.lanServer!;
    const sendToPhone = (event: PcEvent) => this.sendToPhone(event);

    registerCommandMessageHandler(lan, {
      source: 'lan',
      handlePeerHello: (p) => this.handlePeerHello(p),
      handleCommand: (c) => this.handleCommand(c),
      sendToPhone,
    });

    registerLanConnectedHandler(lan, {
      sendPeerHello: () => this.sendPeerHello(),
      emitConnected: () => this.emit('connected'),
    });

    registerDisconnectedHandler(lan, {
      source: 'lan',
      emitDisconnected: (reason) => { this.emit('disconnected', reason); },
    });

    registerTransportErrorHandler(lan, 'lan');

    registerDecryptErrorHandler(lan, {
      source: 'lan',
      sendE2EError: (message) => lan.send({ type: 'e2e_error', message }),
    });
  }

  // --------------------------------------------------------------------------
  // Event Wiring: HookServer -> Phone
  // --------------------------------------------------------------------------

  private wireHookServerEvents(): void {
    wireHookServer(this.hookServer, {
      toolResult: {
        prefs: this.phonePreferences,
        sessionManager: this.sessionManager,
        resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
        sendToPhone: (event) => this.sendToPhone(event),
      },
      error: {
        restartHookServer: () => this.restartHookServer(),
      },
      permissionExpired: {
        sessionManager: this.sessionManager,
        resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
        resolveCodexExternalSessionId: (id) => this.resolveCodexExternalSessionId(id),
        sendToPhone: (event) => this.sendToPhone(event),
        pendingBlockingRequests: this.pendingBlockingRequests,
        sendExpiredPendingSystemMessage: (sId, rId, tn, at, e) => this.sendExpiredPendingSystemMessage(sId, rId, tn, at, e),
        clearNotificationDelivery: (et, sId, rId) => this.clearNotificationDelivery(et, sId, rId),
      },
      codexSessionStart: {
        codexObservers: this.codexObservers,
        recordCodexHookActivity: (req) => this.recordCodexHookActivity(req),
        sendToPhone: (event) => this.sendToPhone(event),
        isInitialDiscoveryDone: () => this.initialDiscoveryDone,
        getCodexCapabilities: (id) => this.getCodexCapabilities(id),
      },
      codexUserPromptSubmit: {
        codexObservers: this.codexObservers,
        recordCodexHookActivity: (req) => this.recordCodexHookActivity(req),
        sendToPhone: (event) => this.sendToPhone(event),
      },
      codexStop: {
        codexObservers: this.codexObservers,
        recordCodexHookActivity: (req) => this.recordCodexHookActivity(req),
        sendToPhone: (event) => this.sendToPhone(event),
        codexStopHookDeduper: this.codexStopHookDeduper,
        sendCodexCompletion: (sId, sess, summary) => this.sendCodexCompletion(sId, sess, summary),
      },
      codexPermissionRequest: {
        recordCodexHookActivity: (req) => this.recordCodexHookActivity(req),
        cryptoEngine: this.cryptoEngine,
        messageSeq: this.messageSeqRef,
        buildPermissionContext: (tn, ti) => this.buildPermissionContext(tn, ti),
        getSessionName: (id) => this.getSessionName(id),
        sendNotificationEventToPhone: (e, et, sId, rId, wp) => this.sendNotificationEventToPhone(e, et, sId, rId, wp),
        trackBlockingRequest: (rId, sId, e, t) => this.trackBlockingRequest(rId, sId, e, t),
      },
      apiSessions: {
        sessionManager: this.sessionManager,
        getRelayClient: () => this.relayClient,
      },
      apiStatus: {
        sessionManager: this.sessionManager,
        getRelayClient: () => this.relayClient,
      },
      sessionStop: {
        sessionManager: this.sessionManager,
        resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
        pendingBlockingRequests: this.pendingBlockingRequests,
        clearNotificationDelivery: (et, sId, rId) => this.clearNotificationDelivery(et, sId, rId),
        nextCompletionRequestId: (sId, ts) => this.nextCompletionRequestId(sId, ts),
        sendNotificationEventToPhone: (e, et, sId, rId, wp) => this.sendNotificationEventToPhone(e, et, sId, rId, wp),
        sendToPhone: (event) => this.sendToPhone(event),
        prefs: this.phonePreferences,
      },
      sessionStopFailure: {
        sessionManager: this.sessionManager,
        resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
        pendingBlockingRequests: this.pendingBlockingRequests,
        sendToPhone: (event) => this.sendToPhone(event),
      },
      sessionEnd: {
        sessionManager: this.sessionManager,
        resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
        pendingClearInfo: this.pendingClearInfo,
        sessionIdMap: this.sessionIdMap,
        replacedSessionIds: this.replacedSessionIds,
        sendToPhone: (event) => this.sendToPhone(event),
      },
      subagent: { sessionManager: this.sessionManager },
      sessionStart: {
        sessionManager: this.sessionManager,
        resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
        pendingClearInfo: this.pendingClearInfo,
        sessionIdMap: this.sessionIdMap,
        replacedSessionIds: this.replacedSessionIds,
        sendToPhone: (event) => this.sendToPhone(event),
        isInitialDiscoveryDone: () => this.initialDiscoveryDone,
        sendSessionHistory: (id) => this.sendSessionHistory(id),
      },
      permissionDismissed: {
        sessionManager: this.sessionManager,
        resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
        untrackBlockingRequest: (id) => this.untrackBlockingRequest(id),
        sendToPhone: (event) => this.sendToPhone(event),
      },
      permissionPrompt: {
        sessionManager: this.sessionManager,
        resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
        sendPlanForReview: (sId, rId, ti, cwd) => this.sendPlanForReview(sId, rId, ti, cwd),
        buildPermissionContext: (tn, ti) => this.buildPermissionContext(tn, ti),
        getSessionName: (id) => this.getSessionName(id),
        cryptoEngine: this.cryptoEngine,
        messageSeq: this.messageSeqRef,
        sendNotificationEventToPhone: (e, et, sId, rId, wp) => this.sendNotificationEventToPhone(e, et, sId, rId, wp),
        trackBlockingRequest: (rId, sId, e, t) => this.trackBlockingRequest(rId, sId, e, t),
      },
    });
  }

  // --------------------------------------------------------------------------
  // Event Wiring: HookServer PermissionRequest -> Phone
  // --------------------------------------------------------------------------

  private wirePermissionPromptEvents(): void {
    // Folded into wireHookServerEvents via wireHookServer().
  }

  private recordCodexHookActivity(request: CodexHookRequest): string {
    const hookThreadId = request.threadId || request.sessionId;
    const requestedSessionId = isCodexSessionId(request.sessionId)
      ? request.sessionId
      : codexExternalSessionId(hookThreadId);
    const fallbackSession = this.registerCodexHookSession(request, requestedSessionId);
    const sessionId = fallbackSession?.sessionId ?? requestedSessionId;
    const existing = this.codexTerminalTargets.get(sessionId);
    const pid = request.codexPid ?? existing?.pid;
    const target = pid ? (findTerminalForPid(pid) ?? existing?.target) : existing?.target;

    this.codexTerminalTargets.set(sessionId, {
      pid,
      target,
      cwd: request.cwd || existing?.cwd,
      transcriptPath: request.transcriptPath || existing?.transcriptPath,
      turnId: request.turnId ?? existing?.turnId,
      updatedAt: Date.now(),
    });

    const session = fallbackSession ?? this.codexDiscovery.getSession(sessionId);
    if (session && !this.codexObservers.has(sessionId)) {
      const observer = new CodexObserver(session.sessionId, session.rolloutPath);
      const tracked = {
        observer,
        session,
        status: SessionStatus.READY,
        lastActivity: Date.now(),
      };
      this.codexObservers.set(sessionId, tracked);
      this.attachCodexObserverHandlers(tracked);
      observer.start();
    }

    return sessionId;
  }

  private registerCodexHookSession(request: CodexHookRequest, requestedSessionId: string): CodexSession | undefined {
    const rolloutPath = this.findCodexHookRolloutPath(request, requestedSessionId);
    if (!rolloutPath) return undefined;
    return this.codexDiscovery.registerSessionFromRollout({
      sessionId: requestedSessionId,
      threadId: request.threadId,
      rolloutPath,
      cwd: request.cwd,
    });
  }

  private findCodexHookRolloutPath(request: CodexHookRequest, requestedSessionId: string): string | undefined {
    return findCodexHookRolloutPath(request, requestedSessionId);
  }

  private nextCompletionRequestId(sessionId: string, timestamp: number = Date.now()): string {
    return this.completionRequestIdGen(sessionId, timestamp);
  }

  private sendCodexCompletion(sessionId: string, session?: CodexSession, summary?: string): void {
    sendCodexCompletionExternal(
      {
        isInitialDiscoveryDone: () => this.initialDiscoveryDone,
        getLastAssistantMessage: (id) => this.codexDiscovery.getLastAssistantMessage(id),
        nextCompletionRequestId: (id, ts) => this.nextCompletionRequestId(id, ts),
        getSessionName: (id) => this.getSessionName(id),
        sendNotificationEventToPhone: (e, et, sId, rId, wp) => this.sendNotificationEventToPhone(e, et, sId, rId, wp),
      },
      sessionId,
      session,
      summary,
    );
  }

  private resolveCodexExternalSessionId(sessionId: string): string | undefined {
    return resolveCodexExternalSessionIdHelper(sessionId, {
      hasTerminalTarget: (id) => this.codexTerminalTargets.has(id),
      hasObserver: (id) => this.codexObservers.has(id),
      hasSession: (id) => !!this.codexDiscovery.getSession(id),
    });
  }

  private resolveCodexTerminalTarget(sessionId: string, knownLiveCodex?: CodexLiveSession | null): CodexTerminalTargetEntry | undefined {
    const existing = this.codexTerminalTargets.get(sessionId);
    if (existing?.target) {
      logger.debug('daemon', 'resolveCodexTerminalTarget hit cached target', { sessionId, pid: existing.pid, target: existing.target });
      return existing;
    }
    const liveCodex = knownLiveCodex === undefined
      ? this.codexDiscovery.discoverLiveSessions().get(sessionId)
      : knownLiveCodex ?? undefined;
    const next = refreshCodexTerminalTarget(existing, liveCodex, findTerminalForPid);
    if (!liveCodex) {
      logger.debug('daemon', 'resolveCodexTerminalTarget found no live session', { sessionId, existingPid: existing?.pid, hasExistingTarget: !!existing?.target });
      return next;
    }
    logger.debug('daemon', 'resolveCodexTerminalTarget resolved live session', { sessionId, pid: liveCodex.pid, target: next?.target });
    if (next && next !== existing) this.codexTerminalTargets.set(sessionId, next);
    return next;
  }

  private attachCodexObserverHandlers(tracked: CodexObserverTracked): void {
    attachCodexObserverHandlersExternal(
      {
        isInitialDiscoveryDone: () => this.initialDiscoveryDone,
        codexStopHookDeduper: this.codexStopHookDeduper,
        sendFlattenedSessionOutput: (sId, e, at) => this.sendFlattenedSessionOutput(sId, e, at),
        sendToPhone: (e, wake, wp) => this.sendToPhone(e, wake, wp),
        sendCodexCompletion: (sId, sess, summary) => this.sendCodexCompletion(sId, sess, summary),
      },
      tracked,
    );
  }

  private getCodexCapabilities(sessionId: string): string[] {
    return getCodexCapabilities(this.codexTerminalTargets.get(sessionId));
  }

  // --------------------------------------------------------------------------
  // Session Discovery & Observation
  // --------------------------------------------------------------------------

  /**
   * Discover running CLI Claude sessions and start observing them.
   */
  private async discoverAndObserveSessions(): Promise<void> {
    return discoverAndObserveSessionsExternal({
      sessionDiscovery: this.sessionDiscovery,
      sessionManager: this.sessionManager,
      sessionIdMap: this.sessionIdMap,
      replacedSessionIds: this.replacedSessionIds,
      isInitialDiscoveryDone: () => this.initialDiscoveryDone,
      sendToPhone: (e) => this.sendToPhone(e),
      sendSessionHistory: (id) => { this.sendSessionHistory(id); },
      readSessionMap,
      getLatestSessionMapEntryForPid,
      removeSessionMapEntries,
    });
  }

  private discoverAndObserveCodexSessions(): void {
    discoverAndObserveCodexSessionsExternal({
      codexDiscovery: this.codexDiscovery,
      codexObservers: this.codexObservers,
      isInitialDiscoveryDone: () => this.initialDiscoveryDone,
      sendToPhone: (e) => this.sendToPhone(e),
      attachCodexObserverHandlers: (tracked) => this.attachCodexObserverHandlers(tracked),
    });
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
      cleanSessionMap(deadPids);
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
        await this.handleInterruptSession(command as InterruptSessionCommand);
        break;

      case 'set_permission_mode':
        await this.handleSetPermissionMode(command as SetPermissionModeCommand);
        break;

      case 'set_model':
        await this.handleSetModel(command as SetModelCommand);
        break;

      case 'get_supported_models':
        await this.handleGetSupportedModels(command as GetSupportedModelsCommand);
        break;

      case 'get_context_usage':
        await this.handleGetContextUsage(command as GetContextUsageCommand);
        break;
      case 'get_supported_commands':
        await this.handleGetSupportedCommands(command as GetSupportedCommandsCommand);
        break;
      case 'get_supported_agents':
        await this.handleGetSupportedAgents(command as GetSupportedAgentsCommand);
        break;
      case 'get_mcp_server_status':
        await this.handleGetMcpServerStatus(command as GetMcpServerStatusCommand);
        break;
      case 'rewind_session':
        await this.handleRewindSession(command as RewindSessionCommand);
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

      case 'notification_delivery_ack':
        this.handleNotificationDeliveryAck(command);
        break;

      case 'verify_history':
        this.handleVerifyHistory(command);
        break;

      case 'sync_request':
        this.handleSyncRequest(command);
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
    handleNewSessionExternal(this.commandContext(), command);
  }

  private handleResumeSession(command: ResumeSessionCommand): void {
    handleResumeSessionExternal(this.commandContext(), command);
  }

  private handleSendMessage(command: SendMessageCommand): Promise<void> {
    return handleSendMessageExternal(this.commandContext(), this.sendMessageDeps(), command);
  }

  private sendMessageDeps(): SendMessageDeps {
    return {
      resolveCodexTerminalTarget: (id) => this.resolveCodexTerminalTarget(id),
      codexObservers: this.codexObservers,
      codexInjectedMessages: this.codexInjectedMessages,
      sendTerminalMessage: (target, message) => terminalSendMessage(target as TerminalTarget, message),
      getRunningCliSessions: () => this.sessionDiscovery.getRunningCliSessions(),
      discoverSessions: () => this.sessionDiscovery.discoverSessions(),
      sessionIdMap: this.sessionIdMap,
    };
  }

  private handlePermissionResponse(command: PermissionResponseCommand): void {
    handlePermissionResponseExternal(
      this.commandContext(),
      this.hookServer,
      this.cryptoEngine,
      this.responseDeps(),
      command,
    );
  }

  private handleQuestionResponse(command: QuestionResponseCommand): void {
    handleQuestionResponseExternal(this.commandContext(), this.hookServer, this.responseDeps(), command);
  }

  private responseDeps(): ResponseDeps {
    return {
      untrackBlockingRequest: (requestId) => this.untrackBlockingRequest(requestId),
      clearNotificationDelivery: (eventType, sessionId, requestId) =>
        this.clearNotificationDelivery(eventType, sessionId, requestId),
    };
  }

  private async handleKillSession(command: KillSessionCommand): Promise<void> {
    return handleKillSessionExternal(this.commandContext(), this.codexLifecycleDeps(), command);
  }

  private async handleInterruptSession(command: InterruptSessionCommand): Promise<void> {
    return handleInterruptSessionExternal(this.commandContext(), this.codexLifecycleDeps(), command);
  }

  private async handleSetPermissionMode(command: SetPermissionModeCommand): Promise<void> {
    return handleSetPermissionModeExternal(this.commandContext(), command);
  }

  private async handleSetModel(command: SetModelCommand): Promise<void> {
    return handleSetModelExternal(this.commandContext(), command);
  }

  private async handleGetSupportedModels(command: GetSupportedModelsCommand): Promise<void> {
    return handleGetSupportedModelsExternal(this.commandContext(), command);
  }

  private async handleGetContextUsage(command: GetContextUsageCommand): Promise<void> {
    return handleGetContextUsageExternal(this.commandContext(), command);
  }

  private async handleGetSupportedCommands(command: GetSupportedCommandsCommand): Promise<void> {
    return handleGetSupportedCommandsExternal(this.commandContext(), command);
  }

  private async handleGetSupportedAgents(command: GetSupportedAgentsCommand): Promise<void> {
    return handleGetSupportedAgentsExternal(this.commandContext(), command);
  }

  private async handleGetMcpServerStatus(command: GetMcpServerStatusCommand): Promise<void> {
    return handleGetMcpServerStatusExternal(this.commandContext(), command);
  }

  private async handleRewindSession(command: RewindSessionCommand): Promise<void> {
    return handleRewindSessionExternal(this.commandContext(), command);
  }

  private handleListSessions(command: ListSessionsCommand): Promise<void> {
    return handleListSessionsExternal(this.commandContext(), this.listSessionsDeps(), command);
  }

  private listSessionsDeps(): ListSessionsDeps {
    return {
      getCachedSessions: () => this.sessionDiscovery.getCachedSessions(),
      discoverSessions: () => this.sessionDiscovery.discoverSessions(),
      getRunningAllSessions: () => this.sessionDiscovery.getRunningAllSessions(),
      getSessionHistory: (id, options) => this.sessionDiscovery.getSessionHistory(id, options),
      discoverCodexSessions: () => this.codexDiscovery.discoverSessions(),
      discoverCodexLiveSessions: (sessions) => this.codexDiscovery.discoverLiveSessions(sessions),
      getCodexHistory: (id, options) => this.codexDiscovery.getSessionHistory(id, options),
      resolveCodexTerminalTarget: (id, liveCodex) => this.resolveCodexTerminalTarget(id, liveCodex),
      getCodexCapabilities: (id) => this.getCodexCapabilities(id),
      getCodexObserver: (id) => {
        const o = this.codexObservers.get(id);
        return o ? { status: o.status, lastActivity: o.lastActivity } : undefined;
      },
      getAllTrackedSessions: () => this.sessionManager.getAllSessions(),
      pendingBlockingRequests: this.pendingBlockingRequests,
      replacedSessionIds: this.replacedSessionIds,
      claudeAgentVersion: this.claudeAgentVersion,
    };
  }

  private async handleReadFile(command: ReadFileCommand): Promise<void> {
    return handleReadFileExternal(this.commandContext(), command);
  }

  private handleEmergencyAbort(command: EmergencyAbortCommand): void {
    handleEmergencyAbortExternal(this.commandContext(), this.cryptoEngine, command);
  }

  private handleGetHistory(command: GetHistoryCommand): void {
    handleGetHistoryExternal(this.commandContext(), command);
  }

  private handleSessionOutputAck(command: SessionOutputAckCommand): void {
    handleSessionOutputAckExternal(this.lastAckedSeqs, command);
  }

  private handleNotificationDeliveryAck(command: NotificationDeliveryAckCommand): void {
    handleNotificationDeliveryAckExternal(this.pendingNotificationDeliveries, command);
  }

  private handleVerifyHistory(command: VerifyHistoryCommand): void {
    const deps: VerifyHistoryDeps = {
      getSdkHistory: (id, opts) => this.sessionDiscovery.getSessionHistory(id, opts),
      getCodexHistory: (id, opts) => this.codexDiscovery.getSessionHistory(id, opts),
      phonePreferences: this.phonePreferences,
    };
    handleVerifyHistoryExternal(this.commandContext(), deps, command);
  }

  private handleSetPreferences(command: SetPreferencesCommand): void {
    handleSetPreferencesExternal(this.phonePreferences, command);
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private sendToPhone(event: PcEvent, wake = false, wakePayload?: WakeBlobPayload, forceWake = false): void {
    this.bookkeeping.sendToPhone(event, wake, wakePayload, forceWake);
  }

  private sendNotificationEventToPhone(
    event: PcEvent,
    eventType: NotificationDeliveryEventType,
    sessionId: string,
    requestId: string,
    wakePayload: WakeBlobPayload,
  ): void {
    this.bookkeeping.sendNotificationEventToPhone(event, eventType, sessionId, requestId, wakePayload);
  }

  private trackNotificationDelivery(
    eventType: NotificationDeliveryEventType,
    sessionId: string,
    requestId: string,
    event: PcEvent,
    wakePayload: WakeBlobPayload,
  ): void {
    this.bookkeeping.trackNotificationDelivery(eventType, sessionId, requestId, event, wakePayload);
  }

  private notificationDeliveryKey(eventType: string, sessionId: string, requestId: string): string {
    return this.bookkeeping.notificationDeliveryKey(eventType, sessionId, requestId);
  }

  private resendTrackedBlockingEvent(
    eventType: 'permission_request' | 'user_question' | 'plan_review',
    sessionId: string,
    requestId: string,
    event: PcEvent,
    forceWake = false,
  ): void {
    this.bookkeeping.resendTrackedBlockingEvent(eventType, sessionId, requestId, event, forceWake);
  }

  private clearNotificationDelivery(eventType: string, sessionId: string, requestId: string): void {
    this.bookkeeping.clearNotificationDelivery(eventType, sessionId, requestId);
  }

  private clearNotificationDeliveriesForSession(sessionId: string): void {
    this.bookkeeping.clearNotificationDeliveriesForSession(sessionId);
  }

  private retryPendingNotificationDeliveries(): void {
    this.bookkeeping.retryPendingNotificationDeliveries();
  }

  private sendExpiredPendingSystemMessage(
    sessionId: string,
    requestId: string,
    toolName: string,
    actionType: 'permission_request' | 'user_question' | 'plan_review',
    entry?: { expiredSystemMessageSent?: boolean },
  ): void {
    this.bookkeeping.sendExpiredPendingSystemMessage(sessionId, requestId, toolName, actionType, entry);
  }

  private sendFlattenedSessionOutput(sessionId: string, agentEvent: ClaudeEvent, agentType: AgentType): void {
    sendFlattenedSessionOutputExternal(
      { codexInjectedMessages: this.codexInjectedMessages, sendToPhone: (e) => this.sendToPhone(e) },
      sessionId,
      agentEvent,
      agentType,
    );
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
   * Build the minimum dependency surface a command handler needs from this
   * daemon. Reused across every extracted handler module under
   * src/commands/handlers/. Cheap to construct (just method references).
   */
  private commandContext(): CommandContext {
    return {
      sendToPhone: (event, wake) => this.sendToPhone(event, wake),
      sendError: (requestId, message, code) => this.sendError(requestId, message, code),
      resolveInternalSessionId: (id) => this.resolveInternalSessionId(id),
      resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
      sendSessionHistory: (id, options) => this.sendSessionHistory(id, options),
      sessionManager: this.sessionManager,
      sessionIdMap: this.sessionIdMap,
      pendingSessionRequests: this.pendingSessionRequests,
    };
  }

  private codexLifecycleDeps(): CodexLifecycleDeps {
    return {
      codexObservers: this.codexObservers,
      resolveCodexTerminalTarget: (id) => this.resolveCodexTerminalTarget(id),
      sendTerminalInterrupt: (target) => terminalSendInterrupt(target as TerminalTarget),
    };
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
    handlePeerHelloExternal(this.peers, hello);
  }

  /**
   * True if the most recent peer_hello announced this capability.
   * Returns false if no peer_hello has been received yet.
   */
  hasPeerCapability(name: string): boolean {
    return this.peers.has(name);
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
    this.bookkeeping.trackBlockingRequest(requestId, sessionId, event, type);
  }

  /**
   * Stop tracking a blocking request (phone responded or it was dismissed).
   */
  private untrackBlockingRequest(requestId: string): void {
    this.bookkeeping.untrackBlockingRequest(requestId);
  }

  /**
   * Retry pending blocking requests that haven't received a response
   * within BLOCKING_RETRY_INTERVAL_MS.
   */
  private retryPendingBlockingRequests(): void {
    this.bookkeeping.retryPendingBlockingRequests();
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
    return buildPermissionContextExternal(toolName, toolInput);
  }

  private findWorkingDirForSession(claudeSessionId: string): string {
    return findWorkingDirForSessionExternal(
      {
        sessionDiscovery: this.sessionDiscovery,
        defaultWorkingDirectory: this.config.defaultWorkingDirectory,
      },
      claudeSessionId,
    );
  }

  private isPlanModeTool(toolName: string, toolInput: Record<string, unknown>): boolean {
    return isPlanModeToolExternal(toolName, toolInput);
  }

  private sendPlanForReview(
    sessionId: string,
    requestId: string,
    toolInput: Record<string, unknown>,
    cwd: string,
  ): void {
    sendPlanForReviewExternal(
      {
        getSessionName: (id) => this.getSessionName(id),
        sendNotificationEventToPhone: (e, et, sId, rId, wp) => this.sendNotificationEventToPhone(e, et, sId, rId, wp),
        trackBlockingRequest: (rId, sId, e, et) => this.trackBlockingRequest(rId, sId, e, et),
      },
      sessionId,
      requestId,
      toolInput,
      cwd,
    );
  }

  /**
   * Read session history from disk and send it to the phone.
   * Supports pagination (offset/limit) and incremental fetch (since).
   * Returns the tail seq actually sent (for callers that need to report
   * it back, e.g. sync_complete.delivered).
   */
  private sendSessionHistory(
    claudeSessionId: string,
    options?: { since?: string; sinceSeq?: number; offset?: number; limit?: number },
  ): number | undefined {
    return sendSessionHistoryExternal(
      {
        sessionDiscovery: this.sessionDiscovery,
        codexDiscovery: this.codexDiscovery,
        phonePreferences: this.phonePreferences,
        sendToPhone: (e) => this.sendToPhone(e),
      },
      claudeSessionId,
      options,
    );
  }

  /**
   * Handle sync_request from the phone (issue #160). For each session known
   * to the daemon, replay missed history (everything past the phone's
   * cursor, or the full history if the phone never saw it). Then emit a
   * sync_complete terminator so the phone can commit its side-staged batch
   * in one transaction.
   *
   * Ordering: sendSessionHistory is synchronous and sendToPhone serializes
   * to the WS, so emitting sync_complete after the loop guarantees it
   * arrives last on the wire.
   *
   * Gated by PEER_CAPABILITIES.SYNC_BOUNDARY (announced separately once
   * the protocol package's CURRENT_PEER_CAPABILITIES is updated).
   */
  private handleSyncRequest(command: SyncRequestCommand): void {
    handleSyncRequestExternal(this.commandContext(), command);
  }
}
