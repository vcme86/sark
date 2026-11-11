import { Link, setIdentity, useClient, useNavigate } from '@olivaw/sark/page'
import { useActionState, useState } from 'react'

export function meta() {
  return {
    title: 'Sign In — Ink & Feather',
    description: 'Sign in to access authoring workspace and draft management.',
  }
}

interface ActionState {
  error: string | null
}

export default function LoginPage() {
  const client = useClient()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    async () => {
      if (!username || !password) {
        return { error: 'Please enter both username and password.' }
      }

      try {
        const { user } = await client.post('/auth/login', {
          json: { username: username.trim(), password },
        })
        setIdentity({ user: { sub: user.id, roles: [user.role], displayName: user.displayName } })
        await navigate('/')
        return { error: null }
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Invalid username or password.' }
      }
    },
    { error: null },
  )

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <span style={{ fontSize: '2.5rem' }}>🪶</span>
          <h1 className="auth-title">Editor Sign In</h1>
          <p className="auth-subtitle">
            Access your authoring workspace to write, manage and publish stories.
          </p>
        </div>

        {state.error && (
          <div
            style={{
              padding: '0.75rem 1rem',
              backgroundColor: 'var(--danger-bg)',
              color: 'var(--danger-text)',
              border: '1px solid var(--danger-border)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.875rem',
              marginBottom: '1.25rem',
            }}
          >
            {state.error}
          </div>
        )}

        <form action={formAction}>
          <div className="form-field" style={{ marginBottom: '1rem' }}>
            <label className="form-label" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              type="text"
              name="username"
              autoComplete="username"
              className="form-input"
              placeholder="e.g. admin"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>

          <div className="form-field" style={{ marginBottom: '1.25rem' }}>
            <label className="form-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              name="password"
              autoComplete="current-password"
              className="form-input"
              placeholder="••••••••"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%' }}
            disabled={isPending}
          >
            {isPending ? (
              <>
                <span className="spinner" />
                Signing In...
              </>
            ) : (
              'Sign In to Workspace'
            )}
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: '0.85rem' }}>
          <Link to="/" style={{ color: 'var(--text-secondary)' }}>
            &larr; Back to Public Stories
          </Link>
        </div>
      </div>
    </div>
  )
}
