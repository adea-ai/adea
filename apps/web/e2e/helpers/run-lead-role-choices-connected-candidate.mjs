import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { basename, dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

const root = process.cwd()
const manifestPath = process.env.PI_FACTORY_MANIFEST
const expectedHead = process.env.PI_FACTORY_EXPECTED_HEAD
const cpRoot = process.env.PI_FACTORY_CP_ROOT
const bun = process.env.PI_FACTORY_BUN
const databaseUrl = process.env.DATABASE_URL
assert.ok(manifestPath && expectedHead && cpRoot && bun && databaseUrl, 'FIXTURE_INPUTS_REQUIRED')
assert.match(expectedHead, /^[a-f0-9]{40}$/u)
const db = new URL(databaseUrl)
assert.equal(db.hostname, '127.0.0.1')
assert.equal(db.port, '55439')
assert.equal(db.pathname, '/adea_pi_candidate_prepared')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
assert.equal(manifest.schemaVersion, 'pi-durable-candidate-artifacts/v1')
assert.equal(manifest.head, expectedHead)
assert.equal(manifest.dirty, false)
const packages = ['@adea-ai/contracts', '@adea-ai/runtime-sdk', '@adea-ai/sdk']
assert.deepEqual(
  manifest.artifacts.map((item) => item.name),
  packages
)
const temp = mkdtempSync(join(tmpdir(), 'adea-connected-role-candidate-'))
const packageRoots = new Map()
const swapped = []
const packageScope = resolve(root, 'apps/web/node_modules/@adea-ai')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function spawnAndWait(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' })
    let closed = false
    child.once('error', () => {
      if (closed) return
      closed = true
      rejectPromise(new Error('PLAYWRIGHT_SPAWN_FAILED'))
    })
    child.once('close', (code) => {
      if (closed) return
      closed = true
      resolvePromise(Number.isInteger(code) ? code : 1)
    })
  })
}

