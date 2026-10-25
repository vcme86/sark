import type { Context, MiddlewareHandler, TypedResponse } from 'hono'
import type { JSONParsed } from 'hono/utils/types'
import type { ZodType } from 'zod'

import type { CorsOptions } from './config'

declare module 'hono' {
  interface ContextVariableMap {
    /** Identifier shared by this request, internal calls, responses, and diagnostics. */
    requestId: string
  }
}

/** HTTP methods and the ALL fallback used in endpoint declarations. */
export type HttpMethod =
  | 'GET'
  | 'QUERY'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'HEAD'
  | 'ALL'

/**
 * Route input schema declarations.
 * Defines schemas for validating URL path parameters, search query parameters,
 * request headers, and request body.
 *
 * The three body fields (`json`, `form`, `text`) are strictly mutually exclusive:
 * declaring more than one for a single route throws an error during declaration.
 */
export interface RouteInputSchema {
  /** Schema validating path parameters supplied by the router. */
  params?: any
  /** Schema validating URL search query parameters (duplicate keys collected as arrays). */
  query?: any
  /** Schema validating HTTP request headers (keys normalized to lowercase). */
  headers?: any
  /** Schema validating JSON request body (`application/json` or `*+json`). */
  json?: any
  /** Schema validating URL-encoded or multipart form body. */
  form?: any
  /** Schema validating raw text request body. */
  text?: any
}

/**
 * Extracts the output type from Standard Schema V1 or Zod-compatible schema metadata.
 * Used for server-side route handler input arguments after parsing and transformation.
 */
export type InferSchemaOutput<T> = T extends {
  readonly '~standard': { readonly types?: { readonly output: infer O } }
}
  ? O
  : T extends ZodType<any, any, any>
    ? T['_output']
    : T extends { readonly _output: infer O }
      ? O
      : T extends { safeParse(val: any): { success: true; data: infer O } | any }
        ? O
        : unknown

/**
 * Extracts the input type accepted by a schema before validation or transformation.
 * Used for client-side call parameters when sending data to an endpoint.
 */
export type InferSchemaInput<T> = T extends {
  readonly '~standard': { readonly types?: { readonly input: infer I } }
}
  ? I
  : T extends ZodType<any, any, any>
    ? T['_input']
    : T extends { readonly _input: infer I }
      ? I
      : unknown

/** Derives the strongly-typed input object for a route handler from its RouteInputSchema. */
export type InferRouteInput<S extends RouteInputSchema> = {
  params: S['params'] extends undefined ? undefined : InferSchemaOutput<S['params']>
  query: S['query'] extends undefined ? undefined : InferSchemaOutput<S['query']>
  headers: S['headers'] extends undefined ? undefined : InferSchemaOutput<S['headers']>
  json: S['json'] extends undefined ? undefined : InferSchemaOutput<S['json']>
  form: S['form'] extends undefined ? undefined : InferSchemaOutput<S['form']>
  text: S['text'] extends undefined ? undefined : InferSchemaOutput<S['text']>
}

/**
 * Handles a matched HTTP request with validated inputs.
 *
 * @param ctx - Hono context for the matched request.
 * @param input - Parsed and transformed values from the declared schemas.
 * @returns A Response, a JSON value, or undefined for HTTP 204, directly or as a promise.
 */
export type RouteHandler<TInput = any, TOutput = any> = (
  ctx: Context,
  input: TInput,
) => Promise<TOutput> | TOutput

/** Route-level policy options that override application-wide and scope-wide configurations. */
export interface RouteOptions {
  /** Route-specific Hono middleware executed only for this route's method and path. */
  middleware?: MiddlewareHandler[]

  /** Route-specific request body size limit in bytes, or `false` to disable. */
  bodyLimit?: number | false

  /** Route-specific CORS options, or `false` to disable CORS for this route. */
  cors?: false | CorsOptions

  /** Route-specific CSRF configuration (`boolean` or `{ origins?: string[] }`). */
  csrf?: boolean | { origins?: string[] }

  [key: string]: unknown
}

/** Declared route overrides with the route's own middleware list normalized. */
export interface ResolvedRouteOptions extends Pick<RouteOptions, 'bodyLimit' | 'cors' | 'csrf'> {
  readonly middleware: readonly MiddlewareHandler[]
  readonly [key: string]: unknown
}

/** Route options, validation schemas, and handler used by the HTTP pipeline. */
export interface RouteDeclaration<
  TInput = any,
  TOutput = any,
  TSchemas extends RouteInputSchema | undefined = any,
> {
  readonly options: ResolvedRouteOptions
  readonly schemas?: TSchemas
  readonly handler: RouteHandler<TInput, TOutput>
  readonly isRoute: true
}

/** Strongly-typed metadata representation of an endpoint for API client consumption. */
export interface Endpoint<
  Method extends string = string,
  Path extends string = string,
  Input = unknown,
  Output = unknown,
> {
  method: Method
  path: Path
  input: Input
  output: Output
}

/** JSON representation used by Hono and automatic JSON responses. */
export type Jsonify<T> = JSONParsed<T>

type SchemaField<S, K extends keyof S> =
  undefined extends InferSchemaInput<S[K]>
    ? { [P in K]?: InferSchemaInput<S[P]> }
    : { [P in K]: InferSchemaInput<S[P]> }

type BodyInput<S> = S extends { json: unknown }
  ? SchemaField<S, 'json'> & { form?: never; text?: never }
  : S extends { form: unknown }
    ? (undefined extends InferSchemaInput<S['form']>
        ? { form?: InferSchemaInput<S['form']> | FormData | URLSearchParams }
        : { form: InferSchemaInput<S['form']> | FormData | URLSearchParams }) & {
        json?: never
        text?: never
      }
    : S extends { text: unknown }
      ? SchemaField<S, 'text'> & { json?: never; form?: never }
      : { json?: never; form?: never; text?: never }

export type ClientInputFromSchemas<S extends RouteInputSchema | undefined> = (S extends {
  params: unknown
}
  ? SchemaField<S, 'params'>
  : {}) &
  (S extends { query: unknown } ? SchemaField<S, 'query'> : {}) &
  BodyInput<S>

type SuccessfulOutput<T> =
  T extends TypedResponse<infer Data, infer Status, infer Format>
    ? Status extends 204 | 205
      ? undefined
      : `${Status}` extends `2${string}`
        ? Format extends 'json' | 'text'
          ? Data
          : unknown
        : never
    : T extends Response
      ? unknown
      : T extends void
        ? undefined
        : JSONParsed<T>

type PathParameterNames<Path extends string> = Path extends `${infer Segment}/${infer Rest}`
  ? PathParameterNames<Segment> | PathParameterNames<Rest>
  : Path extends `:${infer Name}` | `*${infer Name}`
    ? Name
    : never

type DefaultPathInput<Path extends string> = [PathParameterNames<Path>] extends [never]
  ? {}
  : { params: Record<PathParameterNames<Path>, string | number> }

/** Infers schema inputs and decoded output; generated paths supply parameters when no params schema exists. */
export type EndpointFromRoute<R, Path extends string = never> =
  R extends RouteDeclaration<never, infer Output, infer Schemas>
    ? {
        input: ClientInputFromSchemas<Schemas> &
          (Schemas extends { params: unknown } ? {} : DefaultPathInput<Path>)
        output: SuccessfulOutput<Awaited<Output>>
      }
    : { input: unknown; output: unknown }
