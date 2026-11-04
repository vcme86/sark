/** Default API prefix shared by engineering options and standalone HTTP clients. */
export const DEFAULT_API_PREFIX = '/api'

/** Fetch credentials mode used when the client has no explicit policy. */
export const DEFAULT_CLIENT_CREDENTIALS: RequestCredentials = 'same-origin'

/** Standard baseline security headers applied to HTTP responses. */
export const DEFAULT_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
} as const
