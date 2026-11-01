import { spawnSync } from 'node:child_process'

import { expect, it } from 'vitest'

const tableFamilies = {
  totp: ['sark_totp_factors'],
  webauthn: ['sark_webauthn_subjects', 'sark_webauthn_credentials'],
  recovery: ['sark_mfa_recovery'],
  state: ['sark_mfa_challenges', 'sark_mfa_attempts'],
}
const entries = Object.keys(tableFamilies).flatMap((capability) =>
  (capability === 'state' ? ['postgres', 'd1'] : ['sqlite', 'postgres', 'd1']).map((backend) => ({
    capability,
    backend,
  })),
)

it.each(entries)(
  'isolates $capability/$backend during native Node module loading',
  ({ capability, backend }) => {
    const forbidden = Object.entries(tableFamilies)
      .filter(([name]) => name !== capability)
      .flatMap(([, names]) => names)
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import { registerHooks } from 'node:module'
const forbidden = ${JSON.stringify(forbidden)}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@simplewebauthn/') || specifier.startsWith('@otplib/')) throw new Error('Persistence entry loaded an authentication SDK: ' + specifier)
    return next(specifier, context)
  },
  load(url, context, next) {
    const result = next(url, context)
    // Inspect only modules actually loaded by native ESM, without relying on tree shaking.
    const source = result.source?.toString() ?? ''
    for (const table of forbidden) if (source.includes('"' + table + '"') || source.includes("'" + table + "'")) throw new Error('Persistence entry loaded another capability schema: ' + table + ' from ' + url)
    return result
  },
})
await import(${JSON.stringify(`@olivaw/sark/auth/${capability}/${backend}`)})
`,
      ],
      { encoding: 'utf8' },
    )
    expect(result.status, result.stderr).toBe(0)
  },
)
