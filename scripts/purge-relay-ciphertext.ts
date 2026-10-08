import {
  parseRelayRetentionArguments,
  relayRetentionDatabaseUrl,
  RelayRetentionOperatorError,
} from './relay-retention-config'

async function run() {
  const options = parseRelayRetentionArguments(process.argv.slice(2))
  const url = relayRetentionDatabaseUrl(options)
  // Validate the complete operator target before importing or creating a database client.
  const { createDatabase } = await import('../packages/db/src/connection')
  const { inspectExpiredTaskSubmissionCiphertext, purgeExpiredTaskSubmissionCiphertext } =
    await import('../packages/db/src/task-submission-retention')
  const connection = createDatabase(url)
  let count: number
  try {
    count = await (
      options.apply ? purgeExpiredTaskSubmissionCiphertext : inspectExpiredTaskSubmissionCiphertext
    )(connection.db, options.workspaceId, options.limit)
  } finally {
    await connection.close()
  }
  return {
    schemaVersion: 1,
    mode: options.apply ? 'apply' : 'dry_run',
    count,
    limit: options.limit,
  }
}

try {
  console.log(JSON.stringify(await run()))
} catch (error) {
  console.error(
    JSON.stringify({
      error: error instanceof RelayRetentionOperatorError ? error.code : 'retention_unavailable',
    })
  )
  process.exitCode = 1
}
