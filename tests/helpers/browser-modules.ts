import { parseSync } from 'vite'
import { expect } from 'vitest'

/** Follows actual ESM source imports, including code splits, through the public HTTP host. */
export async function assertBrowserModules(entry: URL): Promise<void> {
  const visited = new Set<string>()
  async function visit(url: URL, parent?: string): Promise<void> {
    if (visited.has(url.href)) return
    visited.add(url.href)
    const response = await fetch(url)
    const source = await response.text()
    expect(response.status, `${url.href} imported by ${parent}\n${source.slice(0, 500)}`).toBe(200)
    if (!response.headers.get('content-type')?.includes('javascript')) return
    const parsed = parseSync('browser.js', source)
    expect(parsed.errors, url.href).toHaveLength(0)
    const dependencies = new Set<string>()
    function collect(value: unknown): void {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) {
        value.forEach(collect)
        return
      }
      const node = value as Record<string, unknown>
      if (
        [
          'ImportDeclaration',
          'ExportNamedDeclaration',
          'ExportAllDeclaration',
          'ImportExpression',
        ].includes(String(node.type))
      ) {
        const imported = node.source as { value?: unknown } | undefined
        if (typeof imported?.value === 'string') dependencies.add(imported.value)
      }
      for (const child of Object.values(node)) collect(child)
    }
    collect(parsed.program)
    for (const dependency of dependencies) await visit(new URL(dependency, url), url.href)
  }
  await visit(entry)
}
