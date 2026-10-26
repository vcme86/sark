/**
 * Isomorphic page declarations, control signals, and shared types.
 *
 * @module
 */

export { definePage } from '../web/page/config'
export { notFound, NotFoundSignal, redirect, RedirectSignal } from '../web/page/signals'
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
} from '../web/page/types'
