import { Head, Outlet, Scripts } from '@olivaw/sark/page'

import './app.css'

export default function Root() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Head />
      </head>
      <body>
        <div id="app" className="site-wrapper">
          <Outlet />
        </div>
        <Scripts />
      </body>
    </html>
  )
}
