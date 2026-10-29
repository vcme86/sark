/**
 * Visitor service error classification.
 *
 * @module
 */

import { HttpError } from '../../http/error'

/** Error raised when visitor operations fail or violate lifecycle boundaries. */
export class VisitorError extends HttpError {
  constructor(message: string, code = 'response_committed', status = 500) {
    super(status, message, { code })
    this.name = 'VisitorError'
  }
}
