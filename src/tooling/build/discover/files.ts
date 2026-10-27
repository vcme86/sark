import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Lists route source candidates, excluding hidden entries, private directories, and test files. */
export function scanRouteFiles(root: string): Array<{ fullPath: string; rel: string }> {
  const files: Array<{ fullPath: string; rel: string }> = []
  if (!existsSync(root)) return files

  function walk(directory: string): void {
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith('.')) continue
      const fullPath = join(directory, entry)
      const stat = statSync(fullPath)
      if (stat.isDirectory()) {
        if (!entry.startsWith('_')) walk(fullPath)
      } else if (
        stat.isFile() &&
        !entry.includes('.test.') &&
        !entry.includes('.spec.') &&
        !entry.endsWith('.d.ts')
      ) {
        files.push({ fullPath, rel: relative(root, fullPath) })
      }
    }
  }

  walk(root)
  return files
}
