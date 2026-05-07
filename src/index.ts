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
import { truncateUtf8 } from './utils/truncate-utf8.js';
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
  consumeInjectedMessage,
  type CodexTerminalTargetEntry,
} from './codex/codex-handler.js';
import {
  PeerCapabilities,
  NOTIFICATION_DELIVERY_ACK_TIMEOUT_MS,
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
  notificationDeliveryKey as buildNotificationDeliveryKey,
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
  registerPermissionRequestPassthrough,
  registerToolResultHandler,
  registerErrorHandler,
  registerSubagentStartHandler,
  registerSubagentStopHandler,
  registerApiSessionsHandler,
  registerApiStatusHandler,
} from './wiring/hook-handlers.js';
import {
  registerPermissionExpiredHandler,
  registerCodexSessionStartHandler,
  registerCodexUserPromptSubmitHandler,
  registerCodexStopHandler,
  registerCodexPermissionRequestHandler,
  type MessageSeqRef,
} from './wiring/hook-handlers-codex.js';
import {
  registerSessionStopHandler,
  registerSessionStopFailureHandler,
  registerSessionEndHandler,
  registerSessionStartHandler,
  registerPermissionDismissedHandler,
  registerPermissionPromptHandler,
} from './wiring/hook-handlers-lifecycle.js';
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
  SessionOutputEvent,
  SessionEndedEvent,
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
  HOOK_HOLD_TIMEOUT_SECONDS,
  DAEMON_DEFAULT_PORT,
  SessionStatus,
  HOOK_SERVER_PORT,
  WIRE_VERSION_CURRENT,
  CURRENT_PEER_CAPABILITIES,
  PEER_CAPABILITIES,
  BLOCKING_RETRY_INTERVAL_MS,
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
  private completionRequestCounter = 0;
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
    registerPermissionRequestPassthrough(this.hookServer);
    registerToolResultHandler(this.hookServer, {
      prefs: this.phonePreferences,
      sessionManager: this.sessionManager,
      resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
      sendToPhone: (event) => this.sendToPhone(event),
    });
    registerErrorHandler(this.hookServer, {
      restartHookServer: () => this.restartHookServer(),
    });

    registerPermissionExpiredHandler(this.hookServer, {
      sessionManager: this.sessionManager,
      resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
      resolveCodexExternalSessionId: (id) => this.resolveCodexExternalSessionId(id),
      sendToPhone: (event) => this.sendToPhone(event),
      pendingBlockingRequests: this.pendingBlockingRequests,
      sendExpiredPendingSystemMessage: (sId, rId, tn, at, e) => this.sendExpiredPendingSystemMessage(sId, rId, tn, at, e),
      clearNotificationDelivery: (et, sId, rId) => this.clearNotificationDelivery(et, sId, rId),
    });

    registerCodexSessionStartHandler(this.hookServer, {
      codexObservers: this.codexObservers,
      recordCodexHookActivity: (req) => this.recordCodexHookActivity(req),
      sendToPhone: (event) => this.sendToPhone(event),
      isInitialDiscoveryDone: () => this.initialDiscoveryDone,
      getCodexCapabilities: (id) => this.getCodexCapabilities(id),
    });

    registerCodexUserPromptSubmitHandler(this.hookServer, {
      codexObservers: this.codexObservers,
      recordCodexHookActivity: (req) => this.recordCodexHookActivity(req),
      sendToPhone: (event) => this.sendToPhone(event),
    });

    registerCodexStopHandler(this.hookServer, {
      codexObservers: this.codexObservers,
      recordCodexHookActivity: (req) => this.recordCodexHookActivity(req),
      sendToPhone: (event) => this.sendToPhone(event),
      codexStopHookDeduper: this.codexStopHookDeduper,
      sendCodexCompletion: (sId, sess, summary) => this.sendCodexCompletion(sId, sess, summary),
    });

    registerCodexPermissionRequestHandler(this.hookServer, {
      recordCodexHookActivity: (req) => this.recordCodexHookActivity(req),
      cryptoEngine: this.cryptoEngine,
      messageSeq: this.messageSeqRef,
      buildPermissionContext: (tn, ti) => this.buildPermissionContext(tn, ti),
      getSessionName: (id) => this.getSessionName(id),
      sendNotificationEventToPhone: (e, et, sId, rId, wp) => this.sendNotificationEventToPhone(e, et, sId, rId, wp),
      trackBlockingRequest: (rId, sId, e, t) => this.trackBlockingRequest(rId, sId, e, t),
    });

    registerApiSessionsHandler(this.hookServer, { sessionManager: this.sessionManager });
    registerApiStatusHandler(this.hookServer, {
      sessionManager: this.sessionManager,
      getRelayClient: () => this.relayClient,
    });

    // Stop hook: Claude finished a turn — update session status to ready
    registerSessionStopHandler(this.hookServer, {
      sessionManager: this.sessionManager,
      resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
      pendingBlockingRequests: this.pendingBlockingRequests,
      clearNotificationDelivery: (et, sId, rId) => this.clearNotificationDelivery(et, sId, rId),
      nextCompletionRequestId: (sId, ts) => this.nextCompletionRequestId(sId, ts),
      sendNotificationEventToPhone: (e, et, sId, rId, wp) => this.sendNotificationEventToPhone(e, et, sId, rId, wp),
      sendToPhone: (event) => this.sendToPhone(event),
      prefs: this.phonePreferences,
    });

    // StopFailure hook: Claude's turn ended via API error. Same cleanup as
    // Stop, but log the error and skip the "Session Complete" notification.
    registerSessionStopFailureHandler(this.hookServer, {
      sessionManager: this.sessionManager,
      resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
      pendingBlockingRequests: this.pendingBlockingRequests,
      sendToPhone: (event) => this.sendToPhone(event),
    });

    // SessionEnd hook: fired when /clear runs (with the OLD session ID)
    registerSessionEndHandler(this.hookServer, {
      sessionManager: this.sessionManager,
      resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
      pendingClearInfo: this.pendingClearInfo,
      sessionIdMap: this.sessionIdMap,
      replacedSessionIds: this.replacedSessionIds,
      sendToPhone: (event) => this.sendToPhone(event),
    });

    // SubagentStop hook: fired when a Task-dispatched subagent finishes.
    // Forward to the matching SessionObserver so its SubagentObserver can
    // mark the agent done immediately (instead of waiting for activity timeout).
    registerSubagentStopHandler(this.hookServer, { sessionManager: this.sessionManager });
    registerSubagentStartHandler(this.hookServer, { sessionManager: this.sessionManager });

    // SessionStart hook: fired after /clear with the NEW session ID
    registerSessionStartHandler(this.hookServer, {
      sessionManager: this.sessionManager,
      resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
      pendingClearInfo: this.pendingClearInfo,
      sessionIdMap: this.sessionIdMap,
      replacedSessionIds: this.replacedSessionIds,
      sendToPhone: (event) => this.sendToPhone(event),
      isInitialDiscoveryDone: () => this.initialDiscoveryDone,
      sendSessionHistory: (id) => this.sendSessionHistory(id),
    });

    // When a PermissionRequest hook connection closes (terminal won the race),
    // tell the phone to dismiss the permission request.
    registerPermissionDismissedHandler(this.hookServer, {
      sessionManager: this.sessionManager,
      resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
      untrackBlockingRequest: (id) => this.untrackBlockingRequest(id),
      sendToPhone: (event) => this.sendToPhone(event),
    });
  }

  // --------------------------------------------------------------------------
  // Event Wiring: HookServer PermissionRequest -> Phone
  // --------------------------------------------------------------------------

  private wirePermissionPromptEvents(): void {
    registerPermissionPromptHandler(this.hookServer, {
      sessionManager: this.sessionManager,
      resolveExternalSessionId: (id) => this.resolveExternalSessionId(id),
      sendPlanForReview: (sId, rId, ti, cwd) => this.sendPlanForReview(sId, rId, ti, cwd),
      buildPermissionContext: (tn, ti) => this.buildPermissionContext(tn, ti),
      getSessionName: (id) => this.getSessionName(id),
      cryptoEngine: this.cryptoEngine,
      messageSeq: this.messageSeqRef,
      sendNotificationEventToPhone: (e, et, sId, rId, wp) => this.sendNotificationEventToPhone(e, et, sId, rId, wp),
      trackBlockingRequest: (rId, sId, e, t) => this.trackBlockingRequest(rId, sId, e, t),
    });
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
    this.completionRequestCounter = (this.completionRequestCounter + 1) % Number.MAX_SAFE_INTEGER;
    return `completion_${sessionId}_${timestamp}_${this.completionRequestCounter}`;
  }

  private sendCodexCompletion(sessionId: string, session?: CodexSession, summary?: string): void {
    if (!this.initialDiscoveryDone) return;
    const body = summary?.trim() || this.codexDiscovery.getLastAssistantMessage(sessionId) || 'Codex turn finished';
    const completionRequestId = this.nextCompletionRequestId(sessionId);
    this.sendNotificationEventToPhone({
      type: 'session_status',
      session_id: sessionId,
      status: SessionStatus.READY,
      is_completion: true,
      completion_request_id: completionRequestId,
      completion_body: body,
    } as unknown as PcEvent, 'session_completed', sessionId, completionRequestId, {
      type: 'session_completed',
      session_name: session?.title ?? (session?.cwd ? path.basename(session.cwd) : this.getSessionName(sessionId)),
      body: truncateUtf8(body, 256),
      sound: 'completion.caf',
      category: 'SESSION_COMPLETED',
      session_id: sessionId,
      request_id: completionRequestId,
    });
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

  private attachCodexObserverHandlers(tracked: { observer: CodexObserver; session: CodexSession; status: SessionStatus; lastActivity: number }): void {
    const { observer, session } = tracked;
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
    observer.on('completed', (summary?: string) => {
      tracked.status = SessionStatus.READY;
      tracked.lastActivity = Date.now();
      if (!this.initialDiscoveryDone) return;
      if (this.codexStopHookDeduper.consume(session.sessionId)) return;
      this.sendCodexCompletion(session.sessionId, session, summary);
    });
    observer.on('error', (err: Error) => {
      tracked.status = SessionStatus.ERROR;
      tracked.lastActivity = Date.now();
      logger.warn('codex-observer', `Observer error: ${err.message}`, { sessionId: session.sessionId });
      if (!this.initialDiscoveryDone) return;
      this.sendToPhone({
        type: 'session_status',
        session_id: session.sessionId,
        status: SessionStatus.ERROR,
      } as unknown as PcEvent, true, {
        type: 'session_error',
        session_name: session.title ?? path.basename(session.cwd),
        body: truncateUtf8(err.message || 'Codex turn failed', 256),
        sound: 'default',
        category: 'SESSION_ERROR',
        session_id: session.sessionId,
      });
    });
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
        const mapEntry = getLatestSessionMapEntryForPid(pidInfo.pid);
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
          const mapped = readSessionMap();
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
            removeSessionMapEntries(staleSids);
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
        this.attachCodexObserverHandlers(tracked);
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
    if ((event as { type?: string })?.type === 'session_list') {
      const sl = event as unknown as { sessions: Array<{ session_id: string; project_name?: string; status?: string }> };
      logger.info('daemon', `[debug] session_list -> phone: ${sl.sessions.length} sessions: ${sl.sessions.map(s => `${s.session_id.slice(0,12)}(${s.project_name ?? '?'},${s.status ?? '?'})`).join(' | ')}`);
    }

    const mode = this.config.connectionMode ?? 'relay';

    if (mode === 'lan' && this.lanServer) {
      this.lanServer.send(event);
    } else if (this.relayClient) {
      // Check for rekey before sending
      if (this.cryptoEngine.needsRekey()) {
        this.cryptoEngine.resetRekeyCounters();
      }
      this.relayClient.send(event, wake, wakePayload, forceWake);
    }
  }

  private sendNotificationEventToPhone(
    event: PcEvent,
    eventType: NotificationDeliveryEventType,
    sessionId: string,
    requestId: string,
    wakePayload: WakeBlobPayload,
  ): void {
    const phoneOnline = this.relayClient?.getPhonePeerOnline() === true;
    logger.debug('daemon', 'notification emit', { eventType, sessionId, requestId, phoneOnline });
    this.sendToPhone(event, true, wakePayload);
    // Only track for ack-fallback when phone was online at emit time. If phone
    // was offline, the relay already routed to APNs — no second push needed.
    if (phoneOnline) {
      this.trackNotificationDelivery(eventType, sessionId, requestId, event, wakePayload);
    }
  }

  private trackNotificationDelivery(
    eventType: NotificationDeliveryEventType,
    sessionId: string,
    requestId: string,
    event: PcEvent,
    wakePayload: WakeBlobPayload,
  ): void {
    if (!this.hasPeerCapability(PEER_CAPABILITIES.NOTIFICATION_DELIVERY_ACKS)) return;
    const key = this.notificationDeliveryKey(eventType, sessionId, requestId);
    this.pendingNotificationDeliveries.set(key, {
      requestId,
      sessionId,
      eventType,
      event,
      wakePayload,
      sentAt: Date.now(),
      attempts: 1,
    });
    logger.debug('daemon', 'Tracking notification delivery', { eventType, sessionId, requestId });
  }

  private notificationDeliveryKey(eventType: string, sessionId: string, requestId: string): string {
    return buildNotificationDeliveryKey(eventType, sessionId, requestId);
  }

  private resendTrackedBlockingEvent(
    eventType: 'permission_request' | 'user_question' | 'plan_review',
    sessionId: string,
    requestId: string,
    event: PcEvent,
    forceWake = false,
  ): void {
    const pending = this.pendingNotificationDeliveries.get(this.notificationDeliveryKey(eventType, sessionId, requestId));
    if (pending?.wakePayload) {
      this.sendToPhone(event, true, pending.wakePayload, forceWake);
    } else {
      this.sendToPhone(event);
    }
  }

  private clearNotificationDelivery(eventType: string, sessionId: string, requestId: string): void {
    this.pendingNotificationDeliveries.delete(this.notificationDeliveryKey(eventType, sessionId, requestId));
  }

  private clearNotificationDeliveriesForSession(sessionId: string): void {
    for (const [key, entry] of this.pendingNotificationDeliveries) {
      if (entry.sessionId === sessionId) {
        this.pendingNotificationDeliveries.delete(key);
      }
    }
  }

  private retryPendingNotificationDeliveries(): void {
    if (!this.hasPeerCapability(PEER_CAPABILITIES.NOTIFICATION_DELIVERY_ACKS)) return;
    const now = Date.now();
    for (const [key, entry] of this.pendingNotificationDeliveries) {
      if (now - entry.sentAt < NOTIFICATION_DELIVERY_ACK_TIMEOUT_MS) continue;
      // Phone was online at emit but didn't ack within the window — fall back
      // to one forceWake APNs and stop. No further retries; APNs is trusted.
      this.pendingNotificationDeliveries.delete(key);
      logger.warn('daemon', 'notification ack timeout — sending forceWake APNs fallback', {
        eventType: entry.eventType,
        sessionId: entry.sessionId,
        requestId: entry.requestId,
        elapsedMs: now - entry.sentAt,
      });
      this.sendToPhone(entry.event, true, entry.wakePayload, true);
    }
  }

  private sendExpiredPendingSystemMessage(
    sessionId: string,
    requestId: string,
    toolName: string,
    actionType: 'permission_request' | 'user_question' | 'plan_review',
    entry?: { expiredSystemMessageSent?: boolean },
  ): void {
    if (entry?.expiredSystemMessageSent) return;
    const actionLabel = actionType === 'user_question'
      ? 'question'
      : actionType === 'plan_review'
      ? 'plan review'
      : 'permission request';
    const content = "This " + actionLabel + " has expired. Handle it in the terminal, or interrupt this session from the app and continue it to trigger a new request.";
    this.sendToPhone({
      type: 'session_output',
      session_id: sessionId,
      output_type: 'system',
      content,
      timestamp: Date.now(),
      request_id: requestId,
      tool_name: toolName,
    } as unknown as PcEvent);
    if (entry) entry.expiredSystemMessageSent = true;
  }

  private sendFlattenedSessionOutput(sessionId: string, agentEvent: ClaudeEvent, agentType: AgentType): void {
    if (agentType === 'codex' && agentEvent.type === 'user_message') {
      const injected = this.codexInjectedMessages.get(sessionId);
      if (consumeInjectedMessage(injected, agentEvent.message)) {
        return;
      }
    }

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
        if (agentEvent.sdkUuid) flat.sdk_uuid = agentEvent.sdkUuid;
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
        this.clearNotificationDelivery(entry.type, entry.sessionId, requestId);
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

    this.sendNotificationEventToPhone(flat as unknown as PcEvent, 'plan_review', sessionId, requestId, {
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
   * Returns the tail seq actually sent (for callers that need to report
   * it back, e.g. sync_complete.delivered).
   */
  private sendSessionHistory(
    claudeSessionId: string,
    options?: { since?: string; sinceSeq?: number; offset?: number; limit?: number },
  ): number | undefined {
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
    return result.tailSeq;
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
