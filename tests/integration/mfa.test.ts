import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'vite'
import { describe, expect, it } from 'vitest'

import { generateProject } from '../../src/tooling/build/project'
import { createProject } from '../helpers/project'
import { checkTypes } from '../helpers/typecheck'

const secret = 'session-signing-secret-at-least-32-bytes'
const totpKeyHex = '11'.repeat(32) // 32 bytes hex

describe('MFA End-to-End Application Integration', () => {
  it('runs generated TOTP enrollment, MFA challenge login, and Step-Up in real Node application', async () => {
    const project = createProject()

    try {
      project.write(
        'app.ts',
        `import { defineApp } from '@olivaw/sark'
import { defineAuth } from '@olivaw/sark/auth'
import { defineTotp } from '@olivaw/sark/auth/totp'
import { sqlTotp } from '@olivaw/sark/auth/totp/sqlite'
import { defineMfa } from '@olivaw/sark/auth/mfa'
import { defineDatabase } from '@olivaw/sark/db/sqlite'

export const app = defineApp({ csrf: false })

export const database = defineDatabase({ filename: '${join(project.root, 'test.db')}' })

export const auth = defineAuth({ secret: '${secret}' })

export const totp = defineTotp({
  issuer: 'IntegrationApp',
  keys: {
    current: {
      id: 'k1',
      key: new Uint8Array(Buffer.from('${totpKeyHex}', 'hex')),
    },
  },
  store: sqlTotp({ database }),
})

export const mfa = defineMfa({
  signIn: 'if-enrolled',
})
`,
      )

      project.write(
        'api/login.post.ts',
        `import { route } from '@olivaw/sark'

export default route().handler(async ctx => {
  const body = await ctx.req.json()
  const result = await ctx.var.mfa.beginSignIn({ sub: body.sub })
  return result
})`,
      )

      project.write(
        'api/mfa/complete.post.ts',
        `import { route } from '@olivaw/sark'

export default route().handler(async ctx => {
  const { challenge, code } = await ctx.req.json()
  const session = await ctx.var.mfa.complete(
    challenge,
    { kind: 'totp', code },
  )
  return { status: 'authenticated', sub: session.identity.sub, amr: session.identity.amr }
})`,
      )

      project.write(
        'api/enroll.post.ts',
        `import { route } from '@olivaw/sark'

export default route().handler(async ctx => {
  if (!ctx.var.auth.identity) {
    return ctx.text('Unauthorized', 401)
  }
  const res = await ctx.var.totp.beginEnrollment()
  return res
})`,
      )

      project.write(
        'api/confirm.post.ts',
        `import { route } from '@olivaw/sark'

export default route().handler(async ctx => {
  const { challenge, code } = await ctx.req.json()
  await ctx.var.totp.confirmEnrollment(challenge, code)
  return { status: 'confirmed' }
})`,
      )

      project.write(
        'api/stepup.post.ts',
        `import { route } from '@olivaw/sark'

export default route().handler(async ctx => {
  if (!ctx.var.auth.identity) {
    return ctx.text('Unauthorized', 401)
  }
  const res = await ctx.var.mfa.beginStepUp()
  return res
})`,
      )

      project.write(
        'api/profile.get.ts',
        `import { route } from '@olivaw/sark'

export default route().handler(async ctx => {
  return { identity: ctx.var.auth.identity ?? null }
})`,
      )

      generateProject(project.root)
      project.write(
        'tsconfig.json',
        JSON.stringify({ extends: '../../tsconfig.json', include: ['**/*.ts', '.build/**/*.ts'] }),
      )
      const typecheck = checkTypes(project.root)
      expect(typecheck.status, typecheck.output).toBe(0)

      await build({
        root: project.root,
        configFile: false,
        logLevel: 'silent',
        build: {
          ssr: join(project.root, '.build/app.ts'),
          outDir: 'dist',
          rolldownOptions: {
            external: (id) => id.startsWith('@olivaw/sark/'),
            output: { entryFileNames: 'definition.mjs' },
          },
        },
      })

      const url = pathToFileURL(join(project.root, 'dist/definition.mjs')).href

      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
import { TOTP } from '@otplib/totp'
import { WebCryptoPlugin } from '@otplib/plugin-crypto-web'
import { ScureBase32Plugin } from '@otplib/plugin-base32-scure'
import { parse } from '@otplib/uri'

const otplib = new TOTP({
  crypto: new WebCryptoPlugin(),
  base32: new ScureBase32Plugin(),
})

const { definition } = await import(${JSON.stringify(url)})
const { createApp } = await import('@olivaw/sark')
const app = await createApp(definition)

app.db.$client.exec(\`
  CREATE TABLE IF NOT EXISTS totp_factors (
    sub TEXT PRIMARY KEY NOT NULL,
    factor_id TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    digits INTEGER NOT NULL,
    period INTEGER NOT NULL,
    secret BLOB NOT NULL,
    last_step INTEGER,
    revision TEXT NOT NULL,
    enabled_at INTEGER NOT NULL
  );
\`)

try {
  // 1. Initial login for unenrolled user -> immediately authenticated
  const res1 = await app.fetch(new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sub: 'alice' })
  }))
  if (res1.status !== 200) throw new Error('Unenrolled login failed: status ' + res1.status)
  const data1 = await res1.json()
  if (data1.status !== 'authenticated') throw new Error('Expected authenticated status, got ' + JSON.stringify(data1))

  const sessionCookie = res1.headers.get('set-cookie')
  if (!sessionCookie) throw new Error('Session cookie missing')

  // Extract pure cookie value
  const cookieHeader = sessionCookie.split(';')[0]

  // 2. Profile check returns logged in user
  const prof1 = await app.fetch(new Request('http://localhost/api/profile', {
    headers: { 'Cookie': cookieHeader }
  }))
  const profData1 = await prof1.json()
  if (profData1.identity?.sub !== 'alice') throw new Error('Profile sub mismatched')

  // 3. Begin enrollment
  const enrollRes = await app.fetch(new Request('http://localhost/api/enroll', {
    method: 'POST',
    headers: { 'Cookie': cookieHeader }
  }))
  if (enrollRes.status !== 200) throw new Error('Begin enrollment failed: ' + enrollRes.status)
  const enrollData = await enrollRes.json()
  const { uri, challenge } = enrollData

  // Parse secret from URI
  const parsedUri = parse(uri)
  const secret = parsedUri.params.secret

  // Generate code and confirm enrollment
  const validCode = await otplib.generate({ secret, epoch: Math.floor(Date.now() / 1000) - 30 })
  const invalidEnrollment = await app.fetch(new Request('http://localhost/api/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ challenge, code: '12345' }),
  }))
  if (invalidEnrollment.status !== 400 || (await invalidEnrollment.json()).error.code !== 'invalid_code') throw new Error('Malformed enrollment code must return retryable invalid_code')

  const confirmRes = await app.fetch(new Request('http://localhost/api/confirm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader
    },
    body: JSON.stringify({
      challenge,
      code: validCode,
    })
  }))
  if (confirmRes.status !== 200) throw new Error('Confirm enrollment failed: ' + (await confirmRes.text()))

  // 4. Subsequent login now triggers MFA challenge!
  const resMfa = await app.fetch(new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sub: 'alice' })
  }))
  const mfaData = await resMfa.json()
  if (mfaData.status !== 'challenge') throw new Error('Expected MFA challenge, got ' + JSON.stringify(mfaData))
  if (!mfaData.methods.includes('totp')) throw new Error('Missing totp factor in challenge methods')

  const mfaChallenge = mfaData.challenge

  const invalidLogin = await app.fetch(new Request('http://localhost/api/mfa/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge: mfaChallenge, code: '12345a' }),
  }))
  if (invalidLogin.status !== 400 || (await invalidLogin.json()).error.code !== 'invalid_code') throw new Error('Malformed login code must return retryable invalid_code')

  // 5. Complete MFA with valid code
  const mfaCode = await otplib.generate({ secret, epoch: Math.floor(Date.now() / 1000) })
  const completeRes = await app.fetch(new Request('http://localhost/api/mfa/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge: mfaChallenge, code: mfaCode })
  }))

  if (completeRes.status !== 200) throw new Error('Complete MFA failed: ' + (await completeRes.text()))
  const completeData = await completeRes.json()
  if (!completeData.amr.includes('otp')) throw new Error('Expected amr to contain otp')

  const mfaCookie = completeRes.headers.get('set-cookie')
  if (!mfaCookie) throw new Error('MFA Set-Cookie missing')
  const mfaCookieHeader = mfaCookie.split(';')[0]

  const authenticatedProfile = await app.fetch(new Request('http://localhost/api/profile', { headers: { Cookie: mfaCookieHeader } }))
  const verifiedProfile = await authenticatedProfile.json()
  if (verifiedProfile.identity?.sub !== 'alice' || verifiedProfile.identity?.auth?.method !== 'totp') throw new Error('The issued MFA cookie did not verify')

  // 6. Step-Up flow
  const stepUpRes = await app.fetch(new Request('http://localhost/api/stepup', {
    method: 'POST',
    headers: { 'Cookie': mfaCookieHeader }
  }))
  if (stepUpRes.status !== 200) throw new Error('Step-Up begin failed: ' + (await stepUpRes.text()))
  const stepUpData = await stepUpRes.json()
  if (!stepUpData.challenge) throw new Error('Step-Up must return challenge')

  // Step-Up completion with advanced epoch
  const stepUpCode = await otplib.generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 })
  const stepUpCompleteRes = await app.fetch(new Request('http://localhost/api/mfa/complete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': mfaCookieHeader,
    },
    body: JSON.stringify({ challenge: stepUpData.challenge, code: stepUpCode })
  }))
  if (stepUpCompleteRes.status !== 200) throw new Error('Step-Up complete failed: ' + (await stepUpCompleteRes.text()))

  console.log('INTEGRATION_SUCCESS')
} finally {
  await app.close()
}
`,
        ],
        { encoding: 'utf8' },
      )

      if (result.status !== 0) {
        throw new Error(`Subprocess 1 failed:\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`)
      }
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('INTEGRATION_SUCCESS')
    } finally {
      project.remove()
    }
  })

  it.each(['totp', 'webauthn'] as const)(
    'does not load the other SDK when only %s is enabled',
    async (factor) => {
      const project = createProject()

      try {
        project.write(
          'app.ts',
          `import { defineApp } from '@olivaw/sark'
import { defineAuth } from '@olivaw/sark/auth'
${factor === 'totp' ? `import { defineTotp } from '@olivaw/sark/auth/totp'` : `import { defineWebAuthn } from '@olivaw/sark/auth/webauthn'`}
import { ${factor === 'totp' ? 'sqlTotp' : 'sqlWebAuthn'} } from '@olivaw/sark/auth/${factor}/sqlite'
import { defineMfa } from '@olivaw/sark/auth/mfa'
import { defineDatabase } from '@olivaw/sark/db/sqlite'

export const app = defineApp({ csrf: false })

export const database = defineDatabase({ filename: '${join(project.root, 'test.db')}' })
export const auth = defineAuth({ secret: '${secret}' })
${
  factor === 'totp'
    ? `export const totp = defineTotp({
  issuer: 'IntegrationApp', keys: { current: { id: 'k1', key: new Uint8Array(32).fill(1) } }, store: sqlTotp({ database }),
})`
    : `export const webauthn = defineWebAuthn({
  rpId: 'example.com', rpName: 'Test', origins: ['https://example.com'], user: sub => ({ userName: sub, displayName: sub }), store: sqlWebAuthn({ database }),
})`
}
export const mfa = defineMfa({ signIn: 'if-enrolled' })
`,
        )

        generateProject(project.root)
        project.write(
          'tsconfig.json',
          JSON.stringify({
            extends: '../../tsconfig.json',
            include: ['**/*.ts', '.build/**/*.ts'],
          }),
        )
        const typecheck = checkTypes(project.root)
        expect(typecheck.status, typecheck.output).toBe(0)

        await build({
          root: project.root,
          configFile: false,
          logLevel: 'silent',
          build: {
            ssr: join(project.root, '.build/app.ts'),
            outDir: 'dist',
            rolldownOptions: {
              external: (id) => id.startsWith('@olivaw/sark/'),
              output: { entryFileNames: 'definition.mjs' },
            },
          },
        })

        const url = pathToFileURL(join(project.root, 'dist/definition.mjs')).href

        const result = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.includes(${JSON.stringify(factor === 'totp' ? '@simplewebauthn' : '@otplib')})) {
      throw new Error('Unselected factor SDK loaded: ' + specifier)
    }
    return next(specifier, context)
  }
})

const { definition } = await import(${JSON.stringify(url)})
const { createApp } = await import('@olivaw/sark')
const app = await createApp(definition)

try {
  console.log('ISOLATION_SUCCESS')
} finally {
  await app.close()
}
`,
          ],
          { encoding: 'utf8' },
        )

        if (result.status !== 0) {
          throw new Error(
            `Subprocess 2 failed:\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`,
          )
        }
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('ISOLATION_SUCCESS')
      } finally {
        project.remove()
      }
    },
  )
})
