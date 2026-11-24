import type { LoaderArgs } from '@olivaw/sark/page'

export async function loader({ client, signal }: LoaderArgs) {
  return client.get('/status', { init: { signal } })
}

export function meta() {
  return { title: 'Sark on Cloudflare Workers' }
}

export default function Home({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  return (
    <main>
      <h1>Sark on Cloudflare Workers</h1>
      <p>Last report in D1: {data.recordedAt ?? 'Waiting for the first scheduled run'}</p>
      <ul>
        <li>
          <a href="/api/report">Report stored in R2</a>
        </li>
        <li>
          <a href="/about.txt">Static resource</a>
        </li>
      </ul>
    </main>
  )
}
