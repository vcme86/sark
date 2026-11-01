/**
 * Multi-factor authentication domain errors.
 *
 * @module
 */

import { HttpError } from '../../http/error'

/** Categorized machine-readable error codes for MFA failures. */
export type MfaErrorCode =
  | 'challenge_invalid'
  | 'too_many_attempts'
  | 'invalid_code'
  | 'conflict'
  | 'factor_missing'
  | 'key_unavailable'
  | 'step_up_required'
  | 'storage_error'
  | 'unauthorized'

const STATUS_BY_CODE: Record<MfaErrorCode, number> = {
  challenge_invalid: 400,
  too_many_attempts: 429,
  invalid_code: 400,
  conflict: 409,
  factor_missing: 400,
  key_unavailable: 500,
  step_up_required: 403,
  storage_error: 500,
  unauthorized: 401,
}

/** Specialized HTTP error for MFA, TOTP, WebAuthn, and recovery failures. */
export class MfaError extends HttpError {
  constructor(
    code: MfaErrorCode,
    message: string,
    options?: { details?: unknown; headers?: HeadersInit },
  ) {
    super(STATUS_BY_CODE[code], message, {
      code,
      details: options?.details,
      headers: options?.headers,
    })
    this.name = 'MfaError'
  }
}
