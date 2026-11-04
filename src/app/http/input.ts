/**
 * Parsing and validation of declared HTTP route inputs.
 *
 * @module
 */

import type { Context } from 'hono'

import { HttpError } from '../../http/error'
import type { InputValidators } from './types'

/**
 * Parses and validates the input fields declared by the route.
 *
 * Validation order:
 * 1. Path parameters from the Hono route match.
 * 2. Query parameters, collecting repeated keys as arrays.
 * 3. Request headers with lowercase names.
 * 4. The selected JSON, form, or text body, including schema transformations.
 *
 * Body handling:
 * - JSON and form schemas check Content-Type; text schemas accept the body as text.
 * - The pipeline checks declared lengths early and limits unknown-length bodies as read.
 * - Repeated form keys become arrays, including File values in multipart forms.
 * - Syntax and schema failures produce HTTP 400 with validation details.
 *
 * @param ctx - Hono request context.
 * @param validators - Schema adapters prepared by the route declaration.
 * @returns Validated values keyed by the declared schema fields; undeclared fields are omitted.
 * @throws {HttpError} 400 for malformed syntax or schema validation failures.
 * @throws {HttpError} 413 if reading an unknown-length body exceeds the effective limit.
 * @throws {HttpError} 415 if Content-Type is incompatible with the JSON or form schema.
 */
export async function parseAndValidateInput(
  ctx: Context,
  validators: InputValidators,
): Promise<any> {
  const result: Record<string, any> = {}

  // 1. Params
  if (validators.params) {
    const rawParams = ctx.req.param()
    const validated = await validators.params(rawParams)
    if (!validated.success) {
      throw new HttpError(400, 'Invalid path parameters', { details: validated.error })
    }
    result.params = validated.data
  }

  // 2. Query
  if (validators.query) {
    const url = new URL(ctx.req.url)
    const rawQuery = collectFields(url.searchParams)
    const validated = await validators.query(rawQuery)
    if (!validated.success) {
      throw new HttpError(400, 'Invalid query parameters', { details: validated.error })
    }
    result.query = validated.data
  }

  // 3. Headers
  if (validators.headers) {
    const rawHeaders: Record<string, string> = {}
    for (const [key, value] of ctx.req.raw.headers.entries()) {
      rawHeaders[key.toLowerCase()] = value
    }
    const validated = await validators.headers(rawHeaders)
    if (!validated.success) {
      throw new HttpError(400, 'Invalid request headers', { details: validated.error })
    }
    result.headers = validated.data
  }

  // 4. Body fields (json | form | text)
  const contentType = (ctx.req.header('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()

  if (validators.json) {
    if (
      contentType !== 'application/json' &&
      !/^application\/[^/]+\+json$/.test(contentType) &&
      contentType.trim() !== ''
    ) {
      throw new HttpError(415, `Unsupported Media Type: expected JSON, got ${contentType}`)
    }

    let text = ''
    try {
      text = await ctx.req.text()
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError(400, 'Failed to read request body', { details: String(err) })
    }

    let rawBody: unknown
    try {
      rawBody = text.trim() ? JSON.parse(text) : undefined
    } catch (err) {
      throw new HttpError(400, 'Malformed JSON body', { details: String(err) })
    }

    const validated = await validators.json(rawBody)
    if (!validated.success) {
      throw new HttpError(400, 'Invalid JSON body', { details: validated.error })
    }
    result.json = validated.data
  } else if (validators.form) {
    if (
      contentType !== 'application/x-www-form-urlencoded' &&
      contentType !== 'multipart/form-data'
    ) {
      throw new HttpError(415, `Unsupported Media Type: expected form-data, got ${contentType}`)
    }

    let rawForm: Record<string, FormDataEntryValue | FormDataEntryValue[]>
    try {
      const formData = await ctx.req.formData()
      rawForm = collectFields(formData)
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError(400, 'Malformed form body', { details: String(err) })
    }

    const validated = await validators.form(rawForm)
    if (!validated.success) {
      throw new HttpError(400, 'Invalid form body', { details: validated.error })
    }
    result.form = validated.data
  } else if (validators.text) {
    let text = ''
    try {
      text = await ctx.req.text()
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError(400, 'Failed to read text body', { details: String(err) })
    }

    const validated = await validators.text(text)
    if (!validated.success) {
      throw new HttpError(400, 'Invalid text body', { details: validated.error })
    }
    result.text = validated.data
  }

  return result
}

/** Collects repeated query and form fields in a dictionary without a prototype. */
function collectFields<T>(entries: Iterable<[string, T]>): Record<string, T | T[]> {
  const fields = Object.create(null) as Record<string, T | T[]>
  for (const [key, value] of entries) {
    const previous = fields[key]
    if (previous === undefined) fields[key] = value
    else if (Array.isArray(previous)) previous.push(value)
    else fields[key] = [previous, value]
  }
  return fields
}
