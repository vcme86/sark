/**
 * Public visitor identity entrypoint for application declarations and server handlers.
 *
 * @module
 */

export { defineVisitors, type VisitorsDeclaration } from '../services/visitors/config'
export { VisitorError } from '../services/visitors/error'
export type {
  RequestVisitor,
  VisitorCookieConfig,
  VisitorsConfig,
} from '../services/visitors/types'
