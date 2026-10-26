import type { Context } from 'hono'

/**
 * Merges restrictive API cache directives into the enclosing page response.
 * Cookie-bearing responses force private, no-store; Cookie forwarding belongs to the transport.
 *
 * @param context - Outer page request context accumulating response headers.
 * @param response - Completed internal or remote API response, whose body is not consumed.
 */
export function captureResponsePolicy(context: Context, response: Response): void {
  const restrictions = (response.headers.get('cache-control') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^(private|no-store|no-cache)(?:$|=)/i.test(value))
  if (response.headers.getSetCookie().length) restrictions.push('private', 'no-store')
  if (!restrictions.length) return
  const previous = (context.res.headers.get('cache-control') ?? '').split(',')
  context.header(
    'Cache-Control',
    [
      ...new Set([
        ...previous
          .map((value) => value.trim())
          .filter((value) => value && value.toLowerCase() !== 'public'),
        ...restrictions,
      ]),
    ].join(', '),
  )
}
