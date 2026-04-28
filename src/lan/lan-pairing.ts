// Agent Pocket -- LAN Pairing
// Handles the local pairing flow: QR code display, key exchange via HTTP.

import * as os from 'node:os'
import { v4 as uuidv4 } from 'uuid'
import type { CryptoEngine } from '../crypto/crypto-engine.js'
import { spkiEd25519ToRaw, rawX25519ToSpki, rawEd25519ToSpki } from '../crypto/key-format.js'
import type { LanPairRequest, LanPairResponse, QrCodePayload } from '../shared/index.js'
import { DAEMON_DEFAULT_PORT, PAIRING_EXPIRY_SECONDS } from '../shared/index.js'
import { LanServer } from './lan-server.js'

// ============================================================================
// Types
// ============================================================================

export interface LanPairingResult {
  pair_id: string
  phone_identity_public_key: string
  session_send_key?: string
  session_recv_key?: string
  session_sas_key?: string
}

// ============================================================================
// LAN Pairing
// ============================================================================

/**
 * Run the LAN pairing flow:
 * 1. Generate a pair_id locally
 * 2. Display QR code with LAN address info
 * 3. Wait for phone to POST /pair/complete with its keys
 * 4. Perform key exchange
 * 5. Return pairing result
 */
export async function runLanPairing(
  lanServer: LanServer,
  cryptoEngine: CryptoEngine,
  port: number = DAEMON_DEFAULT_PORT,
): Promise<LanPairingResult> {
  const pairId = uuidv4()
  const deviceName = os.hostname()

  // Generate ephemeral key pair for key exchange
  cryptoEngine.generateEphemeralKeyPair()

  // Get LAN addresses
  const addresses = LanServer.getLanAddresses()
  if (addresses.length === 0) {
    throw new Error('No LAN network interfaces found')
  }

  const primaryAddr = addresses[0]

  // Build QR payload
  const now = Date.now()
  const qrPayload: QrCodePayload = {
    relay_url: '', // not used in LAN mode
    pairing_id: pairId,
    pc_ephemeral_pk: cryptoEngine.getEphemeralPublicKeyBase64(),
    otp: '', // not used in LAN mode
    timestamp: now,
    expires: now + PAIRING_EXPIRY_SECONDS * 1000,
    mode: 'lan',
    lan_host: primaryAddr,
    lan_port: port,
  }

  const qrData = Buffer.from(JSON.stringify(qrPayload)).toString('base64url')

  console.log('\nScan this QR code with the Agent Pocket iOS app:\n')
  console.log(`[lan-pairing] QR payload: ${JSON.stringify(qrPayload)}`)

  try {
    const qrTerminal = await import('qrcode-terminal')
    const mod = qrTerminal.default ?? qrTerminal
    mod.generate(qrData, { small: true })
  } catch {
    console.log('[QR display unavailable]')
  }

  console.log(`\nLAN addresses: ${addresses.join(', ')}`)
  console.log(`Port: ${port}`)
  console.log(`Pair ID: ${pairId.slice(0, 8)}...`)
  console.log(`Device name: ${deviceName}`)
  console.log('\nWaiting for phone to complete pairing... (times out in 2 minutes)')

  // Set up pair completion handler on the LAN server
  return new Promise<LanPairingResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      lanServer.setPairCompleteHandler(null)
      reject(new Error('LAN pairing timeout'))
    }, PAIRING_EXPIRY_SECONDS * 1000)

    lanServer.setPairCompleteHandler((req: LanPairRequest): LanPairResponse => {
      clearTimeout(timeout)
      lanServer.setPairCompleteHandler(null)

      try {
        // Perform key exchange
        // Phone sends raw 32-byte X25519 key; Node.js crypto expects SPKI/DER
        const phoneEphemeralSpki = rawX25519ToSpki(req.phone_ephemeral_pk)
        const sharedSecret = cryptoEngine.deriveSharedSecret(phoneEphemeralSpki)
        cryptoEngine.deriveSessionKeys(sharedSecret)
        // Phone sends raw 32-byte Ed25519 key; Node.js crypto expects SPKI/DER
        const phoneIdentitySpki = rawEd25519ToSpki(req.phone_identity_public_key)
        cryptoEngine.setPeerIdentityPublicKey(phoneIdentitySpki)

        const response: LanPairResponse = {
          success: true,
          pair_id: pairId,
          pc_name: deviceName,
          pc_identity_public_key: spkiEd25519ToRaw(cryptoEngine.getIdentityPublicKeyBase64()),
        }

        // Resolve the promise after sending the response
        const sessionKeys = cryptoEngine.getSessionKeys()
        setTimeout(() => {
          resolve({
            pair_id: pairId,
            phone_identity_public_key: req.phone_identity_public_key, // raw format, matches what phone sends during auth
            session_send_key: sessionKeys?.sendKey.toString('base64'),
            session_recv_key: sessionKeys?.recvKey.toString('base64'),
            session_sas_key: sessionKeys?.sasKey?.toString('base64'),
          })
        }, 100)

        return response
      } catch (err) {
        const response: LanPairResponse = {
          success: false,
          pair_id: pairId,
          pc_name: deviceName,
          pc_identity_public_key: '',
          error: (err as Error).message,
        }

        setTimeout(() => {
          reject(new Error(`Key exchange failed: ${(err as Error).message}`))
        }, 100)

        return response
      }
    })
  })
}
