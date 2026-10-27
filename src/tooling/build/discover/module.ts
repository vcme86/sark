import { readFileSync } from 'node:fs'

import { parseSync } from 'vite'

/** Parses application modules without evaluating them; syntax errors retain the source path. */
export function parseModule(file: string): ReturnType<typeof parseSync>['program'] {
  const parsed = parseSync(file, readFileSync(file, 'utf8'))
  if (parsed.errors.length) {
    throw new Error(
      `Failed to parse ${file}: ${parsed.errors.map((error) => error.message).join(', ')}`,
    )
  }
  return parsed.program
}