let exitCode = 1
let phase = 'manifest-verification'
try {
  phase = 'candidate-extraction'
  mkdirSync(packageScope, { recursive: true })
  for (const [index, artifact] of manifest.artifacts.entries()) {
    assert.equal(basename(artifact.archive), artifact.archive)
    const archive = resolve(dirname(manifestPath), artifact.archive)
    const bytes = readFileSync(archive)
    assert.equal(bytes.length, artifact.bytes)
    assert.equal(sha256(bytes), artifact.sha256)
    const extracted = join(temp, String(index))
    mkdirSync(extracted, { recursive: true })
    const tar = spawn('tar', ['-xzf', archive, '-C', extracted, '--strip-components=1'], {
      stdio: 'ignore',
    })
    const tarCode = await new Promise((resolvePromise, rejectPromise) => {
      tar.once('error', () => rejectPromise(new Error('CANDIDATE_EXTRACTION_FAILED')))
      tar.once('close', resolvePromise)
    })
    assert.equal(tarCode, 0)
    const packageJson = JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8'))
    assert.equal(packageJson.name, artifact.name)
    assert.equal(packageJson.version, artifact.version)
    packageRoots.set(artifact.name, extracted)
  }

  phase = 'transitive-package-links'
  phase = 'transitive-web-resolution'
  const zodEntry = realpathSync(
    resolve(root, 'node_modules/.bun/zod@4.6.5/node_modules/zod/package.json')
  )
  phase = 'transitive-zod-package'
  const zodRoot = dirname(zodEntry)
  const zodPackage = JSON.parse(readFileSync(zodEntry, 'utf8'))
  assert.equal(zodPackage.name, 'zod')
  assert.equal(zodPackage.version, '4.6.5')
  const contractNodeModules = join(packageRoots.get('@adea-ai/contracts'), 'node_modules')
  mkdirSync(contractNodeModules, { recursive: true })
  symlinkSync(zodRoot, join(contractNodeModules, 'zod'), 'dir')
  phase = 'transitive-runtime-links'
  for (const name of ['@adea-ai/runtime-sdk', '@adea-ai/sdk']) {
    const dependencies = join(packageRoots.get(name), 'node_modules')
    const scope = join(dependencies, '@adea-ai')
    mkdirSync(scope, { recursive: true })
    symlinkSync(packageRoots.get('@adea-ai/contracts'), join(scope, 'contracts'), 'dir')
    if (name === '@adea-ai/sdk')
      symlinkSync(packageRoots.get('@adea-ai/runtime-sdk'), join(scope, 'runtime-sdk'), 'dir')
    symlinkSync(zodRoot, join(dependencies, 'zod'), 'dir')
  }

  phase = 'candidate-link-swap'
  for (const name of packages) {
    const link = join(packageScope, name.slice('@adea-ai/'.length))
    const backup = `${link}.connected-proof-backup-${process.pid}`
    assert.equal(existsSync(backup), false)
    let hadOriginal = false
    try {
      lstatSync(link)
      renameSync(link, backup)
      hadOriginal = true
    } catch (error) {
      if (error?.code !== 'ENOENT')
        throw new Error('PACKAGE_LINK_PREPARATION_FAILED', { cause: error })
    }
    try {
      symlinkSync(packageRoots.get(name), link, 'dir')
    } catch {
      if (hadOriginal) renameSync(backup, link)
      throw new Error('PACKAGE_LINK_PREPARATION_FAILED')
    }
    swapped.push({ link, backup, hadOriginal })
  }

  phase = 'pinned-bun-verification'
  const version = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bun, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let value = ''
    child.stdout.on('data', (chunk) => (value += chunk.toString()))
    child.once('error', (error) =>
      rejectPromise(new Error('PINNED_BUN_UNAVAILABLE', { cause: error }))
    )
    child.once('close', (code) =>
      code === 0 ? resolvePromise(value.trim()) : rejectPromise(new Error('PINNED_BUN_UNAVAILABLE'))
    )
  })
  assert.equal(version, '1.4.2')
  console.log(
    JSON.stringify({
      schemaVersion: 'adea-connected-role-candidate-run/v1',
      candidateHead: manifest.head,
      sourceDigest: manifest.sourceDigest,
      packages: manifest.artifacts.map(({ name, version: packageVersion, sha256: digest }) => ({
        name,
        version: packageVersion,
        sha256: digest,
      })),
      transitivePackageResolution: {
        contracts: 'exact local archive',
        runtimeSdk: 'exact local archive',
        zod: zodPackage.version,
      },
      bun: version,
      sourceChangesToManifests: false,
    })
  )
  const env = {
    ...process.env,
    PI_ROLE_CONNECTED_PROOF: '1',
    PERF_BASE_URL: 'http://127.0.0.1:1',
  }
  phase = 'playwright'
  exitCode = await spawnAndWait(
    bun,
    [
      '--conditions=react-server',
      'x',
      'playwright',
      'test',
      '--config=playwright.config.ts',
      'apps/web/e2e/lead-role-choices-connected.spec.ts',
      '--workers=1',
      '--reporter=list',
    ],
    { cwd: root, env }
  )
} catch (error) {
  console.error(
    JSON.stringify({
      schemaVersion: 'adea-connected-role-candidate-run/v1',
      failure:
        error?.message === 'FIXTURE_INPUTS_REQUIRED' ? 'FIXTURE_INPUTS_REQUIRED' : 'RUNNER_FAILED',
      phase,
      code: ['EEXIST', 'ENOENT', 'EACCES', 'ERR_ASSERTION'].includes(error?.code)
        ? error.code
        : 'UNKNOWN',
      errorClass: /^[A-Za-z]+$/u.test(error?.name ?? '') ? error.name : 'Error',
    })
  )
  exitCode = 1
} finally {
  for (const { link, backup, hadOriginal } of swapped.toReversed()) {
    rmSync(link, { recursive: true, force: true })
    if (hadOriginal && existsSync(backup)) renameSync(backup, link)
  }
  rmSync(temp, { recursive: true, force: true })
  console.log(
    JSON.stringify({
      schemaVersion: 'adea-connected-role-candidate-cleanup/v1',
      packageLinksRestored: true,
      extractedArtifactsRemoved: true,
      exitCode,
    })
  )
}
process.exitCode = exitCode
