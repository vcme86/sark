/**
 * Declaration factory for application background jobs and scheduled tasks.
 *
 * @module
 */

import { evaluateDeclaration, type RequiresEnv } from '../../app/declaration'
import type {
  JobDefinition,
  JobsDeclaration,
  ResolvedCloudflareJobDefinition,
  ResolvedNodeJobDefinition,
} from './types'

export function assertUniqueJobNames(jobs: readonly JobDefinition[]): void {
  const seen = new Set<string>()
  for (const job of jobs) {
    if (!job || typeof job.name !== 'string' || !job.name.trim()) {
      throw new Error('Every job definition must have a non-empty string name.')
    }
    if (seen.has(job.name)) {
      throw new Error(`Duplicate job name "${job.name}". Job names must be unique.`)
    }
    seen.add(job.name)
  }
}

export function defineJobs(definitions: readonly JobDefinition[]): JobsDeclaration
export function defineJobs<E>(
  factory: (env: E) => readonly JobDefinition[],
): JobsDeclaration<E> & RequiresEnv<E>
export function defineJobs<E>(
  input: readonly JobDefinition[] | ((env: E) => readonly JobDefinition[]),
): JobsDeclaration {
  if (Array.isArray(input)) {
    assertUniqueJobNames(input)
  }
  return {
    kind: 'jobs',
    value: input,
    isFactory: typeof input === 'function',
  }
}

export function resolveJobsDeclaration(
  declaration: JobsDeclaration | undefined,
  env: unknown,
  target: 'node',
): readonly ResolvedNodeJobDefinition[]
export function resolveJobsDeclaration(
  declaration: JobsDeclaration | undefined,
  env: unknown,
  target: 'cloudflare',
): readonly ResolvedCloudflareJobDefinition[]
export function resolveJobsDeclaration(
  declaration: JobsDeclaration | undefined,
  env: unknown,
  target: 'node' | 'cloudflare',
): readonly ResolvedNodeJobDefinition[] | readonly ResolvedCloudflareJobDefinition[] {
  if (!declaration) return []
  const rawJobs = evaluateDeclaration<readonly JobDefinition[]>(
    (declaration as any).value,
    env,
    'jobs',
  )
  if (!Array.isArray(rawJobs)) {
    throw new Error('Jobs declaration must evaluate to an array of job definitions.')
  }
  assertUniqueJobNames(rawJobs)

  if (target === 'cloudflare') {
    const resolved: ResolvedCloudflareJobDefinition[] = []
    for (const job of rawJobs) {
      if (
        (job as any).schedule !== undefined ||
        (job as any).timezone !== undefined ||
        (job as any).preventOverlap !== undefined ||
        (job as any).runOnInit !== undefined
      ) {
        throw new Error(
          `Job "${job.name}" declares Node-specific options (schedule, timezone, preventOverlap, or runOnInit) not supported on Cloudflare Workers.`,
        )
      }
      if (typeof (job as any).onCron !== 'string' || !(job as any).onCron.trim()) {
        throw new Error(
          `Job "${job.name}" must specify a non-empty onCron string on Cloudflare Workers.`,
        )
      }
      if (typeof job.handler !== 'function') {
        throw new Error(`Job "${job.name}" must provide a valid handler function.`)
      }
      if (job.timeout !== undefined && (!Number.isFinite(job.timeout) || job.timeout <= 0)) {
        throw new Error(`Job "${job.name}" timeout must be a positive number of milliseconds.`)
      }
      resolved.push({
        name: job.name,
        onCron: (job as any).onCron.trim(),
        handler: job.handler,
        timeout: job.timeout,
      })
    }
    return resolved
  }

  const resolved: ResolvedNodeJobDefinition[] = []
  for (const job of rawJobs) {
    if ((job as any).onCron !== undefined) {
      throw new Error(
        `Job "${job.name}" declares onCron which is only supported on Cloudflare Workers. Use schedule for Node.js.`,
      )
    }
    if (typeof job.handler !== 'function') {
      throw new Error(`Job "${job.name}" must provide a valid handler function.`)
    }
    const isInterval =
      typeof (job as any).schedule === 'object' && 'interval' in (job as any).schedule
    if (isInterval) {
      const interval = (job.schedule as { interval: number }).interval
      if (!Number.isFinite(interval) || interval <= 0) {
        throw new Error(`Job "${job.name}" interval must be a positive number of milliseconds.`)
      }
    } else if (typeof (job as any).schedule !== 'string' || !(job as any).schedule.trim()) {
      throw new Error(`Job "${job.name}" must specify a cron string or interval schedule.`)
    }

    if (job.timeout !== undefined && (!Number.isFinite(job.timeout) || job.timeout <= 0)) {
      throw new Error(`Job "${job.name}" timeout must be a positive number of milliseconds.`)
    }

    resolved.push({
      name: job.name,
      schedule: job.schedule as any,
      handler: job.handler,
      timeout: job.timeout,
      timezone: (job as any).timezone,
      preventOverlap: (job as any).preventOverlap ?? true,
      runOnInit: (job as any).runOnInit ?? false,
    })
  }

  return resolved
}
