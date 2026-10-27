import { DEFAULT_API_PREFIX, DEFAULT_CLIENT_CREDENTIALS } from '../defaults'
import { HttpError } from '../error'
import { decodeResponse } from './decode'
import { buildUrl, encodeBody, type RequestData } from './encode'

/**
 * Global declaration merging interface for registering application API types.
 * Extended in the configured generated directory's types.d.ts during build or development.
 */
export interface Register {}

/** Resolved default API type derived from the global `Register` interface. */
export type DefaultApi = import('@olivaw/sark/http').Register extends { api: infer A } ? A : unknown

/** Options configuring an HTTP client instance. */
export interface ClientOptions {
  /**
   * Base URL prefix for all requests (e.g. `'/api'` or `'https://api.example.com'`).
   * @default '/api'
   */
  baseUrl?: string

  /**
   * Credentials mode for outgoing requests (`'same-origin'`, `'include'`, or `'omit'`).
   * Defaults to fetch standard `'same-origin'`.
   * @default 'same-origin'
   */
  credentials?: RequestCredentials

  /** Default headers or an async factory returning headers to attach to every request. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>)

  /** Custom fetch function implementation (defaults to global fetch). */
  fetch?: (request: Request) => Promise<Response>
}

/** Per-call request options including query, params, body, headers, and fetch init. */
export interface ClientCallOptions extends RequestData {
  /** Additional RequestInit parameters excluding method, body, and headers. */
  init?: Omit<RequestInit, 'method' | 'body' | 'headers'>
}

type MethodEndpoint<Methods, Method extends string> = Method extends keyof Methods
  ? Methods[Method]
  : 'ALL' extends keyof Methods
    ? Methods['ALL']
    : never

export type ExtractPaths<Api, Method extends string> =
  Api extends Record<string, unknown>
    ? {
        [Path in keyof Api & string]: [MethodEndpoint<Api[Path], Method>] extends [never]
          ? never
          : Path
      }[keyof Api & string]
    : string

export type EndpointInput<Api, Method extends string, Path extends string> =
  Api extends Record<string, unknown>
    ? Path extends keyof Api
      ? MethodEndpoint<Api[Path], Method> extends { input: infer Input }
        ? Input
        : undefined
      : undefined
    : undefined

export type ExtractOutput<Api, Method extends string, Path extends string, Fallback = unknown> =
  Api extends Record<string, unknown>
    ? Path extends keyof Api
      ? MethodEndpoint<Api[Path], Method> extends { output: infer Output }
        ? Awaited<Output>
        : Fallback
      : Fallback
    : Fallback

type IsRequired<T> = undefined extends T ? false : [T] extends [never] ? false : true

type HasRequiredInput<I> = I extends object
  ? (
      I extends { params: infer P } ? (IsRequired<P> extends true ? true : false) : false
    ) extends true
    ? true
    : (
          I extends { query: infer Q } ? (IsRequired<Q> extends true ? true : false) : false
        ) extends true
      ? true
      : (
            I extends { json: infer J } ? (IsRequired<J> extends true ? true : false) : false
          ) extends true
        ? true
        : (
              I extends { form: infer F } ? (IsRequired<F> extends true ? true : false) : false
            ) extends true
          ? true
          : (
                I extends { text: infer T } ? (IsRequired<T> extends true ? true : false) : false
              ) extends true
            ? true
            : false
  : false

type SafeBodyForMethod<Method extends string> = Method extends 'GET' | 'HEAD'
  ? { json?: never; form?: never; text?: never }
  : {}

export type ClientOptionsFor<Api, Method extends string, Path extends string> =
  Api extends Record<string, unknown>
    ? (EndpointInput<Api, Method, Path> extends object ? EndpointInput<Api, Method, Path> : {}) & {
        headers?: HeadersInit
        init?: Omit<RequestInit, 'method' | 'body' | 'headers'>
      } & SafeBodyForMethod<Method>
    : ClientCallOptions & SafeBodyForMethod<Method>

export type ClientArgsFor<Api, Method extends string, Path extends string> =
  Api extends Record<string, unknown>
    ? HasRequiredInput<EndpointInput<Api, Method, Path>> extends true
      ? [options: ClientOptionsFor<Api, Method, Path>]
      : [options?: ClientOptionsFor<Api, Method, Path>]
    : [options?: ClientCallOptions & SafeBodyForMethod<Method>]

/**
 * Strongly-typed HTTP client interface.
 * When parameterized with `Api`, methods constrain paths and automatically infer return types.
 * Convenience methods decode successful responses by Content-Type and reject
 * non-2xx responses with HttpError. Transport and body parsing failures propagate.
 */
