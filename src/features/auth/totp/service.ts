/**
 * TOTP factor service implementing enrollment, verification, anti-replay, and key rotation.
 *
 * @module
 */

import { type HashAlgorithm, TokenFormatError, TokenLengthError } from '@otplib/core'
import { ScureBase32Plugin } from '@otplib/plugin-base32-scure'
import { WebCryptoPlugin } from '@otplib/plugin-crypto-web'
import { TOTP } from '@otplib/totp'
import { generateTOTP } from '@otplib/uri'

import type { AuthCheckContext, Identity } from '../contracts'
import { AuthError } from '../error'
import type { FactorPolicy } from '../factor'
import {
  assertActive,
  consumeChallenge,
  createChallenge,
  requireRecentAuthentication,
} from '../state/flow'
import type { AuthFlow, AuthStateStore } from '../state/types'
import type { ResolvedTotpConfig } from './config'
import { decryptTotpSecret, encryptTotpSecret } from './crypto'
import type { RequestTotp, TotpRecord, TotpStore } from './types'

interface TotpServiceDependencies {
  readonly config: ResolvedTotpConfig
  readonly totpStore: TotpStore
  readonly stateStore: AuthStateStore
  readonly policy: FactorPolicy
  readonly getCurrentIdentity?: () => Identity | undefined
  readonly markFactorEnrolledInRequest?: (sub: string) => void
  readonly hasOtherFactor?: (sub: string) => Promise<boolean>
  readonly context: AuthCheckContext
}

export class TotpService implements RequestTotp {
  constructor(private readonly deps: TotpServiceDependencies) {}

  private requireCurrentIdentity(): Identity {
    const id = this.deps.getCurrentIdentity?.()
    if (!id || !id.sub) {
      throw new AuthError('unauthorized', 'No active identity found for TOTP operation.')
    }
    return id
  }

  async isEnabled(sub: string, context = this.deps.context): Promise<boolean> {
    const record = await this.deps.totpStore.read(sub, context)
    return record !== null
  }

  async beginEnrollment(): Promise<{ challenge: string; uri: string }> {
    assertActive(this.deps.context)
    const identity = this.requireCurrentIdentity()
    const existing = await this.deps.totpStore.read(identity.sub, this.deps.context)
    requireRecentAuthentication(
      identity,
      this.deps.policy.recentAuthMaxAge,
      (existing !== null || (await this.deps.hasOtherFactor?.(identity.sub))) === true,
    )

    const otplib = new TOTP({
      crypto: new WebCryptoPlugin(),
      base32: new ScureBase32Plugin(),
    })
    const secret = otplib.generateSecret()
    const factorId = crypto.randomUUID()
    const expectedRevision = existing ? existing.revision : null

    const encryptedBytes = await encryptTotpSecret(
      secret,
      this.deps.config.keys.current,
      identity.sub,
      factorId,
    )

    const flowId = await createChallenge(
      this.deps.stateStore,
      this.deps.policy.challenge,
      'enroll-totp',
      {
        encryptedSecret: Array.from(encryptedBytes),
        factorId,
        expectedRevision,
        algorithm: this.deps.config.algorithm,
        digits: this.deps.config.digits,
        period: this.deps.config.period,
      },
      identity.sub,
    )

    const uri = generateTOTP({
      issuer: this.deps.config.issuer,
      label: identity.sub,
      secret,
      algorithm: this.deps.config.algorithm.toLowerCase() as HashAlgorithm,
      digits: this.deps.config.digits,
      period: this.deps.config.period,
    })

    return { challenge: flowId, uri }
  }

  async confirmEnrollment(challenge: string, code: string): Promise<{ enabled: true }> {
    assertActive(this.deps.context)
    const identity = this.requireCurrentIdentity()
    const flow = await this.deps.stateStore.read(challenge)
    if (!flow || flow.purpose !== 'enroll-totp' || flow.sub !== identity.sub) {
      throw new AuthError('challenge_invalid', 'Invalid or expired enrollment challenge.')
    }

    const claimId = crypto.randomUUID()
    const claimRes = await this.deps.stateStore.claim(challenge, claimId, Date.now())
    if (claimRes.status !== 'claimed') {
      throw new AuthError('challenge_invalid', 'Enrollment challenge cannot be claimed.')
    }

    const data = flow.data as {
      encryptedSecret: number[]
      factorId: string
      expectedRevision: string | null
      algorithm: ResolvedTotpConfig['algorithm']
      digits: number
      period: number
    }

    const { secret } = await decryptTotpSecret(
      new Uint8Array(data.encryptedSecret),
      this.deps.config.keys.byId,
      identity.sub,
      data.factorId,
    )

    const otplib = new TOTP({
      crypto: new WebCryptoPlugin(),
      base32: new ScureBase32Plugin(),
      algorithm: data.algorithm.toLowerCase() as HashAlgorithm,
      digits: data.digits,
      period: data.period,
    })

    let verifyRes
    try {
      verifyRes = await verifyCode(otplib, code, {
        secret,
        epochTolerance: this.deps.config.epochTolerance,
      })
    } catch (error) {
      if (error instanceof AuthError && error.code === 'invalid_code')
        await this.deps.stateStore.release(challenge, claimId, Date.now())
      throw error
    }

    if (!verifyRes.valid) {
      await this.deps.stateStore.release(challenge, claimId, Date.now())
      throw new AuthError('invalid_code', 'Invalid TOTP code during enrollment.')
    }

    const record: TotpRecord = {
      factorId: data.factorId,
      secret: new Uint8Array(data.encryptedSecret),
      algorithm: data.algorithm,
      digits: data.digits,
      period: data.period,
      lastStep: verifyRes.timeStep,
      revision: crypto.randomUUID(),
      enabledAt: Date.now(),
    }

    assertActive(this.deps.context, claimRes.flow)
    const committed = await this.deps.totpStore.commit(
      identity.sub,
      data.expectedRevision,
      record,
      this.deps.context,
    )

    if (!committed) {
      throw new AuthError('conflict', 'Factor revision conflict during enrollment.')
    }

    await consumeChallenge(this.deps.stateStore, claimRes.flow, claimId, this.deps.context)
    this.deps.markFactorEnrolledInRequest?.(identity.sub)

    return { enabled: true }
  }

