/**
 * Page declarations, React components, navigation hooks, and shared contracts.
 *
 * @module
 */

export { definePage } from '../page/config'

export { DefaultRoot } from '../page/components/root'
export { Head, type HeadProps } from '../page/components/head'
export { Outlet } from '../page/components/outlet'
export { Scripts } from '../page/components/scripts'
export { Link, type LinkProps } from '../page/components/link'
export { DefaultError, ScopedErrorBoundary } from '../page/components/error'

export {
  useClient,
  useAction,
  useNavigate,
  useNavigation,
  useBlocker,
  reload,
  setIdentity,
} from '../page/hooks'
export { redirect, RedirectSignal, notFound, NotFoundSignal } from '../page/signals'

export type {
  ActionArgs,
  ActionResult,
  BlockerHandler,
  ErrorProps,
  IdentitySnapshot,
  LinkDescriptor,
  LoaderArgs,
  MetaArgs,
  MetaDescriptor,
  NavigateOptions,
  NavigationState,
  PageApiConfig,
  PageCacheConfig,
  PageConfig,
  PageDeclaration,
  PageError,
  PageIdentityResolver,
  ScriptDescriptor,
  ShouldRevalidateArgs,
} from '../page/types'
