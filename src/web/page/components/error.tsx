/**
 * Scoped presentation of loader errors and client-side rendering failures.
 *
 * @module
 */

import { Component, type ComponentType, type ReactNode } from 'react'

import { toPageError } from '../errors'
import { RedirectSignal } from '../signals'
import type { ErrorProps, PageError } from '../types'

/** Props for ScopedErrorBoundary. */
export interface ScopedErrorBoundaryProps {
  readonly scopeId: string
  readonly errorComponent?: ComponentType<ErrorProps>
  readonly initialError?: PageError
  readonly onRetry?: () => void
  readonly resetKey?: number
  readonly onRedirect?: (to: string) => void
  readonly children?: ReactNode
}

interface State {
  error: PageError | null
  initialError?: PageError
  resetKey?: number
  redirect?: string
}

/** Fallback error presentation component when no scoped _error is provided. */
export function DefaultError({ error, retry }: ErrorProps) {
  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>{error.status ? `Error ${error.status}` : 'Application Error'}</h1>
      <p>{error.message}</p>
      <button
        type="button"
        onClick={retry}
        style={{
          padding: '0.5rem 1rem',
          borderRadius: '4px',
          border: '1px solid #ccc',
          cursor: 'pointer',
        }}
      >
        Retry
      </button>
    </div>
  )
}

/**
 * Displays precomputed loader errors and catches rendering failures after hydration.
 * Server rendering failures are handled by the SSR renderer, not React class boundaries.
 * Retry delegates to the controller when available; otherwise it clears the local error.
 */
export class ScopedErrorBoundary extends Component<ScopedErrorBoundaryProps, State> {
  constructor(props: ScopedErrorBoundaryProps) {
    super(props)
    this.state = {
      error: props.initialError ?? null,
      initialError: props.initialError,
      resetKey: props.resetKey,
    }
  }

  static getDerivedStateFromError(error: unknown): State {
    return error instanceof RedirectSignal
      ? { error: null, redirect: error.url }
      : { error: toPageError(error) }
  }

  static getDerivedStateFromProps(
    props: ScopedErrorBoundaryProps,
    state: State,
  ): Partial<State> | null {
    if (
      props.initialError !== state.initialError ||
      (props.resetKey !== undefined && props.resetKey !== state.resetKey)
    ) {
      return {
        error: props.initialError ?? null,
        initialError: props.initialError,
        resetKey: props.resetKey,
        redirect: undefined,
      }
    }
    return null
  }

  componentDidCatch(error: unknown) {
    if (error instanceof RedirectSignal && this.props.onRedirect) this.props.onRedirect(error.url)
    else console.error('Page component failed', error)
  }

  handleRetry = () => {
    if (this.props.onRetry) this.props.onRetry()
    else this.setState({ error: null, redirect: undefined })
  }

  render() {
    if (this.state.redirect) return null
    if (this.state.error) {
      const Fallback = this.props.errorComponent ?? DefaultError
      return <Fallback error={this.state.error} retry={this.handleRetry} />
    }

    return this.props.children
  }
}
