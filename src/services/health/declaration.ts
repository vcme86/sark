/**
 * Declaration factory for application health checks and readiness probes.
 *
 * @module
 */

import { evaluateDeclaration, type RequiresEnv } from '../../core/declaration'
import type { HealthConfig, HealthDeclaration, ResolvedHealthConfig } from './types'

export function defineHealth(config?: HealthConfig): HealthDeclaration
export function defineHealth<E>(
  factory: (env: E) => HealthConfig,
): HealthDeclaration & RequiresEnv<E>
export function defineHealth<E>(
  input?: HealthConfig | ((env: E) => HealthConfig),
): HealthDeclaration {
  return {
    kind: 'health',
    value: input === undefined ? {} : input,
    isFactory: typeof input === 'function',
  }
}

/**
 * Resolves, validates, and normalizes declared health options against host environment.
 *
 * @param declaration - Declared health configuration or factory.
 * @param env - Current environment.
 * @returns Fully validated and resolved health configuration.
 */
export function resolveHealthConfig(
  declaration: HealthDeclaration | undefined,
  env: unknown,
): ResolvedHealthConfig {
  if (!declaration) {
    return { readiness: {}, timeout: 1000, cache: 2000 }
  }
  const raw = evaluateDeclaration<HealthConfig>(declaration.value, env, 'health')
  const timeout = raw.timeout ?? 1000
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('Health check timeout must be a positive number of milliseconds.')
  }
  const cache = raw.cache ?? 2000
  if (!Number.isFinite(cache) || cache < 0) {
    throw new Error('Health check cache duration must be a non-negative number of milliseconds.')
  }
  return {
    readiness: raw.readiness ?? {},
    timeout,
    cache,
    auth: raw.auth,
  }
}
