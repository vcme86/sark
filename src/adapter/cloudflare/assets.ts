/**
 * Cache-Control policy for Cloudflare Workers build assets.
 *
 * @module
 */

/**
 * Applies immutable caching to successful hashed assets and no-cache to other responses.
 *
 * @param response - Original asset response returned by platform ASSETS binding.
 * @param hashed - Whether the completed build identifies this URL as content-hashed.
 * @returns Response with adjusted Cache-Control header.
 */
export function decorateCloudflareAssetResponse(response: Response, hashed: boolean): Response {
  const cacheControl =
    hashed && response.status < 400 ? 'public, max-age=31536000, immutable' : 'no-cache'

  const headers = new Headers(response.headers)
  headers.set('cache-control', cacheControl)

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
