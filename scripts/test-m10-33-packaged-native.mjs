// M10 #33 packaged-native evidence lane.
// Runs only the Bun executable shipped inside an Electrobun bundle. The child
// probe creates synthetic secret material and a disposable SQLite database;
// neither the secret nor a secret-derived digest is emitted.
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(import.meta.dir, '..')
const defaultBundle = join(repoRoot, 'apps/desktop/shell/build/stable-macos-arm64/Adea.app')
const defaultArtifact = join(repoRoot, 'artifacts/packaged/m10-33-native-evidence.json')
const EXTRACT_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 30_000

const childProbe = String.raw`
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

const report = {
  bunVersion: Bun.version,
  bunSecrets: { available: typeof Bun.secrets?.get === 'function' },
  bunSqlite: { available: typeof Database === 'function' },
}

const service = 'com.adea.m10.evidence.' + process.pid + '.' + Date.now()
const name = 'round-trip'
const secret = 'synthetic-' + crypto.randomUUID()
if (report.bunSecrets.available) {
  let secretAttempted = false
  let secretWasSet = false
  let roundTrip = false
  let failure
  let cleanupFailure
  try {
    secretAttempted = true
    await Bun.secrets.set({ service, name, value: secret })
    secretWasSet = true
    roundTrip = (await Bun.secrets.get({ service, name })) === secret
  } catch (error) {
    failure = error instanceof Error ? error.name : 'unknown'
  } finally {
    if (secretAttempted) {
      try {
        await Bun.secrets.delete({ service, name })
      } catch (error) {
        cleanupFailure = error instanceof Error ? error.name : 'unknown'
      }
    }
  }
  if (cleanupFailure) throw new Error('Bun.secrets cleanup failed')
  const absentAfterDelete = secretWasSet
    ? (await Bun.secrets.get({ service, name })) === null
    : false
  report.bunSecrets = {
    ...report.bunSecrets,
    roundTrip,
    absentAfterDelete,
    ...(failure ? { failure } : {}),
  }
} else {
  report.bunSecrets = { ...report.bunSecrets, roundTrip: false, absentAfterDelete: false }
}

const dbDir = mkdtempSync(join(tmpdir(), 'adea-m10-33-sqlite-'))
const dbPath = join(dbDir, 'durable.sqlite')
let db
try {
  if (!report.bunSqlite.available) throw new Error('bun:sqlite is unavailable')
  db = new Database(dbPath)
  db.exec(
    'PRAGMA journal_mode = WAL; CREATE TABLE evidence (id INTEGER PRIMARY KEY, label TEXT UNIQUE NOT NULL);'
  )
  db.query('INSERT INTO evidence (label) VALUES (?)').run('survivor')
  let failureInjected = false
  try {
    const atomic = db.transaction(() => {
      db.query('INSERT INTO evidence (label) VALUES (?)').run('rolled-back')
      db.query('INSERT INTO evidence (label) VALUES (?)').run('survivor')
    })
    atomic()
  } catch {
    failureInjected = true
  }
  const afterFailure = db.query('SELECT label FROM evidence ORDER BY id').all()
  db.close()
  db = undefined
  const reopened = new Database(dbPath)
  const afterReopen = reopened.query('SELECT label FROM evidence ORDER BY id').all()
  reopened.close()
  const expected = JSON.stringify([{ label: 'survivor' }])
  report.bunSqlite = {
    ...report.bunSqlite,
    journalMode: 'WAL',
    failureInjected,
    rollbackPreserved: JSON.stringify(afterFailure) === expected,
    reopenDurable: JSON.stringify(afterReopen) === expected,
  }
} catch (error) {
  report.bunSqlite = {
    ...report.bunSqlite,
    failureInjected: false,
    rollbackPreserved: false,
    reopenDurable: false,
    failure: error instanceof Error ? error.name : 'unknown',
  }
} finally {
  try {
    db?.close()
  } finally {
    rmSync(dbDir, { recursive: true, force: true })
  }
}

console.log(JSON.stringify(report))
`

function usage() {
  console.error(
    'usage: bun scripts/test-m10-33-packaged-native.mjs [--app-bundle <Adea.app>] [--artifact <path>] [--source-commit <sha>]'
  )
  process.exit(2)
}

