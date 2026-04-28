// QR Code Pairing — PC side of the pairing flow.
// Initiates pairing with the relay, displays QR code, and waits for completion.

import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { CryptoEngine } from './crypto/crypto-engine.js';

// ---------------------------------------------------------------------------
// Pairing Config (passed in from CLI or caller)
// ---------------------------------------------------------------------------

export interface PairingConfig {
  relay_url: string;
  device_name: string;
}

export interface PairingResult {
  device_pair_id: string;
  jwt_pc: string;
  phone_public_key: string;
  phone_identity_public_key: string;
}

// ---------------------------------------------------------------------------
// Relay pairing response types
// ---------------------------------------------------------------------------

interface InitiateResponse {
  pairing_token: string;
  expires_at: string;
}

interface CompleteResponse {
  device_pair_id: string;
  jwt_pc: string;
  jwt_phone: string;
  phone_public_key: string;
  phone_identity_public_key: string;
}

// ---------------------------------------------------------------------------
// Main pairing function
// ---------------------------------------------------------------------------

export async function runPairing(
  config: PairingConfig,
  cryptoEngine: CryptoEngine,
): Promise<PairingResult | null> {
  cryptoEngine.loadOrGenerateIdentityKeyPair();
  cryptoEngine.generateEphemeralKeyPair();

  const pcPublicKey = cryptoEngine.getEphemeralPublicKeyBase64();
  const pcIdentityPublicKey = cryptoEngine.getIdentityPublicKeyBase64();

  // Step 1: POST /pair/initiate
  const relayHttpUrl = config.relay_url
    .replace('wss://', 'https://')
    .replace('ws://', 'http://');

  let initiateResult: InitiateResponse;
  try {
    initiateResult = await httpPost<InitiateResponse>(
      `${relayHttpUrl}/pair/initiate`,
      {
        pc_public_key: pcPublicKey,
        pc_identity_public_key: pcIdentityPublicKey,
        pc_name: config.device_name,
      },
    );
  } catch (err) {
    console.error('\nPairing failed: Could not reach relay server.');
    console.error(`  ${(err as Error).message}`);
    console.error('Make sure the relay is running and the URL is correct.');
    return null;
  }

  // Step 2: Generate QR payload and display
  const qrPayload = {
    v: 1,
    relay: config.relay_url,
    token: initiateResult.pairing_token,
    pk: pcPublicKey,
    ipk: pcIdentityPublicKey,
    name: config.device_name,
  };

  const qrData = Buffer.from(JSON.stringify(qrPayload)).toString('base64url');

  console.log('\n=== Agent Pocket Pairing ===\n');
  console.log('Scan this QR code with the Agent Pocket iOS app:\n');

  // Display QR code in terminal
  try {
    const qrTerminal = await import('qrcode-terminal');
    const generateFn = qrTerminal.default?.generate ?? qrTerminal.generate;
    generateFn(qrData, { small: true }, (qr: string) => {
      console.log(qr);
    });
  } catch {
    // Fallback: just print the raw data
    console.log('[QR code display unavailable]');
    console.log('Pairing data:', qrData);
  }

  console.log('\nPairing token:', initiateResult.pairing_token);
  console.log('Expires at:', initiateResult.expires_at);
  console.log('\nWaiting for phone to complete pairing...');

  // Step 3: Poll for completion
  const pollInterval = 2000;    // 2 seconds
  const maxPollTime = 120_000;  // 2 minutes
  const startTime = Date.now();

  while (Date.now() - startTime < maxPollTime) {
    try {
      const result = await httpGet<CompleteResponse | { status: string }>(
        `${relayHttpUrl}/pair/status/${initiateResult.pairing_token}`,
      );

      if ('device_pair_id' in result) {
        const completeResult = result as CompleteResponse;

        console.log('\nPairing successful!');
        console.log('Device pair ID:', completeResult.device_pair_id);
        console.log('\nYou can now start the daemon with: agentpocket start');

        return {
          device_pair_id: completeResult.device_pair_id,
          jwt_pc: completeResult.jwt_pc,
          phone_public_key: completeResult.phone_public_key,
          phone_identity_public_key: completeResult.phone_identity_public_key,
        };
      }

      // Not yet paired, wait and poll again
    } catch {
      // Polling error — may be a 404 if token expired
    }

    await sleep(pollInterval);
  }

  // Timeout
  console.error('\nPairing timed out. Please try again with: agentpocket pair');
  return null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpPost<T>(url: string, body: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;

    const payload = JSON.stringify(body);

    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              reject(new Error(`Invalid JSON response: ${data.substring(0, 200)}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpGet<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;

    const req = mod.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              reject(new Error(`Invalid JSON response: ${data.substring(0, 200)}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          }
        });
      },
    );

    req.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
