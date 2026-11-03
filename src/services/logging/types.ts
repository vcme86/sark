/**
 * Application logging configuration and declaration contracts.
 *
 * @module
 */

import type { LogLevel, Sink } from '@logtape/logtape'

import type { BaseDeclaration } from '../../core/declaration'

/** Configuration options for application logging. */
export interface LoggingConfig {
  /** Minimum logging level for application loggers (defaults to 'info'). */
  level?: LogLevel
  /** Named sink creation factories. Sinks are instantiated during resource setup. */
  sinks?: Record<string, () => Sink | Promise<Sink>>
  /** Access log destinations: true for default console, false/empty to disable, or specific sink names. */
  access?: boolean | readonly string[]
  /** Routes application category names to specific sinks. */
  categories?: Record<string, readonly string[]>
  /** Top-level structured field names masked in application log arguments. */
  redact?: readonly string[]
}

/** Declaration representing configured logging. */
export type LoggingDeclaration = BaseDeclaration<'logging', LoggingConfig>

/** Resolved and validated configuration for LogTape application logging. */
export interface ResolvedLoggingConfig {
  readonly level: LogLevel
  readonly sinks: Readonly<Record<string, () => Sink | Promise<Sink>>>
  readonly accessEnabled: boolean
  readonly accessSinks: readonly string[]
  readonly categories: Readonly<Record<string, readonly string[]>>
  readonly redact: readonly string[]
}
