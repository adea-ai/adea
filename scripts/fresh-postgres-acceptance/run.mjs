import { spawnSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { fixtureEnvironment, memoryEnvironment, resolveLocalDockerEndpoint } from './policy.mjs'

const repositoryFlag = process.argv.indexOf('--repository')
const root =
  repositoryFlag === -1
    ? fileURLToPath(new URL('../../', import.meta.url))
    : resolve(process.argv[repositoryFlag + 1] ?? '.')
const repositoryFile = (path) => pathToFileURL(resolve(root, path))
// Dedicated memory mode never imports provisioning or connects to PostgreSQL.
if (process.argv.includes('--memory')) {
  const sourceRoot = resolve(process.env.FRESH_AUTH_SOURCE_ROOT ?? root)
  for (const path of ['packages/auth/src/better-auth-server.ts', 'packages/auth/src/delivery.ts']) {
    try {
      await access(resolve(sourceRoot, path))
    } catch {
      throw new Error(
        'memory acceptance prerequisite missing: ' + path + '; use reviewed #1466 source'
      )
    }
  }
  if (process.argv.includes('--preflight')) {
    console.log('Memory acceptance source prerequisites present; no tests or database started.')
    process.exit(0)
  }
  const result = spawnSync(
    'bun',
    [
      '--no-env-file',
      '--conditions=react-server',
      'test',
      'scripts/fresh-postgres-acceptance/web-lifecycle-memory.test.ts',
      'scripts/fresh-postgres-acceptance/desktop-origin-revocation.test.ts',
    ],
    {
      cwd: root,
      env: memoryEnvironment(sourceRoot),
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    }
  )
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  if (
    result.error ||
    result.status !== 0 ||
    !/\b2 pass\b/.test(output) ||
    /\b[1-9]\d* skip\b/.test(output)
  ) {
    throw new Error(
      'memory acceptance failed or did not execute both journeys; raw output withheld'
    )
  }
  console.log(
    JSON.stringify({ status: 'passed', mode: 'memory', journeys: 2, postgres: 'not-run' })
  )
  process.exit(0)
}
// Fail before starting PostgreSQL when the reviewed auth dependency is absent.
for (const path of [
  'packages/auth/src/better-auth-server.ts',
  'packages/auth/src/delivery.ts',
  'scripts/fresh-postgres-acceptance/auth-lifecycle.ts',
  'scripts/fresh-postgres-acceptance/fixture.ts',
]) {
  try {
    await access(repositoryFile(path))
  } catch {
    throw new Error(
      'fresh-schema prerequisite missing: ' + path + '; integrate reviewed #1466 first'
    )
  }
}
const auth = JSON.parse(await readFile(repositoryFile('packages/auth/package.json')))
if (!auth.dependencies?.['better-auth'] || !auth.dependencies?.pg) {
  throw new Error(
    'fresh-schema acceptance requires reviewed #1466 Better Auth/PostgreSQL dependencies'
  )
}
if (process.argv.includes('--preflight')) {
  console.log('Fresh-schema source prerequisites present; no database started.')
  process.exit(0)
}
const dockerEndpoint = resolveLocalDockerEndpoint(process.env, () => {
  const result = spawnSync(
    'docker',
    ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
    {
      encoding: 'utf8',
      timeout: 5_000,
      killSignal: 'SIGKILL',
    }
  )
  if (result.error || result.status !== 0) throw new Error('Docker context metadata unavailable')
  return result.stdout.trim()
})
// Pin this runner process for its entire lifetime, including cleanup/exit handlers.
// No persistent Docker context or caller environment is changed.
process.env.DOCKER_HOST = dockerEndpoint
delete process.env.DOCKER_CONTEXT
delete process.env.DOCKER_TLS_VERIFY
delete process.env.DOCKER_CERT_PATH
const { startCaptureProvisioning } = await import(
  repositoryFile('scripts/capture-provisioning.mjs')
)
let fixture
let failed = false
try {
  fixture = startCaptureProvisioning((handle) => {
    fixture = handle
  })
  if (!fixture?.databaseUrl)
    throw new Error('disposable loopback PostgreSQL unavailable; acceptance did not run')
  const result = spawnSync(
    'bun',
    [
      '--no-env-file',
      '--conditions=react-server',
      'run',
      'scripts/fresh-postgres-acceptance/fixture.ts',
    ],
    {
      cwd: root,
      env: fixtureEnvironment(fixture.databaseUrl),
      encoding: 'utf8',
      timeout: 180_000,
      killSignal: 'SIGKILL',
    }
  )
  if (result.error || result.status !== 0) {
    // Child failures may include SQL/URL parameters. Do not relay raw output or tokens.
    throw new Error('fresh-schema fixture failed; exit=' + result.status)
  }
  const line = result.stdout
    .trim()
    .split('\n')
    .findLast((value) => value.startsWith('FRESH_SCHEMA_ACCEPTANCE '))
  if (!line) throw new Error('fresh-schema receipt missing')
  const receipt = JSON.parse(line.slice('FRESH_SCHEMA_ACCEPTANCE '.length))
  if (receipt.status !== 'passed' || !Number.isInteger(receipt.migrations))
    throw new Error('invalid fresh-schema receipt')
  console.log(
    JSON.stringify({ status: 'passed', migrations: receipt.migrations, verificationRequired: true })
  )
} catch (error) {
  failed = true
  console.error(error.message)
} finally {
  try {
    fixture?.stop()
  } catch {
    failed = true
    console.error('owned PostgreSQL cleanup failed')
  }
}
process.exitCode = failed ? 1 : 0
