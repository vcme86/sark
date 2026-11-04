/**
 * Types and interfaces for WebAuthn passkey and multi-factor authentication.
 *
 * @module
 */

import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  CredentialDeviceType,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'

import type { StoreDeclaration } from '../../../app/store'
import type { AuthCheckContext } from '../contracts'
import type { SessionOptions, SignInInput } from '../session/types'
import type { WebAuthnStore } from './store'

export type WebAuthnIdentity = Pick<SignInInput, 'sub' | 'ver' | 'roles' | 'claims'>

export type WebAuthnIdentityResolver = (
  sub: string,
  context: AuthCheckContext,
) => WebAuthnIdentity | Promise<WebAuthnIdentity>

export interface CredentialSummary {
  readonly id: string
  readonly createdAt: number
  readonly transports?: readonly string[]
  readonly deviceType?: string
  readonly backedUp?: boolean
}

export type { WebAuthnRecord, WebAuthnStore } from './store'

export type WebAuthnStoreDeclaration<Env = unknown> = StoreDeclaration<WebAuthnStore, Env>

export type { SqlWebAuthnOptions } from './store'

export interface WebAuthnUserLabel {
  readonly userName: string
  readonly displayName: string
}

export interface WebAuthnConfig {
  /** Relying-party domain, without a URL scheme or path. */
  readonly rpId: string | undefined
  /** Display name presented by authenticators during registration. */
  readonly rpName: string | undefined
  /** Exact browser origins allowed for this relying party. */
  readonly origins: readonly string[] | undefined
  readonly store: WebAuthnStoreDeclaration
  readonly user: (
    sub: string,
    context: AuthCheckContext,
  ) => WebAuthnUserLabel | Promise<WebAuthnUserLabel>
  /** Optional application account lookup used only after passwordless proof consumption. */
  readonly identity?: WebAuthnIdentityResolver
  /** Second-step verification preference; defaults to required. Passwordless always requires it. */
  readonly userVerification?: 'required' | 'preferred' | 'discouraged'
  /** Browser ceremony timeout in milliseconds; defaults to 60000. */
  readonly timeout?: number
}

export interface ResolvedWebAuthnConfig {
  readonly rpId: string
  readonly rpName: string
  readonly origins: readonly string[]
  readonly store: WebAuthnStoreDeclaration
  readonly user: (
    sub: string,
    context: AuthCheckContext,
  ) => WebAuthnUserLabel | Promise<WebAuthnUserLabel>
  readonly identity?: WebAuthnIdentityResolver
  readonly userVerification: 'required' | 'preferred' | 'discouraged'
  readonly timeout: number
}

export interface RequestWebAuthn {
  /** Begins registration for the authenticated subject after the common management checks. */
  beginEnrollment(): Promise<{
    challenge: string
    options: PublicKeyCredentialCreationOptionsJSON
  }>
  /**
   * Verifies a registration response against server-stored protocol expectations.
   *
   * @param challenge - Opaque enrollment handle, distinct from the WebAuthn protocol challenge.
   * @param response - Browser SDK registration response.
   * @returns The credential identifier after conditional insertion and flow consumption.
   */
  confirmEnrollment(
    challenge: string,
    response: RegistrationResponseJSON,
  ): Promise<{ credentialId: string }>
  /**
   * Obtains protocol options without replacing expectations already bound to a pending challenge.
   *
   * @param challenge - Handle from MFA beginSignIn/beginStepUp or WebAuthn beginSignIn.
   * @returns Browser options detached from the stored protocol snapshot.
   * @throws AuthError if the challenge is expired, unavailable, or changed concurrently.
   */
  beginAuthentication(challenge: string): Promise<PublicKeyCredentialRequestOptionsJSON>
  /**
   * Starts discoverable-credential login without a client-supplied account identifier.
   *
   * @param options - Session delivery options retained until successful completion.
   * @returns A handle and browser options; submit the signed response through mfa.complete.
   */
  beginSignIn(options?: SessionOptions): Promise<{
    challenge: string
    options: PublicKeyCredentialRequestOptionsJSON
  }>
  /** Lists only the current authenticated subject's credentials, without public-key material. */
  listCredentials(): Promise<CredentialSummary[]>
  /** Removes an owned credential after recent factor auth, checking its revision. */
  removeCredential(id: string): Promise<void>
}

export type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  CredentialDeviceType,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
}
