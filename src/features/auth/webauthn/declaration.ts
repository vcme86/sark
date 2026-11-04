/**
 * Declaration of WebAuthn authentication factor.
 *
 * @module
 */

import type { BaseDeclaration, RequiresEnv } from '../../../app/declaration'
import type { WebAuthnConfig } from './types'

type WebAuthnInput = WebAuthnConfig | ((env: any) => WebAuthnConfig)

/** WebAuthn declaration holding input settings. */
export interface WebAuthnDeclaration extends BaseDeclaration<'webauthn', WebAuthnConfig> {}

/**
 * Declares the WebAuthn authentication factor for the application.
 *
 * @param config - Static WebAuthn options.
 * @returns A WebAuthn declaration.
 */
export function defineWebAuthn(config: WebAuthnConfig): WebAuthnDeclaration

/**
 * Declares the WebAuthn authentication factor resolved once per application or event.
 *
 * @param factory - Receives environment and returns WebAuthn options.
 * @returns A WebAuthn declaration requiring typed environment.
 */
export function defineWebAuthn<E>(
  factory: (env: E) => WebAuthnConfig,
): WebAuthnDeclaration & RequiresEnv<E>

export function defineWebAuthn(input: WebAuthnInput): WebAuthnDeclaration {
  return {
    kind: 'webauthn',
    value: input,
    isFactory: typeof input === 'function',
  }
}
