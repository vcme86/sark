import type { JSONParsed } from 'hono/utils/types'

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
