import { Link, type LoaderArgs } from '@olivaw/sark/page'
import { useState } from 'react'

import { formatDate } from './format'

export async function loader({ client, signal, identity }: LoaderArgs) {
  const isAuthor = Boolean(identity?.user?.sub)
  const statusParam = isAuthor ? 'all' : 'published'

  const { posts } = await client.get('/posts', {
    query: { status: statusParam },
    init: { signal },
  })

  return {
    posts,
    isAuthor,
  }
}

export function meta() {
  return {
    title: 'Ink & Feather — Stories, Essays & Architecture',
    description:
      'Explore thoughtful editorial writings and technical architectures on Ink & Feather',
  }
}

function estimateReadingTime(summary: string): string {
  const text = summary.trim()
  const wordCount = text.split(/\s+/).filter(Boolean).length
  const minutes = Math.max(1, Math.ceil(wordCount / 180))
  return `${minutes} min read`
}

export default function Home({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  const [filter, setFilter] = useState<'all' | 'published' | 'draft'>('all')

  const posts = data.posts
  const isAuthor = data.isAuthor

  const filteredPosts = posts.filter((post) => {
    if (filter === 'published') return post.status === 'published'
    if (filter === 'draft') return post.status !== 'published'
    return true
  })

  return (
    <div className="container" style={{ paddingBottom: '5rem' }}>
      <section className="hero">
        <div className="hero-tag">
          <span>✦</span>
          <span>Independent Editorial Station</span>
        </div>
        <h1 className="hero-title">Words, crafted with precision.</h1>
        <p className="hero-desc">
          An autonomous editorial publishing platform engineered with Sark. Featuring full-stack SSR
          streaming, first-party cookie sessions, SQLite persistence, and scheduled task releases.
        </p>
      </section>

      <div className="filter-bar">
        {isAuthor ? (
          <div className="tab-group" role="tablist">
            <button
              type="button"
              className={`tab-item ${filter === 'all' ? 'active' : ''}`}
              onClick={() => setFilter('all')}
            >
              All Stories ({posts.length})
            </button>
            <button
              type="button"
              className={`tab-item ${filter === 'published' ? 'active' : ''}`}
              onClick={() => setFilter('published')}
            >
              Published ({posts.filter((p) => p.status === 'published').length})
            </button>
            <button
              type="button"
              className={`tab-item ${filter === 'draft' ? 'active' : ''}`}
              onClick={() => setFilter('draft')}
            >
              Drafts &amp; Scheduled ({posts.filter((p) => p.status !== 'published').length})
            </button>
          </div>
        ) : (
          <div style={{ fontSize: '0.925rem', color: 'var(--text-muted)' }}>
            Curated archive of {filteredPosts.length}{' '}
            {filteredPosts.length === 1 ? 'published story' : 'published stories'}
          </div>
        )}

        {isAuthor && (
          <Link to="/posts/new" className="btn btn-primary btn-sm">
            + Write Story
          </Link>
        )}
      </div>

      {filteredPosts.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '5rem 2rem',
            backgroundColor: 'var(--bg-surface)',
            border: '1px dashed var(--border-default)',
            borderRadius: 'var(--radius-lg)',
          }}
        >
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🪶</div>
          <h2
            style={{ fontFamily: 'var(--font-serif)', fontSize: '1.5rem', marginBottom: '0.5rem' }}
          >
            No stories found in this section
          </h2>
          <p style={{ color: 'var(--text-muted)', maxWidth: '400px', margin: '0 auto 1.5rem' }}>
            {isAuthor
              ? 'Ready to share your insights? Compose your first story and publish it now or on schedule.'
              : 'New articles and technical essays will appear here once published.'}
          </p>
          {isAuthor && (
            <Link to="/posts/new" className="btn btn-primary">
              + Compose Your First Story
            </Link>
          )}
        </div>
      ) : (
        <div className="posts-grid">
          {filteredPosts.map((post) => {
            const isScheduled = post.status === 'scheduled'
            const readingTime = estimateReadingTime(post.summary)
            const date = formatDate(post.date, 'short')

            return (
              <article key={post.id} className="post-card">
                <div className="post-card-header">
                  <div
                    className="user-avatar-circle"
                    style={{ width: '1.25rem', height: '1.25rem', fontSize: '0.65rem' }}
                  >
                    {post.authorName.charAt(0).toUpperCase()}
                  </div>
                  <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
                    {post.authorName}
                  </span>
                  <span>&middot;</span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {isScheduled ? `Scheduled for ${date}` : date}
                  </span>
                  {isAuthor && (
                    <span style={{ marginLeft: 'auto' }}>
                      {isScheduled ? (
                        <span className="status-pill scheduled">
                          <span>⏰</span>
                          <span>Scheduled</span>
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
                    </span>
                  )}
                </div>

                <Link to={`/posts/${post.id}`}>
                  <h2 className="post-card-title">{post.title}</h2>
                </Link>

                <p className="post-card-summary">{post.summary}</p>

                <div className="post-card-footer">
                  <div className="post-meta-left">
                    <span>{readingTime}</span>
                    {post.attachmentCount > 0 && (
                      <>
                        <span>&middot;</span>
                        <span
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                        >
                          <span>📎</span>
                          <span>
                            {post.attachmentCount} {post.attachmentCount === 1 ? 'file' : 'files'}
                          </span>
                        </span>
                      </>
                    )}
                  </div>

                  <Link
                    to={`/posts/${post.id}`}
                    style={{
                      fontWeight: 600,
                      color: 'var(--text-main)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                    }}
                  >
                    <span>Read story</span>
                    <span>&rarr;</span>
                  </Link>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
