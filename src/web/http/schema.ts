/**
 * Input validation through Zod-compatible and Standard Schema V1 interfaces.
 *
 * @module
 */

import { z, ZodType } from 'zod'

export { z, ZodType }

/** Result envelope returned by schema validation. */
export interface ValidationResult<T> {
  /** Indicates whether validation passed. */
  success: boolean
  /** Parsed and transformed output data if successful. */
  data?: T
  /** Validation issues or parse errors if validation failed. */
  error?: unknown
}

/**
 * Validates a value through the first applicable schema interface.
 *
 * Dispatch order:
 * 1. A missing schema passes the value through unchanged.
 * 2. Zod or safeParseAsync-compatible schemas use asynchronous validation.
 * 3. safeParse-compatible schemas use synchronous validation.
 * 4. Standard Schema V1 uses ~standard.validate.
 * 5. Unrecognized schemas pass the value through unchanged.
 *
 * @param schema - Validation schema or `undefined`.
 * @param value - Unknown runtime data to validate.
 * @returns Validation status with transformed data or issues; unsupported schemas pass value through.
 * @throws If the schema implementation itself throws or rejects.
 */
export async function validateSchema<T>(schema: any, value: unknown): Promise<ValidationResult<T>> {
  if (!schema) return { success: true, data: value as T }

  if (schema instanceof ZodType || typeof schema.safeParseAsync === 'function') {
    const res = await schema.safeParseAsync(value)
    if (res.success) {
      return { success: true, data: res.data as T }
    }
    return { success: false, error: res.error }
  }

  if (typeof schema.safeParse === 'function') {
    const res = schema.safeParse(value)
    if (res.success) {
      return { success: true, data: res.data as T }
    }
    return { success: false, error: res.error }
  }

  // Standard Schema V1 support
  if (schema['~standard']) {
    const res = await schema['~standard'].validate(value)
    if (res.issues && res.issues.length > 0) {
      return { success: false, error: res.issues }
    }
    return { success: true, data: res.value as T }
  }

  return { success: true, data: value as T }
}
