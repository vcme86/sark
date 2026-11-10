/** Declaration preparation, route inheritance and ownership of ingress counters. */
import type { AdmissionRuntime, RouteAdmission, RouteEntry } from '../../app/http/assembly'
import type { MiddlewareHandler, RouteOptions } from '../../app/http/types'
import { resolveRateLimitConfig, resolveRateLimitDeclaration } from './declaration'
import { createRateLimitMiddleware } from './middleware'
import { NodeRateLimiter } from './node'
import type { RateLimitConfig, RateLimitDeclaration, ResolvedRateLimitConfig } from './types'

/** Creates a policy runtime without evaluating the declaration or starting counters. */
export function createRateLimitAssembly(declaration: RateLimitDeclaration): () => AdmissionRuntime {
  return () => {
    let staticConfig: ResolvedRateLimitConfig | undefined
    let previousRoutes: readonly RouteEntry[] | undefined
    let previousAdmission: RouteAdmission | undefined
    const overrides = new WeakMap<object, object>()
    return {
      prepare(env, routes, target) {
        const base = declaration.isFactory
          ? resolveRateLimitDeclaration(declaration, env)!
          : (staticConfig ??= resolveRateLimitDeclaration(declaration, env)!)
        if (base.kind !== target) {
          throw new Error(`Rate limit configuration is not supported on the ${target} host.`)
        }
        if (
          !declaration.isFactory &&
          previousRoutes &&
          routes.length === previousRoutes.length &&
          routes.every((route, index) => route === previousRoutes![index])
        )
          return previousAdmission!

        const counter = base.kind === 'node' ? new NodeRateLimiter(base) : undefined
        const defaultAdmission = createRateLimitMiddleware(base, counter)
        const admissions = new Map<RouteEntry, MiddlewareHandler | undefined>()
        const merged = new WeakMap<
          object,
          WeakMap<ResolvedRateLimitConfig, ResolvedRateLimitConfig>
        >()
        const merge = (
          parent: ResolvedRateLimitConfig | false,
          input: RouteOptions['rateLimit'],
        ) => {
          if (input === undefined) return parent
          if (input === false) return false
          let partial = overrides.get(input)
          if (!partial) {
            partial = Object.fromEntries(
              Object.entries(input).filter(([, value]) => value !== undefined),
            )
            overrides.set(input, partial)
          }
          const inherited = parent === false ? base : parent
          if (Object.keys(partial).length === 0) return inherited
          let byParent = merged.get(input)
          if (!byParent) {
            byParent = new WeakMap()
            merged.set(input, byParent)
          }
          let resolved = byParent.get(inherited)
          if (!resolved) {
            resolved = resolveRateLimitConfig({ ...inherited, ...partial } as RateLimitConfig)
            byParent.set(inherited, resolved)
          }
          return resolved
        }
        for (const entry of routes) {
          if (entry.routePath.isWs) {
            admissions.set(entry, undefined)
            continue
          }
          let effective: ResolvedRateLimitConfig | false = base
          for (const scope of entry.scopes ?? [])
            effective = merge(effective, scope.options?.rateLimit)
          if (!('pageHandler' in entry))
            effective = merge(effective, entry.declaration.options.rateLimit)
          if (effective === false) {
            admissions.set(entry, undefined)
            continue
          }
          const inheritedCounter = sameCounter(base, effective) ? counter : undefined
          const middleware =
            effective === base
              ? defaultAdmission
              : createRateLimitMiddleware(effective, inheritedCounter)
          admissions.set(entry, middleware)
        }
        const admission: RouteAdmission = (entry) =>
          entry ? admissions.get(entry) : defaultAdmission
        if (!declaration.isFactory) {
          previousRoutes = routes
          previousAdmission = admission
        }
        return admission
      },
    }
  }
}

function sameCounter(left: ResolvedRateLimitConfig, right: ResolvedRateLimitConfig): boolean {
  if (left.kind !== right.kind || left.key !== right.key) return false
  if (left.kind === 'node' && right.kind === 'node') {
    return (
      left.window === right.window && left.limit === right.limit && left.maxKeys === right.maxKeys
    )
  }
  return left.kind === 'cloudflare' && right.kind === 'cloudflare' && left.binding === right.binding
}