  async disable(): Promise<void> {
    assertActive(this.deps.context)
    const identity = this.requireCurrentIdentity()
    requireRecentAuthentication(identity, this.deps.policy.recentAuthMaxAge, true)
    const existing = await this.deps.totpStore.read(identity.sub, this.deps.context)
    if (!existing) return

    assertActive(this.deps.context)
    const committed = await this.deps.totpStore.commit(
      identity.sub,
      existing.revision,
      null,
      this.deps.context,
    )
    if (!committed) {
      throw new AuthError('conflict', 'Factor revision conflict during removal.')
    }
  }

  async verifyProof(
    flow: AuthFlow,
    token: string,
    context = this.deps.context,
  ): Promise<{ verified: boolean; factorId?: string }> {
    const sub = flow.sub
    if (!sub) throw new Error('TOTP verification requires an authentication subject.')
    const expectedFactorId = (flow.data.factorBindings as Record<string, string> | undefined)?.totp
    const record = await this.deps.totpStore.read(sub, context)
    if (!record || (expectedFactorId !== undefined && record.factorId !== expectedFactorId)) {
      return { verified: false }
    }

    const { secret } = await decryptTotpSecret(
      record.secret,
      this.deps.config.keys.byId,
      sub,
      record.factorId,
    )

    // Verify using recorded user parameters instead of global configuration
    const userOtplib = new TOTP({
      crypto: new WebCryptoPlugin(),
      base32: new ScureBase32Plugin(),
      algorithm: record.algorithm.toLowerCase() as HashAlgorithm,
      digits: record.digits,
      period: record.period,
    })

    const verifyRes = await verifyCode(userOtplib, token, {
      secret,
      epochTolerance: this.deps.config.epochTolerance,
      afterTimeStep: record.lastStep,
    })

    if (!verifyRes.valid) {
      return { verified: false }
    }

    // Commit advanced lastStep atomically
    const updatedRecord: TotpRecord = {
      ...record,
      lastStep: verifyRes.timeStep,
      revision: crypto.randomUUID(),
    }

    assertActive(context, flow)
    const committed = await this.deps.totpStore.commit(sub, record.revision, updatedRecord, context)
    if (!committed) {
      throw new AuthError('conflict', 'TOTP factor changed during verification.')
    }

    return { verified: true, factorId: record.factorId }
  }

  async reencrypt(sub: string): Promise<boolean> {
    const record = await this.deps.totpStore.read(sub, this.deps.context)
    if (!record) return false

    const decrypted = await decryptTotpSecret(
      record.secret,
      this.deps.config.keys.byId,
      sub,
      record.factorId,
    )

    if (decrypted.keyId === this.deps.config.keys.current.id) {
      return true
    }

    const freshSecretBytes = await encryptTotpSecret(
      decrypted.secret,
      this.deps.config.keys.current,
      sub,
      record.factorId,
    )

    const updatedRecord: TotpRecord = {
      ...record,
      secret: freshSecretBytes,
      revision: crypto.randomUUID(),
    }

    return this.deps.totpStore.commit(sub, record.revision, updatedRecord, this.deps.context)
  }
}

/** Converts malformed tokens to retryable errors without masking host or secret failures. */
async function verifyCode(otplib: TOTP, code: string, options: Parameters<TOTP['verify']>[1]) {
  if (typeof code !== 'string') throw new AuthError('invalid_code', 'Invalid TOTP code.')
  try {
    return await otplib.verify(code, options)
  } catch (error) {
    if (error instanceof TokenLengthError || error instanceof TokenFormatError)
      throw new AuthError('invalid_code', 'Invalid TOTP code.')
    throw error
  }
}
