// M10 #33 packaged application-level vault evidence lane.
// Bundles the production vault adapter into a disposable probe, runs it with
// the Bun executable shipped inside an Electrobun app, and records redacted
// results. A parent cleanup attempt runs even when the probe times out.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(import.meta.dir, '..')
const defaultBundle = join(repoRoot, 'apps/desktop/shell/build/stable-macos-arm64/Adea.app')
const defaultArtifact = join(repoRoot, 'artifacts/packaged/m10-33-vault-evidence.json')
const PROBE_TIMEOUT_MS = 60_000
const CLEANUP_TIMEOUT_MS = 10_000

function cleanupSecuritySlots(base) {
  let succeeded = true
  for (const suffix of ['journey', 'journey.bun', 'denied', 'locked', 'mismatch']) {
    const service = `${base}.${suffix}`
    const result = spawnSync(
      '/usr/bin/security',
      ['delete-generic-password', '-s', service, '-a', 'master-key-v1'],
      { stdio: 'ignore', timeout: CLEANUP_TIMEOUT_MS }
    )
    if (result.error || (result.status !== 0 && result.status !== 44)) succeeded = false
  }
  return succeeded
}

const cleanupProbe = String.raw`
const base = process.env.ADEA_M10_VAULT_SERVICE_ID
if (!base) throw new Error('missing cleanup service id')
const names = ['journey', 'denied', 'locked', 'mismatch']
for (const suffix of names) {
  const service = base + '.' + suffix
  for (const candidate of [service, service + '.bun']) {
    try { await Bun.secrets?.delete?.({ service: candidate, name: 'master-key-v1' }) } catch {}
    try {
      const result = Bun.spawnSync([
        '/usr/bin/security', 'delete-generic-password', '-s', candidate,
        '-a', 'master-key-v1',
      ], { stdout: 'ignore', stderr: 'ignore' })
      if (result.exitCode !== 0 && result.exitCode !== 44) throw new Error('security cleanup failed')
    } catch {}
  }
}
`

function usage() {
  console.error(
    'usage: bun scripts/test-m10-33-packaged-vault.mjs [--app-bundle <Adea.app>] [--artifact <path>] [--source-commit <sha>] [--self-test]'
  )
  process.exit(2)
}

function parseArgs() {
  let appBundle = defaultBundle
  let artifact = defaultArtifact
  let sourceCommit
  let selfTest = false
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
    } else if (flag === '--self-test') {
      selfTest = true
    } else {
      usage()
    }
  }
  return {
    appBundle,
    artifact,
    sourceCommit: sourceCommit ?? run('git', ['rev-parse', 'HEAD'], 5_000).stdout.trim(),
    selfTest,
  }
}

function run(command, args, timeout, input, environment) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    input,
    maxBuffer: 2 * 1024 * 1024,
    timeout,
    ...(environment ? { env: { ...process.env, ...environment } } : {}),
  })
  if (result.error) throw new Error(`command failed: ${result.error.name}`)
  if (result.status !== 0) throw new Error(`command exited ${result.status ?? 'unknown'}`)
  return result
}

function sha256(file) {
  const hash = createHash('sha256')
  hash.update(readFileSync(file))
  return hash.digest('hex')
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
  if (archives.length !== 1) throw new Error('app bundle has no unique payload archive')
  const extractDir = mkdtempSync(join(tmpdir(), 'adea-m10-33-vault-payload-'))
  try {
    run('tar', ['--zstd', '-xf', archives[0], '-C', extractDir], 120_000)
    const extractedApp = join(extractDir, 'Adea.app')
    const runtimePath = join(extractedApp, 'Contents/MacOS/bun')
    if (!existsSync(runtimePath)) throw new Error('payload has no Bun executable')
    return { runtimePath, appRoot: extractedApp, archivePath: archives[0], extractDir }
  } catch (error) {
    rmSync(extractDir, { recursive: true, force: true })
    throw error
  }
}

function relativeArtifactPath(file) {
  const value = relative(repoRoot, file)
  return value && !value.startsWith('../') ? value : '<external-bundle>'
}

function assertEvidence(value) {
  const failures = []
  const journey = value?.journey
  if (journey?.bunSecretsSupported !== true) failures.push('Bun.secrets unsupported')
  if (journey?.legacyKeyRetained !== true) failures.push('legacy key was not retained')
  if (journey?.migratedKeyMatches !== true) failures.push('migration key mismatch')
  if (journey?.upgradedVaultOpened !== true) failures.push('upgraded vault did not open')
  if (journey?.downgradedVaultOpened !== true) failures.push('downgraded vault did not open')
  for (const reason of ['denied', 'locked']) {
    if (value?.refused?.[reason]?.code !== 'auth_required') {
      failures.push(`${reason} store was not refused`)
    }
    if (value?.refused?.[reason]?.writes !== 0) failures.push(`${reason} attempted a write`)
  }
  if (value?.refused?.mismatch?.code !== 'corrupt_state') {
    failures.push('mismatched stores were not refused')
  }
  if (failures.length) throw new Error('packaged vault assertions failed')
}

