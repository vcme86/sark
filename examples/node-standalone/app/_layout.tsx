import {
  Link,
  type LoaderArgs,
  Outlet,
  reload,
  setIdentity,
  useClient,
  useNavigate,
} from '@olivaw/sark/page'
import { useState, useTransition } from 'react'

export async function loader({ client, signal }: LoaderArgs) {
  return client.get('/auth/me', { init: { signal } })
}

export function meta() {
  return {
    title: 'Ink & Feather — Modern Publishing',
    description: 'Standalone content publishing platform powered by Sark',
  }
}

export default function Layout({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  const client = useClient()
  const navigate = useNavigate()
  const [isPending, startTransition] = useTransition()
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const user = data.user

  function handleLogout() {
    startTransition(async () => {
      setLogoutError(null)
      try {
        await client.post('/auth/logout')
        setIdentity({ user: null })
        if (window.location.pathname === '/') await reload()
        else await navigate('/')
      } catch (error) {
        setLogoutError(error instanceof Error ? error.message : 'Sign out failed.')
      }
    })
  }

  return (
    <div className="site-wrapper">
      <header className="navbar">
        <div className="container navbar-inner">
          <Link to="/" className="brand">
            <span className="brand-icon">🪶</span>
            <span>Ink &amp; Feather</span>
          </Link>

          <nav className="nav-links">
            <Link to="/" className="nav-link">
              Stories
            </Link>

            {user ? (
              <div className="nav-auth">
                <Link to="/posts/new" className="btn btn-primary btn-sm">
                  + New Story
                </Link>
                <div className="user-badge">
                  <div className="user-avatar-circle">
                    {user.displayName.charAt(0).toUpperCase()}
                  </div>
                  <span>{user.displayName}</span>
                  <span className="role-pill">{user.role}</span>
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="btn btn-ghost btn-sm"
                  aria-label="Sign out"
                  disabled={isPending}
                >
                  {isPending ? 'Signing out...' : 'Sign Out'}
                </button>
              </div>
            ) : (
              <Link to="/login" className="btn btn-secondary btn-sm">
                Editor Login
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main style={{ flex: '1 0 auto' }}>
        {logoutError && (
          <p className="container" role="alert">
            {logoutError}
          </p>
        )}
        <Outlet />
      </main>

      <footer className="footer">
        <div className="container footer-inner">
          <div>
            <strong>Ink &amp; Feather</strong> — Built with{' '}
            <a
              href="https://github.com/vcme86/sark"
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: 'underline' }}
            >
              Sark
            </a>{' '}
            (Node.js 26, React 19, SQLite &amp; Local Storage).
          </div>
          <div>All assets &amp; stories persisted in dedicated storage.</div>
        </div>
      </footer>
    </div>
  )
}