function parseArgs() {
  let appBundle = defaultBundle
  let artifact = defaultArtifact
  let sourceCommit
  for (let index = 2; index < process.argv.length; index += 1) {
    const flag = process.argv[index]
    const value = process.argv[index + 1]
    if (flag === '--app-bundle' && value) {
      appBundle = resolve(value)
      index += 1
    } else if (flag === '--artifact' && value) {
      artifact = resolve(value)
      index += 1
    } else if (flag === '--source-commit' && value) {
      sourceCommit = value
      index += 1
    } else if (flag === '--help') {
      usage()
    } else {
      usage()
    }
  }
  return {
    appBundle,
    artifact,
    sourceCommit: sourceCommit ?? run('git', ['rev-parse', 'HEAD'], 5_000).stdout.trim(),
  }
}

function digestFile(file) {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveDigest(hash.digest('hex')))
  })
}

function run(command, args, timeout, input) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    input,
    maxBuffer: 2 * 1024 * 1024,
    timeout,
  })
  if (result.error) throw new Error(`${command} failed: ${result.error.name}`)
  if (result.status !== 0) {
    const signal = result.signal ? ` (${result.signal})` : ''
    throw new Error(`${command} exited ${result.status ?? 'unknown'}${signal}`)
  }
  return result
}

function resolveRuntime(appBundle) {
  const directRuntime = join(appBundle, 'Contents/MacOS/bun')
  if (existsSync(directRuntime)) return { runtimePath: directRuntime, appRoot: appBundle }

  const resources = join(appBundle, 'Contents/Resources')
  const archives = existsSync(resources)
    ? readdirSync(resources)
        .filter((name) => name.endsWith('.tar.zst'))
        .map((name) => join(resources, name))
    : []
  if (archives.length !== 1) {
    throw new Error('stable app bundle must contain exactly one payload archive')
  }
  const extractDir = mkdtempSync(join(tmpdir(), 'adea-m10-33-payload-'))
  try {
    run('tar', ['--zstd', '-xf', archives[0], '-C', extractDir], EXTRACT_TIMEOUT_MS)
    const extractedApp = join(extractDir, 'Adea.app')
    const extractedRuntime = join(extractedApp, 'Contents/MacOS/bun')
    if (!existsSync(extractedRuntime)) throw new Error('payload has no bundled Bun executable')
    return {
      runtimePath: extractedRuntime,
      appRoot: extractedApp,
      archivePath: archives[0],
      extractDir,
    }
  } catch (error) {
    rmSync(extractDir, { recursive: true, force: true })
    throw error
  }
}

function relativeArtifactPath(file) {
  const relativePath = relative(repoRoot, file)
  return relativePath && !relativePath.startsWith('../') ? relativePath : '<external-bundle>'
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('packaged Bun.secrets evidence requires macOS')
  }
  const { appBundle, artifact, sourceCommit } = parseArgs()
  if (!/^[0-9a-f]{7,40}$/.test(sourceCommit)) {
    throw new Error('source commit must be a lowercase hexadecimal Git object id')
  }
  if (!existsSync(appBundle)) throw new Error('app bundle does not exist')

  let resolved
  try {
    resolved = resolveRuntime(appBundle)
    const result = run(resolved.runtimePath, ['-'], PROBE_TIMEOUT_MS, childProbe)
    const probe = JSON.parse(result.stdout)
    const artifactValue = {
      schemaVersion: 1,
      lane: 'm10-33-packaged-native-evidence',
      sourceCommit,
      bundle: {
        kind: resolved.archivePath ? 'stable-payload' : 'direct-bundle',
        app: relativeArtifactPath(resolved.appRoot),
        archiveSha256: resolved.archivePath ? await digestFile(resolved.archivePath) : null,
        runtimeSha256: await digestFile(resolved.runtimePath),
        versionJsonSha256: await digestFile(
          join(resolved.appRoot, 'Contents/Resources/version.json')
        ),
      },
      probe,
    }
    mkdirSync(dirname(artifact), { recursive: true })
    writeFileSync(artifact, `${JSON.stringify(artifactValue, null, 2)}\n`, { mode: 0o600 })
    console.log('M10-33 PACKAGED NATIVE EVIDENCE PASS')
    console.log(JSON.stringify(artifactValue))
  } finally {
    if (resolved?.extractDir) rmSync(resolved.extractDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(
    `M10-33 PACKAGED NATIVE EVIDENCE FAIL: ${error instanceof Error ? error.message : 'unknown error'}`
  )
  process.exitCode = 1
})
