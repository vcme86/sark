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
  lazy,
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

  info(message: string, ...args: unknown[]): void {
    this.logger.info(message, args.length ? { args } : undefined)
  }

  warn(message: string, ...args: unknown[]): void {
    this.logger.warn(message, args.length ? { args } : undefined)
  }

  error(message: string, ...args: unknown[]): void {
    this.logger.error(message, args.length ? { args } : undefined)
  }

  debug(message: string, ...args: unknown[]): void {
    this.logger.debug(message, args.length ? { args } : undefined)
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
