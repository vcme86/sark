import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveEffectiveWranglerTriggers } from '../../src/tooling/build/wrangler'

describe('resolveEffectiveWranglerTriggers', () => {
  it('reads crons array from wrangler.toml using upstream unstable_readConfig', () => {
    const root = mkdtempSync(join(tmpdir(), 'sark-wrangler-toml-'))
    try {
      writeFileSync(
        join(root, 'wrangler.toml'),
        `
name = "test-worker"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[triggers]
crons = ["0 * * * *", "0 0 * * *"]
`,
      )

      const triggers = resolveEffectiveWranglerTriggers(root)
      expect(triggers).toEqual({
        crons: ['0 * * * *', '0 0 * * *'],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads crons array from wrangler.json using upstream unstable_readConfig', () => {
    const root = mkdtempSync(join(tmpdir(), 'sark-wrangler-json-'))
    try {
      writeFileSync(
        join(root, 'wrangler.json'),
        JSON.stringify({
          name: 'json-worker',
          main: 'src/index.ts',
          compatibility_date: '2024-01-01',
          triggers: {
            crons: ['*/10 * * * *'],
          },
        }),
      )

      const triggers = resolveEffectiveWranglerTriggers(root)
      expect(triggers).toEqual({
        crons: ['*/10 * * * *'],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns undefined when triggers are omitted in wrangler.toml', () => {
    const root = mkdtempSync(join(tmpdir(), 'sark-wrangler-empty-'))
    try {
      writeFileSync(
        join(root, 'wrangler.toml'),
        `
name = "no-triggers-worker"
compatibility_date = "2024-01-01"
`,
      )

      const triggers = resolveEffectiveWranglerTriggers(root)
      expect(triggers).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns undefined when no wrangler configuration file exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'sark-no-wrangler-'))
    try {
      const triggers = resolveEffectiveWranglerTriggers(root)
      expect(triggers).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('uses triggers from the selected environment and explicit configuration path', () => {
    const root = mkdtempSync(join(tmpdir(), 'sark-wrangler-env-'))
    try {
      writeFileSync(
        join(root, 'worker.json'),
        JSON.stringify({
          triggers: { crons: ['0 0 * * *'] },
          env: { review: { triggers: { crons: ['0 * * * *'] } } },
        }),
      )
      expect(resolveEffectiveWranglerTriggers(root, 'worker.json', 'review')).toEqual({
        crons: ['0 * * * *'],
      })
      expect(() => resolveEffectiveWranglerTriggers(root, 'missing.json')).toThrow('does not exist')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
