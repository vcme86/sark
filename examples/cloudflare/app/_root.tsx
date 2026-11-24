import { Head, Outlet, Scripts } from '@olivaw/sark/page'

export default function Root() {
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
