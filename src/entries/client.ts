/**
 * React page components, navigation hooks, and client signals.
 *
 * @module
 */

export { DefaultError, ScopedErrorBoundary } from '../page/components/error'
export { Head, type HeadProps } from '../page/components/head'
export { Link, type LinkProps } from '../page/components/link'
export { Outlet } from '../page/components/outlet'
export { DefaultRoot } from '../page/components/root'
export { Scripts } from '../page/components/scripts'
export {
  reload,
  setIdentity,
  useAction,
  useBlocker,
  useClient,
  useNavigate,
  useNavigation,
} from '../page/hooks'
export { notFound, NotFoundSignal, redirect, RedirectSignal } from '../page/signals'
export type {
  ActionArgs,
  ActionResult,
  BlockerHandler,
  ErrorProps,
  IdentitySnapshot,
  NavigateOptions,
  NavigationState,
  PageError,
} from '../page/types'
