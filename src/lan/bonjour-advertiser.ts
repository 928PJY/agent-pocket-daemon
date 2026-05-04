// Agent Pocket -- Bonjour Advertiser
// Publishes _agentpocket._tcp service via mDNS for LAN discovery.

import { BONJOUR_SERVICE_TYPE } from 'agent-pocket-protocol'
import { logger } from '../logger.js'

type BonjourPublishOptions = {
  name: string
  type: string
  port: number
  txt: Record<string, string>
}

type BonjourService = {
  stop?: CallableFunction
}

type BonjourInstance = {
  publish(options: BonjourPublishOptions): BonjourService
  destroy(): void
}

export type BonjourFactory = () => Promise<BonjourInstance> | BonjourInstance

async function createDefaultBonjour(): Promise<BonjourInstance> {
  const { Bonjour } = await import('bonjour-service')
  return new Bonjour()
}

// ============================================================================
// BonjourAdvertiser
// ============================================================================

export class BonjourAdvertiser {
  private bonjour: BonjourInstance | null = null
  private service: BonjourService | null = null
  private port: number
  private pairId: string
  private deviceName: string
  private version: string
  private createBonjour: BonjourFactory

  constructor(
    port: number,
    pairId: string,
    deviceName: string,
    version: string = '0.1.0',
    createBonjour: BonjourFactory = createDefaultBonjour,
  ) {
    this.port = port
    this.pairId = pairId
    this.deviceName = deviceName
    this.version = version
    this.createBonjour = createBonjour
  }

  /**
   * Start advertising the service via Bonjour/mDNS.
   */
  async start(): Promise<void> {
    try {
      this.bonjour = await this.createBonjour()

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
      this.service.stop?.()
      this.service = null
    }
    if (this.bonjour) {
      this.bonjour.destroy()
      this.bonjour = null
    }
    logger.info('bonjour', 'Stopped advertising')
  }
}
