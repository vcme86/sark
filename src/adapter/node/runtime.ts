import { isIP } from 'node:net'

import type { BaseDeclaration, RequiresEnv } from '../../core/declaration'
import {
  type CompressionOptions,
  DEFAULT_COMPRESSION_OPTIONS,
  resolveCompression,
  type ResolvedCompressionOptions,
} from '../../web/http/compression'
export type { CompressionOptions } from '../../web/http/compression'

/** Node runtime deployment configuration options. */
export interface NodeRuntimeOptions {
  /**
   * Integer TCP port to listen on (0–65535).
   * Resolution priority: explicit `port` option > `PORT` environment variable > default `3000`.
   * Pass `0` to bind to an ephemeral OS-assigned port.
   *
   * @default 3000
   */
  port?: number

  /**
   * Hostname or IP address interface to bind.
   * When omitted or undefined, binds to all available network interfaces (`0.0.0.0` or `::`).
   *
   * @default undefined
   */
  hostname?: string

  /**
   * HTTP response compression policy.
   * Pass `true` for default gzip settings, `false` to disable the default policy,
   * or an options object for custom encoding and threshold. Explicit compress middleware
   * can override this policy for individual requests.
   *
   * @default true
   */
  compress?: boolean | CompressionOptions

  /** Graceful shutdown timing configuration. */
  shutdown?: {
    /**
     * Total shutdown budget in milliseconds. Manual close rejects on timeout;
     * signal-triggered shutdown exits the process when close completes or fails.
     * @default 10000 (10 seconds)
     */
    deadline?: number

    /**
     * Time in milliseconds reserved within the deadline for resource disposal after request draining.
     * Must be strictly greater than 0 and less than `deadline`.
     * @default 2000 (2 seconds)
     */
    reserve?: number
  }

  /**
   * Built-in HTTP health check probe endpoints.
   * Pass `false` to disable probe endpoints, or an object specifying custom endpoint paths.
   *
   * @default { liveness: '/livez', readiness: '/readyz' }
   */
  probes?:
    | false
    | {
        /**
         * Liveness endpoint path; returns HTTP 200 regardless of application state.
         * @default '/livez'
         */
        liveness?: string

        /**
         * Readiness endpoint path; returns HTTP 200 only when ready, HTTP 503 otherwise.
         * @default '/readyz'
         */
        readiness?: string
      }
}

/** Declaration representation for Node runtime configuration. */
export interface NodeRuntimeDeclaration extends BaseDeclaration<
  'runtime_node',
  NodeRuntimeOptions
> {}

/** Default options for the Node runtime. */
export const DEFAULT_NODE_RUNTIME_OPTIONS = {
  port: 3000,
  compress: DEFAULT_COMPRESSION_OPTIONS,
  shutdown: { deadline: 10000, reserve: 2000 },
  probes: { liveness: '/livez', readiness: '/readyz' },
}

/** Fully resolved Node runtime configuration with all defaults applied. */
export interface ResolvedNodeRuntimeOptions {
  readonly port: number
  readonly hostname?: string
  readonly compress: false | ResolvedCompressionOptions
  readonly shutdown: { readonly deadline: number; readonly reserve: number }
  readonly probes: false | { readonly liveness: string; readonly readiness: string }
}

/**
 * Declares the Node runtime configuration for the application.
 * Accepts a static options object or a factory receiving the environment.
 *
 * @param options - Listening, compression, shutdown, and probe settings.
 * @returns A runtime declaration resolved when the Node server starts.
 */
export function defineNodeRuntime(options?: NodeRuntimeOptions): NodeRuntimeDeclaration
/**
 * Declares Node runtime settings resolved from the environment.
 *
 * @param factory - Options factory evaluated when the Node server starts.
 * @returns A declaration preserving the factory's environment requirement.
 */
export function defineNodeRuntime<E>(
  factory: (env: E) => NodeRuntimeOptions,
): NodeRuntimeDeclaration & RequiresEnv<E>
export function defineNodeRuntime<E>(
  input?: NodeRuntimeOptions | ((env: E) => NodeRuntimeOptions),
): NodeRuntimeDeclaration & RequiresEnv<E> {
  return {
    kind: 'runtime_node',
    value: input === undefined ? {} : input,
    isFactory: typeof input === 'function',
  } as NodeRuntimeDeclaration & RequiresEnv<E>
}

