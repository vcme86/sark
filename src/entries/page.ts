/**
 * Isomorphic page declarations, control signals, and shared types.
 *
 * @module
 */

export { definePage } from '../page/config'
export { notFound, NotFoundSignal, redirect, RedirectSignal } from '../page/signals'
export type {
  ActionArgs,
  ActionResult,
  ErrorProps,
  IdentitySnapshot,
  LinkDescriptor,
  LoaderArgs,
  MetaArgs,
  MetaDescriptor,
  PageApiConfig,
  PageCacheConfig,
  PageConfig,
  PageDeclaration,
  PageError,
  PageIdentityCallback,
  ScriptDescriptor,
  ShouldRevalidateArgs,
} from '../page/types'
