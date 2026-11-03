import type {
  ContextVariableMap,
  Context as HonoContext,
  MiddlewareHandler as HonoMiddlewareHandler,
  TypedResponse,
} from 'hono'
import type { JSONParsed } from 'hono/utils/types'
import type { ZodType } from 'zod'

import type { Register } from '../core/types'
import type { RateLimitConfig } from '../services/rate-limit/types'
import type { CorsOptions } from './config'
import type { InputSchema, InputValidator } from './schema'

declare module 'hono' {
  interface ContextVariableMap {
    /** Identifier shared by this request, internal calls, responses, and diagnostics. */
    requestId: string
  }
}

/** Registered platform bindings, or an untyped binding record when no environment is registered. */
type RegisteredBindings = Register extends { env: infer E } ? E : Record<string, unknown>

/** Resources selected by generated server-side assembly. */
type RegisteredResources = Register extends { resources: infer R } ? R : {}

/** Services selected by generated server-side assembly. */
type RegisteredServices = Register extends { services: infer S } ? S : {}

/** Execution environment for Sark request handlers. */
interface ContextEnv {
  Bindings: RegisteredBindings
  Variables: ContextVariableMap & RegisteredResources & RegisteredServices
}

/** Hono context strongly typed with Sark context variables. */
export type Context = HonoContext<ContextEnv>

/** Hono middleware with the application's declared resources and request services. */
export type MiddlewareHandler = HonoMiddlewareHandler<ContextEnv>

/** Directory-level HTTP policy and middleware shared by API and page assembly. */
export interface RouteScope {
  /** Optional policy overrides declared via `export const scope = { ... }`. */
  readonly options?: RouteOptions
  /** Optional Hono middleware handler exported as default. */
  readonly middleware?: MiddlewareHandler
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
  params?: InputSchema
  /** Schema validating URL search query parameters (duplicate keys collected as arrays). */
  query?: InputSchema
  /** Schema validating HTTP request headers (keys normalized to lowercase). */
  headers?: InputSchema
  /** Schema validating JSON request body (`application/json` or `*+json`). */
  json?: InputSchema
  /** Schema validating URL-encoded or multipart form body. */
  form?: InputSchema
  /** Schema validating raw text request body. */
  text?: InputSchema
}

/**
 * Extracts schema output from Standard Schema V1, Zod metadata, or a safeParse result.
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
      : T extends { safeParseAsync(value: any): infer R }
        ? ParsedSchemaOutput<Awaited<R>>
        : T extends { safeParse(value: any): infer R }
          ? ParsedSchemaOutput<R>
          : unknown

type ParsedSchemaOutput<R> = R extends { data?: infer O } ? O : never

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
  [K in keyof S]: InferSchemaOutput<S[K]>
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

  /** Route-specific rate limit configuration, or `false` to disable. */
  rateLimit?: false | Partial<RateLimitConfig>
}

/** Declared route overrides with the route's own middleware list normalized. */
export interface ResolvedRouteOptions extends Pick<
  RouteOptions,
  'bodyLimit' | 'cors' | 'csrf' | 'rateLimit'
> {
  readonly middleware: readonly MiddlewareHandler[]
}

/** Declared fields with their validation interfaces resolved before request execution. */
export type InputValidators = Readonly<Partial<Record<keyof RouteInputSchema, InputValidator>>>

/** Route options, validation schemas, and handler used by the HTTP pipeline. */
export interface RouteDeclaration<
  TInput = any,
  TOutput = any,
  TSchemas extends RouteInputSchema | undefined = any,
> {
  readonly options: ResolvedRouteOptions
  readonly schemas?: TSchemas
  readonly validators: InputValidators
  readonly handler: RouteHandler<TInput, TOutput>
  readonly isRoute: true
  readonly isSse?: false
}

/** Options configuring Server-Sent Events behavior. */
export interface SseOptions {
  /**
   * Heartbeat interval in milliseconds using comment frames.
   * Pass `false` to disable heartbeat frames.
   *
   * @default 15000
   */
  heartbeat?: number | false
}

/** Resolved and validated options for Server-Sent Events behavior. */
export interface ResolvedSseOptions {
  /** Heartbeat interval in milliseconds using comment frames, or `false` if disabled. */
  readonly heartbeat: number | false
}

/** Per-message metadata for Server-Sent Events. */
export interface SseSendOptions {
  /** Event identifier; CR, LF, and NUL are not allowed. */
  id?: string
  /** Non-negative integer reconnection interval in milliseconds, including zero. */
  retry?: number
}

