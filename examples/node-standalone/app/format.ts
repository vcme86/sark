/** Formats article dates in UTC for consistent server and browser rendering. */
export function formatDate(epochMs: number, month: 'short' | 'long'): string {
  return new Date(epochMs).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month,
    day: 'numeric',
    year: 'numeric',
  })
}

/** Formats an attachment size for display. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${Number((bytes / 1024 ** index).toFixed(1))} ${units[index]}`
}

/** Chooses a display icon from the attachment's content type. */
export function getFileIcon(contentType: string): string {
  if (contentType.startsWith('image/')) return '🖼️'
  if (contentType.includes('pdf')) return '📕'
  if (contentType.includes('zip') || contentType.includes('tar') || contentType.includes('gzip'))
    return '📦'
  return '📄'
}
