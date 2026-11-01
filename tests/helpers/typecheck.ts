import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { resolveConfig } from 'vite'

import type { PluginOptions } from '../../src/tooling/config'
import { sark } from '../../src/tooling/vite'
import { createProject, projectRoot } from './project'

/** Checks a fixture with the repository's standard compiler command and its own tsconfig. */
export function checkTypes(root: string) {
  const pnpm = process.env.npm_execpath
  if (!pnpm) throw new Error('Run type contracts through the project pnpm scripts.')
  const args = ['typecheck', '--project', root]
  const nodeScript = /\.(?:c|m)?js$/i.test(pnpm)
  const result = spawnSync(
    nodeScript ? process.execPath : pnpm,
    nodeScript ? [pnpm, ...args] : args,
    {
      cwd: projectRoot,
      encoding: 'utf8',
    },
  )
  if (result.error) throw result.error
  return { status: result.status, output: result.stdout + result.stderr }
}

/** Generates and checks only the files supplied by one integration scenario. */
export async function checkGeneratedTypes(
  files: Readonly<Record<string, string>>,
  options: Pick<PluginOptions, 'target' | 'apiPrefix'> & {
    customHost?: boolean
  } = {},
) {
  const project = createProject()
  try {
    for (const [file, source] of Object.entries(files)) project.write(file, source)
    project.write(
      'tsconfig.json',
      JSON.stringify({
        extends: resolve(projectRoot, 'tsconfig.json'),
        include: ['**/*.ts', '**/*.tsx', '.build/**/*.ts', '.build/**/*.tsx'],
        // Custom hosts are checked by their own source instead of the standard ProcessEnv entry.
        exclude: options.customHost ? ['.build/start.ts'] : undefined,
      }),
    )
    await resolveConfig(
      {
        root: project.root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          sark({
            target: options.target,
            apiPrefix: options.apiPrefix,
            webDir: false,
          }),
        ],
      },
      'build',
    )
    return checkTypes(project.root)
  } finally {
    project.remove()
  }
}
