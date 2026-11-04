/**
 * Error types reported during stats declaration and runtime operations.
 *
 * @module
 */

export type StatsErrorCode =
  | 'stats_subject_missing'
  | 'stats_subject_invalid'
  | 'stats_counter_unknown'
  | 'stats_key_invalid'
  | 'stats_period_invalid'
  | 'stats_config_error'

/** Domain error thrown when stats operations or configuration constraints fail. */
export class StatsError extends Error {
  readonly code: StatsErrorCode

  constructor(code: StatsErrorCode, message: string) {
    super(message)
    this.name = 'StatsError'
    this.code = code
  }
}
