/** Shared serialization and bounded cleanup scheduling for SQL challenge stores. */
import type { StoreContext } from '../store'
import type { AuthFlow } from './types'

export interface StoredFlow {
  id: string
  revision: string
  purpose: string
  sub: string | null
  createdAt: number
  expiresAt: number
  attempts: number
  maxAttempts: number
  status: string
  claimId: string | null
  data: string
}

export function decodeFlow(row: StoredFlow): AuthFlow {
  const saved = JSON.parse(row.data) as {
    data: Record<string, unknown>
    protocol?: Record<string, unknown>
  }
  return {
    ...row,
    purpose: row.purpose as AuthFlow['purpose'],
    status: row.status as AuthFlow['status'],
    sub: row.sub ?? undefined,
    claimId: row.claimId ?? undefined,
    data: saved.data,
    protocol: saved.protocol,
  }
}

/** Stores data and protocol metadata together without interpreting either payload. */
export function encodeFlowData(flow: Pick<AuthFlow, 'data' | 'protocol'>): string {
  return JSON.stringify({ data: flow.data, protocol: flow.protocol })
}

/** The declaration retains only scheduling state, never a database or event binding. */
export function createCleanupGate() {
  let nextRun = 0
  let running = false
  return (now: number, context: StoreContext, remove: () => Promise<boolean>) => {
    if (running || now < nextRun) return
    nextRun = now + 60_000
    running = true
    const work = remove()
      .then((hasMore) => {
        if (hasMore) nextRun = 0
      })
      .catch((error) =>
        context.logger.warn('Authentication state cleanup failed: {error}', { error }),
      )
      .finally(() => {
        running = false
      })
    context.waitUntil(work)
  }
}
