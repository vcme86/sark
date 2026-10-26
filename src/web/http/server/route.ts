import { compileSchema, type InputValidator } from '../schema'
import type {
  InferRouteInput,
  ResolvedRouteOptions,
  RouteDeclaration,
  RouteHandler,
  RouteInputSchema,
  RouteOptions,
} from '../types'

/** Fluent builder for declaring an HTTP route. */
export interface RouteBuilder {
  /**
   * Adds input validation schemas for parameters, query, headers, and/or body.
   * Enforces mutual exclusivity of `json`, `form`, and `text` schemas.
   *
   * @param schemas - Schema declarations; at most one body field may be defined.
   * @returns A builder whose handler receives the validated schema output types.
   * @throws {Error} If more than one body schema is declared.
   * @throws {TypeError} If a schema does not implement a supported validation interface.
   */
  validate<TSchemas extends RouteInputSchema>(
    schemas: TSchemas,
  ): RouteBuilderWithValidation<TSchemas>

  /**
   * Completes a route without input validation schemas.
   *
   * @param fn - Handler receiving the Hono context and an empty input object.
   * @returns A route declaration for discovery or application assembly.
   */
  handler<TOutput>(fn: RouteHandler<{}, TOutput>): RouteDeclaration<{}, TOutput, undefined>
}

/** Fluent builder step after validation schemas have been provided. */
export interface RouteBuilderWithValidation<TSchemas extends RouteInputSchema> {
  /**
   * Completes a route with the previously declared validation schemas.
   *
   * @param fn - Handler receiving the Hono context and validated, transformed input.
   * @returns A declaration retaining schema input types for clients and output types for handlers.
   */
  handler<TOutput>(
    fn: RouteHandler<InferRouteInput<TSchemas>, TOutput>,
  ): RouteDeclaration<InferRouteInput<TSchemas>, TOutput, TSchemas>
}

/** Validates that at most one body schema (`json`, `form`, or `text`) is declared. */
function assertValidSchemas(schemas: RouteInputSchema | undefined): void {
  if (!schemas) return
  const bodyFields = [schemas.json, schemas.form, schemas.text].filter((f) => f !== undefined)
  if (bodyFields.length > 1) {
    throw new Error(
      'Mutually exclusive body schemas declared: json, form, and text cannot be declared together.',
    )
  }
}

/**
 * Creates an HTTP route builder with optional route-level configuration overrides.
 *
 * @param options - Route middleware and policy overrides; omitted policies inherit application defaults.
 * @returns A builder accepting validation schemas and a handler, or a handler directly.
 *
 * @example
 * ```ts
 * export default route({ bodyLimit: 512 * 1024 })
 *   .validate({ params: z.object({ id: z.string() }), json: UserSchema })
 *   .handler(async (ctx, input) => {
 *     return ctx.json(await updateUser(input.params.id, input.json))
 *   })
 * ```
 */
export function route(options: RouteOptions = {}): RouteBuilder {
  const resolvedOptions: ResolvedRouteOptions = {
    ...options,
    middleware: options.middleware === undefined ? [] : [...options.middleware],
  }

  return {
    validate<TSchemas extends RouteInputSchema>(
      schemas: TSchemas,
    ): RouteBuilderWithValidation<TSchemas> {
      assertValidSchemas(schemas)
      const validators: Partial<Record<keyof RouteInputSchema, InputValidator>> = {}
      for (const field of ['params', 'query', 'headers', 'json', 'form', 'text'] as const) {
        const schema = schemas[field]
        if (schema !== undefined) validators[field] = compileSchema(schema)
      }
      return {
        handler<TOutput>(
          fn: RouteHandler<InferRouteInput<TSchemas>, TOutput>,
        ): RouteDeclaration<InferRouteInput<TSchemas>, TOutput, TSchemas> {
          return {
            options: resolvedOptions,
            schemas,
            validators,
            handler: fn,
            isRoute: true,
          }
        },
      }
    },
    handler<TOutput>(fn: RouteHandler<{}, TOutput>): RouteDeclaration<{}, TOutput, undefined> {
      return {
        options: resolvedOptions,
        schemas: undefined,
        validators: {},
        handler: fn,
        isRoute: true,
      }
    },
  }
}
