/**
 * Baseline LogTape configuration and request-correlated application logging.
 *
 * @module
 */

import {
  configureSync,
  getConfig,
  getConsoleSink,
  getLogger as getLogtapeLogger,
} from '@logtape/logtape'

import { getRequestId } from './context'

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
  })
}

/**
 * Application logger whose messages include the current request ID when available.
 * Additional arguments are stored in the structured args property, not interpolated.
 */
export interface Logger {
  /**
   * Logs an informational message.
   *
   * @param message - Message text, prefixed with the active request ID when available.
   * @param args - Values recorded in the structured args property.
   */
  info(message: string, ...args: unknown[]): void
  /**
   * Logs a warning.
   *
   * @param message - Message text, prefixed with the active request ID when available.
   * @param args - Values recorded in the structured args property.
   */
  warn(message: string, ...args: unknown[]): void
  /**
   * Logs an error.
   *
   * @param message - Message text, prefixed with the active request ID when available.
   * @param args - Values recorded in the structured args property.
   */
  error(message: string, ...args: unknown[]): void
  /**
   * Logs a debug message, subject to the configured minimum level.
   *
   * @param message - Message text, prefixed with the active request ID when available.
   * @param args - Values recorded in the structured args property.
   */
  debug(message: string, ...args: unknown[]): void
}

class SarkLogger implements Logger {
  private readonly logger: ReturnType<typeof getLogtapeLogger>

  constructor(category: string) {
    this.logger = getLogtapeLogger(category === 'app' ? ['app'] : ['app', category])
  }

  private format(message: string): string {
    const reqId = getRequestId()
    return reqId ? `[req:${reqId}] ${message}` : message
  }

  info(message: string, ...args: unknown[]): void {
    this.logger.info(this.format(message), { args })
  }

  warn(message: string, ...args: unknown[]): void {
    this.logger.warn(this.format(message), { args })
  }

  error(message: string, ...args: unknown[]): void {
    this.logger.error(this.format(message), { args })
  }

  debug(message: string, ...args: unknown[]): void {
    this.logger.debug(this.format(message), { args })
  }
}

/**
 * Creates a logger for `category` (default: `app`). Messages include `[req:<id>]`
 * when emitted within a request scope.
 *
 * @param category - Category namespace (defaults to `'app'`).
 * @returns Logger instance configured for contextual output.
 */
export function getLogger(category = 'app'): Logger {
  return new SarkLogger(category)
}
