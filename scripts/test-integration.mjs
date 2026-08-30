import { readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const localDatabaseEnvironment = {
  DATABASE_URL:
    'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable',
  DATABASE_URL_UNPOOLED:
    'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable',
  DATABASE_MIGRATION_URL:
    'postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55432/agent_hq?sslmode=disable',
}

const integrationDirectories = readdirSync(resolve(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(root, 'packages', entry.name, 'tests', 'integration'))
  .filter((directory) => existsSync(directory))
  .sort()

if (integrationDirectories.length === 0) {
  throw new Error('No package integration test directories were found')
}

function run(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: environment,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }
}

function runningComposeServices() {
  const result = spawnSync('docker', ['compose', 'ps', '--status', 'running', '--services'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw new Error('Docker is required when DATABASE_URL is not set')
  if (result.status !== 0) {
    throw new Error('Docker Compose is required when DATABASE_URL is not set')
  }
  return result.stdout.split(/\r?\n/).filter(Boolean)
}

const usesExplicitDatabase = Boolean(process.env.DATABASE_URL)
if (usesExplicitDatabase) {
  const missingVariables = ['DATABASE_URL_UNPOOLED', 'DATABASE_MIGRATION_URL'].filter(
    (name) => !process.env[name]
  )
  if (missingVariables.length > 0) {
    throw new Error(
      `${missingVariables.join(', ')} ${missingVariables.length === 1 ? 'is' : 'are'} required when DATABASE_URL is supplied; use an isolated test target`
    )
  }
}

const environment = usesExplicitDatabase
  ? { ...process.env }
  : { ...process.env, ...localDatabaseEnvironment }
let startedLocalPostgres = false

try {
  if (!usesExplicitDatabase && !runningComposeServices().includes('postgres')) {
    run(
      'docker',
      ['compose', 'up', '-d', '--wait', '--wait-timeout', '30', 'postgres'],
      process.env
    )
    startedLocalPostgres = true
  }

  run('node', ['scripts/database-health.mjs'], environment)
  run('bun', ['run', '--cwd', 'packages/db', 'db:verify'], environment)
  run('bun', ['test', ...integrationDirectories], environment)
} finally {
  if (startedLocalPostgres) {
    run('docker', ['compose', 'stop', 'postgres'], process.env)
  }
}
