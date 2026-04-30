// Agent Pocket — Shared Protocol Types
// All messages exchanged between iOS App ↔ Relay Server ↔ PC Daemon

// ============================================================================
// Connection Modes
// ============================================================================

export type ConnectionMode = 'relay' | 'lan';

export type AgentType = 'claude_code' | 'codex' | 'gemini' | 'unknown';

// ============================================================================
// Enums
// ============================================================================

export enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export enum SessionStatus {
  STARTING = 'starting',
  RUNNING = 'running',
  READY = 'ready',
  PENDING_ACTIONS = 'pending_actions',
  HISTORY = 'history',
  ERROR = 'error',
}

export enum PermissionDecision {
  APPROVE = 'approve',
  DENY = 'deny',
  ALWAYS_ALLOW = 'always_allow',
  APPROVE_MANUAL = 'approve_manual',
}

// ============================================================================
// NDJSON Event Types (Claude Code stdout)
// ============================================================================

export interface ThinkingEvent {
  type: 'thinking';
  thinking: string;
}

export interface AssistantMessageEvent {
  type: 'assistant_message';
  message: string;
}

export interface ToolUseEvent {
  type: 'tool_use';
  tool_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: 'tool_result';
  tool_id: string;
  status: 'success' | 'error';
  output: string;
}

