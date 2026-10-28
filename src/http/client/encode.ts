/**
 * Client URL construction, request body encoding, and Content-Type validation.
 *
 * @module
 */

/** Structured request components passed to client serialization. */
export interface RequestData {
  /** Path parameter substitutions (e.g. `:id` or `*wildcard`). */
  params?: Record<string, string | number>
  /** Query values; arrays become repeated keys and undefined values are omitted. */
  query?: Record<string, unknown>
  /** Explicit HTTP request headers to include in the dispatch. */
  headers?: HeadersInit
  /** JSON payload value to be serialized with `JSON.stringify`. */
  json?: unknown
  /** Form payload (raw object, `FormData`, or `URLSearchParams`). */
  form?: unknown
  /** Plain text payload. */
  text?: string
}

/**
 * Joins baseUrl and path, substitutes parameters, and appends query values.
 * Relative base URLs remain relative. Named parameters are percent-encoded;
 * wildcard values preserve slashes. Query arrays become repeated keys.
 *
 * @param baseUrl - Absolute or relative API URL prefix, such as https://example.com/api or /api.
 * @param path - Route template containing named parameters (`:param`) or wildcards (`*wildcard`).
 * @param params - Dictionary of values to interpolate into the route path.
 * @param query - Dictionary of query parameters to serialize into the search query string.
 * @returns The joined URL string, retaining whether the base URL is absolute or relative.
 */
export function buildUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, string | number>,
  query?: Record<string, unknown>,
): string {
  const resolvedPath = path
    .split('/')
    .map((segment) => {
      if (!params || (!segment.startsWith(':') && !segment.startsWith('*'))) return segment
      const value = params[segment.slice(1)]
      if (value === undefined) return segment
      return segment.startsWith('*')
        ? String(value).split('/').map(encodeURIComponent).join('/')
        : encodeURIComponent(String(value))
    })
    .join('/')

  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  const sub = resolvedPath.startsWith('/') ? resolvedPath : `/${resolvedPath}`

  const fullPath = base + sub

  if (!query || Object.keys(query).length === 0) {
    return fullPath
  }

  const searchParams = new URLSearchParams()
  for (const [key, val] of Object.entries(query)) {
    if (val === undefined) continue
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item !== undefined) searchParams.append(key, String(item))
      }
    } else {
      searchParams.set(key, String(val))
    }
  }

  const qs = searchParams.toString()
  return qs ? `${fullPath}?${qs}` : fullPath
}

function isBlob(v: unknown): boolean {
  return (
    typeof Blob !== 'undefined' &&
    (v instanceof Blob || (Array.isArray(v) && v.some((item) => item instanceof Blob)))
  )
}

function urlencodedContentType(headers: Headers): void {
  const mediaType = headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
  if (mediaType && mediaType !== 'application/x-www-form-urlencoded') {
    throw new TypeError('URL-encoded form requires application/x-www-form-urlencoded Content-Type.')
  }
  if (!mediaType) headers.set('Content-Type', 'application/x-www-form-urlencoded; charset=utf-8')
}

/**
 * Encodes one of json, form, or text, updating the supplied headers in place.
 * The three body fields are mutually exclusive.
 *
 * Encoding rules:
 * - JSON: JSON.stringify with application/json by default; accepts application/*+json overrides.
 * - Text: preserves the string with text/plain by default; accepts text/* overrides.
 * - FormData or form objects containing blobs: multipart encoding; removes Content-Type
 *   so fetch can generate the boundary.
 * - URLSearchParams or other form objects: application/x-www-form-urlencoded.
 *
 * JSON, text, and URL-encoded forms reject incompatible explicit Content-Type values.
 *
 * @param data - Request component data.
 * @param headers - Request headers mutated to set or remove Content-Type for the chosen encoding.
 * @returns The encoded body, or undefined when no supported body value is supplied.
 * @throws {Error} If multiple body types are specified simultaneously.
 * @throws {TypeError} If explicit Content-Type conflicts with the body payload kind.
 */
export function encodeBody(data: RequestData, headers: Headers): BodyInit | undefined {
  const bodyFields = [
    data.json !== undefined,
    data.form !== undefined,
    data.text !== undefined,
  ].filter(Boolean)
  if (bodyFields.length > 1) {
    throw new Error('Only one of json, form, or text body can be provided in client call.')
  }

  if (data.json !== undefined) {
    const mediaType = headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
    if (
      mediaType &&
      mediaType !== 'application/json' &&
      !/^application\/[^/]+\+json$/.test(mediaType)
    ) {
      throw new TypeError('JSON body requires a JSON Content-Type.')
    }
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json; charset=utf-8')
    }
    return JSON.stringify(data.json)
  }

  if (data.text !== undefined) {
    const mediaType = headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
    if (mediaType && !mediaType.startsWith('text/')) {
      throw new TypeError('Text body requires a text Content-Type.')
    }
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'text/plain; charset=utf-8')
    }
    return data.text
  }

  if (data.form !== undefined) {
    if (data.form instanceof FormData || data.form instanceof URLSearchParams) {
      if (data.form instanceof FormData) {
        headers.delete('Content-Type')
      } else {
        urlencodedContentType(headers)
      }
      return data.form
    }

    if (typeof data.form === 'object' && data.form !== null) {
      // Blob values, including array items, require multipart form encoding.
      const values = Object.values(data.form as Record<string, unknown>)
      const hasBlob = values.some(isBlob)

      if (hasBlob) {
        headers.delete('Content-Type')
        const formData = new FormData()
        for (const [k, v] of Object.entries(data.form as Record<string, unknown>)) {
          if (v !== undefined) {
            if (Array.isArray(v)) {
              for (const item of v) formData.append(k, item as any)
            } else {
              formData.append(k, v as any)
            }
          }
        }
        return formData
      }

      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(data.form as Record<string, unknown>)) {
        if (v !== undefined) {
          if (Array.isArray(v)) {
            for (const item of v) params.append(k, String(item))
          } else {
            params.set(k, String(v))
          }
        }
      }
      urlencodedContentType(headers)
      return params
    }
  }

  return undefined
}
