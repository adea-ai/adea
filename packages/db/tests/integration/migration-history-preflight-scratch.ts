export type ScratchDatabaseAdmin = { unsafe(query: string): Promise<unknown[]> }

function assertSafeDatabaseName(name: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('unsafe generated database name')
}

/** Attempt every teardown step and report both command failures and a surviving database. */
export async function cleanupScratchDatabase(admin: ScratchDatabaseAdmin, name: string) {
  assertSafeDatabaseName(name)
  const failures: unknown[] = []

  try {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`
    )
  } catch (error) {
    failures.push(error)
  }

  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`)
  } catch (error) {
    failures.push(error)
  }

  try {
    const [row] = await admin.unsafe(
      `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${name}') AS exists`
    )
    const stillExists = (row as { exists?: unknown } | undefined)?.exists
    if (typeof stillExists !== 'boolean') {
      throw new Error(`could not verify whether scratch database ${name} was removed`)
    }
    if (stillExists) failures.push(new Error(`scratch database ${name} still exists after cleanup`))
  } catch (error) {
    failures.push(error)
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `failed to clean up scratch database ${name}`)
  }
}

/** Preserve the operation error as the primary failure while retaining teardown failures. */
export function throwScratchFailures(
  bodyFailed: boolean,
  bodyError: unknown,
  cleanupErrors: readonly unknown[]
): void {
  if (cleanupErrors.length === 0) {
    if (bodyFailed) throw bodyError
    return
  }

  const errors = bodyFailed ? [bodyError, ...cleanupErrors] : [...cleanupErrors]
  throw new AggregateError(
    errors,
    'scratch database operation or cleanup failed',
    bodyFailed ? { cause: bodyError } : undefined
  )
}
