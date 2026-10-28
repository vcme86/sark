import { HTTPException } from 'hono/http-exception'

import { HttpError } from '../http/error'
import { NotFoundSignal } from './signals'
import type { PageError } from './types'

/**
 * Converts failures to page errors, hiding 5xx details in production.
 *
 * @param error - Loader, action, metadata, or rendering failure.
 * @param production - Whether unexpected server failures must omit their original details.
 * @returns A display error with a concrete HTTP status for page response handling.
 */
export function toPageError(
  error: unknown,
  production = false,
): PageError & { readonly status: number } {
  if (error instanceof NotFoundSignal) return { status: 404, message: error.message }
  if (error instanceof HttpError) {
    const status = error.status >= 400 ? error.status : 500
    return production && status >= 500
      ? { status, message: 'Internal Server Error' }
      : { status, message: error.message, data: error.details }
  }
  if (error instanceof HTTPException) {
    return {
      status: error.status,
      message: production && error.status >= 500 ? 'Internal Server Error' : error.message,
    }
  }
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    const status = 'status' in error && typeof error.status === 'number' ? error.status : 500
    return production && status >= 500
      ? { status, message: 'Internal Server Error' }
      : { status, message: error.message, ...('data' in error ? { data: error.data } : {}) }
  }
  return { status: 500, message: production ? 'Internal Server Error' : String(error) }
}
