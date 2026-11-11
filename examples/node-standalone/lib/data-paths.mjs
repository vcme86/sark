/**
 * Resolves the application's configured SQLite filename or its local default.
 *
 * @param {NodeJS.ProcessEnv} env - Application environment.
 * @returns {string} Filename relative to the application root or an absolute path.
 */
export function databaseFile(env) {
  return env.DATABASE_FILE ?? './data/app.db'
}
