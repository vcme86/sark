/**
 * HTTP security and performance middleware.
 *
 * @module
 */

export { cors } from '../web/http/middleware/cors'
export { csrf, type CsrfOptions } from '../web/http/middleware/csrf'
export { compress, type CompressionOptions } from '../web/http/middleware/compress'
export type { CorsOptions } from '../core/config'
