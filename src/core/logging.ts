/**
 * Baseline LogTape configuration, logging ownership tracking, and request-correlated application logging.
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import {
  configureSync,
  getConfig,
  getConsoleSink,
  getLogger as getLogtapeLogger,
  lazy,
} from '@logtape/logtape'

import { getCurrentScope, getRequestId } from './context'

/** Default sensitive field names redacted from structured properties. */
export const DEFAULT_REDACT = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'token',
  'secret',
] as const

/** AsyncLocalStorage carrier used by LogTape for scoped configurations. */
export const sarkContextLocalStorage = new AsyncLocalStorage<Record<string, unknown>>()

let basicLoggingConfig: unknown = null
let activeLoggingOwner: object | null = null
let activeLoggingConfig: unknown = null
let activeLoggingRedactFields: readonly string[] = DEFAULT_REDACT

/** Reserves logging ownership before asynchronous setup and rejects host or application conflicts. */
export function acquireLoggingOwnership(owner: object): void {
  const currentConfig = getConfig()
  if (
    currentConfig &&
    currentConfig !== basicLoggingConfig &&
    currentConfig !== activeLoggingConfig
  ) {
    throw new Error(
      'Host already configured LogTape logging. Cannot overwrite existing external logging configuration.',
    )
  }
  if (activeLoggingOwner && activeLoggingOwner !== owner) {
    throw new Error(
      'Another active Sark application instance already configured LogTape logging. Cannot overwrite existing active logging configuration.',
    )
  }
  activeLoggingOwner = owner
}

/** Commits logging ownership to an application instance after LogTape is configured. */
export function commitLoggingOwnership(owner: object, redactFields: readonly string[]): void {
  activeLoggingOwner = owner
  activeLoggingConfig = getConfig()
  activeLoggingRedactFields = redactFields
}

/** Releases logging ownership if the caller is the current active owner. */
export function releaseLoggingOwnership(owner: object): boolean {
  if (activeLoggingOwner === owner) {
    activeLoggingOwner = null
    activeLoggingConfig = null
    activeLoggingRedactFields = DEFAULT_REDACT
    return true
  }
  return false
}

/** Gets the active redact field list for structured property masking. */
export function getActiveLoggingRedactFields(): readonly string[] {
  return activeLoggingRedactFields
}

/**
 * Installs default console logging when no LogTape configuration exists.
 * Existing host configuration is preserved; configuration failures propagate to creation.
 */
export function ensureBasicLogging(): void {
  if (getConfig()) return
  configureSync({
    sinks: {
      console: getConsoleSink(),
    },
    loggers: [
      {
        category: ['app'],
        lowestLevel: 'info',
        sinks: ['console'],
      },
    ],
    contextLocalStorage: sarkContextLocalStorage,
  })
  basicLoggingConfig = getConfig()
}

/** Redacts sensitive fields from a structured record using configured redact keys. */
export function redactStructuredProperties(
  properties: Record<string, unknown>,
  redactFields: readonly string[] = DEFAULT_REDACT,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const redactSet = new Set(redactFields.map((f) => f.toLowerCase()))
  for (const [key, value] of Object.entries(properties)) {
    result[key] = redactSet.has(key.toLowerCase()) ? '[REDACTED]' : value
  }
  return result
}

function redactLogArgs(args: readonly unknown[], redactFields: readonly string[]): unknown[] {
  return args.map((arg) => {
    if (arg && typeof arg === 'object' && !Array.isArray(arg) && !(arg instanceof Error)) {
      return redactStructuredProperties(arg as Record<string, unknown>, redactFields)
    }
    return arg
  })
}

/**
 * Application logger with the current request ID as a structured property.
 * Additional arguments are stored in the structured args property, not interpolated.
 */
export interface Logger {
  /**
   * Logs an informational message.
   *
   * @param message - Message text; the active request ID is attached as a structured property.
   * @param args - Values recorded in the structured args property.
   */
  info(message: string, ...args: unknown[]): void
  /**
   * Logs a warning.
   *
   * @param message - Message text; the active request ID is attached as a structured property.
   * @param args - Values recorded in the structured args property.
   */
  warn(message: string, ...args: unknown[]): void
  /**
   * Logs an error.
   *
   * @param message - Message text; the active request ID is attached as a structured property.
   * @param args - Values recorded in the structured args property.
   */
  error(message: string, ...args: unknown[]): void
  /**
   * Logs a debug message, subject to the configured minimum level.
   *
   * @param message - Message text; the active request ID is attached as a structured property.
   * @param args - Values recorded in the structured args property.
   */
  debug(message: string, ...args: unknown[]): void
}

class RequestLogger implements Logger {
  private readonly logger: ReturnType<typeof getLogtapeLogger>

  constructor(category: string) {
    this.logger = getLogtapeLogger(category === 'app' ? ['app'] : ['app', category]).with({
      requestId: lazy(getRequestId),
    })
  }

  private formatArgs(args: unknown[]): Record<string, unknown> | undefined {
    if (!args.length) return undefined
    const scope = getCurrentScope()
    const scopeRedact = (
      scope?.resources?.logging as { redactFields?: readonly string[] } | undefined
    )?.redactFields
    const redactFields = scopeRedact ?? getActiveLoggingRedactFields()
    return { args: redactLogArgs(args, redactFields) }
  }

  info(message: string, ...args: unknown[]): void {
    this.logger.info(message, this.formatArgs(args))
  }

  warn(message: string, ...args: unknown[]): void {
    this.logger.warn(message, this.formatArgs(args))
  }

  error(message: string, ...args: unknown[]): void {
    this.logger.error(message, this.formatArgs(args))
  }

  debug(message: string, ...args: unknown[]): void {
    this.logger.debug(message, this.formatArgs(args))
  }
}

/**
 * Creates a logger for `category` (default: `app`) with a lazy requestId property.
 *
 * @param category - Category namespace (defaults to `'app'`).
 * @returns Logger instance configured for contextual output.
 */
export function getLogger(category = 'app'): Logger {
  return new RequestLogger(category)
}
