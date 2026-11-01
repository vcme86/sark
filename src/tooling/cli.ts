#!/usr/bin/env node
/**
 * Sark commands for generation, Vite development/builds, and server startup.
 *
 * @module
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Manifest, ResolvedConfig } from 'vite'

import { createProductionAssets, listPublicFiles, writeBuildAssets } from './build/assets'
import { discoverPages } from './build/discover/pages'
import { type ResolvedProjectConfig, resolvePluginOptions, resolveProjectConfig } from './config'
import type { PluginApi } from './vite'

/** Expected command-line usage failures, reported without an internal stack. */
class UsageError extends Error {}

/**
 * Executes the Sark CLI with the provided command-line arguments.
 *
 * @param args - Array of command-line argument tokens (defaults to `process.argv.slice(2)`).
 * @returns A promise resolving after command setup, generation, or building completes.
 * @throws If the command is invalid or configuration loading, generation, startup, or building fails.
 */
async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const command = args[0] || 'help'
  const cwd = process.cwd()

  if (command === 'generate') {
    const { resolveConfig } = await import('vite')
    const config = await resolveConfig(
      { environments: { ssr: {} } },
      'build',
      'production',
      'production',
    )
    if (!config.plugins.some((plugin) => plugin.name === '@olivaw/sark')) {
      const { generateConfiguredProject } = await import('./build/project')
      await generateConfiguredProject(
        config,
        resolveProjectConfig(config.root, resolvePluginOptions()),
      )
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
      build: { manifest: true },
    })
    const project = await projectFromConfig(builder.config)
    if (project.target === 'cloudflare') {
      await builder.buildApp()
    } else {
      // Clean output directory once before environment builds if configured to empty
      const rootDir = builder.config.root
      const absOutDir = resolve(rootDir, builder.config.build.outDir)
      const relOutDir = relative(rootDir, absOutDir)
      const isInsideRoot =
        relOutDir !== '' &&
        relOutDir !== '..' &&
        !relOutDir.startsWith(`..${sep}`) &&
        !isAbsolute(relOutDir)
      const shouldEmpty = builder.config.build.emptyOutDir ?? isInsideRoot

      if (shouldEmpty) {
        rmSync(absOutDir, { recursive: true, force: true })
      }

      const clientEntry = resolve(project.generatedDir, 'client.tsx')
      const hasPages = existsSync(clientEntry)
      const plugin = builder.config.plugins.find((entry) => entry.name === '@olivaw/sark')
      const pages = plugin
        ? (plugin.api as PluginApi).pages
        : project.webDir === false
          ? undefined
          : discoverPages(project.webDir, project.webPrefix)
      let manifest: Manifest = {}
      if (hasPages) {
        const clientEnvironment = new BuildEnvironment('client', builder.config, {
          options: {
            build: {
              outDir: resolve(absOutDir, 'client'),
              manifest: true,
              copyPublicDir: false,
              emptyOutDir: false,
              rolldownOptions: {
                input: clientEntry,
                output: {
                  entryFileNames: 'assets/[name]-[hash].js',
                  chunkFileNames: 'assets/[name]-[hash].js',
                  assetFileNames: 'assets/[name]-[hash][extname]',
                },
              },
            },
          },
        })
        await clientEnvironment.init()
        await builder.build(clientEnvironment)
        const manifestName =
          typeof clientEnvironment.config.build.manifest === 'string'
            ? clientEnvironment.config.build.manifest
            : '.vite/manifest.json'
        const manifestPath = resolve(clientEnvironment.config.build.outDir, manifestName)
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
        copyFileSync(manifestPath, resolve(absOutDir, 'manifest.json'))
        rmSync(manifestPath)
      }

      const publicPaths = listPublicFiles(builder.config.publicDir)
      if (builder.config.publicDir && existsSync(builder.config.publicDir)) {
        mkdirSync(absOutDir, { recursive: true })
        cpSync(builder.config.publicDir, resolve(absOutDir, 'public'), { recursive: true })
      }
      writeBuildAssets(
        project,
        createProductionAssets(manifest, project, pages, builder.config.base, publicPaths),
      )

      // Reuse Vite's resolved configuration and public environment merging; do not load it again.
      const environment = new BuildEnvironment('ssr', builder.config, {
        options: {
          build: {
            ssr: resolve(project.generatedDir, 'start.ts'),
            outDir: absOutDir,
            emptyOutDir: false,
            copyPublicDir: false,
            manifest: false,
            rolldownOptions: {
              output: { entryFileNames: 'server.mjs', chunkFileNames: 'server/[name]-[hash].mjs' },
            },
          },
        },
      })
      await environment.init()
      await builder.build(environment)
    }
  } else if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`
Sark CLI

Commands:
  generate       Generate .build artifacts
  dev            Start Vite development server
  build          Build production bundle
  start [entry]  Run production server entry
`)
  } else {
    throw new UsageError(
      `Unknown Sark command: ${command}. Run "sark help" for available commands.`,
    )
  }
}

async function projectFromConfig(config: ResolvedConfig): Promise<ResolvedProjectConfig> {
  const plugin = config.plugins.find((entry) => entry.name === '@olivaw/sark')
  if (plugin) {
    return (plugin.api as PluginApi).project
  }
  const project = resolveProjectConfig(config.root, resolvePluginOptions())
  const { generateConfiguredProject } = await import('./build/project')
  await generateConfiguredProject(config, project)
  return project
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((err) => {
    console.error(err instanceof UsageError ? err.message : err)
    process.exit(1)
  })
}