/** Server-Sent Events stream handle providing message transmission and lifecycle controls. */
export interface SseStream<TEvents = Record<string, unknown>> {
  /**
   * Encodes and sends a typed event to the connected client respecting backpressure.
   *
   * @param event - Name of the event defined in the endpoint's event table.
   * @param data - JSON-serializable payload written to the event's data field.
   * @param options - Optional event ID and retry interval.
   * @returns Resolves after stream backpressure, or without writing if closing.
   *   Rejects on serialization, metadata, or transport failure.
   */
  send<K extends keyof TEvents & string>(
    event: K,
    data: TEvents[K],
    options?: SseSendOptions,
  ): Promise<void>
  /** Abort signal triggered when the client disconnects or the stream is closed. */
  readonly signal: AbortSignal
  /** Initiates graceful close without waiting for the currently executing callback. */
  close(): void
}

/** Lifecycle callbacks for a Server-Sent Events endpoint. */
export interface SseHandlers<TEvents = Record<string, unknown>> {
  /**
   * Starts the producer after admission, before the host necessarily delivers response headers.
   * Returning from onOpen does not close the stream.
   */
  onOpen?(stream: SseStream<TEvents>): void | Promise<void>
  /** Runs once during close, after the producer's returned asynchronous work finishes. */
  onClose?(stream: SseStream<TEvents>): void | Promise<void>
  /** Invoked when an unhandled error occurs during stream production or message writing. */
  onError?(stream: SseStream<TEvents>, error: unknown): void | Promise<void>
}

/** Declared Server-Sent Events endpoint definition. */
export interface SseDeclaration<
  TInput = any,
  TEvents = Record<string, unknown>,
  TSchemas extends RouteInputSchema | undefined = any,
> {
  readonly options: ResolvedRouteOptions
  readonly schemas?: TSchemas
  readonly validators: InputValidators
  readonly sseOptions: ResolvedSseOptions
  readonly handler: (
    ctx: Context,
    input: TInput,
  ) => SseHandlers<TEvents> | Response | Promise<SseHandlers<TEvents> | Response>
  readonly isRoute: true
  readonly isSse: true
}

/** Duplex WebSocket abstraction for active connections across Node and Cloudflare Workers. */
export interface Socket {
  /** Submits text or binary data to the underlying transport. */
  send(data: string | Uint8Array): void
  /** Initiates the closing handshake with an optional status code and reason string. */
  close(code?: number, reason?: string): void
  /** Abort signal triggered when the connection is closed, faulted, or drained. */
  readonly signal: AbortSignal
  /** Numeric connection state: 0 (CONNECTING), 1 (OPEN), 2 (CLOSING), 3 (CLOSED). */
  readonly readyState: number
}

/** Lifecycle and message event handlers for a WebSocket endpoint. */
export interface SocketHandlers {
  /** Invoked after the WebSocket handshake completes and the socket is ready for communication. */
  onOpen?(socket: Socket): void | Promise<void>
  /** Invoked concurrently for incoming messages without awaiting prior message execution. */
  onMessage?(socket: Socket, data: string | Uint8Array): void | Promise<void>
  /** Runs after transport closure and the completion of returned open, message, and error work. */
  onClose?(socket: Socket, code: number, reason: string): void | Promise<void>
  /** Invoked on unhandled callback exceptions, asynchronous rejections, or transport failures. */
  onError?(socket: Socket, error: unknown): void | Promise<void>
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

/**
 * Infers schema inputs and decoded output.
 * Generated paths supply parameters when the route declares no params schema.
 */
export type EndpointFromRoute<R, Path extends string = never> =
  R extends RouteDeclaration<never, infer Output, infer Schemas>
    ? {
        input: ClientInputFromSchemas<Schemas> &
          (Schemas extends { params: unknown } ? {} : DefaultPathInput<Path>)
        output: SuccessfulOutput<Awaited<Output>>
      }
    : { input: unknown; output: unknown }

/**
 * Infers typed schema inputs and the event-to-payload mapping for an SSE endpoint.
 * Request bodies are excluded from the inferred input.
 */
export type SseEndpointFromRoute<R, Path extends string = never> =
  R extends SseDeclaration<any, infer Events, infer Schemas>
    ? {
        input: (Schemas extends { params: unknown } ? SchemaField<Schemas, 'params'> : {}) &
          (Schemas extends { query: unknown } ? SchemaField<Schemas, 'query'> : {}) &
          (Schemas extends { headers: unknown } ? SchemaField<Schemas, 'headers'> : {}) &
          (Schemas extends { params: unknown } ? {} : DefaultPathInput<Path>)
        events: Events
      }
    : { input: unknown; events: Record<string, unknown> }

/**
 * Infers typed schema inputs for a WebSocket endpoint.
 * Request bodies are excluded from the inferred input.
 */
export type WsEndpointFromRoute<R, Path extends string = never> =
  R extends RouteDeclaration<any, any, infer Schemas>
    ? {
        input: (Schemas extends { params: unknown } ? SchemaField<Schemas, 'params'> : {}) &
          (Schemas extends { query: unknown } ? SchemaField<Schemas, 'query'> : {}) &
          (Schemas extends { headers: unknown } ? SchemaField<Schemas, 'headers'> : {}) &
          (Schemas extends { params: unknown } ? {} : DefaultPathInput<Path>)
      }
    : { input: unknown }
