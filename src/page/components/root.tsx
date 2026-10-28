/**
 * Default HTML document root used when the configured website tree omits _root.tsx/.jsx.
 *
 * @module
 */

import { Head } from './head'
import { Outlet } from './outlet'
import { Scripts } from './scripts'

/** Fallback root document combining Head, Outlet, and Scripts. */
export function DefaultRoot() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Head />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  )
}
