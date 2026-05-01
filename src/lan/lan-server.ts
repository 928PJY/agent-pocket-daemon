// Agent Pocket -- LAN Server
// WebSocket server for direct LAN connection from the iOS app.
// Single-client, challenge-response auth with Ed25519.

import { EventEmitter } from 'node:events'
import * as http from 'node:http'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'
import type { CryptoEngine } from '../crypto/crypto-engine.js'
import { logger } from '../logger.js'
import { rawEd25519ToSpki, spkiEd25519ToRaw } from '../crypto/key-format.js'
import type {
  LanAuthChallenge,
  LanAuthResponse,
  LanAuthResult,
  LanPairRequest,
  LanPairResponse,
} from 'agent-pocket-protocol'
import { LAN_AUTH_TIMEOUT_MS, WIRE_VERSION_MIN, WIRE_VERSION_CURRENT } from 'agent-pocket-protocol'

// ============================================================================
// Types
// ============================================================================

export interface LanServerConfig {
  port: number
  cryptoEngine: CryptoEngine
  pairId: string
  phoneIdentityPublicKey: string // base64 Ed25519 public key of paired phone
}

export interface LanServerEvents {
  connected: []
  disconnected: [reason: string]
  message: [payload: unknown]
  error: [error: Error]
}

type PairCompleteHandler = (req: LanPairRequest) => LanPairResponse

// ============================================================================
// LanServer
// ============================================================================

export class LanServer extends EventEmitter {
  private config: LanServerConfig
  private httpServer: http.Server
  private wss: WebSocketServer | null = null
  private activeClient: WebSocket | null = null
  private isAuthenticated: boolean = false
  private pairCompleteHandler: PairCompleteHandler | null = null
  private consecutiveDecryptFailures: number = 0

