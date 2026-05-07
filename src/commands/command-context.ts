// Agent Pocket — Command Handler Context
// The minimum dependency surface a PhoneCommand handler needs from
// AgentPocketDaemon, exposed as a structural interface so handler functions
// can be unit-tested with a small mock instead of the whole daemon.
//
// Each handler file (under ./handlers) lists the subset of CommandContext
// it actually uses in its signature so callers can see at a glance what a
// handler touches.
//
// Keep this surface small and grow it deliberately — each new field/method
// added here is one more thing handler tests need to mock.

import type { PcEvent } from 'agent-pocket-protocol';
import type { SessionManager } from '../sessions/session-manager.js';

export interface SendSessionHistoryOptions {
  since?: string;
  sinceSeq?: number;
  offset?: number;
  limit?: number;
}

export interface CommandContext {
  /** Send a PcEvent over the active phone channel (relay or LAN). */
  sendToPhone(event: PcEvent, wake?: boolean): void;

  /** Send a typed `error` event back to the phone. */
  sendError(requestId: string | undefined, message: string, code: string): void;

  /**
   * Map the external session id the phone uses (which might be the daemon's
   * internal id, the Claude session id, or something already mapped) to the
   * internal id stored in `SessionManager`. Returns undefined when no record
   * exists for the input.
   */
  resolveInternalSessionId(externalId: string): string | undefined;

  /**
   * Reply to the phone with messages from a session's history. Returns the
   * tail seq of the last message delivered (or undefined when nothing was
   * sent — empty session, missing session, etc.).
   */
  sendSessionHistory(claudeSessionId: string, options?: SendSessionHistoryOptions): number | undefined;

  /** The session manager the daemon owns. */
  readonly sessionManager: SessionManager;
}

