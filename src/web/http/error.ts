/** JSON payload used by Sark-generated HTTP errors. */
export interface ErrorBody {
  error: {
    /** Machine-readable error code string (e.g. `'http_error'`, `'csrf_forbidden'`). */
    code: string
    /** Human-readable error message. */
    message: string
    /** Optional contextual error details (e.g. validation issue list). */
    details?: unknown
  }
}

/** Standard HTTP error class used across server and client. */
export class HttpError extends Error {
  /** HTTP response status code (e.g. 400, 403, 404, 500). */
  readonly status: number

  /** Machine-readable error code string. Defaults to `'http_error'`. */
  readonly code: string

  /** Optional structured error details. */
  readonly details?: unknown

  /** Associated response headers (e.g. `WWW-Authenticate`, `Allow`). */
  readonly headers: Headers

  /** Decoded response body (available on the client when received from a server). */
  readonly body?: unknown

  /**
   * Creates an HTTP error for server serialization or a decoded client response.
   *
   * @param status - HTTP status associated with the error.
   * @param message - Error message; defaults to HTTP error followed by the status.
   * @param options - Error code, details, headers, and optional decoded client response body.
   */
  constructor(
    status: number,
    message?: string,
    options?: { code?: string; details?: unknown; headers?: HeadersInit; body?: unknown },
  ) {
    super(message ?? `HTTP error ${status}`)
    this.name = 'HttpError'
    this.status = status
    this.code = options?.code ?? 'http_error'
    this.details = options?.details
    this.headers = new Headers(options?.headers)
    this.body = options?.body
  }

  /**
   * Serializes the error code, message, and details into a JSON response.
   * The client-only body field is not serialized.
   *
   * @returns A Response with this error's status and headers, defaulting Content-Type to JSON.
   */
  toResponse(): Response {
    const errorPayload: ErrorBody = {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    }

    const headers = new Headers(this.headers)
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json; charset=utf-8')
    }

    return new Response(JSON.stringify(errorPayload), {
      status: this.status,
      headers,
    })
  }
}
