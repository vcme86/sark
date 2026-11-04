/**
 * HTTP access records with structured request metadata.
 *
 * @module
 */

import { getLogger } from '@logtape/logtape'

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
  status: number | undefined,
  durationMs: number,
  outcome: 'ok' | 'error' | 'aborted',
): void {
  const path = new URL(req.url).pathname
  const logger = getLogger(['sark', 'access'])

  logger.info('{method} {path} {statusLabel} {outcome} ({duration}ms)', {
    method: req.method,
    path,
    ...(status === undefined ? {} : { status }),
    statusLabel: status ?? '-',
    requestId: req.requestId,
    clientIp: req.clientIp,
    outcome,
    duration: Math.round(durationMs),
  })
}
