// Peer capability identifiers exchanged between daemon and app over the
// E2E-encrypted channel. Relay never sees these.
//
// Capabilities are a flat set of opaque strings. Adding a new feature =
// adding a new constant here + having the producing side announce it in
// its peer_hello and the consuming side gate on peerCapabilities.has(X).
//
// Never remove a constant until no deployed peer can possibly still
// announce it; instead mark it deprecated and stop gating on it.

export const PEER_CAPABILITIES = {
  /**
   * Daemon supports the verify_history command (introduced PR #39).
   * App must skip the call when this is absent or the daemon will log
   * a "Unknown command type" error.
   */
  HISTORY_VERIFY: 'history.verify',

  /**
   * Daemon emits MessageAckEvent for SendMessageCommands carrying a
   * client_message_id (introduced PR #39). When absent, the app must
   * not block UI on ack arrival — old daemons will never send one.
   */
  MESSAGE_ACKS: 'messages.delivery_acks',

  /**
   * Peers understand explicit per-session agent identity fields such as
   * agent_type, agent_display_name, and agent_version.
   */
  AGENT_IDENTITY: 'agent.identity',

  /** Daemon can list and read local Codex sessions in observe mode. */
  CODEX_OBSERVE: 'codex.observe',

  /** Daemon can inject user text into an attached terminal session. */
  TERMINAL_REMOTE_MESSAGE: 'terminal.remote_message',

  /** Daemon can send an interrupt key sequence to an attached terminal. */
  TERMINAL_INTERRUPT: 'terminal.interrupt',

  /** Completion events include a stable per-turn request id for deduplication. */
  COMPLETION_REQUEST_ID: 'completion.request_id',
} as const;

export type PeerCapability = typeof PEER_CAPABILITIES[keyof typeof PEER_CAPABILITIES];

/**
 * Capabilities this build of the daemon/app announces in its peer_hello.
 * Both sides happen to support both today, so the list is identical.
 */
export const CURRENT_PEER_CAPABILITIES: PeerCapability[] = [
  PEER_CAPABILITIES.HISTORY_VERIFY,
  PEER_CAPABILITIES.MESSAGE_ACKS,
  PEER_CAPABILITIES.AGENT_IDENTITY,
  PEER_CAPABILITIES.CODEX_OBSERVE,
  PEER_CAPABILITIES.TERMINAL_REMOTE_MESSAGE,
  PEER_CAPABILITIES.TERMINAL_INTERRUPT,
  PEER_CAPABILITIES.COMPLETION_REQUEST_ID,
];
