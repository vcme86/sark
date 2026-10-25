import { getCurrentScope } from './context'

interface CacheNode {
  children: Map<unknown, CacheNode>
  value?: Promise<unknown>
}

/**
 * Reuses promises within one execution scope, including rejected promises.
 * Arguments are compared by Map key equality, so objects use identity unless
 * `keyFn` supplies a shared key. Outside a scope, calls execute without caching.
 *
 * @param fn - The async function to deduplicate.
 * @param keyFn - Optional function deriving one cache key from the full argument list.
 * @returns A wrapper sharing pending and settled promises for each key within a scope.
 */
export function dedup<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  keyFn?: (...args: Args) => unknown,
): (...args: Args) => Promise<R> {
  const fnKey = Symbol('dedup')
  return (...args) => {
    const store = getCurrentScope()?.dedupStore
    if (!store) return fn(...args)

    let node = store.get(fnKey) as CacheNode | undefined
    if (!node) {
      node = { children: new Map() }
      store.set(fnKey, node)
    }
    for (const key of keyFn ? [keyFn(...args)] : args) {
      let child = node.children.get(key)
      if (!child) {
        child = { children: new Map() }
        node.children.set(key, child)
      }
      node = child
    }
    // Each wrapper owns its cache tree, so its leaves all resolve to R.
    return (node.value ??= fn(...args)) as Promise<R>
  }
}
