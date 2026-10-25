#!/usr/bin/env node
/**
 * Sark commands for generation, Vite development/builds, and server startup.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ResolvedConfig } from 'vite'

import { type ResolvedProjectConfig, resolveProjectConfig, resolveSarkOptions } from '../config'
import type { SarkPluginApi } from '../vite'

/**
 * Executes the Sark CLI with the provided command-line arguments.
 *
 * @param args - Array of command-line argument tokens (defaults to `process.argv.slice(2)`).
 * @returns A promise resolving after command setup, generation, or building completes.
 * @throws If configuration loading, generation, startup, or building fails.
 */
export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const command = args[0] || 'help'
  const cwd = process.cwd()

  if (command === 'generate') {
    const { resolveConfig } = await import('vite')
    const config = await resolveConfig({}, 'build', 'production', 'production')
    if (!config.plugins.some((plugin) => plugin.name === '@olivaw/sark')) {
      const { generateResolvedProject } = await import('../vite')
      generateResolvedProject(resolveProjectConfig(config.root, resolveSarkOptions()))
    }
    console.log('✨ Sark build artifacts generated successfully.')
  } else if (command === 'start') {
    const entry = args[1] || 'dist/server.mjs'
    const fullPath = resolve(cwd, entry)
    if (!existsSync(fullPath)) {
      console.error(`Error: Production entry "${entry}" not found. Run "sark build" first.`)
      process.exit(1)
    }
    process.env.NODE_ENV = 'production'
    await import(fullPath)
  } else if (command === 'dev') {
    const { createServer } = await import('vite')
    const server = await createServer()
    await server.listen()
    server.printUrls()
  } else if (command === 'build') {
    const { BuildEnvironment, createBuilder } = await import('vite')
    const builder = await createBuilder({
      environments: { ssr: {} },
      builder: { sharedConfigBuild: true },
    })
    const project = await projectFromConfig(builder.config)
    // Reuse Vite's resolved configuration and public environment merging; do not load it again.
    const environment = new BuildEnvironment('ssr', builder.config, {
      options: {
        build: {
          ssr: resolve(project.generatedDir, 'start.ts'),
          outDir: builder.config.build.outDir,
          rolldownOptions: { output: { entryFileNames: 'server.mjs' } },
        },
      },
    })
    await environment.init()
    await builder.build(environment)
  } else {
    console.log(`
Sark CLI

Commands:
  generate       Generate .build artifacts
  dev            Start Vite development server
  build          Build production bundle
  start [entry]  Run production server entry
`)
  }
}

async function projectFromConfig(config: ResolvedConfig): Promise<ResolvedProjectConfig> {
  const plugin = config.plugins.find((entry) => entry.name === '@olivaw/sark')
  if (plugin) {
    const api: SarkPluginApi = plugin.api
    return api.project
  }
  const project = resolveProjectConfig(config.root, resolveSarkOptions())
  const { generateResolvedProject } = await import('../vite')
  generateResolvedProject(project)
  return project
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
