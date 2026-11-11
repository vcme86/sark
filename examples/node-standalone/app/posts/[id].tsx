import { HttpError } from '@olivaw/sark/client'
import { Link, type LoaderArgs, notFound, useClient, useNavigate } from '@olivaw/sark/page'
import { useState, useTransition } from 'react'

import { formatBytes, formatDate, getFileIcon } from '../format'

export async function loader({ client, params, signal }: LoaderArgs<{ id: string }>) {
  try {
    return await client.get('/posts/:id', { params, init: { signal } })
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 403)) {
      throw notFound(error.message)
    }
    throw error
  }
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  if (!data?.post) return { title: 'Story Not Found — Ink & Feather' }
  return {
    title: `${data.post.title} — Ink & Feather`,
    description: data.post.summary,
  }
}

function estimateReadingTime(content: string): string {
  const words = content.trim().split(/\s+/).filter(Boolean).length
  const minutes = Math.max(1, Math.ceil(words / 180))
  return `${minutes} min read`
}

export default function PostDetailPage({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  const client = useClient()
  const navigate = useNavigate()
  const [isDeleting, startDeleteTransition] = useTransition()
  const [showConfirm, setShowConfirm] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const post = data.post
  const attachments = data.attachments

  const isScheduled = post.status === 'scheduled'
  const readingTime = estimateReadingTime(post.content)
  const date = formatDate(post.date, 'long')

  function handleDeleteConfirm() {
    startDeleteTransition(async () => {
      try {
        await client.delete('/posts/:id', { params: { id: post.id } })
        navigate('/')
      } catch (error) {
        setDeleteError(error instanceof Error ? error.message : 'Failed to delete story.')
        setShowConfirm(false)
      }
    })
  }

  return (
    <article className="reader-container reader-article">
      <div style={{ marginBottom: '2rem' }}>
        <Link
          to="/"
          style={{
            fontSize: '0.875rem',
            color: 'var(--text-muted)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
          }}
        >
          <span>&larr;</span>
          <span>Back to Stories</span>
        </Link>
      </div>

      <header className="reader-header">
        <div
          style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginBottom: '1rem' }}
        >
          {isScheduled ? (
            <span className="status-pill scheduled">
              <span>⏰</span>
              <span>Scheduled Release</span>
            </span>
          ) : post.status === 'published' ? (
            <span className="status-pill published">
              <span>✓</span>
              <span>Published</span>
            </span>
          ) : (
            <span className="status-pill draft">
              <span>✎</span>
              <span>Draft</span>
            </span>
          )}
          <span style={{ fontSize: '0.825rem', color: 'var(--text-muted)' }}>{readingTime}</span>
        </div>

        <h1 className="reader-title">{post.title}</h1>

        {post.summary && <p className="reader-lead">{post.summary}</p>}

        <div className="reader-meta-bar">
          <div className="reader-author">
            <div
              className="user-avatar-circle"
              style={{ width: '1.75rem', height: '1.75rem', fontSize: '0.8rem' }}
            >
              {post.authorName.charAt(0).toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text-main)', lineHeight: 1.2 }}>
                {post.authorName}
              </div>
              <div style={{ fontSize: '0.775rem', color: 'var(--text-muted)' }}>
                {isScheduled ? `Scheduled for ${date}` : date}
              </div>
            </div>
          </div>

          {data.canEdit && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <Link to={`/posts/${post.id}/edit`} className="btn btn-secondary btn-sm">
                Edit Story
              </Link>

              {showConfirm ? (
                <div className="inline-confirm">
                  <span>Permanently delete?</span>
                  <button
                    type="button"
                    onClick={handleDeleteConfirm}
                    disabled={isDeleting}
                    className="btn btn-danger btn-sm"
                    style={{ padding: '0.2rem 0.6rem', fontSize: '0.775rem' }}
                  >
                    {isDeleting ? 'Deleting...' : 'Yes, Delete'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowConfirm(false)}
                    disabled={isDeleting}
                    className="btn btn-secondary btn-sm"
                    style={{ padding: '0.2rem 0.6rem', fontSize: '0.775rem' }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowConfirm(true)}
                  className="btn btn-ghost btn-sm"
                  style={{ color: 'var(--danger-text)' }}
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>

        {deleteError && (
          <div
            style={{
              marginTop: '1rem',
              padding: '0.5rem 0.75rem',
              backgroundColor: 'var(--danger-bg)',
              color: 'var(--danger-text)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.825rem',
            }}
          >
            {deleteError}
          </div>
        )}
      </header>

      {/* Main Content Body */}
      <div className="reader-content">
        {post.content.split('\n\n').map((paragraph, index) => {
          if (paragraph.startsWith('> ')) {
            return (
              <blockquote key={index}>
                <p>{paragraph.replace(/^>\s*/, '')}</p>
              </blockquote>
            )
          }
          if (paragraph.startsWith('## ')) {
            return <h2 key={index}>{paragraph.replace(/^##\s*/, '')}</h2>
          }
          if (paragraph.startsWith('```')) {
            const cleaned = paragraph.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
            return (
              <pre key={index}>
                <code>{cleaned}</code>
              </pre>
            )
          }
          return <p key={index}>{paragraph}</p>
        })}
      </div>

      {/* Story Attachments */}
      {attachments.length > 0 && (
        <section className="reader-attachments">
          <h3 className="attachments-title">
            <span>📎</span>
            <span>Attached Resources &amp; Downloads ({attachments.length})</span>
          </h3>
          <div>
            {attachments.map((file) => (
              <a
                key={file.id}
                href={`/api/attachments/${file.id}/download`}
                target="_blank"
                rel="noreferrer"
                download={file.filename}
                className="attachment-pill"
                title={`Download ${file.filename}`}
              >
                <span>{getFileIcon(file.contentType)}</span>
                <span style={{ fontWeight: 600 }}>{file.filename}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                  ({formatBytes(file.size)})
                </span>
                <span style={{ color: 'var(--accent-terracotta)', fontWeight: 'bold' }}>
                  &darr;
                </span>
              </a>
            ))}
          </div>
        </section>
      )}
    </article>
  )
}