  constructor(config: LanServerConfig) {
    super()
    this.config = config

    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res)
    })
  }

  /**
   * Start listening on the configured port.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ server: this.httpServer })

      this.wss.on('connection', (ws: WebSocket) => {
        this.handleNewConnection(ws)
      })

      this.wss.on('error', (err: Error) => {
        logger.error('lan', `WebSocket server error: ${err.message}`)
        this.emit('error', err)
      })

      this.httpServer.on('error', (err: Error) => {
        logger.error('lan', `HTTP server error: ${err.message}`)
        reject(err)
      })

      this.httpServer.listen(this.config.port, '0.0.0.0', () => {
        logger.info('lan', `Listening on 0.0.0.0:${this.config.port}`)
        resolve()
      })
    })
  }

  /**
   * Stop the server and close all connections.
   */
  async stop(): Promise<void> {
    if (this.activeClient) {
      try {
        this.activeClient.close(1000, 'Server shutting down')
      } catch {
        // Ignore close errors
      }
      this.activeClient = null
    }

    this.isAuthenticated = false

    if (this.wss) {
      this.wss.close()
      this.wss = null
    }

    return new Promise((resolve) => {
      this.httpServer.close(() => {
        logger.info('lan', 'Stopped')
        resolve()
      })
    })
  }

  /**
   * Send a payload to the connected phone.
   * Encrypts with E2E if session keys are available, otherwise sends raw JSON.
   */
  send(payload: unknown): void {
    if (!this.activeClient || this.activeClient.readyState !== WebSocket.OPEN) {
      return
    }

    try {
      const serialized = JSON.stringify(payload)
      const type = (payload as { type?: string })?.type

      if (this.config.cryptoEngine.hasSessionKeys()) {
        const encrypted = this.config.cryptoEngine.encrypt(serialized)
        const envelope = JSON.stringify({
          encrypted_payload: encrypted.ciphertext,
          nonce: encrypted.nonce,
        })
        logger.trace('lan', 'TX encrypted', { type, envelope_nonce: encrypted.nonce })
        this.activeClient.send(envelope)
      } else {
        this.activeClient.send(serialized)
      }
      logger.trace('lan', 'TX', { type })
    } catch (err) {
      logger.error('lan', `Send failed: ${(err as Error).message}`)
      this.emit('error', new Error(`Failed to send: ${(err as Error).message}`))
    }
  }

  /**
   * Register a handler for POST /pair/complete requests.
   */
  setPairCompleteHandler(handler: PairCompleteHandler | null): void {
    this.pairCompleteHandler = handler
  }

  /**
   * Get all non-loopback IPv4 addresses on this machine.
   */
  static getLanAddresses(): string[] {
    const interfaces = os.networkInterfaces()
    const addresses: string[] = []

    for (const iface of Object.values(interfaces)) {
      if (!iface) continue
      for (const info of iface) {
        if (info.family === 'IPv4' && !info.internal) {
          addresses.push(info.address)
        }
      }
    }

    return addresses
  }

  /**
   * Check if a client is currently connected and authenticated.
   */
  isClientConnected(): boolean {
    return this.isAuthenticated && this.activeClient !== null
      && this.activeClient.readyState === WebSocket.OPEN
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private resetDecryptFailureCount(reason: string): void {
    if (this.consecutiveDecryptFailures === 0) return
    logger.debug('lan', 'Resetting decrypt failure count', {
      reason,
      previousFailures: this.consecutiveDecryptFailures,
    })
    this.consecutiveDecryptFailures = 0
  }

  private handleNewConnection(ws: WebSocket): void {
    // Only allow one client at a time — kick previous
    if (this.activeClient && this.activeClient.readyState === WebSocket.OPEN) {
      logger.warn('lan', 'New connection replacing existing client')
      this.activeClient.close(1000, 'Replaced by new connection')
      this.resetDecryptFailureCount('replaced')
      this.emit('disconnected', 'Replaced by new connection')
    }

    this.activeClient = ws
    this.isAuthenticated = false
    this.resetDecryptFailureCount('connected')

    logger.info('lan', 'New WebSocket connection — starting auth handshake')

    // Start auth handshake
    this.runAuthHandshake(ws)

    ws.on('close', (code: number, reason: Buffer) => {
      if (ws === this.activeClient) {
        this.activeClient = null
        const wasAuthed = this.isAuthenticated
        this.isAuthenticated = false
        this.resetDecryptFailureCount('disconnected')
        if (wasAuthed) {
          const reasonStr = reason?.toString() || `code=${code}`
          this.emit('disconnected', reasonStr)
          logger.info('lan', `Client disconnected: ${reasonStr}`)
        }
      }
    })

    ws.on('error', (err: Error) => {
      logger.error('lan', `Client socket error: ${err.message}`)
      this.emit('error', err)
    })
  }

  private runAuthHandshake(ws: WebSocket): void {
    // Generate random challenge
    const challenge = crypto.randomBytes(32).toString('base64')

    const challengeMsg: LanAuthChallenge = {
      type: 'lan_auth_challenge',
      challenge,
      // Send raw 32-byte format so iOS CryptoKit can parse it
      server_identity_pk: spkiEd25519ToRaw(this.config.cryptoEngine.getIdentityPublicKeyBase64()),
      wire_version: WIRE_VERSION_CURRENT,
      min_supported_version: WIRE_VERSION_MIN,
    }

    ws.send(JSON.stringify(challengeMsg))

    // Wait for auth response with timeout
    const timeout = setTimeout(() => {
      if (!this.isAuthenticated && ws === this.activeClient) {
        logger.warn('lan', 'Auth handshake timed out')
        ws.close(4001, 'Auth timeout')
      }
    }, LAN_AUTH_TIMEOUT_MS)

    // Listen for the auth response (first message only)
    const onMessage = (data: WebSocket.Data) => {
      clearTimeout(timeout)
      ws.off('message', onMessage)

      try {
        const raw = Buffer.isBuffer(data) ? data.toString('utf-8') : String(data)
        const response = JSON.parse(raw) as LanAuthResponse

        if (response.type !== 'lan_auth_response') {
          this.sendAuthResult(ws, false, 'Expected lan_auth_response')
          ws.close(4002, 'Invalid auth response type')
          return
        }

        // Verify pair_id matches
        if (response.pair_id !== this.config.pairId) {
          this.sendAuthResult(ws, false, 'Pair ID mismatch')
          ws.close(4003, 'Pair ID mismatch')
          return
        }

        // Wire version negotiation. Pre-negotiation phones omit the range —
        // treat as [1,1]. Accept if the ranges overlap; respond with the
        // highest common version.
        const clientMax = response.wire_version ?? 1
        const clientMin = response.min_supported_version ?? clientMax
        const overlapLow = Math.max(clientMin, WIRE_VERSION_MIN)
        const overlapHigh = Math.min(clientMax, WIRE_VERSION_CURRENT)
        if (overlapLow > overlapHigh) {
          logger.warn('lan', 'Wire version mismatch', {
            client_min: clientMin,
            client_max: clientMax,
            server_min: WIRE_VERSION_MIN,
            server_max: WIRE_VERSION_CURRENT,
          })
          this.sendAuthResult(ws, false, 'Unsupported wire version')
          ws.close(4007, 'Unsupported wire version')
          return
        }
        const negotiatedWireVersion = overlapHigh

        // Verify the phone's signing key matches what we have on file
        // Phone sends raw 32-byte key, config stores raw key from pairing
        if (response.client_identity_pk !== this.config.phoneIdentityPublicKey) {
          this.sendAuthResult(ws, false, 'Unknown client identity')
          ws.close(4004, 'Unknown client')
          return
        }

        // Verify the signature on the challenge
        // Convert phone's raw Ed25519 key to SPKI/DER for Node.js crypto.verify()
        const phoneSpkiKey = rawEd25519ToSpki(response.client_identity_pk)
        const valid = this.config.cryptoEngine.verify(
          challenge,
          response.challenge_signature,
          phoneSpkiKey,
        )

        if (!valid) {
          this.sendAuthResult(ws, false, 'Invalid challenge signature')
          ws.close(4005, 'Invalid signature')
          return
        }

        // Auth successful
        this.isAuthenticated = true
        this.sendAuthResult(ws, true, undefined, negotiatedWireVersion)
        this.emit('connected')
        logger.info('lan', 'Client authenticated successfully', { wire: negotiatedWireVersion })

        // Now wire up message handling for post-auth messages
        ws.on('message', (msgData: WebSocket.Data) => {
          this.handleMessage(msgData)
        })
      } catch (err) {
        this.sendAuthResult(ws, false, 'Auth error')
        ws.close(4006, 'Auth error')
        logger.error('lan', `Auth handshake error: ${(err as Error).message}`)
        this.emit('error', new Error(`Auth handshake error: ${(err as Error).message}`))
      }
    }

    ws.on('message', onMessage)
  }

  private sendAuthResult(ws: WebSocket, success: boolean, error?: string, negotiatedWireVersion?: number): void {
    const result: LanAuthResult = {
      type: 'lan_auth_result',
      success,
      error,
      negotiated_wire_version: negotiatedWireVersion,
    }
    try {
      ws.send(JSON.stringify(result))
    } catch {
      // Client may already be gone
    }
  }

  private handleMessage(data: WebSocket.Data): void {
    let raw: string
    if (Buffer.isBuffer(data)) {
      raw = data.toString('utf-8')
    } else if (typeof data === 'string') {
      raw = data
    } else if (Array.isArray(data)) {
      raw = Buffer.concat(data).toString('utf-8')
    } else {
      raw = data.toString()
    }

    logger.trace('lan', `RX ${raw.length} bytes`)

    let payload: unknown
    let envelopeNonceForLog: number | undefined
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      envelopeNonceForLog = typeof parsed.nonce === 'number' ? parsed.nonce : undefined

      // Check if this is an encrypted envelope
      if (parsed.encrypted_payload && this.config.cryptoEngine.hasSessionKeys()) {
        const envelopeNonce = parsed.nonce as number
        const decrypted = this.config.cryptoEngine.decrypt(
          parsed.encrypted_payload as string,
          envelopeNonce,
        )
        logger.trace('lan', 'RX encrypted', { envelope_nonce: envelopeNonce })
        payload = JSON.parse(decrypted)
      } else {
        payload = parsed
      }
    } catch (err) {
      this.consecutiveDecryptFailures++
      logger.warn('lan', `Failed to parse/decrypt frame (${this.consecutiveDecryptFailures} consecutive)`, {
        preview: raw.slice(0, 120),
        envelope_nonce: envelopeNonceForLog,
      })
      if (this.consecutiveDecryptFailures >= 3) {
        this.emit('decrypt_error', this.consecutiveDecryptFailures)
      }
      return
    }

    this.consecutiveDecryptFailures = 0

    const cmdType = (payload as { type?: string })?.type
    logger.trace('lan', 'RX decoded', { type: cmdType })
    this.emit('message', payload)
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Only handle POST /pair/complete
    if (req.method === 'POST' && req.url === '/pair/complete') {
      let body = ''
      let bodySize = 0
      const MAX_BODY_SIZE = 16 * 1024 // 16KB
      req.on('data', (chunk: Buffer) => {
        bodySize += chunk.length
        if (bodySize > MAX_BODY_SIZE) {
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Request body too large' }))
          req.destroy()
          return
        }
        body += chunk.toString()
      })
      req.on('end', () => {
        try {
          const pairReq = JSON.parse(body) as LanPairRequest

          if (!this.pairCompleteHandler) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, error: 'Not in pairing mode' }))
            return
          }

          const result = this.pairCompleteHandler(pairReq)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: (err as Error).message }))
        }
      })
      return
    }

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', connected: this.isClientConnected() }))
      return
    }

    res.writeHead(404)
    res.end('Not Found')
  }
}
