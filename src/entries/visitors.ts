/**
 * Visitor declarations, request contracts, and browser initialization.
 *
 * @module
 */

export { defineVisitors, type VisitorsDeclaration } from '../features/visitors/config'
export { ensureVisitor, type EnsureVisitorOptions } from '../features/visitors/browser'
export { VisitorError } from '../features/visitors/error'
export type {
  RequestVisitor,
  VisitorCookieConfig,
  VisitorsConfig,
} from '../features/visitors/types'