/**
 * Resolves Node runtime options from a declaration and environment variables.
 * Validates port numbers (0–65535) and shutdown deadline/reserve constraints.
 *
 * @param declaration - Static or factory declaration; omitted declarations use defaults.
 * @param env - Factory input and PORT source. This function does not load environment files.
 * @returns Options with listening, compression, shutdown, and probe defaults applied.
 * @throws {Error} If the port, hostname, or shutdown timing is invalid.
 */
export function resolveNodeRuntime(
  declaration?: NodeRuntimeDeclaration,
  env?: any,
): ResolvedNodeRuntimeOptions {
  let opts: NodeRuntimeOptions = {}
  if (declaration) {
    if (typeof declaration.value === 'function') {
      if (env === undefined)
        throw new Error('Environment required by runtime declaration factory was not provided.')
      opts = declaration.value(env)
    } else {
      opts = declaration.value
    }
  }

  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new Error('Node runtime configuration must be an object.')
  }

  for (const [field, value] of Object.entries(opts)) {
    if (value === null) throw new Error(`runtime.${field} does not accept null.`)
  }

  let resolvedPort = opts.port
  if (resolvedPort === undefined && env?.PORT !== undefined) {
    const parsed = Number(env.PORT)
    if (
      !/^\d+$/.test(String(env.PORT).trim()) ||
      !Number.isInteger(parsed) ||
      parsed < 0 ||
      parsed > 65535
    ) {
      throw new Error(
        `Invalid PORT environment variable value: "${env.PORT}". Expected integer 0-65535.`,
      )
    }
    resolvedPort = parsed
  }
  if (resolvedPort === undefined) {
    resolvedPort = DEFAULT_NODE_RUNTIME_OPTIONS.port
  } else if (!Number.isInteger(resolvedPort) || resolvedPort < 0 || resolvedPort > 65535) {
    throw new Error(`Invalid port configured: ${resolvedPort}. Expected integer 0-65535.`)
  }

  const resolvedHostname = opts.hostname
  if (
    resolvedHostname !== undefined &&
    (!resolvedHostname.trim() ||
      /[\s/]/.test(resolvedHostname) ||
      (resolvedHostname.includes(':') && isIP(resolvedHostname) !== 6))
  ) {
    throw new Error('hostname must be a non-empty host name or IP address.')
  }

  const deadline =
    opts.shutdown?.deadline === undefined
      ? DEFAULT_NODE_RUNTIME_OPTIONS.shutdown.deadline
      : opts.shutdown.deadline
  const reserve =
    opts.shutdown?.reserve === undefined
      ? DEFAULT_NODE_RUNTIME_OPTIONS.shutdown.reserve
      : opts.shutdown.reserve
  if (
    !Number.isFinite(deadline) ||
    !Number.isFinite(reserve) ||
    reserve <= 0 ||
    reserve >= deadline
  ) {
    throw new Error(
      `Invalid shutdown timing: reserve (${reserve}) must be > 0 and < deadline (${deadline}).`,
    )
  }

  let resolvedProbes: false | { liveness: string; readiness: string } = false
  if (opts.probes !== false) {
    resolvedProbes = {
      liveness:
        opts.probes?.liveness === undefined
          ? DEFAULT_NODE_RUNTIME_OPTIONS.probes.liveness
          : opts.probes.liveness,
      readiness:
        opts.probes?.readiness === undefined
          ? DEFAULT_NODE_RUNTIME_OPTIONS.probes.readiness
          : opts.probes.readiness,
    }
    for (const [field, path] of Object.entries(resolvedProbes)) {
      if (typeof path !== 'string' || !path.startsWith('/') || /[?#\s]/.test(path)) {
        throw new Error(`runtime.probes.${field} must be an absolute URL path.`)
      }
    }
    if (resolvedProbes.liveness === resolvedProbes.readiness) {
      throw new Error('runtime.probes paths must be distinct.')
    }
  }

  return {
    port: resolvedPort,
    hostname: resolvedHostname,
    compress: resolveCompression(
      opts.compress === undefined ? DEFAULT_NODE_RUNTIME_OPTIONS.compress : opts.compress,
    ),
    shutdown: { deadline, reserve },
    probes: resolvedProbes,
  }
}
