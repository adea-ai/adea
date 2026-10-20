import { spawnSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { assertFocusedJourneyPassed } from './acceptance-receipt.mjs'
import { classifyEvidence } from './evidence.mjs'
import { readCheckoutProvenance } from './provenance.mjs'
import { fixtureEnvironment, memoryEnvironment, resolveLocalDockerEndpoint } from './policy.mjs'

const repositoryFlag = process.argv.indexOf('--repository')
const root =
  repositoryFlag === -1
    ? fileURLToPath(new URL('../../', import.meta.url))
    : resolve(process.argv[repositoryFlag + 1] ?? '.')
const repositoryFile = (path) => pathToFileURL(resolve(root, path))
// The provenance of the checkout that runs this code. It is read from the
// checkout and not from the target, so a receipt names the tree that produced
// it even when the target is somewhere else.
const checkout = readCheckoutProvenance(fileURLToPath(new URL('../../', import.meta.url)))
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
    JSON.stringify({
      status: 'passed',
      mode: 'memory',
      journeys: 2,
      postgres: 'not-run',
      // The memory lane runs synthetic journeys against an in-memory database.
      // It proves the provider's request path and nothing about PostgreSQL, so
      // its receipt carries the weakest class and cannot be counted as more.
      evidence: classifyEvidence('memory-journey'),
      checkout,
    })
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
let passedReceipt
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
  let receipt
  try {
    receipt = JSON.parse(line.slice('FRESH_SCHEMA_ACCEPTANCE '.length))
  } catch {
    // A receipt that is not JSON is an invalid receipt, not a parse error the
    // caller has to interpret.
    throw new Error('invalid fresh-schema receipt')
  }
  if (receipt.status !== 'passed' || !Number.isInteger(receipt.migrations))
    throw new Error('invalid fresh-schema receipt')
  // The focused desktop principal journey runs in this lane, against the same
  // validated instance and the same isolated environment. It never starts a
  // container itself, so it can only execute here.
  const focused = spawnSync(
    'bun',
    [
      '--no-env-file',
      '--conditions=react-server',
      'test',
      'scripts/fresh-postgres-acceptance/desktop-principal-lifecycle.test.ts',
    ],
    {
      cwd: root,
      env: fixtureEnvironment(fixture.databaseUrl),
      encoding: 'utf8',
      timeout: 600_000,
      killSignal: 'SIGKILL',
    }
  )
  const focusedOutput = (focused.stdout ?? '') + (focused.stderr ?? '')
  if (focused.error || focused.status !== 0) {
    throw new Error('the desktop principal acceptance phase failed; exit=' + focused.status)
  }
  // The journey must have executed: nothing skipped, and the receipt it prints
  // must say it passed. A pass count alone cannot prove that, because the
  // offline regressions of the focused file always run.
  assertFocusedJourneyPassed(focusedOutput)
  passedReceipt = {
    status: 'passed',
    migrations: receipt.migrations,
    verificationRequired: true,
    // The receipt names the class of its own evidence: a disposable loopback
    // instance of the real provider and the real database. It is not a CI
    // result and not a live one, and it may not be recorded as either.
    evidence: classifyEvidence('local-disposable'),
    // The receipt names the commit, the cleanliness and the source of the
    // checkout that produced it, so the artifact can be reproduced.
    checkout,
    ...(receipt.desktopPrincipal ? { desktopPrincipal: receipt.desktopPrincipal } : {}),
  }
} catch (error) {
  failed = true
  console.error(error.message)
} finally {
  try {
    await fixture?.stop()
  } catch {
    failed = true
    console.error('owned PostgreSQL cleanup failed')
  }
}
if (!failed) console.log(JSON.stringify(passedReceipt))
process.exitCode = failed ? 1 : 0
