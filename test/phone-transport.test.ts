import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PeerCapabilities,
  NOTIFICATION_DELIVERY_ACK_TIMEOUT_MS,
  NOTIFICATION_DELIVERY_RETRY_CHECK_INTERVAL_MS,
} from '../src/relay/phone-transport.js';
import type { PeerHello } from 'agent-pocket-protocol';

function hello(overrides: Partial<PeerHello> = {}): PeerHello {
  return {
    type: 'peer_hello',
    product: 'phone',
    product_version: '1.0.0',
    wire_version: 1,
    capabilities: [],
    sent_at: Date.now(),
    ...overrides,
  } as PeerHello;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('NOTIFICATION_DELIVERY constants have expected default values', () => {
  // Sanity: these values affect retry behaviour in the daemon, so a
  // change here should be intentional.
  assert.equal(NOTIFICATION_DELIVERY_ACK_TIMEOUT_MS, 3_000);
  assert.equal(NOTIFICATION_DELIVERY_RETRY_CHECK_INTERVAL_MS, 1_000);
});

// ---------------------------------------------------------------------------
// PeerCapabilities — initial state
// ---------------------------------------------------------------------------

test('PeerCapabilities has() returns false before any peer_hello is received', () => {
  const peers = new PeerCapabilities();
  assert.equal(peers.has('any.cap'), false);
});

test('PeerCapabilities versions are null before any peer_hello', () => {
  const peers = new PeerCapabilities();
  assert.equal(peers.getProductVersion(), null);
  assert.equal(peers.getWireVersion(), null);
  assert.equal(peers.size(), 0);
  assert.deepEqual(peers.list(), []);
});

// ---------------------------------------------------------------------------
// PeerCapabilities.update
// ---------------------------------------------------------------------------

test('PeerCapabilities.update stores product_version, wire_version, and capabilities', () => {
  const peers = new PeerCapabilities();
  peers.update(hello({
    product_version: '2.5.1',
    wire_version: 7,
    capabilities: ['cap.a', 'cap.b'],
  }));
  assert.equal(peers.getProductVersion(), '2.5.1');
  assert.equal(peers.getWireVersion(), 7);
  assert.equal(peers.has('cap.a'), true);
  assert.equal(peers.has('cap.b'), true);
  assert.equal(peers.has('cap.c'), false);
  assert.equal(peers.size(), 2);
  assert.deepEqual(peers.list().sort(), ['cap.a', 'cap.b']);
});

test('PeerCapabilities.update replaces (does not merge) the previous capability set', () => {
  const peers = new PeerCapabilities();
  peers.update(hello({ capabilities: ['cap.a', 'cap.b'] }));
  peers.update(hello({ capabilities: ['cap.c'] }));
  assert.equal(peers.has('cap.a'), false);
  assert.equal(peers.has('cap.b'), false);
  assert.equal(peers.has('cap.c'), true);
  assert.equal(peers.size(), 1);
});

test('PeerCapabilities.update tolerates a non-array capabilities field defensively', () => {
  const peers = new PeerCapabilities();
  // Defensive path: phone sends garbage / older-protocol payload missing the
  // field. Treat as empty rather than throwing.
  peers.update({
    type: 'peer_hello',
    product: 'phone',
    product_version: '1.0.0',
    wire_version: 1,
    // @ts-expect-error -- intentional: testing defensive handling
    capabilities: undefined,
    sent_at: Date.now(),
  } as PeerHello);
  assert.equal(peers.size(), 0);
  // But version fields are still updated from the hello
  assert.equal(peers.getProductVersion(), '1.0.0');
  assert.equal(peers.getWireVersion(), 1);
});

test('PeerCapabilities.update with an empty capability list clears the set', () => {
  const peers = new PeerCapabilities();
  peers.update(hello({ capabilities: ['cap.a'] }));
  peers.update(hello({ capabilities: [] }));
  assert.equal(peers.has('cap.a'), false);
  assert.equal(peers.size(), 0);
});

test('PeerCapabilities.list returns a snapshot, not a live view', () => {
  const peers = new PeerCapabilities();
  peers.update(hello({ capabilities: ['cap.a'] }));
  const snapshot = peers.list();
  peers.update(hello({ capabilities: ['cap.b'] }));
  assert.deepEqual(snapshot, ['cap.a']);
});
