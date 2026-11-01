/**
 * Declaration of TOTP authentication factor.
 *
 * @module
 */

import type { BaseDeclaration, RequiresEnv } from '../../../core/declaration'
import type { TotpConfig } from './types'

type TotpInput = TotpConfig | ((env: any) => TotpConfig)

/** TOTP declaration holding input settings. */
export interface TotpDeclaration extends BaseDeclaration<'totp', TotpConfig> {}

/**
 * Declares the TOTP authentication factor for the application.
 *
 * @param config - Static TOTP options.
 * @returns A TOTP declaration.
 */
export function defineTotp(config: TotpConfig): TotpDeclaration

/**
 * Declares the TOTP authentication factor resolved once per application or event.
 *
 * @param factory - Receives environment and returns TOTP options.
 * @returns A TOTP declaration requiring typed environment.
 */
export function defineTotp<E>(factory: (env: E) => TotpConfig): TotpDeclaration & RequiresEnv<E>

export function defineTotp(input: TotpInput): TotpDeclaration {
  return {
    kind: 'totp',
    value: input,
    isFactory: typeof input === 'function',
  }
}
