import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryAuthStateStore } from '../../src/services/auth/state/memory'
import type { AccountLimitParams, AuthFlow } from '../../src/services/auth/state/types'

const createSampleFlow = (
  id: string,
  sub = 'user1',
  expiresAt = Date.now() + 60_000,
): AuthFlow => ({
  id,
  revision: 'rev-1',
  purpose: 'login',
  sub,
  createdAt: Date.now(),
  expiresAt,
  attempts: 0,
  maxAttempts: 3,
  status: 'pending',
  data: {},
})

afterEach(() => vi.useRealTimers())

describe('MemoryAuthStateStore State Machine and Throttling', () => {
  const store = new MemoryAuthStateStore({ maxChallenges: 10, maxAccounts: 10 })

  it('creates, claims, and consumes flow', async () => {
    const flow = createSampleFlow('flow-1')
    const created = await store.create(flow)
    expect(created).toBe(true)

    // Repeated create with duplicate id returns false
    expect(await store.create(flow)).toBe(false)

    // Read pending flow
    const read1 = await store.read('flow-1')
    expect(read1?.status).toBe('pending')

    // Claim
    const claimId = 'claim-1'
    const now = Date.now()
    const claimRes = await store.claim('flow-1', claimId, now)
    expect(claimRes.status).toBe('claimed')
    if (claimRes.status === 'claimed') {
      expect(claimRes.flow.status).toBe('verifying')
      expect(claimRes.flow.claimId).toBe(claimId)

      // Concurrent claim on verifying flow must fail!
      const claim2 = await store.claim('flow-1', 'claim-2', now)
      expect(claim2.status).toBe('invalid')

      // Consume
      const consumed = await store.consume('flow-1', claimId, now)
      expect(consumed).toBe(true)
    }

    // After consumed, read returns null
    expect(await store.read('flow-1')).toBeNull()
  })

  it('releases back to pending and increments attempts', async () => {
    const flow = createSampleFlow('flow-attempts')
    await store.create(flow)

    const now = Date.now()
    const claim1 = await store.claim('flow-attempts', 'claim-a', now)
    expect(claim1.status).toBe('claimed')
    if (claim1.status !== 'claimed') return

    // Release back to pending retains attempt count
    const rel1 = await store.release('flow-attempts', 'claim-a', now)
    expect(rel1).toBe(true)

    const read1 = await store.read('flow-attempts')
    expect(read1?.status).toBe('pending')
    expect(read1?.attempts).toBe(1)
  })

  it('enforces account throttling across different challenges', async () => {
    const throttledStore = new MemoryAuthStateStore({ maxChallenges: 10, maxAccounts: 10 })
    const account: AccountLimitParams = {
      sub: 'target-user',
      purpose: 'login',
      window: 60_000,
      maxAttempts: 2,
    }

    // Challenge A
    const flowA = createSampleFlow('challenge-A', 'target-user')
    await throttledStore.create(flowA)

    const now = Date.now()
    const claimA1 = await throttledStore.claim('challenge-A', 'claim-a1', now, account)
    expect(claimA1.status).toBe('claimed')

    // Release challenge A back to pending (account attempts preserved)
    await throttledStore.release('challenge-A', 'claim-a1', now)

    // Challenge B created for the same user
    const flowB = createSampleFlow('challenge-B', 'target-user')
    await throttledStore.create(flowB)

    // 2nd claim (hitting limit of 2)
    const claimB1 = await throttledStore.claim('challenge-B', 'claim-b1', now, account)
    expect(claimB1.status).toBe('claimed')

    await throttledStore.release('challenge-B', 'claim-b1', now)

    // Challenge C for the same user: 3rd claim must return 'limited'!
    const flowC = createSampleFlow('challenge-C', 'target-user')
    await throttledStore.create(flowC)

    const claimC1 = await throttledStore.claim('challenge-C', 'claim-c1', now, account)
    expect(claimC1.status).toBe('limited')
  })

  it('evicts expired verifying challenges and prevents capacity leak when maxChallenges is 1', async () => {
    const tinyStore = new MemoryAuthStateStore({ maxChallenges: 1 })
    vi.useFakeTimers({ now: Date.now() })
    const now = Date.now()

    // 1. Create a flow with 50ms ttl
    const flow1: AuthFlow = {
      ...createSampleFlow('short-flow', 'user-leak', now + 50),
      status: 'pending',
    }
    await tinyStore.create(flow1)

    // 2. Claim it into verifying state while still active
    const claimRes = await tinyStore.claim('short-flow', 'claim-leak', now)
    expect(claimRes.status).toBe('claimed')

    // 3. Advance time past expiration
    vi.advanceTimersByTime(60)
    const futureTime = now + 200

    // 4. Create a new flow at futureTime; tinyStore should clean up the expired verifying flow and succeed
    const newFlow = createSampleFlow('new-flow', 'user-fresh', futureTime + 60_000)
    const createdNew = await tinyStore.create(newFlow)
    expect(createdNew).toBe(true)
  })
})

it('binds one opaque protocol snapshot without depending on a provider-specific property', async () => {
  const store = new MemoryAuthStateStore()
  const flow = createSampleFlow('protocol')
  await store.create(flow)
  const [first, second] = await Promise.all([
    store.bindProtocol(flow.id, flow.revision, { nonce: 'first' }, Date.now()),
    store.bindProtocol(flow.id, flow.revision, { nonce: 'second' }, Date.now()),
  ])
  expect(first?.protocol).toEqual(second?.protocol)
  expect(await store.read(flow.id)).toMatchObject({ data: {}, protocol: first!.protocol })
})

it('isolates nested flow and protocol snapshots at every memory store boundary', async () => {
  const store = new MemoryAuthStateStore()
  const flow = { ...createSampleFlow('detached'), data: { input: { sub: 'alice' } } }
  await store.create(flow)
  flow.data.input.sub = 'other'
  const read = (await store.read(flow.id))!
  expect(read.data).toEqual({ input: { sub: 'alice' } })
  ;(read.data.input as { sub: string }).sub = 'changed'
  const protocol = { options: { challenge: 'original' } }
  const bound = (await store.bindProtocol(flow.id, flow.revision, protocol, Date.now()))!
  protocol.options.challenge = 'other'
  ;(bound.protocol!.options as { challenge: string }).challenge = 'changed'
  const current = (await store.read(flow.id))!
  expect(current.data).toEqual({ input: { sub: 'alice' } })
  expect(current.protocol).toEqual({ options: { challenge: 'original' } })
  const claimed = await store.claim(flow.id, 'claim', Date.now())
  if (claimed.status !== 'claimed') throw new Error('Expected a claimed flow')
  ;(claimed.flow.protocol!.options as { challenge: string }).challenge = 'changed'
  expect((await store.read(flow.id))!.protocol).toEqual({ options: { challenge: 'original' } })
})