function runSelfTest() {
  const passing = {
    journey: {
      bunSecretsSupported: true,
      legacyKeyRetained: true,
      migratedKeyMatches: true,
      upgradedVaultOpened: true,
      downgradedVaultOpened: true,
    },
    refused: {
      denied: { code: 'auth_required', writes: 0 },
      locked: { code: 'auth_required', writes: 0 },
      mismatch: { code: 'corrupt_state' },
    },
  }
  assertEvidence(passing)
  for (const [section, field, value] of [
    ['journey', 'legacyKeyRetained', false],
    ['journey', 'upgradedVaultOpened', false],
    ['refused', 'denied', { code: 'accepted', writes: 1 }],
    ['refused', 'mismatch', { code: 'accepted' }],
  ]) {
    const failed = structuredClone(passing)
    if (section === 'journey') failed.journey[field] = value
    else failed.refused[field] = value
    try {
      assertEvidence(failed)
    } catch {
      continue
    }
    throw new Error('packaged vault assertion self-test failed')
  }
  console.log('M10-33 PACKAGED VAULT SELF-TEST PASS')
}

async function main() {
  const { appBundle, artifact, sourceCommit, selfTest } = parseArgs()
  if (selfTest) {
    runSelfTest()
    return
  }
  if (process.platform !== 'darwin') throw new Error('packaged vault evidence requires macOS')
  if (!/^[0-9a-f]{7,40}$/.test(sourceCommit)) throw new Error('invalid source commit')
  if (!existsSync(appBundle)) throw new Error('app bundle does not exist')

  const probeDir = mkdtempSync(join(tmpdir(), 'adea-m10-33-vault-probe-'))
  let resolved
  let serviceId
  let artifactValue
  let primaryError
  try {
    const probePath = join(probeDir, 'packaged-vault-smoke.js')
    run(
      'bun',
      [
        'build',
        'apps/desktop/shell/scripts/packaged-vault-smoke.ts',
        '--outfile',
        probePath,
        '--target=bun',
        '--minify',
      ],
      60_000
    )
    resolved = resolveRuntime(appBundle)
    serviceId = `com.adea.m10.vault.${randomUUID()}`
    artifactValue = {
      schemaVersion: 1,
      lane: 'm10-33-packaged-vault-evidence',
      status: 'failed',
      sourceCommit,
      bundle: {
        kind: resolved.archivePath ? 'stable-payload' : 'direct-bundle',
        app: relativeArtifactPath(resolved.appRoot),
        archiveSha256: resolved.archivePath ? sha256(resolved.archivePath) : null,
        runtimeSha256: sha256(resolved.runtimePath),
      },
      probe: { probeSha256: sha256(probePath) },
      cleanup: { attempted: false, succeeded: false },
    }
    const result = run(resolved.runtimePath, [probePath], PROBE_TIMEOUT_MS, undefined, {
      ADEA_M10_VAULT_SERVICE_ID: serviceId,
    })
    const probe = JSON.parse(result.stdout)
    artifactValue.probe = { ...probe, probeSha256: sha256(probePath) }
    assertEvidence(probe)
    artifactValue.status = 'passed'
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error('packaged vault probe failed')
  } finally {
    if (serviceId && resolved?.runtimePath) {
      const securityCleanup = cleanupSecuritySlots(serviceId)
      let bundledCleanup = false
      try {
        run(resolved.runtimePath, ['-'], CLEANUP_TIMEOUT_MS, cleanupProbe, {
          ADEA_M10_VAULT_SERVICE_ID: serviceId,
        })
        bundledCleanup = true
      } catch {
        bundledCleanup = false
      }
      if (artifactValue) {
        artifactValue.cleanup = {
          attempted: true,
          securityCliSucceeded: securityCleanup,
          bundledRuntimeSucceeded: bundledCleanup,
          succeeded: securityCleanup && bundledCleanup,
        }
        if (!artifactValue.cleanup.succeeded) artifactValue.status = 'failed'
      }
    }
    if (artifactValue) {
      try {
        mkdirSync(dirname(artifact), { recursive: true })
        writeFileSync(artifact, `${JSON.stringify(artifactValue, null, 2)}\n`, { mode: 0o600 })
      } catch {
        if (!primaryError) primaryError = new Error('evidence artifact write failed')
      }
    }
    if (resolved?.extractDir) rmSync(resolved.extractDir, { recursive: true, force: true })
    rmSync(probeDir, { recursive: true, force: true })
  }
  if (primaryError) throw primaryError
  console.log('M10-33 PACKAGED VAULT EVIDENCE PASS')
  console.log(JSON.stringify(artifactValue))
}

main().catch((error) => {
  console.error(
    `M10-33 PACKAGED VAULT EVIDENCE FAIL: ${error instanceof Error ? error.message : 'unknown error'}`
  )
  process.exitCode = 1
})
