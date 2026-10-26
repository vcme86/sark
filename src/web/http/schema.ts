/**
 * Input validation through Zod-compatible and Standard Schema V1 interfaces.
 *
 * @module
 */

import type { ZodType } from 'zod'

export { z, ZodType } from 'zod'

/** Result envelope returned by schema validation. */
export interface ValidationResult<T> {
  /** Indicates whether validation passed. */
  success: boolean
  /** Parsed and transformed output data if successful. */
  data?: T
  /** Validation issues or parse errors if validation failed. */
  error?: unknown
}

/** Schema contracts accepted at the route declaration boundary. */
export type InputSchema =
  | {
      readonly '~standard': Pick<ZodType['~standard'], 'version' | 'vendor' | 'validate' | 'types'>
    }
  | { safeParseAsync(value: unknown): PromiseLike<ValidationResult<unknown>> }
  | { safeParse(value: unknown): ValidationResult<unknown> }

/** Adapter prepared once for a schema declared by an application. */
export type InputValidator = (value: unknown) => Promise<ValidationResult<unknown>>

/**
 * Selects a supported validation interface once, while the route is declared.
 *
 * Dispatch order:
 * 1. safeParseAsync-compatible schemas use asynchronous validation.
 * 2. safeParse-compatible schemas use synchronous validation.
 * 3. Standard Schema V1 uses ~standard.validate.
 *
 * @param schema - An application-supplied validation schema.
 * @returns Bound validation function; schema execution errors propagate to the request boundary.
 * @throws {TypeError} If the declaration does not implement a supported schema interface.
 */
export function compileSchema(schema: InputSchema): InputValidator {
  if (schema && (typeof schema === 'object' || typeof schema === 'function')) {
    if ('safeParseAsync' in schema && typeof schema.safeParseAsync === 'function')
      return async (value) => schema.safeParseAsync(value)
    if ('safeParse' in schema && typeof schema.safeParse === 'function')
      return async (value) => schema.safeParse(value)
    if ('~standard' in schema) {
      const standard = schema['~standard']
      if (standard?.version === 1 && typeof standard.validate === 'function')
        return async (value) => {
          const result: { readonly value?: unknown; readonly issues?: readonly unknown[] } =
            await standard.validate(value)
          return result.issues
            ? { success: false, error: result.issues }
            : { success: true, data: result.value }
        }
    }
  }
  throw new TypeError(
    'Route schema must implement Standard Schema V1, safeParse, or safeParseAsync.',
  )
}
