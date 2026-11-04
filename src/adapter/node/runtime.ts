import { isIP } from 'node:net'

import { type BaseDeclaration, evaluateDeclaration, type RequiresEnv } from '../../app/declaration'
import type { AppDefinition } from '../../app/definition'
import { DEFAULT_SHUTDOWN_BUDGET } from '../../app/lifecycle'
import {
  type CompressionOptions,
  resolveCompression,
  type ResolvedCompressionOptions,
} from '../../middleware/compression'
import type { PreparedHealthChecks } from './probes'
export type { CompressionOptions } from '../../middleware/compression'

/** Node runtime deployment configuration. */
export interface NodeRuntimeConfig {
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

  /** Graceful shutdown and Node development instance handoff budgets. */
  shutdown?: {
    /**
     * Total shutdown or development handoff budget in milliseconds. Manual close rejects on timeout;
     * signal-triggered shutdown exits the process when close completes or fails.
     *
     * @default 10000 (10 seconds)
     */
    deadline?: number

    /**
     * Time in milliseconds reserved within the deadline for cancellation and resource disposal
     * after the graceful request-draining window.
     * Must be strictly greater than 0 and less than `deadline`.
     *
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
         *
         * @default '/livez'
         */
        liveness?: string

        /**
         * Readiness endpoint path; returns HTTP 200 only when ready, HTTP 503 otherwise.
         *
         * @default '/readyz'
         */
        readiness?: string
      }
}

/** Declaration representation for Node runtime configuration. */
export interface NodeRuntimeDeclaration extends BaseDeclaration<
  'runtime_node',
  NodeRuntimeConfig
> {}

/** Default Node runtime configuration. */
const DEFAULT_NODE_RUNTIME_CONFIG = {
  port: 3000,
  shutdown: DEFAULT_SHUTDOWN_BUDGET,
  probes: { liveness: '/livez', readiness: '/readyz' },
}

/** Fully resolved Node runtime configuration with all defaults applied. */
export interface ResolvedNodeRuntimeConfig {
  readonly port: number
  readonly hostname?: string
  readonly compress: false | ResolvedCompressionOptions
  readonly shutdown: { readonly deadline: number; readonly reserve: number }
  readonly probes: false | { readonly liveness: string; readonly readiness: string }
}

/** Host settings and optional checks prepared before application resource creation. */
export interface PreparedNodeRuntime extends ResolvedNodeRuntimeConfig {
  readonly health?: PreparedHealthChecks
}

/**
 * Prepares host settings before application resources open.
 *
 * @param definition - Generated definition carrying optional health preparation.
 * @param declaration - Node runtime declaration, absent for default host settings.
 * @param env - Loaded host environment supplied to runtime and health factories.
 * @returns Settings consumed directly by the listener or development adapter.
 * @throws If host settings are invalid or health is combined with disabled probes.
 */
export function prepareNodeRuntime(
  definition: AppDefinition,
  declaration: NodeRuntimeDeclaration | undefined,
  env: unknown,
): PreparedNodeRuntime {
  const config = resolveNodeRuntime(declaration, env)
  return { ...config, health: definition.health?.(env, config.probes !== false) }
}

/**
 * Declares the Node runtime configuration for the application.
 * Accepts a static configuration object or a factory receiving the environment.
 *
 * @param config - Listening, compression, shutdown, and probe settings.
 * @returns A declaration resolved at Node startup or when Vite creates a Node application instance.
 */
export function defineNodeRuntime(config?: NodeRuntimeConfig): NodeRuntimeDeclaration
/**
 * Declares Node runtime settings resolved from the environment.
 *
 * @param factory - Configuration factory evaluated at Node startup or Vite instance creation.
 * @returns A declaration preserving the factory's environment requirement.
 */
export function defineNodeRuntime<E>(
  factory: (env: E) => NodeRuntimeConfig,
): NodeRuntimeDeclaration & RequiresEnv<E>
export function defineNodeRuntime<E>(
  input?: NodeRuntimeConfig | ((env: E) => NodeRuntimeConfig),
): NodeRuntimeDeclaration {
  return {
    kind: 'runtime_node',
    value: input === undefined ? {} : input,
    isFactory: typeof input === 'function',
  }
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
): ResolvedNodeRuntimeConfig {
  const input = declaration ? evaluateDeclaration(declaration.value, env, 'runtime') : {}

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Node runtime configuration must be an object.')
  }

  for (const [field, value] of Object.entries(input)) {
    if (value === null) throw new Error(`runtime.${field} does not accept null.`)
  }

  let resolvedPort = input.port
  if (resolvedPort !== undefined) {
    if (!Number.isInteger(resolvedPort) || resolvedPort < 0 || resolvedPort > 65535) {
      throw new Error(`Invalid port configured: ${resolvedPort}. Expected integer 0-65535.`)
    }
  } else if (env?.PORT !== undefined) {
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
  } else {
    resolvedPort = DEFAULT_NODE_RUNTIME_CONFIG.port
  }

  const resolvedHostname = input.hostname
  if (
    resolvedHostname !== undefined &&
    (!resolvedHostname.trim() ||
      /[\s/]/.test(resolvedHostname) ||
      (resolvedHostname.includes(':') && isIP(resolvedHostname) !== 6))
  ) {
    throw new Error('hostname must be a non-empty host name or IP address.')
  }

  const deadline =
    input.shutdown?.deadline === undefined
      ? DEFAULT_NODE_RUNTIME_CONFIG.shutdown.deadline
      : input.shutdown.deadline
  const reserve =
    input.shutdown?.reserve === undefined
      ? DEFAULT_NODE_RUNTIME_CONFIG.shutdown.reserve
      : input.shutdown.reserve
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
  if (input.probes !== false) {
    resolvedProbes = {
      liveness:
        input.probes?.liveness === undefined
          ? DEFAULT_NODE_RUNTIME_CONFIG.probes.liveness
          : input.probes.liveness,
      readiness:
        input.probes?.readiness === undefined
          ? DEFAULT_NODE_RUNTIME_CONFIG.probes.readiness
          : input.probes.readiness,
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
    compress: resolveCompression(input.compress),
    shutdown: { deadline, reserve },
    probes: resolvedProbes,
  }
}
