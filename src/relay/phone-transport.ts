// Agent Pocket — Phone Transport State
// State helpers for the phone-side delivery layer, extracted from
// AgentPocketDaemon. The actual `sendToPhone`, retry loops, and the
// `pendingBlockingRequests` / `pendingNotificationDeliveries` maps still
// live in src/index.ts because they are tightly coupled to ~60 call sites
// across the daemon and to two retry timers fed by `setInterval`.
//
// Step 1.3 (this file) only extracts the cleanest piece — peer-capability
// tracking. A planned Step 1.3b will pull the two delivery-tracker maps
// into dedicated classes once the daemon's callers can absorb the rename.

import type { PeerHello } from 'agent-pocket-protocol';

// ---------------------------------------------------------------------------
// Constants (re-export for daemon convenience; values unchanged)
// ---------------------------------------------------------------------------

/**
 * After emitting a notification while the phone was online, wait this long
 * for the phone's `notification_delivery_ack` before falling back to a single
 * forceWake APNs push.
 */
export const NOTIFICATION_DELIVERY_ACK_TIMEOUT_MS = 3_000;

/**
 * How often the daemon checks pending-delivery records for entries past
 * the ack-timeout.
 */
export const NOTIFICATION_DELIVERY_RETRY_CHECK_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------
// Notification + blocking record types
// ---------------------------------------------------------------------------

export type NotificationDeliveryEventType =
  | 'permission_request'
  | 'user_question'
  | 'plan_review'
  | 'session_completed'
  | 'session_error';

export type BlockingRequestType = 'permission_request' | 'user_question' | 'plan_review';

// ---------------------------------------------------------------------------
// Peer capabilities
// ---------------------------------------------------------------------------

/**
 * Tracks the most recent `peer_hello` advertised by the phone:
 * product version, wire version, and capability set.
 *
 * Before any peer_hello arrives, `has()` returns false for every capability
 * and the version accessors return null.
 *
 * Replaces 3 inline fields (`peerCapabilities`, `peerProductVersion`,
 * `peerWireVersion`) and the `hasPeerCapability` / `handlePeerHello` private
 * methods on AgentPocketDaemon.
 */
export class PeerCapabilities {
  private capabilities: Set<string> = new Set();
  private productVersion: string | null = null;
  private wireVersion: number | null = null;

  /** Replace state with whatever the latest `peer_hello` declared. */
  update(hello: PeerHello): void {
    this.productVersion = hello.product_version;
    this.wireVersion = hello.wire_version;
    this.capabilities = new Set(Array.isArray(hello.capabilities) ? hello.capabilities : []);
  }

  /** True iff the most recent peer_hello included this capability name. */
  has(name: string): boolean {
    return this.capabilities.has(name);
  }

  getProductVersion(): string | null {
    return this.productVersion;
  }

  getWireVersion(): number | null {
    return this.wireVersion;
  }

  /** Snapshot of the current capability set (for logging/diagnostics). */
  list(): string[] {
    return Array.from(this.capabilities);
  }

  /** Number of capabilities currently advertised. */
  size(): number {
    return this.capabilities.size;
  }
}
