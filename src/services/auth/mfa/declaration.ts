/**
 * Declaration of Multi-Factor Authentication (MFA).
 *
 * @module
 */

import type { BaseDeclaration, RequiresEnv } from '../../../core/declaration'
import type { MfaConfig } from './types'

type MfaInput = MfaConfig | ((env: any) => MfaConfig)

/** MFA declaration holding input settings. */
export interface MfaDeclaration extends BaseDeclaration<'mfa', MfaConfig> {}

/**
 * Declares MFA configuration for the application.
 *
 * @param config - Static MFA options.
 * @returns An MFA declaration.
 */
export function defineMfa(config?: MfaConfig): MfaDeclaration

/**
 * Declares MFA configuration resolved once per application or event.
 *
 * @param factory - Receives environment and returns MFA options.
 * @returns An MFA declaration requiring typed environment.
 */
export function defineMfa<E>(factory: (env: E) => MfaConfig): MfaDeclaration & RequiresEnv<E>

export function defineMfa(input?: MfaInput): MfaDeclaration {
  return {
    kind: 'mfa',
    value: input ?? {},
    isFactory: typeof input === 'function',
  }
}
