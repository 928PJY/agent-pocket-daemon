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
  sinceMs?: number;
  offset?: number;
  limit?: number;
}

export interface SendSessionHistoryResult {
  tailSeq?: number;
  tailMs?: number;
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
   * Reverse of `resolveInternalSessionId`: given an internal id, return the
   * id the phone knows. Falls back to the internal id when no mapping exists.
   */
  resolveExternalSessionId(internalId: string): string;

  /**
   * Reply to the phone with messages from a session's history. Returns the
   * tail seq of the last message delivered (or undefined when nothing was
   * sent — empty session, missing session, etc.).
   */
  sendSessionHistory(claudeSessionId: string, options?: SendSessionHistoryOptions): SendSessionHistoryResult;

  /** The session manager the daemon owns. */
  readonly sessionManager: SessionManager;

  /** internal session id -> claude session id (when resumed from disk). */
  readonly sessionIdMap: Map<string, string>;

  /** request_id -> internal session id (resolved when SDK assigns one). */
  readonly pendingSessionRequests: Map<string, string>;

  /** Capability lookup against the *peer's* (phone's) advertised caps. */
  hasPeerCapability(name: string): boolean;
}

