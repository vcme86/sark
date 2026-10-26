/**
 * React page components, navigation hooks, and client signals.
 *
 * @module
 */

export { DefaultError, ScopedErrorBoundary } from '../web/page/components/error'
export { Head, type HeadProps } from '../web/page/components/head'
export { Link, type LinkProps } from '../web/page/components/link'
export { Outlet } from '../web/page/components/outlet'
export { DefaultRoot } from '../web/page/components/root'
export { Scripts } from '../web/page/components/scripts'
export type { BlockerHandler, NavigateOptions, NavigationState } from '../web/page/context'
export {
  reload,
  setIdentity,
  useAction,
  useBlocker,
  useClient,
  useNavigate,
  useNavigation,
} from '../web/page/hooks'
export { notFound, NotFoundSignal, redirect, RedirectSignal } from '../web/page/signals'
export type {
  ActionArgs,
  ActionResult,
  ErrorProps,
  IdentitySnapshot,
  PageError,
} from '../web/page/types'