export interface PermissionRequestFromClaude {
  type: 'permission_request';
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface UserMessageEvent {
  type: 'user_message';
  message: string;
}

export interface SystemMessageEvent {
  type: 'system_message';
  message: string;
}

export interface SubagentEvent {
  type: 'subagent_event';
  agent_id: string;
  agent_name: string;         // description from meta.json
  agent_type: string;         // e.g. "Explore", "code", etc.
  /// Omitted for status-only events (e.g. agent finished with no new content).
  inner_event?: ThinkingEvent | AssistantMessageEvent | ToolUseEvent | ToolResultEvent;
  tool_use_count?: number;
  token_count?: number;
  agent_status?: 'running' | 'idle' | 'done';
}

export type ClaudeEvent =
  | ThinkingEvent
  | AssistantMessageEvent
  | ToolUseEvent
  | ToolResultEvent
  | PermissionRequestFromClaude
  | UserMessageEvent
  | SystemMessageEvent
  | SubagentEvent;

// ============================================================================
// Phone → PC Commands
// ============================================================================

export interface NewSessionCommand {
  type: 'new_session';
  request_id: string;
  config: {
    working_directory?: string;
    model?: string;
    system_prompt?: string;
    allowed_tools?: string[];
    initial_message?: string;
  };
}

export interface ResumeSessionCommand {
  type: 'resume_session';
  request_id: string;
  session_id: string;
}

export interface SendMessageCommand {
  type: 'send_message';
  session_id: string;
  message: string;
  /**
   * Phone-generated UUID for this user message. The daemon echoes it back
   * in MessageAckEvent so the phone can transition the local message
   * state machine from sending → delivered → sent (or → failed).
   * Optional for backward compat with older phone clients.
   */
  client_message_id?: string;
}

export interface PermissionResponseCommand {
  type: 'permission_response';
  session_id: string;
  request_id: string;
  decision: PermissionDecision;
  phone_signature: string; // Ed25519 signature
  seq: number;
  timestamp: number;
}

export interface QuestionResponseCommand {
  type: 'question_response';
  session_id: string;
  request_id: string; // tool_use_id of the AskUserQuestion
  answers: Record<string, string>; // question text -> selected answer label
}

export interface KillSessionCommand {
  type: 'kill_session';
  session_id: string;
}

export interface InterruptSessionCommand {
  type: 'interrupt_session';
  session_id: string;
}

export interface ListSessionsCommand {
  type: 'list_sessions';
  request_id: string;
  offset?: number;   // default 0
  limit?: number;    // default 20
}

export interface ReadFileCommand {
  type: 'read_file';
  path: string;
  request_id: string;
}

export interface EmergencyAbortCommand {
  type: 'emergency_abort';
  phone_signature: string;
}

export interface GetHistoryCommand {
  type: 'get_history';
  session_id: string;
  /** ISO timestamp — only return messages after this time. */
  since?: string;
  /**
   * Only return messages with session_seq strictly greater than this.
   * When present, takes precedence over `since` for gap-fill on reconnect.
   */
  since_seq?: number;
  /** Offset from the end of the message array (0 = most recent page). */
  offset?: number;
  /** Number of messages to return per page (default 30). */
  limit?: number;
}

export interface SetPreferencesCommand {
  type: 'set_preferences';
  preferences: {
    show_tool_use?: boolean;
    show_completion_metrics?: boolean;
  };
}

/**
 * Phone acks that it has received and stored every session_output up to
 * `last_seq` for `session_id`. Best-effort — daemon uses it for telemetry
 * and to avoid re-sending old buffered events when the phone reconnects.
 */
export interface SessionOutputAckCommand {
  type: 'session_output_ack';
  session_id: string;
  last_seq: number;
}

/**
 * Phone asks the daemon to confirm its local history matches the daemon's
 * source-of-truth. Daemon responds with HistoryDivergenceEvent only if
 * something is off (silence = match).
 */
export interface VerifyHistoryCommand {
  type: 'verify_history';
  session_id: string;
  /** Number of messages the phone currently has for this session. */
  count: number;
  /** Phone's in-memory message cap. When count == max_count, count divergence is expected. */
  max_count?: number;
  /** session_seq of the phone's first known message (lowest seq). */
  head_seq?: number;
  /** session_seq of the phone's last known message (highest seq). */
  tail_seq?: number;
}

export type PhoneCommand =
  | NewSessionCommand
  | ResumeSessionCommand
  | SendMessageCommand
  | PermissionResponseCommand
  | QuestionResponseCommand
  | KillSessionCommand
  | InterruptSessionCommand
  | ListSessionsCommand
  | ReadFileCommand
  | EmergencyAbortCommand
  | GetHistoryCommand
  | SetPreferencesCommand
  | SessionOutputAckCommand
  | VerifyHistoryCommand;

// ============================================================================
// PC → Phone Events
// ============================================================================

export interface SessionStartedEvent {
  type: 'session_started';
  session_id: string;
  request_id: string;
  working_directory: string;
  project_name?: string;
  agent_type?: AgentType;
  agent_display_name?: string;
  agent_version?: string;
  capabilities?: string[];
}

export interface SessionOutputEvent {
  type: 'session_output';
  session_id: string;
  event: ClaudeEvent;
  timestamp: number;
  agent_type?: AgentType;
  /**
   * Per-session monotonically increasing sequence number assigned by the
   * daemon when the event is first emitted. Used by the phone to detect
   * gaps and request fill via get_history{since_seq}. Optional only for
   * back-compat with older daemons; current daemons always set it.
   */
  session_seq?: number;
}

export interface SessionEndedEvent {
  type: 'session_ended';
  session_id: string;
  exit_code: number;
  end_reason?: string;
}

export interface SessionStatusEvent {
  type: 'session_status';
  session_id: string;
  status: SessionStatus;
  action_type?: 'permission_request' | 'user_question' | 'plan_review';
  is_completion?: boolean;
  completion_request_id?: string;
  completion_body?: string;
  completion_subtitle?: string;
}

export interface PermissionRequestEvent {
  type: 'permission_request';
  session_id: string;
  agent_type?: AgentType;
  request_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  risk_level: RiskLevel;
  context: string;
  pc_signature: string; // Ed25519 signature
  seq: number;
  timestamp: number;
  ttl: number; // seconds, default 30
  has_always_allow?: boolean; // whether the terminal shows "Always Allow" option
}

export interface PermissionDismissedEvent {
  type: 'permission_dismissed';
  request_id: string;
  tool_name: string;
}

export interface SessionListEvent {
  type: 'session_list';
  request_id: string;
  sessions: SessionInfo[];
  total_count: number;
  offset: number;
  has_more: boolean;
}

export interface SessionInfo {
  session_id: string;
  agent_type?: AgentType;
  agent_display_name?: string;
  agent_version?: string;
  capabilities?: string[];
  status: SessionStatus;
  working_directory: string;
  project_name: string;
  last_activity: number;
  summary?: string;
  entrypoint?: string;
  pid?: number;
}

export interface FileContentEvent {
  type: 'file_content';
  request_id: string;
  path: string;
  content: string;
  language?: string;
}

export interface ErrorEvent {
  type: 'error';
  request_id?: string;
  message: string;
  code?: string;
}

/**
 * Acknowledges a phone-originated send_message. Sent twice in the happy
 * path:
 *   - status='received' immediately when daemon parses the command
 *   - status='committed' when the message is in the session's input
 *     pipeline (controller mode: pushed to SDK input; observer mode:
 *     terminal injection confirmed in JSONL)
 * Sent once with status='failed' when injection ultimately fails.
 */
export interface MessageAckEvent {
  type: 'message_ack';
  client_message_id: string;
  session_id: string;
  status: 'received' | 'committed' | 'failed';
  /** Daemon-side message identifier when committed (currently unused — reserved). */
  server_message_id?: string;
  /** Failure reason when status='failed'. */
  error?: string;
  /** Daemon timestamp (epoch ms). */
  ts: number;
}

/**
 * Daemon's response to verify_history when the phone's view diverges from
 * the on-disk session history. The phone should re-fetch via get_history.
 */
export interface HistoryDivergenceEvent {
  type: 'history_divergence';
  session_id: string;
  /** The daemon's authoritative message count. */
  expected_count: number;
  /** Daemon's tail seq (last assigned session_seq for this session). */
  expected_tail_seq?: number;
  reason: 'count_mismatch' | 'tail_seq_mismatch' | 'head_seq_mismatch';
}

export type PcEvent =
  | SessionStartedEvent
  | SessionOutputEvent
  | SessionEndedEvent
  | SessionStatusEvent
  | PermissionRequestEvent
  | PermissionDismissedEvent
  | SessionListEvent
  | FileContentEvent
  | ErrorEvent
  | MessageAckEvent
  | HistoryDivergenceEvent;

// ============================================================================
// Peer Hello (E2E, peer-to-peer)
// ============================================================================

/**
 * Sent by each peer (daemon, app) immediately after the E2E session key is
 * established. Travels inside the encrypted channel — relay never sees it.
 *
 * Both sides use the received `capabilities` array to decide whether to
 * use a feature. Unknown capability strings must be ignored (forward-compat).
 * The `product_version` is strictly informational (UI/telemetry) — never
 * gate behavior on it; gate on capabilities.
 *
 * Re-sent whenever the E2E channel is (re-)established, so stale caps from
 * an earlier session cannot leak into a new one.
 */
export interface PeerHello {
  type: 'peer_hello';
  product: 'daemon' | 'app';
  product_version: string;
  wire_version: number;
  capabilities: string[];
  sent_at: number;
}

// ============================================================================
// Relay Protocol (Envelope)
// ============================================================================

export interface WakeBlobPayload {
  type: 'permission_request' | 'user_question' | 'session_completed' | 'plan_review' | 'session_error';
  session_name?: string;
  body: string;
  subtitle?: string;
  sound?: string;
  category?: string;
  session_id?: string;
  request_id?: string;
}

export interface RelayEnvelope {
  pair_id: string;
  sender: 'phone' | 'pc';
  encrypted_payload: string; // base64-encoded E2E ciphertext
  nonce: number;
  timestamp: number;
  /**
   * Deprecated: do not populate. Relay-visible push metadata breaks the
   * zero-knowledge payload boundary; offline APNs pushes are generic wake
   * notifications.
   */
  push_hint?: never;
  /**
   * Boolean wake bit. When true and the recipient is offline, the relay sends
   * an APNs wake notification. The relay-visible envelope carries no
   * session/request content; the daemon sets it only for events that warrant interrupting the user
   * (permission_request, user_question, session_completed, plan_review,
   * session_error). Absent or false → relay does not push.
   */
  wake?: boolean;
  /**
   * Opaque fixed-size encrypted wake summary for iOS Notification Service
   * Extension display. The relay may copy it into APNs payloads but must not
   * decrypt or interpret it.
   */
  wake_blob?: string;
}

// ============================================================================
// Pairing Protocol
// ============================================================================

export interface QrCodePayload {
  relay_url: string;
  pairing_id: string;
  pc_ephemeral_pk: string; // base64 X25519 public key
  otp: string;
  timestamp: number;
  expires: number; // 2 minutes
  mode?: ConnectionMode; // defaults to 'relay' for backward compat
  lan_host?: string; // daemon's LAN IP address
  lan_port?: number; // daemon's LAN WebSocket port
}

export interface PairingRequest {
  type: 'pairing_request';
  pairing_id: string;
  phone_ephemeral_pk: string; // base64 X25519 public key
  otp_proof: string; // HMAC(otp, shared_secret)
}

export interface PairingResponse {
  type: 'pairing_response';
  pairing_id: string;
  success: boolean;
  sas_digits?: string; // 6-digit code for visual verification
}

export interface PairingConfirm {
  type: 'pairing_confirm';
  pairing_id: string;
  confirmed: boolean;
  encrypted_identity_pk: string; // Ed25519 long-term pk, encrypted with session_key
}

// ============================================================================
// JWT Claims
// ============================================================================

export interface DeviceTokenClaims {
  pair_id: string;
  device_type: 'phone' | 'pc';
  device_id: string;
  iat: number;
  exp: number; // 90 days
}

export interface SessionTokenClaims {
  pair_id: string;
  session_nonce: string;
  iat: number;
  exp: number; // 24 hours
}

// ============================================================================
// Risk Classification
// ============================================================================

export const RISK_CLASSIFICATION: Record<string, RiskLevel> = {
  // LOW — read-only operations
  'Read': RiskLevel.LOW,
  'Glob': RiskLevel.LOW,
  'Grep': RiskLevel.LOW,
  'WebFetch': RiskLevel.LOW,
  'WebSearch': RiskLevel.LOW,
  // LOW — plan mode operations (auto-approved or handled specially)
  'EnterPlanMode': RiskLevel.LOW,
  'ExitPlanMode': RiskLevel.LOW,
  // MEDIUM — file modifications
  'Edit': RiskLevel.MEDIUM,
  'Write': RiskLevel.MEDIUM,
  'NotebookEdit': RiskLevel.MEDIUM,
  // HIGH — command execution
  'Bash': RiskLevel.HIGH,
  // CRITICAL — destructive or irreversible
  'emergency_abort': RiskLevel.CRITICAL,
};

// ============================================================================
// LAN Direct Connection — Auth Handshake
// ============================================================================

/** Sent by daemon as the first message when phone connects via LAN WebSocket. */
export interface LanAuthChallenge {
  type: 'lan_auth_challenge';
  challenge: string; // random nonce (base64)
  server_identity_pk: string; // daemon's Ed25519 public key (base64)
  wire_version?: number;
  min_supported_version?: number;
}

/** Phone signs the challenge with its Ed25519 key and replies. */
export interface LanAuthResponse {
  type: 'lan_auth_response';
  pair_id: string;
  challenge_signature: string; // Ed25519 signature of challenge (base64)
  client_identity_pk: string; // phone's Ed25519 public key (base64)
  wire_version?: number;
  min_supported_version?: number;
}

/** Daemon verifies and replies with success/failure. */
export interface LanAuthResult {
  type: 'lan_auth_result';
  success: boolean;
  error?: string;
  negotiated_wire_version?: number;
}

// ============================================================================
// LAN Direct Connection — Pairing (replaces relay POST /pair/complete)
// ============================================================================

export interface LanPairRequest {
  phone_ephemeral_pk: string; // base64 X25519 public key
  phone_identity_public_key: string; // base64 Ed25519 public key
  phone_name: string;
}

export interface LanPairResponse {
  success: boolean;
  pair_id: string;
  pc_name: string;
  pc_identity_public_key: string; // base64 Ed25519 public key
  error?: string;
}
