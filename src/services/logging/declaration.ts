/**
 * Declaration factory for application logging.
 *
 * @module
 */

import { getConsoleSink } from '@logtape/logtape'

import { evaluateDeclaration, type RequiresEnv } from '../../core/declaration'
import { DEFAULT_REDACT } from '../../core/logging'
import type { LoggingConfig, LoggingDeclaration, ResolvedLoggingConfig } from './types'

export { DEFAULT_REDACT } from '../../core/logging'

export function defineLogging(config?: LoggingConfig): LoggingDeclaration
export function defineLogging<E>(
  factory: (env: E) => LoggingConfig,
): LoggingDeclaration & RequiresEnv<E>
export function defineLogging<E>(
  input?: LoggingConfig | ((env: E) => LoggingConfig),
): LoggingDeclaration {
  return {
    kind: 'logging',
    value: input === undefined ? {} : input,
    isFactory: typeof input === 'function',
  }
}

/**
 * Resolves, validates, and normalizes logging options against host environment.
 *
 * @param declaration - Declared logging configuration or factory.
 * @param env - Current environment.
 * @returns Fully validated and resolved logging configuration.
 */
export function resolveLoggingConfig(
  declaration: LoggingDeclaration | undefined,
  env: unknown,
): ResolvedLoggingConfig {
  const raw = declaration
    ? evaluateDeclaration<LoggingConfig>(declaration.value, env, 'logging')
    : {}
  const level = raw.level ?? 'info'
  const redact = raw.redact ?? DEFAULT_REDACT
  const sinks = { console: getConsoleSink, ...raw.sinks }
  const categories = { app: ['console'], ...raw.categories }
  const declaredSinkNames = new Set(Object.keys(sinks))

  let accessEnabled = true
  let accessSinks: string[] = ['console']
  if (raw.access === false || (Array.isArray(raw.access) && raw.access.length === 0)) {
    accessEnabled = false
    accessSinks = []
  } else if (Array.isArray(raw.access)) {
    for (const name of raw.access) {
      if (!declaredSinkNames.has(name)) {
        throw new Error(
          `Configuration error: Unknown sink "${name}" specified in access log destinations.`,
        )
      }
    }
    accessSinks = [...raw.access]
  }

  if (raw.categories) {
    for (const [cat, targets] of Object.entries(raw.categories)) {
      for (const target of targets) {
        if (!declaredSinkNames.has(target)) {
          throw new Error(
            `Configuration error: Unknown sink "${target}" specified for category "${cat}".`,
          )
        }
      }
    }
  }

  return {
    level,
    sinks,
    accessEnabled,
    accessSinks,
    categories,
    redact,
  }
}
