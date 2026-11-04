/**
 * Baseline LogTape configuration, logging ownership tracking, and request-correlated application logging.
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import {
  configureSync,
  type ConsoleFormatter,
  getConfig,
  getConsoleSink,
  getLogger as getLogtapeLogger,
  lazy,
  type Logger,
  type Sink,
  type TextFormatter,
} from '@logtape/logtape'
import { redactByField } from '@logtape/redaction'

import { getRequestId } from './context'

export type { Logger } from '@logtape/logtape'

/** Logging hooks owned by the selected instance or event output configuration. */
export interface ExecutionLogging {
  readonly recordAccess?: (
    request: {
      readonly method: string
      readonly url: string
      readonly requestId: string
      readonly clientIp: string
    },
    status: number | undefined,
    duration: number,
    outcome: 'ok' | 'error' | 'aborted',
  ) => void
  readonly withScope?: <R>(fn: () => Promise<R>) => Promise<R>
}

/** Instance-owned output hooks used by Node delivery without exposing a public service. */
export const applicationLogging = new WeakMap<object, ExecutionLogging>()

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
export function commitLoggingOwnership(owner: object): void {
  activeLoggingOwner = owner
  activeLoggingConfig = getConfig()
}

/** Releases logging ownership if the caller is the current active owner. */
export function releaseLoggingOwnership(owner: object): boolean {
  if (activeLoggingOwner === owner) {
    activeLoggingOwner = null
    activeLoggingConfig = null
    return true
  }
  return false
}

/**
 * Installs default console logging when no LogTape configuration exists.
 * Existing host configuration is preserved; configuration failures propagate to creation.
 *
 * @param formatter - Host-selected console format; omitted for LogTape's default console output.
 */
export function ensureBasicLogging(formatter?: ConsoleFormatter | TextFormatter): void {
  if (getConfig()) return
  configureSync({
    sinks: {
      console: redactSink(getConsoleSink({ formatter }), DEFAULT_REDACT),
    },
    loggers: [
      {
        category: ['app'],
        lowestLevel: 'info',
        sinks: ['console'],
      },
      {
        category: ['logtape', 'meta'],
        lowestLevel: 'warning',
        sinks: ['console'],
      },
    ],
    contextLocalStorage: sarkContextLocalStorage,
  })
  basicLoggingConfig = getConfig()
}

/** Wraps owned output once, preserving upstream record and disposal semantics. */
export function redactSink(sink: Sink, fields: readonly string[]): Sink {
  if (fields.length === 0) return sink
  return redactByField(sink, {
    fieldPatterns: fields.map((field) => new RegExp(`^${RegExp.escape(field)}$`, 'i')),
    action: () => '[REDACTED]',
  })
}

/**
 * Returns the native LogTape logger with the current request ID attached lazily.
 *
 * @param category - Application category; defaults to the root app category.
 * @returns Native logger supporting upstream levels, interpolation and structured properties.
 */
export function getLogger(category = 'app'): Logger {
  return getLogtapeLogger(category === 'app' ? ['app'] : ['app', category]).with({
    requestId: lazy(getRequestId),
  })
}
