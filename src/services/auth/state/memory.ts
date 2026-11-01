/**
 * In-memory AuthStateStore implementation with account throttling and capacity limits.
 *
 * @module
 */

import type { StoreDeclaration } from '../store'
import type { AccountLimitParams, AuthFlow, AuthStateStore, ClaimResult } from './types'

export interface MemoryAuthStateConfig {
  readonly maxChallenges?: number
  readonly maxAccounts?: number
}

interface AccountRecord {
  count: number
  expiresAt: number
}

export class MemoryAuthStateStore implements AuthStateStore {
  private readonly challenges = new Map<string, AuthFlow>()
  private readonly accounts = new Map<string, AccountRecord>()
  private readonly maxChallenges: number
  private readonly maxAccounts: number

  constructor(config?: MemoryAuthStateConfig) {
    this.maxChallenges = config?.maxChallenges ?? 1000
    this.maxAccounts = config?.maxAccounts ?? 10000
    for (const [name, capacity] of [
      ['maxChallenges', this.maxChallenges],
      ['maxAccounts', this.maxAccounts],
    ] as const) {
      if (!Number.isInteger(capacity) || capacity <= 0)
        throw new Error(`MFA ${name} must be a positive integer.`)
    }
  }

  private sweepExpired(now: number): void {
    for (const [id, flow] of this.challenges) {
      if (now >= flow.expiresAt) {
        this.challenges.delete(id)
      }
    }
    for (const [key, acc] of this.accounts) {
      if (now >= acc.expiresAt) {
        this.accounts.delete(key)
      }
    }
  }

  async create(flow: AuthFlow): Promise<boolean> {
    const now = Date.now()
    if (this.challenges.size >= this.maxChallenges) this.sweepExpired(now)

    if (this.challenges.has(flow.id)) {
      return false
    }

    if (this.challenges.size >= this.maxChallenges) {
      return false
    }

    this.challenges.set(flow.id, structuredClone(flow))
    return true
  }

  async read(id: string): Promise<AuthFlow | null> {
    const flow = this.challenges.get(id)
    if (!flow) return null
    if (Date.now() >= flow.expiresAt) {
      this.challenges.delete(id)
      return null
    }
    if (flow.status === 'consumed') {
      return null
    }
    return structuredClone(flow)
  }

  async bindProtocol(
    id: string,
    expectedRevision: string,
    protocol: Record<string, unknown>,
    now: number,
  ): Promise<AuthFlow | null> {
    const flow = this.challenges.get(id)
    if (!flow || now >= flow.expiresAt || flow.status !== 'pending') return null
    if (flow.protocol !== undefined) return structuredClone(flow)
    if (flow.revision !== expectedRevision) {
      return null
    }

    const updated: AuthFlow = {
      ...flow,
      revision: crypto.randomUUID(),
      protocol: structuredClone(protocol),
    }
    this.challenges.set(id, updated)
    return structuredClone(updated)
  }

  async claim(
    id: string,
    claimId: string,
    now: number,
    account?: AccountLimitParams,
  ): Promise<ClaimResult> {
    const flow = this.challenges.get(id)
    if (!flow || now >= flow.expiresAt) {
      return { status: 'invalid' }
    }

    if (flow.status !== 'pending' || flow.attempts >= flow.maxAttempts) {
      return { status: 'invalid' }
    }

    // Atomic account limit check and increment
    if (account) {
      const accountKey = JSON.stringify([account.sub, account.purpose])
      const existing = this.accounts.get(accountKey)

      if (existing && now < existing.expiresAt) {
        if (existing.count >= account.maxAttempts) {
          return { status: 'limited' }
        }
        existing.count += 1
      } else {
        if (this.accounts.size >= this.maxAccounts) {
          // If capacity reached, try to prune expired again
          this.sweepExpired(now)
          if (this.accounts.size >= this.maxAccounts) {
            return { status: 'limited' }
          }
        }
        this.accounts.set(accountKey, {
          count: 1,
          expiresAt: now + account.window,
        })
      }
    }

    const nextAttempts = flow.attempts + 1
    const updated: AuthFlow = {
      ...flow,
      attempts: nextAttempts,
      status: 'verifying',
      claimId,
      revision: crypto.randomUUID(),
    }
    this.challenges.set(id, updated)
    return { status: 'claimed', flow: structuredClone(updated) }
  }

  async release(id: string, claimId: string, now: number): Promise<boolean> {
    const flow = this.challenges.get(id)
    if (!flow || flow.claimId !== claimId || flow.status !== 'verifying' || now >= flow.expiresAt) {
      return false
    }

    if (flow.attempts >= flow.maxAttempts) {
      return false
    }

    const updated: AuthFlow = {
      ...flow,
      status: 'pending',
      claimId: undefined,
      revision: crypto.randomUUID(),
    }
    this.challenges.set(id, updated)
    return true
  }

  async consume(id: string, claimId: string, now: number): Promise<boolean> {
    const flow = this.challenges.get(id)
    if (!flow || flow.claimId !== claimId || flow.status !== 'verifying' || now >= flow.expiresAt) {
      return false
    }

    this.challenges.delete(id)
    return true
  }
}

/**
 * Creates an in-memory AuthStateStore declaration.
 * Only suitable for single-instance Node.js environments.
 */
export function memoryState(config?: MemoryAuthStateConfig): StoreDeclaration<AuthStateStore> {
  return {
    target: 'node',
    create: async () => ({
      value: new MemoryAuthStateStore(config),
    }),
  }
}
