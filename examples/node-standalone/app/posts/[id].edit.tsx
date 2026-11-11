import { HttpError } from '@olivaw/sark/client'
import {
  Link,
  type LoaderArgs,
  notFound,
  redirect,
  useClient,
  useNavigate,
} from '@olivaw/sark/page'
import { type ChangeEvent, useActionState, useState } from 'react'

import { formatBytes, getFileIcon } from '../format'

export async function loader({ client, params, signal }: LoaderArgs<{ id: string }>) {
  try {
    return await client.get('/posts/:id/edit', { params, init: { signal } })
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 401) throw redirect('/login')
      if (error.status === 404 || error.status === 403) throw notFound(error.message)
    }
    throw error
  }
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  if (!data?.post) return { title: 'Edit Story — Ink & Feather' }
  return {
    title: `Edit: ${data.post.title} — Ink & Feather`,
  }
}

interface ActionState {
  error: string | null
}

export default function EditPostPage({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  const client = useClient()
  const navigate = useNavigate()

  const initialPost = data.post

  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const [titleVal, setTitleVal] = useState(initialPost.title)
  const [contentVal, setContentVal] = useState(initialPost.content)
  const [summary, setSummary] = useState(initialPost.summary)
  const [statusVal, setStatusVal] = useState<'draft' | 'published'>(initialPost.status)

  const [attachments, setAttachments] = useState(data.attachments)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const wordCount = contentVal.trim() ? contentVal.trim().split(/\s+/).filter(Boolean).length : 0
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
      console.error('Upload error:', error)
      setUploadError(error instanceof Error ? error.message : 'Upload failed.')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const [state, formAction, isSaving] = useActionState<ActionState, FormData>(
    async () => {
      const title = titleVal.trim()
      const content = contentVal.trim()

      if (!title || !content) {
        return { error: 'Please provide both article title and content.' }
      }

      try {
        await client.put('/posts/:id', {
          params: { id: initialPost.id },
          json: {
            title,
            summary,
            content,
            status: statusVal,
            attachmentIds: attachments.map((a) => a.id),
          },
        })

        await navigate(`/posts/${initialPost.id}`)
        return { error: null }
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Failed to update story.' }
      }
    },
    { error: null },
  )

  return (
    <div className="container studio-page">
      <form action={formAction}>
        <div className="studio-header">
          <div className="studio-stats">
            <Link to={`/posts/${initialPost.id}`} style={{ color: 'var(--text-muted)' }}>
              &larr; View Story
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
              disabled={isSaving || uploading}
            >
              {isSaving ? (
                <>
                  <span className="spinner" />
                  Saving...
                </>
              ) : (
                'Save Changes'
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
            value={titleVal}
            onChange={(e) => setTitleVal(e.target.value)}
            className="editor-title-input"
            placeholder="Title of your story..."
            required
          />

          <div className="slug-bar">
            <span>Slug:</span>
            <code>/posts/{initialPost.slug}</code>
          </div>

          {mode === 'write' ? (
            <textarea
              name="content"
              value={contentVal}
              onChange={(e) => setContentVal(e.target.value)}
              className="editor-textarea"
              placeholder="Refine your narrative..."
              required
            />
          ) : (
            <div className="editor-preview-box reader-content">
              {contentVal.trim() ? (
                contentVal
                  .split('\n\n')
                  .filter(Boolean)
                  .map((para, i) => <p key={i}>{para}</p>)
              ) : (
                <p style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  No content to preview.
                </p>
              )}
            </div>
          )}

          <div className="studio-meta-grid">
            <div className="form-field">
              <label className="form-label" htmlFor="summary">
                Summary &amp; Teaser
              </label>
              <textarea
                id="summary"
                name="summary"
                rows={3}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                className="form-textarea"
                placeholder="Teaser summary for the feed..."
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="status">
                Publication Status
              </label>
              <select
                id="status"
                name="status"
                value={statusVal}
                onChange={(e) => {
                  const { value } = e.currentTarget
                  if (value === 'draft' || value === 'published') setStatusVal(value)
                }}
                className="form-select"
              >
                <option value="draft">Draft (Restricted to author)</option>
                <option value="published">Published (Publicly visible)</option>
              </select>
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
              <label className="form-label">Manage Attachments</label>
              <label
                className="btn btn-secondary btn-sm"
                style={{ cursor: uploading ? 'wait' : 'pointer' }}
              >
                {uploading ? 'Uploading...' : '+ Attach File'}
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
                No attachments currently associated with this story.
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
