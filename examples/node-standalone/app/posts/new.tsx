import { Link, type LoaderArgs, redirect, useClient, useNavigate } from '@olivaw/sark/page'
import { type ChangeEvent, useActionState, useState } from 'react'

import { formatBytes, getFileIcon } from '../format'

export function loader({ identity }: LoaderArgs) {
  if (!identity.user) throw redirect('/login')
}

export function meta() {
  return {
    title: 'Studio — Compose Story · Ink & Feather',
  }
}

const schedules = ['now', 'draft', 'demo10s', '1hour', 'tomorrow'] as const

interface UploadedFile {
  id: string
  filename: string
  size: number
  contentType: string
}

interface ActionState {
  error: string | null
}

export default function NewPostPage() {
  const client = useClient()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [summary, setSummary] = useState('')
  const [customSlug, setCustomSlug] = useState<string | null>(null)
  const [scheduleOption, setScheduleOption] = useState<(typeof schedules)[number]>('now')
  const [attachments, setAttachments] = useState<UploadedFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const slug =
    customSlug ??
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0
  const readingTime = Math.max(1, Math.ceil(wordCount / 180))

  async function handleFileUpload(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return

    setUploading(true)
    setUploadError(null)

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const fd = new FormData()
        fd.append('file', file)

        const { attachment } = await client.post('/upload', { form: fd })
        setAttachments((prev) => [...prev, attachment])
      }
    } catch (error) {
      console.error('File upload failure:', error)
      setUploadError(error instanceof Error ? error.message : 'Upload failed.')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const [state, formAction, isSubmitting] = useActionState<ActionState, FormData>(
    async () => {
      if (!title || !content) {
        return { error: 'Please provide both article title and content.' }
      }

      const status = scheduleOption === 'now' ? 'published' : 'draft'
      let scheduledAt: number | null = null

      const now = Date.now()
      if (scheduleOption === 'demo10s') {
        scheduledAt = now + 10 * 1000 // 10 seconds for Jobs background scheduler verification
      } else if (scheduleOption === '1hour') {
        scheduledAt = now + 60 * 60 * 1000
      } else if (scheduleOption === 'tomorrow') {
        const tomorrow = new Date(now)
        tomorrow.setDate(tomorrow.getDate() + 1)
        tomorrow.setHours(9, 0, 0, 0)
        scheduledAt = tomorrow.getTime()
      }

      try {
        const { post } = await client.post('/posts', {
          json: {
            title,
            slug: slug || undefined,
            summary: summary || undefined,
            content,
            status,
            scheduledAt,
            attachmentIds: attachments.map((a) => a.id),
          },
        })

        await navigate(`/posts/${post.id}`)
        return { error: null }
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Failed to publish story.' }
      }
    },
    { error: null },
  )

  return (
    <div className="container studio-page">
      <form action={formAction}>
        <div className="studio-header">
          <div className="studio-stats">
            <Link to="/" style={{ color: 'var(--text-muted)' }}>
              &larr; Stories
            </Link>
            <span>&middot;</span>
            <span>
              {wordCount} {wordCount === 1 ? 'word' : 'words'}
            </span>
            <span>&middot;</span>
            <span>~{readingTime} min read</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
            <div className="mode-switch">
              <button
                type="button"
                className={`mode-btn ${mode === 'write' ? 'active' : ''}`}
                onClick={() => setMode('write')}
              >
                Write
              </button>
              <button
                type="button"
                className={`mode-btn ${mode === 'preview' ? 'active' : ''}`}
                onClick={() => setMode('preview')}
              >
                Preview
              </button>
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={isSubmitting || uploading}
            >
              {isSubmitting ? (
                <>
                  <span className="spinner" />
                  Saving...
                </>
              ) : scheduleOption === 'now' ? (
                'Publish Now'
              ) : scheduleOption === 'draft' ? (
                'Save Draft'
              ) : (
                'Save on Schedule'
              )}
            </button>
          </div>
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

        <div className="editor-surface">
          <input
            type="text"
            name="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="editor-title-input"
            placeholder="Title of your story..."
            required
          />

          <div className="slug-bar">
            <span>Slug:</span>
            <code>/posts/</code>
            <input
              type="text"
              name="slug"
              value={slug}
              onChange={(event) => setCustomSlug(event.target.value)}
              className="slug-input"
              placeholder="auto-generated-slug"
            />
            {customSlug !== null ? (
              <button
                type="button"
                onClick={() => setCustomSlug(null)}
                className="btn btn-ghost btn-sm"
                style={{ padding: '0.1rem 0.4rem', fontSize: '0.75rem' }}
              >
                Auto-sync
              </button>
            ) : (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                🔒 Auto-synced
              </span>
            )}
          </div>

          <div style={{ display: mode === 'write' ? 'block' : 'none' }}>
            <textarea
              name="content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              className="editor-textarea"
              placeholder="Write your story here in prose or Markdown. Feel free to structure paragraphs, quotes, and ideas..."
              required
            />
          </div>

          {mode === 'preview' && (
            <div className="editor-preview-box reader-content">
              {content.trim() ? (
                content
                  .split('\n\n')
                  .filter(Boolean)
                  .map((para, i) => {
                    if (para.startsWith('> ')) {
                      return <blockquote key={i}>{para.replace(/^>\s*/, '')}</blockquote>
                    }
                    if (para.startsWith('## ')) {
                      return <h2 key={i}>{para.replace(/^##\s*/, '')}</h2>
                    }
                    return <p key={i}>{para}</p>
                  })
              ) : (
                <p style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  No content written yet. Switch back to Write mode to craft your story.
                </p>
              )}
            </div>
          )}

          <div className="studio-meta-grid">
            <div className="form-field">
              <label className="form-label" htmlFor="summary">
                Summary &amp; Teaser (Optional)
              </label>
              <textarea
                id="summary"
                name="summary"
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                rows={3}
                className="form-textarea"
                placeholder="A compelling sentence or two introducing this essay on the feed..."
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="schedule">
                Publication Schedule
              </label>
              <select
                id="schedule"
                value={scheduleOption}
                onChange={(e) => {
                  const schedule = schedules.find((option) => option === e.currentTarget.value)
                  if (schedule) setScheduleOption(schedule)
                }}
                className="form-select"
              >
                <option value="now">Publish immediately to public</option>
                <option value="draft">Save as draft</option>
                <option value="demo10s">Schedule release in 10s (Quick Jobs Test)</option>
                <option value="1hour">Schedule release in 1 hour</option>
                <option value="tomorrow">Schedule release tomorrow morning</option>
              </select>
              <div
                style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}
              >
                {scheduleOption === 'now'
                  ? 'Your article will be live on the home feed immediately.'
                  : scheduleOption === 'draft'
                    ? 'Your article will remain private until you publish it.'
                    : 'The background task will publish this article at the scheduled time.'}
              </div>
            </div>
          </div>

          {/* Attachments Section */}
          <div
            style={{
              marginTop: '2rem',
              paddingTop: '1.5rem',
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '0.75rem',
              }}
            >
              <label className="form-label">Story Attachments &amp; Assets</label>
              <label
                className="btn btn-secondary btn-sm"
                style={{ cursor: uploading ? 'wait' : 'pointer' }}
              >
                {uploading ? 'Uploading...' : '+ Attach Local File'}
                <input
                  type="file"
                  onChange={handleFileUpload}
                  style={{ display: 'none' }}
                  disabled={uploading}
                />
              </label>
            </div>

            {uploadError && (
              <div
                style={{ fontSize: '0.8rem', color: 'var(--danger-text)', marginBottom: '0.5rem' }}
              >
                {uploadError}
              </div>
            )}

            {attachments.length === 0 ? (
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                No files attached. Attachments are saved to Sark local storage and accessible on the
                story page.
              </div>
            ) : (
              <div>
                {attachments.map((file) => (
                  <div key={file.id} className="attachment-pill">
                    <span>{getFileIcon(file.contentType)}</span>
                    <span style={{ fontWeight: 500 }}>{file.filename}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                      ({formatBytes(file.size)})
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(file.id)}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--danger-text)',
                        cursor: 'pointer',
                        padding: '0 0.25rem',
                      }}
                      title="Remove attachment"
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}
