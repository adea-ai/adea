import { applyAuthSchema, planAuthSchema } from '../../src/schema-init'

// Run by schema-backup-restore.test.ts as its own child process, under that test's
// deadline. The initializer opens its own pool, which no client-side timeout of the
// test can reach, so the test kills this process instead. Prints one JSON line on
// success and a single error line on stderr otherwise.

const action = process.env.AUTH_RUNNER_ACTION

try {
  if (action !== 'apply' && action !== 'plan') {
    throw new Error('AUTH_RUNNER_ACTION must be apply or plan')
  }
  const result =
    action === 'apply' ? await applyAuthSchema(process.env) : await planAuthSchema(process.env)
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'unexpected non-error failure'}\n`
  )
  process.exit(1)
}
