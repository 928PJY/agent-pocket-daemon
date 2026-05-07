import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SetPreferencesCommand, PeerHello } from 'agent-pocket-protocol';
import {
  handleSetPreferences,
  handlePeerHello,
  type PhonePreferences,
} from '../src/commands/handlers/preferences-and-peer.js';
import { PeerCapabilities } from '../src/relay/phone-transport.js';

function makePrefs(overrides: Partial<PhonePreferences> = {}): PhonePreferences {
  return { showToolUse: false, showCompletionMetrics: true, ...overrides };
}

const baseSetPrefs = (prefs: SetPreferencesCommand['preferences']): SetPreferencesCommand => ({
  type: 'set_preferences',
  preferences: prefs,
});

// ---------------------------------------------------------------------------
// handleSetPreferences
// ---------------------------------------------------------------------------

test('handleSetPreferences updates show_tool_use when provided', () => {
  const prefs = makePrefs({ showToolUse: false });
  handleSetPreferences(prefs, baseSetPrefs({ show_tool_use: true }));
  assert.equal(prefs.showToolUse, true);
});

test('handleSetPreferences updates show_completion_metrics when provided', () => {
  const prefs = makePrefs({ showCompletionMetrics: true });
  handleSetPreferences(prefs, baseSetPrefs({ show_completion_metrics: false }));
  assert.equal(prefs.showCompletionMetrics, false);
});

test('handleSetPreferences leaves keys unchanged when their command field is undefined', () => {
  const prefs = makePrefs({ showToolUse: true, showCompletionMetrics: false });
  handleSetPreferences(prefs, baseSetPrefs({}));
  assert.deepEqual(prefs, { showToolUse: true, showCompletionMetrics: false });
});

test('handleSetPreferences merges multiple toggles in a single call', () => {
  const prefs = makePrefs();
  handleSetPreferences(prefs, baseSetPrefs({ show_tool_use: true, show_completion_metrics: false }));
  assert.deepEqual(prefs, { showToolUse: true, showCompletionMetrics: false });
});

// ---------------------------------------------------------------------------
// handlePeerHello
// ---------------------------------------------------------------------------

const baseHello = (extra: Partial<PeerHello> = {}): PeerHello => ({
  type: 'peer_hello',
  product: 'phone',
  product_version: '1.2.3',
  wire_version: 7,
  capabilities: ['plan_review', 'user_question'],
  sent_at: 1_700_000_000_000,
  ...extra,
} as PeerHello);

test('handlePeerHello forwards to PeerCapabilities.update so subsequent .has() reflects it', () => {
  const peers = new PeerCapabilities();
  assert.equal(peers.has('plan_review'), false);
  handlePeerHello(peers, baseHello());
  assert.equal(peers.has('plan_review'), true);
  assert.equal(peers.has('user_question'), true);
  assert.equal(peers.has('not_announced'), false);
});

test('handlePeerHello replaces the previous capability set with the latest one', () => {
  const peers = new PeerCapabilities();
  handlePeerHello(peers, baseHello({ capabilities: ['plan_review'] }));
  handlePeerHello(peers, baseHello({ capabilities: ['user_question'] }));
  assert.equal(peers.has('plan_review'), false);
  assert.equal(peers.has('user_question'), true);
});
