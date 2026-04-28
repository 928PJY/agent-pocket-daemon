#!/usr/bin/env node
/**
 * E2E test script — simulates the iOS app (phone) side.
 *
 * Usage:
 *   1. Start the daemon:  node dist/cli.js pair --relay-url wss://www.agent-pocket.com
 *   2. Copy the base64url pairing data from the daemon output
 *   3. Run:  node test-e2e.mjs <pairing_data_base64url>
 *
 * Or run with --auto to do the full flow automatically (daemon not needed):
 *   node test-e2e.mjs --auto --relay-url wss://www.agent-pocket.com
 */

import WebSocket from 'ws';

const RELAY_URL = process.argv.find(a => a.startsWith('--relay-url='))?.split('=')[1]
  || 'wss://www.agent-pocket.com';

const HTTP_URL = RELAY_URL.replace('wss://', 'https://').replace('ws://', 'http://');

function log(msg) { console.log(`[phone-sim] ${msg}`); }
function err(msg) { console.error(`[phone-sim] ERROR: ${msg}`); }

// ============================================================================
// Step 1: Get pairing token (either from CLI arg or by calling /pair/initiate)
// ============================================================================

async function getPairingData() {
  const autoMode = process.argv.includes('--auto');

  if (!autoMode) {
    // Read base64url QR data from CLI arg
    const qrArg = process.argv.find(a => !a.startsWith('--') && !a.endsWith('.mjs') && !a.includes('node'));
    if (!qrArg) {
      console.log('Usage: node test-e2e.mjs <base64url_qr_data>');
      console.log('       node test-e2e.mjs --auto [--relay-url=wss://...]');
      process.exit(1);
    }
    // base64url -> JSON
    let b64 = qrArg.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    return JSON.parse(json);
  }

  // Auto mode: call /pair/initiate ourselves (simulates the daemon's first step)
  log('Auto mode: calling /pair/initiate...');
  const resp = await fetch(`${HTTP_URL}/pair/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pc_public_key: 'test-pc-pk',
      pc_identity_public_key: 'test-pc-sk',
      pc_name: 'test-pc',
    }),
  });
  if (!resp.ok) {
    err(`/pair/initiate failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const { pairing_token } = await resp.json();
  log(`Got pairing token: ${pairing_token.slice(0, 8)}...`);

  return {
    relay_url: RELAY_URL,
    pairing_token,
    pc_ephemeral_pk: 'test-pc-pk',
  };
}

// ============================================================================
// Step 2: Call /pair/complete (phone side)
// ============================================================================

async function completePairing(qrPayload) {
  log(`Calling /pair/complete with token ${qrPayload.pairing_token.slice(0, 8)}...`);

  const resp = await fetch(`${HTTP_URL}/pair/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pairing_token: qrPayload.pairing_token,
      phone_public_key: `phone-pk-${Date.now()}`,
      phone_identity_public_key: `phone-sk-${Date.now()}`,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    err(`/pair/complete failed: HTTP ${resp.status} — ${body}`);
    process.exit(1);
  }

  const result = await resp.json();
  log(`Pairing complete!`);
  log(`  pair_id:   ${result.device_pair_id}`);
  log(`  jwt_phone: ${result.jwt_phone.slice(0, 20)}...`);
  if (result.jwt_pc) {
    err('/pair/complete unexpectedly returned jwt_pc');
    process.exit(1);
  }
  log(`  pc_name:   ${result.pc_name}`);

  return result;
}

// ============================================================================
// Step 3: Connect WebSocket as phone
// ============================================================================

function connectWebSocket(relayUrl, pairId, jwtPhone) {
  return new Promise((resolve, reject) => {
    const wsUrl = new URL(relayUrl.replace('wss://', 'wss://').replace('ws://', 'ws://'));
    if (!wsUrl.pathname.endsWith('/ws')) {
      wsUrl.pathname = wsUrl.pathname === '/' ? '/ws' : wsUrl.pathname;
    }
    log(`Connecting WebSocket: ${wsUrl.origin}${wsUrl.pathname}...`);

    const ws = new WebSocket(wsUrl.toString(), {
      headers: { Authorization: `Bearer ${jwtPhone}` },
    });

    ws.on('open', () => {
      log('WebSocket connected!');

      // Send routing header (first message)
      const routingHeader = JSON.stringify({
        protocol_version: 1,
        device_pair_id: pairId,
        device_role: 'phone',
      });
      ws.send(routingHeader);
      log('Sent routing header');

      resolve(ws);
    });

    ws.on('error', (e) => {
      err(`WebSocket error: ${e.message}`);
      reject(e);
    });

    ws.on('close', (code, reason) => {
      log(`WebSocket closed: code=${code} reason=${reason?.toString() || 'none'}`);
    });
  });
}

// ============================================================================
// Step 4: Send commands wrapped in RelayEnvelope
// ============================================================================

let messageNonce = 0;

function sendEnvelope(ws, pairId, payload) {
  const jsonStr = JSON.stringify(payload);
  const base64Payload = Buffer.from(jsonStr).toString('base64');
  const envelope = {
    pair_id: pairId,
    sender: 'phone',
    encrypted_payload: base64Payload,
    nonce: messageNonce++,
    timestamp: Date.now(),
  };
  ws.send(JSON.stringify(envelope));
}

function decodeEnvelope(raw) {
  try {
    const envelope = JSON.parse(raw);
    if (envelope.encrypted_payload) {
      const decoded = Buffer.from(envelope.encrypted_payload, 'base64').toString('utf-8');
      return { envelope, payload: JSON.parse(decoded) };
    }
    // Relay control or raw message
    return { envelope, payload: envelope };
  } catch (e) {
    return { envelope: null, payload: raw };
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  log('=== Agent Pocket E2E Test (Phone Simulator) ===\n');

  // Step 1: Get QR payload
  const qrPayload = await getPairingData();
  log(`QR payload: relay_url=${qrPayload.relay_url}, token=${qrPayload.pairing_token.slice(0, 8)}...`);
  console.log();

  // Step 2: Complete pairing
  const pairResult = await completePairing(qrPayload);
  const pairId = pairResult.device_pair_id;
  const jwtPhone = pairResult.jwt_phone;
  console.log();

  // Step 3: Connect WebSocket
  const ws = await connectWebSocket(qrPayload.relay_url, pairId, jwtPhone);
  console.log();

  // Listen for messages
  ws.on('message', (data) => {
    const raw = data.toString();
    const { payload } = decodeEnvelope(raw);
    log(`<<< Received: ${JSON.stringify(payload).slice(0, 200)}`);

    // If it's a session_started, celebration!
    if (payload && payload.type === 'session_started') {
      log('\n*** SESSION STARTED SUCCESSFULLY! ***');
      log(`  session_id: ${payload.session_id}`);
      log(`  working_directory: ${payload.working_directory}`);
    }
    if (payload && payload.type === 'error') {
      err(`PC daemon error: ${payload.message}`);
    }
    if (payload && payload.type === 'session_list') {
      log(`Session list: ${JSON.stringify(payload.sessions)}`);
    }
  });

  // Wait a moment for the connection to settle
  await new Promise(r => setTimeout(r, 1000));

  // Step 4: Send list_sessions command
  log('>>> Sending list_sessions command');
  sendEnvelope(ws, pairId, {
    type: 'list_sessions',
    request_id: `req-${Date.now()}`,
  });

  // Wait for response
  await new Promise(r => setTimeout(r, 2000));

  // Step 5: Send new_session command
  log('>>> Sending new_session command');
  sendEnvelope(ws, pairId, {
    type: 'new_session',
    request_id: `req-${Date.now()}`,
    config: {
      initial_message: 'echo "Hello from Agent Pocket E2E test!"',
    },
  });

  // Wait for responses
  log('Waiting for responses (30s)...\n');
  await new Promise(r => setTimeout(r, 30000));

  log('Test complete. Closing connection.');
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  err(`Fatal: ${e.message}`);
  process.exit(1);
});
