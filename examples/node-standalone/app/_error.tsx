import { type ErrorProps, Link } from '@olivaw/sark/page'

export default function RootError({ error, retry }: ErrorProps) {
  const status = error.status ?? 500
  const is404 = status === 404

  return (
    <div className="container" style={{ padding: '6rem 1.5rem', textAlign: 'center' }}>
      <div
        style={{
          maxWidth: '520px',
          margin: '0 auto',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: '3.5rem 2.5rem',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <div style={{ fontSize: '3rem', marginBottom: '1.25rem' }}>{is404 ? '🪶' : '⚠️'}</div>
        <h1
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: '2rem',
            color: 'var(--text-main)',
            marginBottom: '0.75rem',
          }}
        >
          {is404 ? '404 — Story Not Found' : `Error ${status}`}
        </h1>
        <p style={{ color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: '2rem' }}>
          {error.message ||
            (is404
              ? 'The requested story or attachment does not exist, or you lack authorization to view it.'
              : 'An unexpected application runtime error occurred.')}
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
          <Link to="/" className="btn btn-primary">
            Return to Stories
          </Link>
          {retry && (
            <button type="button" onClick={retry} className="btn btn-secondary">
              Try Again
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
