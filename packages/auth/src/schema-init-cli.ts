// Operator entry for the explicit Better Auth schema initializer. Plan is the
// default; `--apply` is the only way to change the database. Inputs come from
// the environment (never argv, so no connection string lands in shell history):
// AUTH_MIGRATION_DATABASE_URL plus the same AUTH_BASE_URL, AUTH_SECRET and
// AUTH_TRUSTED_ORIGINS the runtime service validates.
import { AuthSchemaInitError, applyAuthSchema, planAuthSchema } from './schema-init'

const flags = process.argv.slice(2)
const known = new Set(['--plan', '--apply'])
const apply = flags.includes('--apply')

if (flags.some((flag) => !known.has(flag)) || (flags.includes('--plan') && apply)) {
  console.error('usage: schema-init [--plan | --apply]')
  process.exitCode = 2
} else {
  try {
    const result = apply ? await applyAuthSchema() : await planAuthSchema()
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', status: 'ok', ...result }))
  } catch (error) {
    const detail =
      error instanceof AuthSchemaInitError
        ? { message: error.message, stage: error.stage }
        : { message: 'unexpected failure', stage: 'unknown' }
    console.error(JSON.stringify({ mode: apply ? 'apply' : 'plan', status: 'failed', ...detail }))
    process.exitCode = 1
  }
}
