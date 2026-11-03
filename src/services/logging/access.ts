/**
 * HTTP access records with structured request metadata.
 *
 * @module
 */

import { getLogger } from '@logtape/logtape'

export { redactStructuredProperties } from '../../core/logging'

/** Metadata for an HTTP request being logged. */
export interface AccessLogRequest {
  readonly method: string
  readonly url: string
  readonly requestId: string
  readonly clientIp: string
}

/** Emits an access log record for a finished HTTP request. */
export function emitAccessLog(
  req: AccessLogRequest,
  status: number,
  durationMs: number,
  outcome: 'ok' | 'error' | 'aborted',
): void {
  const path = new URL(req.url).pathname
  const logger = getLogger(['sark', 'access'])

  logger.info('{method} {path} {status} {outcome} ({duration}ms)', {
    method: req.method,
    path,
    status,
    requestId: req.requestId,
    clientIp: req.clientIp,
    outcome,
    duration: Math.round(durationMs),
  })
}
