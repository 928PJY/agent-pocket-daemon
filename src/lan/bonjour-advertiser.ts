// Agent Pocket -- Bonjour Advertiser
// Publishes _agentpocket._tcp service via mDNS for LAN discovery.

import { BONJOUR_SERVICE_TYPE } from '../shared/index.js'
import { logger } from '../logger.js'

// ============================================================================
// BonjourAdvertiser
// ============================================================================

export class BonjourAdvertiser {
  private bonjour: any = null
  private service: any = null
  private port: number
  private pairId: string
  private deviceName: string
  private version: string

  constructor(port: number, pairId: string, deviceName: string, version: string = '0.1.0') {
    this.port = port
    this.pairId = pairId
    this.deviceName = deviceName
    this.version = version
  }

  /**
   * Start advertising the service via Bonjour/mDNS.
   */
  async start(): Promise<void> {
    try {
      const { Bonjour } = await import('bonjour-service')
      this.bonjour = new Bonjour()

      this.service = this.bonjour.publish({
        name: `AgentPocket-${this.deviceName}`,
        type: BONJOUR_SERVICE_TYPE.replace(/^_/, '').replace(/\._tcp$/, ''),
        port: this.port,
        txt: {
          pair_id: this.pairId,
          version: this.version,
          name: this.deviceName,
        },
      })

      logger.info('bonjour', `Publishing ${BONJOUR_SERVICE_TYPE} on port ${this.port}`)
    } catch (err) {
      logger.error('bonjour', `Failed to publish: ${(err as Error).message}`)
      throw err
    }
  }

  /**
   * Stop advertising and clean up.
   */
  stop(): void {
    if (this.service) {
      this.service.stop()
      this.service = null
    }
    if (this.bonjour) {
      this.bonjour.destroy()
      this.bonjour = null
    }
    logger.info('bonjour', 'Stopped advertising')
  }
}
