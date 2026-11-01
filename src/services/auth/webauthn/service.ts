/**
 * WebAuthn factor service implementing registration, authentication, passkeys, and counter tracking.
 *
 * @module
 */

import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'

import type { AuthCheckContext, Identity } from '../contracts'
import { MfaError } from '../error'
import type { FactorPolicy } from '../factor'
import type { SessionOptions } from '../session/types'
import {
  assertActive,
  consumeChallenge,
  createChallenge,
  requireRecentAuthentication,
} from '../state/flow'
import type { AuthFlow, AuthStateStore } from '../state/types'
import type {
  CredentialSummary,
  ResolvedWebAuthnConfig,
  WebAuthnRecord,
  WebAuthnService,
  WebAuthnStore,
} from './types'

interface WebAuthnServiceDependencies {
  readonly config: ResolvedWebAuthnConfig
  readonly webauthnStore: WebAuthnStore
  readonly stateStore: AuthStateStore
  readonly policy: FactorPolicy
  readonly getCurrentIdentity?: () => Identity | undefined
  readonly markFactorEnrolledInRequest?: (sub: string) => void
  readonly hasOtherFactor?: (sub: string) => Promise<boolean>
  readonly context: AuthCheckContext
}

export class WebAuthnServiceImpl implements WebAuthnService {
  constructor(private readonly deps: WebAuthnServiceDependencies) {}

  private requireCurrentIdentity(): Identity {
    const identity = this.deps.getCurrentIdentity?.()
    if (!identity || !identity.sub) {
      throw new MfaError('step_up_required', 'WebAuthn operations require an authenticated user.')
    }
    return identity
  }

  async isEnabled(sub: string): Promise<boolean> {
    const creds = await this.deps.webauthnStore.listCredentials(sub)
    return creds.length > 0
  }

