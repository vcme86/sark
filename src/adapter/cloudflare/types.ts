/** Platform event contracts without importing Workers-only SDK types. */
export interface CloudflareExecutionContext {
  /** Registers work with the current platform event lifetime. */
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

/** Scheduled event delivered by the Workers platform. */
export interface ScheduledController {
  readonly scheduledTime: number
  readonly cron: string
  noRetry(): void
}
