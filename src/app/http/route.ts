import { compileSchema, type InputValidator } from './schema'
import type {
  Context,
  InferRouteInput,
  InputValidators,
  ResolvedRouteOptions,
  ResolvedSseOptions,
  RouteDeclaration,
  RouteHandler,
  RouteInputSchema,
  RouteOptions,
  SseDeclaration,
  SseHandlers,
  SseOptions,
} from './types'

/** Fluent builder step for defining Server-Sent Events handlers. */
interface SseBuilder<
  TEvents extends Record<string, unknown>,
  TInput,
  TSchemas extends RouteInputSchema | undefined,
> {
  /**
   * Completes the SSE declaration with callbacks or an HTTP admission response.
   *
   * @param fn - Factory receiving context and input, returning event handlers or an early Response.
   * @returns An SSE route declaration for discovery and pipeline assembly.
   */
  handler(
    fn: (
      ctx: Context,
      input: TInput,
    ) => SseHandlers<TEvents> | Response | Promise<SseHandlers<TEvents> | Response>,
  ): SseDeclaration<TInput, TEvents, TSchemas>
}

/** Fluent builder for declaring an HTTP route. */
interface RouteBuilder {
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
   * Configures the route as a Server-Sent Events endpoint with a typed event table.
   *
   * @param options - SSE streaming options such as heartbeat comment frame interval.
   * @returns A builder accepting SSE event callbacks.
   */
  events<TEvents extends Record<string, unknown>>(
    options?: SseOptions,
  ): SseBuilder<TEvents, {}, undefined>

  /**
   * Completes a route without input validation schemas.
   *
   * @param fn - Handler receiving the Hono context and an empty input object.
   * @returns A route declaration for discovery or application assembly.
   */
  handler<TOutput>(fn: RouteHandler<{}, TOutput>): RouteDeclaration<{}, TOutput, undefined>
}

/** Fluent builder step after validation schemas have been provided. */
interface RouteBuilderWithValidation<TSchemas extends RouteInputSchema> {
  /**
   * Configures the route as a Server-Sent Events endpoint with validated inputs.
   *
   * @param options - SSE streaming options such as heartbeat comment frame interval.
   * @returns A builder accepting SSE event callbacks.
   * @throws {Error} If the validated schemas include a request body schema.
   */
  events<TEvents extends Record<string, unknown>>(
    options?: SseOptions,
  ): SseBuilder<TEvents, InferRouteInput<TSchemas>, TSchemas>

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

/** Asserts that no body schemas are declared for Server-Sent Events. */
function assertNoBodySchemas(schemas: RouteInputSchema | undefined): void {
  if (!schemas) return
  if (schemas.json !== undefined || schemas.form !== undefined || schemas.text !== undefined) {
    throw new Error('SSE routes cannot declare a request body schema.')
  }
}

/** Resolves the heartbeat interval once when declaring an SSE endpoint. */
function resolveSseOptions(options?: SseOptions): ResolvedSseOptions {
  const { heartbeat = 15000 } = options ?? {}
  if (
    heartbeat !== false &&
    (typeof heartbeat !== 'number' || !Number.isFinite(heartbeat) || heartbeat <= 0)
  ) {
    throw new Error('Invalid SSE heartbeat: heartbeat must be a positive number or false.')
  }
  return { heartbeat }
}

/** Shares SSE declaration construction between validated and unvalidated routes. */
function createSseBuilder<
  TEvents extends Record<string, unknown>,
  TInput,
  TSchemas extends RouteInputSchema | undefined,
>(
  options: ResolvedRouteOptions,
  schemas: TSchemas,
  validators: InputValidators,
  sseOptions?: SseOptions,
): SseBuilder<TEvents, TInput, TSchemas> {
  assertNoBodySchemas(schemas)
  const resolvedSseOptions = resolveSseOptions(sseOptions)
  return {
    handler(fn) {
      return {
        options,
        schemas,
        validators,
        sseOptions: resolvedSseOptions,
        handler: fn,
        isRoute: true,
        isSse: true,
      }
    },
  }
}

/**
 * Creates an HTTP route builder with optional route-level configuration overrides.
 *
 * @param options - Route middleware and policy overrides; omitted policies inherit application settings.
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
        events<TEvents extends Record<string, unknown>>(
          sseOptions?: SseOptions,
        ): SseBuilder<TEvents, InferRouteInput<TSchemas>, TSchemas> {
          return createSseBuilder<TEvents, InferRouteInput<TSchemas>, TSchemas>(
            resolvedOptions,
            schemas,
            validators,
            sseOptions,
          )
        },
        handler<TOutput>(
          fn: RouteHandler<InferRouteInput<TSchemas>, TOutput>,
        ): RouteDeclaration<InferRouteInput<TSchemas>, TOutput, TSchemas> {
          return {
            options: resolvedOptions,
            schemas,
            validators,
            handler: fn,
            isRoute: true,
            isSse: false,
          }
        },
      }
    },
    events<TEvents extends Record<string, unknown>>(
      sseOptions?: SseOptions,
    ): SseBuilder<TEvents, {}, undefined> {
      return createSseBuilder<TEvents, {}, undefined>(resolvedOptions, undefined, {}, sseOptions)
    },
    handler<TOutput>(fn: RouteHandler<{}, TOutput>): RouteDeclaration<{}, TOutput, undefined> {
      return {
        options: resolvedOptions,
        schemas: undefined,
        validators: {},
        handler: fn,
        isRoute: true,
        isSse: false,
      }
    },
  }
}
