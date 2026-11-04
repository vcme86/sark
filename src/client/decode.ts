/**
 * HTTP response decoding and conversion of decoded failure responses to HttpError.
 *
 * @module
 */

import { HttpError } from '../http/error'

/**
 * Decodes a response by status and Content-Type.
 *
 * Success handling:
 * - HTTP 204/205: returns undefined without reading the body.
 * - application/json or a +json media type: parses JSON.
 * - text/*: reads a string.
 * - Other media types: reads an ArrayBuffer.
 *
 * Failure handling:
 * - A decoded non-2xx response becomes HttpError with its body, status, and headers.
 * - A structured error envelope supplies message, code, and details when present.
 * - Body reading or parsing errors propagate without conversion to HttpError.
 *
 * @param response - Standard `Response` object received from fetch.
 * @returns Decoded JSON, text, binary data, or undefined for HTTP 204/205.
 * @throws {HttpError} For a non-2xx response whose body was successfully decoded.
 * @throws If reading or parsing the response body fails.
 */
export async function decodeResponse(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined

  const mediaType = (response.headers.get('Content-Type') ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  const body: unknown =
    mediaType === 'application/json' || mediaType.endsWith('+json')
      ? await response.json()
      : mediaType.startsWith('text/')
        ? await response.text()
        : await response.arrayBuffer()

  if (response.ok) return body

  const error =
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'object' &&
    body.error !== null
      ? body.error
      : undefined
  throw new HttpError(
    response.status,
    error && 'message' in error && typeof error.message === 'string'
      ? error.message
      : `Request failed with status ${response.status}`,
    {
      code: error && 'code' in error && typeof error.code === 'string' ? error.code : 'http_error',
      details: error && 'details' in error ? error.details : undefined,
      headers: response.headers,
      body,
    },
  )
}
