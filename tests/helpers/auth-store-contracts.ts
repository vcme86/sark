import { getLogger } from '@logtape/logtape'

import type { RecoveryStore } from '../../src/features/auth/recovery/types'
import type { TotpStore } from '../../src/features/auth/totp/types'
import type { WebAuthnStore } from '../../src/features/auth/webauthn/types'

const check = (value: boolean, message: string) => {
  if (!value) throw new Error(message)
}

/** Exercises the same conditional-write and mapping contract on real SQLite and D1 stores. */
export async function checkAuthStores(
  totp: TotpStore,
  recovery: RecoveryStore,
  webauthn: WebAuthnStore,
): Promise<void> {
  const context = { logger: getLogger(['test']), signal: new AbortController().signal }
  const sub = `contract-${crypto.randomUUID()}`

  const record = {
    revision: 'one',
    factorId: 'factor',
    secret: new Uint8Array([1, 2, 255]),
    algorithm: 'SHA256' as const,
    digits: 8,
    period: 60,
    lastStep: 10,
    enabledAt: 1234,
  }
  check((await totp.read(sub, context)) === null, 'TOTP starts absent')
  check(await totp.commit(sub, null, record, context), 'TOTP insert')
  check(!(await totp.commit(sub, null, record, context)), 'TOTP duplicate insert')
  const stored = await totp.read(sub, context)
  check(
    stored?.algorithm === record.algorithm && stored?.secret.join() === '1,2,255',
    'TOTP mapping',
  )
  const next = { ...record, revision: 'two', lastStep: 11 }
  const races = await Promise.all([
    totp.commit(sub, 'one', next, context),
    totp.commit(sub, 'one', next, context),
  ])
  check(races.filter(Boolean).length === 1, 'TOTP CAS has one winner')
  check(!(await totp.commit(sub, 'one', null, context)), 'TOTP stale delete')
  check(await totp.commit(sub, 'two', null, context), 'TOTP delete')

  check(
    await recovery.commit(sub, null, { revision: 'one', hashes: ['hash-a', 'hash-b'] }),
    'Recovery insert',
  )
  const codes = await recovery.read(sub)
  check(codes?.hashes.join() === 'hash-a,hash-b', 'Recovery mapping')
  const consume = await Promise.all([
    recovery.commit(sub, 'one', { revision: 'two', hashes: ['hash-b'] }),
    recovery.commit(sub, 'one', { revision: 'other', hashes: [] }),
  ])
  check(consume.filter(Boolean).length === 1, 'Recovery CAS has one winner')

  const userHandle = await webauthn.getOrCreateUserHandle(sub)
  check((await webauthn.getOrCreateUserHandle(sub)) === userHandle, 'WebAuthn stable handle')
  const credential = {
    credentialId: sub,
    sub,
    userHandle,
    publicKey: new Uint8Array([4, 5, 255]),
    counter: 0,
    transports: ['internal'] as const,
    deviceType: 'multiDevice' as const,
    backedUp: true,
    revision: 'one',
    createdAt: 1234,
  }
  check(await webauthn.insertCredential(credential), 'WebAuthn insert')
  check(!(await webauthn.insertCredential(credential)), 'WebAuthn duplicate insert')
  const saved = await webauthn.findCredential(sub)
  check(
    saved?.publicKey.join() === '4,5,255' &&
      saved.backedUp === true &&
      saved.transports?.[0] === 'internal',
    'WebAuthn mapping',
  )
  check((await webauthn.listCredentials(sub)).length === 1, 'WebAuthn subject lookup')
  check(
    !(await webauthn.updateCredential(sub, sub, 'stale', { ...credential, revision: 'two' })),
    'WebAuthn stale update',
  )
  check(
    await webauthn.updateCredential(sub, sub, 'one', {
      ...credential,
      revision: 'two',
      counter: 1,
    }),
    'WebAuthn CAS update',
  )
  check(!(await webauthn.removeCredential(sub, sub, 'one')), 'WebAuthn stale delete')
  check(await webauthn.removeCredential(sub, sub, 'two'), 'WebAuthn delete')
}
