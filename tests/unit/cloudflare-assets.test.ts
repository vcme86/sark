import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import type { StaticAssets } from '../../src/http/assets'
import { writeCloudflareAssetHeaders } from '../../src/tooling/build/cloudflare-assets'

/** Models a valid build with generated and public files sharing the assets directory. */
function mixedAssets(count: number): StaticAssets {
  return {
    base: '/',
    files: Object.fromEntries([
      ['assets/readme.txt', { path: 'assets/readme.txt', hashed: false }],
      ...Array.from({ length: count }, (_, index) => {
        const path = `assets/chunk-${index}.js`
        return [path, { path, hashed: true }] as const
      }),
    ]),
  }
}

it('emits the maximum supported number of native header rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'sark-asset-headers-'))
  try {
    writeCloudflareAssetHeaders(root, mixedAssets(99), false)
    const contents = readFileSync(join(root, '_headers'), 'utf8')
    expect(contents.trim().split('\n\n')).toHaveLength(100)
    expect(contents).toContain('/assets/chunk-98.js\n')
    expect(contents).not.toContain('/assets/*\n')
    expect(contents).not.toContain('/assets/readme.txt\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('rejects too many generated rules before writing a partial headers file', () => {
  const root = mkdtempSync(join(tmpdir(), 'sark-asset-headers-'))
  try {
    expect(() => writeCloudflareAssetHeaders(root, mixedAssets(100), false)).toThrow(
      'exceeds 100 rules',
    )
    expect(existsSync(join(root, '_headers'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('rejects a generated URL longer than the native line limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'sark-asset-headers-'))
  try {
    expect(() =>
      writeCloudflareAssetHeaders(
        root,
        { ...mixedAssets(1), base: '/' + 'a'.repeat(2000) + '/' },
        false,
      ),
    ).toThrow('exceeds the 2000-character line limit')
    expect(existsSync(join(root, '_headers'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('leaves application-owned headers to the native toolchain', () => {
  const root = mkdtempSync(join(tmpdir(), 'sark-asset-headers-'))
  const publicDir = join(root, 'public')
  const outputDir = join(root, 'client')
  const contents = '/*\n  X-Owner: application\n'
  try {
    mkdirSync(publicDir)
    mkdirSync(outputDir)
    writeFileSync(join(publicDir, '_headers'), contents)
    writeFileSync(join(outputDir, '_headers'), contents)
    writeCloudflareAssetHeaders(outputDir, mixedAssets(100), publicDir)
    expect(readFileSync(join(outputDir, '_headers'), 'utf8')).toBe(contents)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