export interface HttpClient<Api = unknown> {
  /**
   * Sends a GET request and decodes the response according to Content-Type.
   *
   * @param path - Route template relative to the client's base URL.
   * @param args - Endpoint parameters, query, headers, and fetch options; request bodies are excluded.
   * @returns The decoded success body, or undefined for HTTP 204/205.
   * @throws {HttpError} If a non-2xx response body is successfully decoded.
   */
  get<Path extends ExtractPaths<Api, 'GET'>, T = unknown>(
    path: Path,
    ...args: ClientArgsFor<Api, 'GET', Path>
  ): Promise<ExtractOutput<Api, 'GET', Path, T>>

  /**
   * Sends a POST request with the selected body encoding.
   *
   * @param path - Route template relative to the client's base URL.
   * @param args - Endpoint input and call options; json, form, and text are mutually exclusive.
   * @returns The decoded success body, or undefined for HTTP 204/205.
   * @throws {HttpError} If a non-2xx response body is successfully decoded.
   */
  post<Path extends ExtractPaths<Api, 'POST'>, T = unknown>(
    path: Path,
    ...args: ClientArgsFor<Api, 'POST', Path>
  ): Promise<ExtractOutput<Api, 'POST', Path, T>>

  /**
   * Sends a QUERY request with the endpoint's declared body encoding.
   *
   * @param path - Route template relative to the client's base URL.
   * @param args - Endpoint input and call options, including the selected body field.
   * @returns The decoded success body, or undefined for HTTP 204/205.
   * @throws {HttpError} If a non-2xx response body is successfully decoded.
   */
  query<Path extends ExtractPaths<Api, 'QUERY'>, T = unknown>(
    path: Path,
    ...args: ClientArgsFor<Api, 'QUERY', Path>
  ): Promise<ExtractOutput<Api, 'QUERY', Path, T>>

  /**
   * Sends a PUT request with the selected body encoding.
   *
   * @param path - Route template relative to the client's base URL.
   * @param args - Endpoint input and call options; json, form, and text are mutually exclusive.
   * @returns The decoded success body, or undefined for HTTP 204/205.
   * @throws {HttpError} If a non-2xx response body is successfully decoded.
   */
  put<Path extends ExtractPaths<Api, 'PUT'>, T = unknown>(
    path: Path,
    ...args: ClientArgsFor<Api, 'PUT', Path>
  ): Promise<ExtractOutput<Api, 'PUT', Path, T>>

  /**
   * Sends a PATCH request with the selected body encoding.
   *
   * @param path - Route template relative to the client's base URL.
   * @param args - Endpoint input and call options; json, form, and text are mutually exclusive.
   * @returns The decoded success body, or undefined for HTTP 204/205.
   * @throws {HttpError} If a non-2xx response body is successfully decoded.
   */
  patch<Path extends ExtractPaths<Api, 'PATCH'>, T = unknown>(
    path: Path,
    ...args: ClientArgsFor<Api, 'PATCH', Path>
  ): Promise<ExtractOutput<Api, 'PATCH', Path, T>>

  /**
   * Sends a DELETE request and decodes the response.
   *
   * @param path - Route template relative to the client's base URL.
   * @param args - Endpoint input and call options, including a body if declared by the endpoint.
   * @returns The decoded success body, or undefined for HTTP 204/205.
   * @throws {HttpError} If a non-2xx response body is successfully decoded.
   */
  delete<Path extends ExtractPaths<Api, 'DELETE'>, T = unknown>(
    path: Path,
    ...args: ClientArgsFor<Api, 'DELETE', Path>
  ): Promise<ExtractOutput<Api, 'DELETE', Path, T>>

  /**
   * Sends an OPTIONS request and decodes the response.
   *
   * @param path - Route template relative to the client's base URL.
   * @param args - Endpoint input and call options.
   * @returns The decoded success body, or undefined for HTTP 204/205.
   * @throws {HttpError} If a non-2xx response body is successfully decoded.
   */
  options<Path extends ExtractPaths<Api, 'OPTIONS'>, T = unknown>(
    path: Path,
    ...args: ClientArgsFor<Api, 'OPTIONS', Path>
  ): Promise<ExtractOutput<Api, 'OPTIONS', Path, T>>

