// Agent Pocket — phone preferences + peer hello handlers
//
// Both handlers are tiny pieces of state-merge logic that the daemon hands
// off and never awaits, so they live together in this single module.
//
//   * handleSetPreferences mutates the shared phonePreferences record so
//     downstream output filters (tool-use suppression, completion-metric
//     subtitles) pick up the new toggles.
//   * handlePeerHello updates the PeerCapabilities snapshot learned from
//     the most recent peer_hello so the daemon knows which optional
//     wire-protocol features the phone can accept.
//
// Extracted from AgentPocketDaemon as part of Step 1.4i.

import type { SetPreferencesCommand, PeerHello } from 'agent-pocket-protocol';
import type { PeerCapabilities } from '../../relay/phone-transport.js';
import { logger } from '../../logger.js';

/** Mutable phone-preference flags that downstream output filters read. */
export interface PhonePreferences {
  showToolUse: boolean;
  showCompletionMetrics: boolean;
}

export function handleSetPreferences(
  prefs: PhonePreferences,
  command: SetPreferencesCommand,
): void {
  if (command.preferences.show_tool_use !== undefined) {
    prefs.showToolUse = command.preferences.show_tool_use;
  }
  if (command.preferences.show_completion_metrics !== undefined) {
    prefs.showCompletionMetrics = command.preferences.show_completion_metrics;
  }
  logger.debug('daemon', `Phone preferences updated: ${JSON.stringify(prefs)}`);
}

export function handlePeerHello(
  peers: PeerCapabilities,
  hello: PeerHello,
): void {
  peers.update(hello);
  logger.debug('daemon', 'Received peer_hello', {
    product: hello.product,
    product_version: hello.product_version,
    wire: hello.wire_version,
    capabilities: peers.list(),
  });
}