  async beginEnrollment(): Promise<{
    challenge: string
    options: Awaited<ReturnType<typeof generateRegistrationOptions>>
  }> {
    assertActive(this.deps.context)
    const identity = this.requireCurrentIdentity()
    const existingCreds = await this.deps.webauthnStore.listCredentials(identity.sub)
    requireRecentAuthentication(
      identity,
      this.deps.policy.recentAuthMaxAge,
      (existingCreds.length > 0 || (await this.deps.hasOtherFactor?.(identity.sub))) === true,
    )

    const userLabel = await this.deps.config.user(identity.sub, this.deps.context)
    const userHandle = await this.deps.webauthnStore.getOrCreateUserHandle(identity.sub)
    const excludeCredentials = existingCreds.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransport[] | undefined,
    }))

    const regOptions = await generateRegistrationOptions({
      rpName: this.deps.config.rpName,
      rpID: this.deps.config.rpId,
      userID: new TextEncoder().encode(userHandle),
      userName: userLabel.userName,
      userDisplayName: userLabel.displayName,
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: this.deps.config.userVerification,
      },
      timeout: this.deps.config.timeout,
    })

    const flowId = await createChallenge(
      this.deps.stateStore,
      this.deps.policy.challenge,
      'enroll-webauthn',
      {
        expectedChallenge: regOptions.challenge,
        userHandle,
        rpId: this.deps.config.rpId,
        origins: this.deps.config.origins,
        userVerification: this.deps.config.userVerification,
      },
      identity.sub,
    )

    return {
      challenge: flowId,
      options: regOptions,
    }
  }

  async confirmEnrollment(
    challenge: string,
    response: RegistrationResponseJSON,
  ): Promise<{ credentialId: string }> {
    assertActive(this.deps.context)
    const identity = this.requireCurrentIdentity()
    const flow = await this.deps.stateStore.read(challenge)
    if (!flow || flow.purpose !== 'enroll-webauthn' || flow.sub !== identity.sub) {
      throw new MfaError('challenge_invalid', 'Invalid or expired enrollment challenge.')
    }

    const claimId = crypto.randomUUID()
    const claimRes = await this.deps.stateStore.claim(challenge, claimId, Date.now())
    if (claimRes.status !== 'claimed') {
      throw new MfaError('challenge_invalid', 'Enrollment challenge cannot be claimed.')
    }

    const expectedChallenge = flow.data.expectedChallenge as string

    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: flow.data.origins as string[],
        expectedRPID: flow.data.rpId as string,
        requireUserVerification: flow.data.userVerification === 'required',
      })
    } catch {
      await this.deps.stateStore.release(challenge, claimId, Date.now())
      throw new MfaError('invalid_code', 'WebAuthn registration verification failed.')
    }

    if (!verification.verified || !verification.registrationInfo) {
      await this.deps.stateStore.release(challenge, claimId, Date.now())
      throw new MfaError('invalid_code', 'WebAuthn registration was not verified.')
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
    const userHandle = flow.data.userHandle as string

    const record: WebAuthnRecord = {
      credentialId: credential.id,
      sub: identity.sub,
      userHandle,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      revision: crypto.randomUUID(),
      createdAt: Date.now(),
    }

    assertActive(this.deps.context, claimRes.flow)
    const inserted = await this.deps.webauthnStore.insertCredential(record)
    if (!inserted) {
      throw new MfaError('conflict', 'WebAuthn credential already exists.')
    }

    await consumeChallenge(this.deps.stateStore, claimRes.flow, claimId, this.deps.context)
    this.deps.markFactorEnrolledInRequest?.(identity.sub)

    return { credentialId: credential.id }
  }

  async beginAuthentication(challenge: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const flow = await this.deps.stateStore.read(challenge)
    if (
      !flow ||
      !['login', 'step-up', 'webauthn-login'].includes(flow.purpose) ||
      flow.status !== 'pending'
    ) {
      throw new MfaError('challenge_invalid', 'Authentication challenge not found.')
    }
    assertActive(this.deps.context, flow)

    // Idempotent: return existing bound options if already created for this flow
    if (flow.protocol !== undefined) {
      return flow.protocol.options as PublicKeyCredentialRequestOptionsJSON
    }

    const allowCredentials = flow.sub
      ? (await this.deps.webauthnStore.listCredentials(flow.sub)).map((c) => ({
          id: c.credentialId,
          transports: c.transports as AuthenticatorTransport[] | undefined,
        }))
      : undefined

    const authOptions = await generateAuthenticationOptions({
      rpID: this.deps.config.rpId,
      allowCredentials,
      userVerification: this.deps.config.userVerification,
      timeout: this.deps.config.timeout,
    })

    const bound = await this.deps.stateStore.bindProtocol(
      challenge,
      flow.revision,
      {
        options: authOptions,
        challenge: authOptions.challenge,
        rpId: this.deps.config.rpId,
        origins: this.deps.config.origins,
        userVerification: this.deps.config.userVerification,
      },
      Date.now(),
    )

    if (bound?.protocol) {
      return bound.protocol.options as PublicKeyCredentialRequestOptionsJSON
    }

    throw new MfaError(
      'challenge_invalid',
      'Authentication challenge changed before options were bound.',
    )
  }

  async beginLogin(options?: SessionOptions): Promise<{
    challenge: string
    options: PublicKeyCredentialRequestOptionsJSON
  }> {
    const authOptions = await generateAuthenticationOptions({
      rpID: this.deps.config.rpId,
      userVerification: 'required',
      timeout: this.deps.config.timeout,
    })

    assertActive(this.deps.context)
    const flowId = await createChallenge(
      this.deps.stateStore,
      this.deps.policy.challenge,
      'webauthn-login',
      { sessionOptions: options },
      undefined,
      {
        options: authOptions,
        challenge: authOptions.challenge,
        rpId: this.deps.config.rpId,
        origins: this.deps.config.origins,
        userVerification: 'required',
      },
    )

    return {
      challenge: flowId,
      options: authOptions,
    }
  }

  async listCredentials(): Promise<CredentialSummary[]> {
    assertActive(this.deps.context)
    const identity = this.requireCurrentIdentity()
    const creds = await this.deps.webauthnStore.listCredentials(identity.sub)
    return creds.map((c) => ({
      id: c.credentialId,
      createdAt: c.createdAt,
      transports: c.transports,
      deviceType: c.deviceType,
      backedUp: c.backedUp,
    }))
  }

  async removeCredential(id: string): Promise<void> {
    assertActive(this.deps.context)
    const identity = this.requireCurrentIdentity()
    requireRecentAuthentication(identity, this.deps.policy.recentAuthMaxAge, true)

    const cred = await this.deps.webauthnStore.findCredential(id)
    if (!cred || cred.sub !== identity.sub) {
      return
    }

    assertActive(this.deps.context)
    const removed = await this.deps.webauthnStore.removeCredential(id, identity.sub, cred.revision)
    if (!removed) {
      throw new MfaError(
        'conflict',
        'Failed to remove WebAuthn credential due to revision conflict.',
      )
    }
  }

  async verifyProof(
    flow: AuthFlow,
    response: AuthenticationResponseJSON,
    context = this.deps.context,
  ): Promise<{ verified: boolean; sub?: string; userVerified?: boolean }> {
    const id = authenticationCredentialId(response)
    const cred = await this.deps.webauthnStore.findCredential(id)
    if (!cred) {
      return { verified: false }
    }

    if (flow.sub && flow.sub !== cred.sub) {
      return { verified: false }
    }

    const expectedChallenge = flow.protocol?.challenge as string
    if (!expectedChallenge) {
      return { verified: false }
    }

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: flow.protocol!.origins as string[],
        expectedRPID: flow.protocol!.rpId as string,
        credential: {
          id: cred.credentialId,
          publicKey: new Uint8Array(cred.publicKey),
          counter: cred.counter,
          transports: cred.transports as AuthenticatorTransport[] | undefined,
        },
        requireUserVerification: flow.protocol!.userVerification === 'required',
      })
    } catch {
      return { verified: false }
    }

    if (!verification.verified) {
      return { verified: false }
    }

    if (response.response.userHandle) {
      let decoded: string
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(
          isoBase64URL.toBuffer(response.response.userHandle),
        )
      } catch {
        return { verified: false }
      }
      if (decoded !== cred.userHandle) return { verified: false }
    } else if (flow.purpose === 'webauthn-login') return { verified: false }
    assertActive(context, flow)

    const nextRecord: WebAuthnRecord = {
      ...cred,
      counter: verification.authenticationInfo.newCounter,
      deviceType: verification.authenticationInfo.credentialDeviceType,
      backedUp: verification.authenticationInfo.credentialBackedUp,
      revision: crypto.randomUUID(),
    }

    const updated = await this.deps.webauthnStore.updateCredential(
      cred.credentialId,
      cred.sub,
      cred.revision,
      nextRecord,
    )

    if (!updated) throw new MfaError('conflict', 'WebAuthn credential changed during verification.')

    return {
      verified: true,
      sub: cred.sub,
      userVerified: Boolean(verification.authenticationInfo.userVerified),
    }
  }
}

/** Extracts the lookup key from an untrusted proof before entering persistence. */
export function authenticationCredentialId(response: unknown): string {
  if (
    !response ||
    typeof response !== 'object' ||
    !('id' in response) ||
    typeof response.id !== 'string' ||
    !response.id
  )
    throw new MfaError('invalid_code', 'Invalid WebAuthn authentication response.')
  return response.id
}