  /**
   * Sends a HEAD request without reading its body, including non-2xx responses.
   *
   * @param path - Route template relative to the client's base URL.
   * @param args - Endpoint parameters, query, headers, and fetch options; request bodies are excluded.
   * @returns The successful Response, including status and headers.
   * @throws {HttpError} For a non-2xx response, retaining its status and headers.
   */
  head<Path extends ExtractPaths<Api, 'HEAD'>>(
    path: Path,
    ...args: ClientArgsFor<Api, 'HEAD', Path>
  ): Promise<Response>

  /**
   * Sends a raw HTTP request without typed encoding or automatic error throwing on non-2xx.
   * Inherits default credentials and headers from `ClientOptions`.
   *
   * @param method - HTTP method sent without endpoint type constraints.
   * @param path - Absolute HTTP(S) URL, or a path relative to the client's base URL.
   * @param init - Fetch options including body, headers, credentials, and cancellation signal.
   * @returns The unconsumed Response regardless of HTTP status; transport failures still reject.
   */
  requestRaw(method: string, path: string, init?: RequestInit): Promise<Response>
}

/**
 * Creates an HTTP client instance.
 * Automatically resolves the application's registered API type if available,
 * or accepts a custom API type generic `createClient<MyApi>()`.
 *
 * @param options - Base URL, request defaults, and optional fetch implementation.
 * @returns A client using registered or explicitly supplied API types.
 *
 * @example
 * ```ts
 * import { createClient } from '@olivaw/sark/http'
 *
 * const client = createClient()
 * const users = await client.get('/users')
 * ```
 */
export function createClient<Api = DefaultApi>(options: ClientOptions = {}): HttpClient<Api> {
  const baseUrl = options.baseUrl ?? DEFAULT_API_PREFIX
  const defaultCredentials = options.credentials ?? DEFAULT_CLIENT_CREDENTIALS
  const defaultHeaders =
    typeof options.headers === 'function' ? options.headers : new Headers(options.headers)
  const customFetch = options.fetch ?? ((req: Request) => fetch(req))

  async function resolveHeaders(callHeaders?: HeadersInit): Promise<Headers> {
    const headers = new Headers(
      typeof defaultHeaders === 'function' ? await defaultHeaders() : defaultHeaders,
    )
    if (!headers.has('Accept')) headers.set('Accept', 'application/json')

    if (callHeaders) {
      new Headers(callHeaders).forEach((val, key) => headers.set(key, val))
    }

    return headers
  }

  async function send(
    method: string,
    path: string,
    callOptions?: ClientCallOptions,
  ): Promise<Response> {
    const url = buildUrl(baseUrl, path, callOptions?.params, callOptions?.query)
    const headers = await resolveHeaders(callOptions?.headers)
    const body = callOptions ? encodeBody(callOptions, headers) : undefined
    const credentials = callOptions?.init?.credentials ?? defaultCredentials

    return customFetch(
      new Request(url, {
        ...callOptions?.init,
        method,
        headers,
        body,
        credentials,
      }),
    )
  }

  return {
    async get(path: string, ...args: any[]): Promise<any> {
      return decodeResponse(await send('GET', path, args[0]))
    },

    async post(path: string, ...args: any[]): Promise<any> {
      return decodeResponse(await send('POST', path, args[0]))
    },

    async query(path: string, ...args: any[]): Promise<any> {
      return decodeResponse(await send('QUERY', path, args[0]))
    },

    async put(path: string, ...args: any[]): Promise<any> {
      return decodeResponse(await send('PUT', path, args[0]))
    },

    async patch(path: string, ...args: any[]): Promise<any> {
      return decodeResponse(await send('PATCH', path, args[0]))
    },

    async delete(path: string, ...args: any[]): Promise<any> {
      return decodeResponse(await send('DELETE', path, args[0]))
    },

    async options(path: string, ...args: any[]): Promise<any> {
      return decodeResponse(await send('OPTIONS', path, args[0]))
    },

    async head(path: string, ...args: any[]): Promise<Response> {
      const res = await send('HEAD', path, args[0])
      if (!res.ok) {
        throw new HttpError(res.status, `Request failed with status ${res.status}`, {
          code: 'http_error',
          headers: res.headers,
        })
      }
      return res
    },

    async requestRaw(method: string, path: string, init?: RequestInit): Promise<Response> {
      const url =
        path.startsWith('http://') || path.startsWith('https://') ? path : buildUrl(baseUrl, path)

      const headers = await resolveHeaders(init?.headers)
      const credentials = init?.credentials ?? defaultCredentials
      return customFetch(
        new Request(url, {
          ...init,
          method,
          headers,
          credentials,
        }),
      )
    },
  } as HttpClient<Api>
}
