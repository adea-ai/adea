import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assertProvisionedLoopback,
  fixtureEnvironment,
  memoryEnvironment,
  resolveLocalDockerEndpoint,
} from './policy.mjs'
import { buildAcceptanceReceipt, parseJourneyReceipt } from './acceptance-receipt.mjs'
import {
  EVIDENCE_CLASSES,
  assertEvidenceClass,
  assertEvidenceNotPromoted,
  classifyEvidence,
  receiptEvidence,
} from './evidence.mjs'
import {
  RECOVERY_METHODS,
  assertDatabaseProof,
  assertRecoveryMethod,
  assertTestedRecoveryArtifact,
  recoveryArtifact,
  recoveryPlan,
} from './recovery.mjs'
import { assertReproducibleProvenance, readCheckoutProvenance } from './provenance.mjs'
import { CP_COMPATIBILITY_SCOPE, assertCpScope, cpOpenItems } from './cp-compatibility.mjs'
import {
  assertFreshAccountOnly,
  assertNoNeonInScope,
  freshAccountOnlyViolations,
  freshAccountScopeFiles,
  laneSourceFiles,
  noNeonViolations,
  scanFreshAccountScope,
  scanNoNeonScope,
} from './fresh-account-only.mjs'

const local = 'postgresql://postgres:synthetic@127.0.0.1:54399/postgres?sslmode=disable'
// The checkout this policy suite runs in.
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
// The commands the acceptance runner issues, and the receipt each one prints.
const FRESH_SCHEMA_COMMAND = 'scripts/fresh-postgres-acceptance/fixture.ts'
const FOCUSED_JOURNEY_COMMAND =
  'scripts/fresh-postgres-acceptance/desktop-principal-lifecycle.test.ts'
const SYNTHETIC_FRESH_SCHEMA_OUTPUT = 'FRESH_SCHEMA_ACCEPTANCE {"status":"passed","migrations":3}\n'
const SYNTHETIC_JOURNEY_OUTPUT =
  '1 pass\n0 fail\n0 skip\nDESKTOP_PRINCIPAL_JOURNEY {"status":"passed","journeys":1}\n'
test('Docker provisioning rejects remote hosts, remote contexts and TLS overrides before mutation', () => {
  const socket = 'unix:///synthetic/docker.sock'
  const inspect = () => JSON.stringify(socket)
  assert.equal(resolveLocalDockerEndpoint({}, inspect), socket)
  assert.equal(resolveLocalDockerEndpoint({ DOCKER_HOST: socket }, inspect), socket)
  assert.equal(resolveLocalDockerEndpoint({ DOCKER_CONTEXT: 'local-context' }, inspect), socket)
  for (const endpoint of [
    'tcp://remote.example.test:2376',
    'ssh://operator@remote.example.test',
    'unix://remote/socket',
    'npipe:////remote/pipe/docker_engine',
  ]) {
    assert.throws(() => resolveLocalDockerEndpoint({ DOCKER_HOST: endpoint }, inspect))
    assert.throws(() =>
      resolveLocalDockerEndpoint({ DOCKER_CONTEXT: 'remote' }, () => JSON.stringify(endpoint))
    )
  }
  for (const key of ['DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    assert.throws(() => resolveLocalDockerEndpoint({ [key]: 'synthetic' }, inspect))
  }
  assert.throws(() => resolveLocalDockerEndpoint({}, () => 'invalid metadata'))
})
test('accepts only the exact loopback provisioner URL shape', () => {
  assert.equal(assertProvisionedLoopback(local), local)
  for (const value of [
    local.replace('127.0.0.1', 'db.example.test'),
    local.replace('127.0.0.1:54399', 'localhost:54399'),
    local.replace('127.0.0.1:54399', '127.0.0.1'),
    local.replace('/postgres?', '/shared?'),
    local.replace('postgres:synthetic', 'runtime:synthetic'),
    local + '&host=db.example.test',
    local + '&options=-csearch_path=public',
    local + '#ignored',
    'postgresql:///postgres',
    'not a URL',
  ])
    assert.throws(() => assertProvisionedLoopback(value))
})
test('child environment excludes remote targets, PG routing and real delivery settings', () => {
  const env = fixtureEnvironment(local, {
    PATH: '/synthetic/bin',
    TMPDIR: '/tmp',
    LANG: 'C',
    DATABASE_URL: 'untrusted',
    DATABASE_MIGRATION_URL: 'untrusted',
    PGHOST: 'untrusted',
    PGSERVICE: 'untrusted',
    AUTH_DATABASE_URL: 'untrusted',
    AUTH_SECRET: 'untrusted',
    SMTP_PASSWORD: 'untrusted',
    ADEA_ALLOW_REMOTE_TEST_TARGET: 'untrusted',
    ADEA_CI_BRANCH_HOSTS: 'untrusted',
    MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL: 'untrusted',
  })
  assert.deepEqual(env, {
    PATH: '/synthetic/bin',
    TMPDIR: '/tmp',
    LANG: 'C',
    MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL: local,
  })
})

test('memory acceptance gets explicit opt-in and only the selected source plus process settings', () => {
  assert.deepEqual(
    memoryEnvironment('/synthetic/reviewed-source', {
      PATH: '/synthetic/bin',
      DATABASE_URL: 'untrusted',
      AUTH_SECRET: 'untrusted',
      FRESH_AUTH_SOURCE_ROOT: '/untrusted',
      FRESH_AUTH_ACCEPTANCE: '0',
      SMTP_PASSWORD: 'untrusted',
    }),
    {
      PATH: '/synthetic/bin',
      FRESH_AUTH_SOURCE_ROOT: '/synthetic/reviewed-source',
      FRESH_AUTH_ACCEPTANCE: '1',
    }
  )
})

test('explicit memory run fails closed before tests or provisioning when its source is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'fresh-memory-preflight-'))
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--repository', root, '--memory'],
      { encoding: 'utf8', env: { PATH: process.env.PATH } }
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /memory acceptance prerequisite missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing source fails before the provisioner module can load', () => {
  const root = mkdtempSync(join(tmpdir(), 'fresh-schema-preflight-'))
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--repository', root, '--preflight'],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 1)
    assert.match(
      result.stderr,
      /fresh-schema prerequisite missing: packages\/auth\/src\/better-auth-server.ts/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('complete preflight never imports provisioning or connects to a database', () => {
  const root = mkdtempSync(join(tmpdir(), 'fresh-schema-preflight-'))
  try {
    for (const path of [
      'packages/auth/src/better-auth-server.ts',
      'packages/auth/src/delivery.ts',
      'scripts/fresh-postgres-acceptance/auth-lifecycle.ts',
      'scripts/fresh-postgres-acceptance/fixture.ts',
    ]) {
      const file = join(root, path)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '// source-existence preflight fixture only\n')
    }
    writeFileSync(
      join(root, 'packages/auth/package.json'),
      JSON.stringify({
        dependencies: {
          'better-auth': '1.6.23',
          pg: '8.23.1',
        },
      })
    )
    writeFileSync(
      join(root, 'scripts/capture-provisioning.mjs'),
      "throw new Error('must not import provisioner in preflight')"
    )
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--repository', root, '--preflight'],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /no database started/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function runSyntheticMemoryAcceptance(childOutput, options = {}) {
  const { sourceRoot } = options
  const root = mkdtempSync(join(tmpdir(), 'fresh-memory-gate-'))
  try {
    for (const path of [
      'packages/auth/src/better-auth-server.ts',
      'packages/auth/src/delivery.ts',
    ]) {
      const file = join(root, path)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '// synthetic source prerequisite only\n')
    }
    const shim = join(root, 'synthetic-memory-child.mjs')
    writeFileSync(
      shim,
      `import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const realSpawnSync = childProcess.spawnSync;
      childProcess.spawnSync = (command, args, options) => {
        if (command !== 'bun') return realSpawnSync(command, args, options);
        return { status: 0, stdout: ${JSON.stringify(childOutput)}, stderr: '' };
      };
      syncBuiltinESMExports();`
    )
    return spawnSync(
      process.execPath,
      [
        '--import',
        shim,
        fileURLToPath(new URL('./run.mjs', import.meta.url)),
        '--repository',
        root,
        '--memory',
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          ...(sourceRoot ? { FRESH_AUTH_SOURCE_ROOT: sourceRoot } : {}),
        },
        timeout: 10_000,
      }
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('memory acceptance fails closed on an incomplete or skipped journey run', () => {
  for (const output of ['\n 1 pass\n 0 fail\n', '\n 2 pass\n 1 skip\n']) {
    const result = runSyntheticMemoryAcceptance(output)
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1, result.stderr)
    assert.doesNotMatch(result.stdout, /"status":"passed"/)
    assert.match(result.stderr, /did not execute both journeys/)
  }
})

test('memory acceptance publishes a passed receipt only for both executed journeys', () => {
  const result = runSyntheticMemoryAcceptance('\n 2 pass\n 0 fail\n')
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const receipt = JSON.parse(result.stdout.trim())
  assert.equal(receipt.status, 'passed')
  assert.equal(receipt.mode, 'memory')
  assert.equal(receipt.journeys, 2)
  assert.equal(receipt.postgres, 'not-run')
  assert.equal(receipt.evidence, 'simulated')
  // The receipt names the kind of proof it is, so the recovery procedure can
  // refuse it: it is not a database proof.
  assert.equal(receipt.proofKind, 'memory-journey')
  assert.equal(receipt.postgres, 'not-run')
  // The receipt names the roots it exercised, so the artifact it proves can
  // be reproduced.
  // Every root the run touched is named, and the module checkout is a real
  // one, so the receipt never leaves a root unsaid.
  assert.equal(typeof receipt.checkout.sha, 'string')
  assert.ok(
    receipt.checkout.dirty === null || typeof receipt.checkout.dirty === 'boolean',
    'the dirty flag is a boolean, or null when the tree could not be read'
  )
  assert.ok(receipt.checkout.source.length > 0)
  assert.match(receipt.module.sha, /^[0-9a-f]{40}$/)
  assert.equal(typeof receipt.source.sha, 'string')
  assert.ok(receipt.source.source.length > 0)
})

test('the memory receipt names the source tree it was pointed at', () => {
  const { root: sourceRoot, git } = temporaryRepository()
  try {
    for (const path of [
      'packages/auth/src/better-auth-server.ts',
      'packages/auth/src/delivery.ts',
    ]) {
      const file = join(sourceRoot, path)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '// synthetic source prerequisite only\n')
    }
    const committed = commitRepository(sourceRoot)
    const result = runSyntheticMemoryAcceptance('\n 2 pass\n 0 fail\n', { sourceRoot })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(result.stdout.trim())
    // The receipt names the source tree it read, not the tree the runner code
    // came from.
    assert.equal(receipt.source.sha, committed.sha)
    assert.equal(receipt.source.sha, git(['rev-parse', 'HEAD']))
    assert.notEqual(receipt.module.sha, receipt.source.sha)
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true })
  }
})

/**
 * Turns a directory into a repository with one commit, and returns its sha.
 */
function commitRepository(root) {
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git(['init', '-q'])
  git(['add', '-A'])
  git([
    '-c',
    'user.name=synthetic',
    '-c',
    'user.email=synthetic@example.invalid',
    'commit',
    '-q',
    '-m',
    'synthetic',
  ])
  return { sha: git(['rev-parse', 'HEAD']), source: git(['rev-parse', '--abbrev-ref', 'HEAD']) }
}

/**
 * Runs the acceptance runner against a synthetic child.
 *
 * The child answers each command with its own output, so the fresh-schema
 * receipt and the focused journey receipt stay distinct. A child that answered
 * every command with the fresh-schema receipt produced no journey receipt at
 * all, and the lane failed closed on a run that should have passed.
 */
function runSyntheticPostgresAcceptance(options = {}) {
  const {
    cleanupFails = false,
    freshSchemaOutput = SYNTHETIC_FRESH_SCHEMA_OUTPUT,
    journeyOutput = SYNTHETIC_JOURNEY_OUTPUT,
    freshSchemaStatus = 0,
    journeyStatus = 0,
  } = options
  const root = mkdtempSync(join(tmpdir(), 'fresh-schema-cleanup-'))
  try {
    for (const path of [
      'packages/auth/src/better-auth-server.ts',
      'packages/auth/src/delivery.ts',
      'scripts/fresh-postgres-acceptance/auth-lifecycle.ts',
      'scripts/fresh-postgres-acceptance/fixture.ts',
    ]) {
      const file = join(root, path)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '// synthetic source prerequisite only\n')
    }
    writeFileSync(
      join(root, 'packages/auth/package.json'),
      JSON.stringify({ dependencies: { 'better-auth': 'synthetic', pg: 'synthetic' } })
    )
    writeFileSync(
      join(root, 'scripts/capture-provisioning.mjs'),
      `export function startCaptureProvisioning(register) {
        const fixture = {
          databaseUrl: ${JSON.stringify(local)},
          async stop() {
            await Promise.resolve();
            console.log('SYNTHETIC_CLEANUP');
            ${cleanupFails ? "throw new Error('synthetic cleanup failure');" : ''}
          }
        };
        register(fixture);
        return fixture;
      }`
    )
    const shim = join(root, 'synthetic-child.mjs')
    writeFileSync(
      shim,
      `import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const realSpawnSync = childProcess.spawnSync;
      childProcess.spawnSync = (command, args, options) => {
        if (command === 'docker') return { status: 0, stdout: JSON.stringify('unix:///synthetic/docker.sock') };
        if (command !== 'bun') return realSpawnSync(command, args, options);
        const list = Array.isArray(args) ? args : [];
        if (list.includes(${JSON.stringify(FRESH_SCHEMA_COMMAND)})) {
          return { status: ${freshSchemaStatus}, stdout: ${JSON.stringify(freshSchemaOutput)}, stderr: '' };
        }
        if (list.includes(${JSON.stringify(FOCUSED_JOURNEY_COMMAND)})) {
          return { status: ${journeyStatus}, stdout: ${JSON.stringify(journeyOutput)}, stderr: '' };
        }
        throw new Error('unexpected synthetic command: ' + list.join(' '));
      };
      syncBuiltinESMExports();`
    )
    // The tested tree is a repository of its own, so the receipt has to name
    // it and not the checkout the runner code came from.
    const tested = commitRepository(root)
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        shim,
        fileURLToPath(new URL('./run.mjs', import.meta.url)),
        '--repository',
        root,
      ],
      {
        encoding: 'utf8',
        // The runner reads the provenance of the checkout it runs in, so the
        // path is available to it. The child it starts gets the isolated
        // environment the policy module builds, which is asserted elsewhere.
        env: { PATH: process.env.PATH, DOCKER_HOST: 'unix:///synthetic/docker.sock' },
        timeout: 10_000,
      }
    )
    return { result, tested }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('failed owned cleanup exits nonzero without publishing a passed receipt', () => {
  const { result } = runSyntheticPostgresAcceptance({ cleanupFails: true })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /SYNTHETIC_CLEANUP/)
  assert.doesNotMatch(result.stdout, /"status":"passed"/)
  assert.match(result.stderr, /owned PostgreSQL cleanup failed/)
})

test('passed PostgreSQL receipt is published only after successful owned cleanup', () => {
  const { result } = runSyntheticPostgresAcceptance()
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const lines = result.stdout.trim().split('\n')
  assert.equal(lines[0], 'SYNTHETIC_CLEANUP')
  const receipt = JSON.parse(lines[1])
  assert.equal(receipt.status, 'passed')
  assert.equal(receipt.migrations, 3)
  assert.equal(receipt.verificationRequired, true)
  assert.equal(receipt.evidence, 'local-disposable')
  assert.equal(receipt.proofKind, 'fresh-schema-acceptance')
  assert.equal(receipt.postgres, 'disposable-instance')
  assert.match(receipt.checkout.sha, /^[0-9a-f]{40}$/)
  assert.equal(typeof receipt.checkout.dirty, 'boolean')
  assert.ok(receipt.checkout.source.length > 0)
  assert.match(receipt.module.sha, /^[0-9a-f]{40}$/)
  assert.equal(lines.length, 2)
})

test('the receipt names the repository it tested, not the one the code came from', () => {
  const { result, tested } = runSyntheticPostgresAcceptance()
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const receipt = JSON.parse(result.stdout.trim().split('\n')[1])
  // The tested tree is the synthetic repository, and the receipt names it.
  assert.equal(receipt.checkout.sha, tested.sha)
  assert.equal(receipt.checkout.source, tested.source)
  // The tree the runner code came from is a different checkout, and the
  // receipt names that too, so the two are never confused.
  assert.notEqual(receipt.module.sha, receipt.checkout.sha)
  assert.equal(receipt.module.sha, readCheckoutProvenance(repositoryRoot).sha)
})

test('the focused journey receipt is required, and a fresh-schema receipt never satisfies it', () => {
  const { result } = runSyntheticPostgresAcceptance({
    journeyOutput: SYNTHETIC_FRESH_SCHEMA_OUTPUT,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1, result.stderr)
  assert.doesNotMatch(result.stdout, /"status":"passed"/)
  assert.match(result.stderr, /the focused acceptance journey produced no receipt/)
})

test('a focused journey that skipped a test fails the lane closed', () => {
  const { result } = runSyntheticPostgresAcceptance({
    journeyOutput: '1 pass\n0 fail\n1 skip\nDESKTOP_PRINCIPAL_JOURNEY {"status":"passed"}\n',
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1, result.stderr)
  assert.doesNotMatch(result.stdout, /"status":"passed"/)
  assert.match(result.stderr, /the focused acceptance journey skipped 1 test\(s\)/)
})

test('a focused journey that did not pass fails the lane closed', () => {
  const { result } = runSyntheticPostgresAcceptance({
    journeyOutput: '0 pass\n1 fail\n0 skip\nDESKTOP_PRINCIPAL_JOURNEY {"status":"failed"}\n',
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1, result.stderr)
  assert.doesNotMatch(result.stdout, /"status":"passed"/)
  assert.match(result.stderr, /the focused acceptance journey did not pass/)
})

test('a focused journey that failed to run fails the lane closed', () => {
  const { result } = runSyntheticPostgresAcceptance({ journeyStatus: 1 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1, result.stderr)
  assert.doesNotMatch(result.stdout, /"status":"passed"/)
  assert.match(result.stderr, /the desktop principal acceptance phase failed/)
})

test('a missing fresh-schema receipt fails the lane closed', () => {
  const { result } = runSyntheticPostgresAcceptance({ freshSchemaOutput: '' })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1, result.stderr)
  assert.doesNotMatch(result.stdout, /"status":"passed"/)
  assert.match(result.stderr, /fresh-schema receipt missing/)
})

test('an invalid fresh-schema receipt fails the lane closed', () => {
  for (const output of [
    'FRESH_SCHEMA_ACCEPTANCE {"status":"failed","migrations":3}\n',
    'FRESH_SCHEMA_ACCEPTANCE {"status":"passed","migrations":"three"}\n',
    'FRESH_SCHEMA_ACCEPTANCE not json\n',
  ]) {
    const { result } = runSyntheticPostgresAcceptance({ freshSchemaOutput: output })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1, result.stderr)
    assert.doesNotMatch(result.stdout, /"status":"passed"/)
    assert.match(result.stderr, /invalid fresh-schema receipt/)
  }
})

test('a fresh-schema fixture that failed fails the lane closed', () => {
  const { result } = runSyntheticPostgresAcceptance({ freshSchemaStatus: 1 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1, result.stderr)
  assert.doesNotMatch(result.stdout, /"status":"passed"/)
  assert.match(result.stderr, /fresh-schema fixture failed/)
})

test('the focused journey receipt is distinct from the fresh-schema receipt', () => {
  assert.equal(parseJourneyReceipt(SYNTHETIC_FRESH_SCHEMA_OUTPUT), null)
  assert.deepEqual(parseJourneyReceipt(SYNTHETIC_JOURNEY_OUTPUT), {
    status: 'passed',
    journeys: 1,
  })
  assert.equal(parseJourneyReceipt('DESKTOP_PRINCIPAL_JOURNEY not json\n'), null)
})

test('an evidence class names how much a receipt is worth, and only live needs authorization', () => {
  assert.deepEqual(EVIDENCE_CLASSES, ['simulated', 'local-disposable', 'ci', 'live'])
  assert.equal(classifyEvidence('synthetic-child'), 'simulated')
  assert.equal(classifyEvidence('memory-journey'), 'simulated')
  assert.equal(classifyEvidence('local-disposable'), 'local-disposable')
  assert.equal(classifyEvidence('ci-disposable-proof'), 'ci')
  assert.throws(
    () => classifyEvidence('live-railway'),
    /live acceptance evidence is not authorized/
  )
  assert.equal(classifyEvidence('live-railway', { authorized: true }), 'live')
  assert.throws(() => classifyEvidence('unknown-source'), /unknown acceptance evidence source/)
  assert.throws(() => assertEvidenceClass('strong'), /unknown acceptance evidence class/)
  assert.throws(() => assertEvidenceClass(undefined), /unknown acceptance evidence class/)
})

test('a receipt may not claim an evidence class stronger than its source produced', () => {
  assert.equal(assertEvidenceNotPromoted({ evidence: 'simulated' }, 'synthetic-child'), 'simulated')
  assert.equal(
    assertEvidenceNotPromoted({ evidence: 'local-disposable' }, 'local-disposable'),
    'local-disposable'
  )
  assert.equal(assertEvidenceNotPromoted({ evidence: 'ci' }, 'ci-disposable-proof'), 'ci')
  assert.throws(
    () => assertEvidenceNotPromoted({ evidence: 'ci' }, 'synthetic-child'),
    /stronger than its source/
  )
  assert.throws(
    () => assertEvidenceNotPromoted({ evidence: 'live' }, 'local-disposable'),
    /stronger than its source/
  )
  assert.throws(
    () => assertEvidenceNotPromoted({}, 'synthetic-child'),
    /unknown acceptance evidence class/
  )
  assert.throws(
    () => receiptEvidence({ evidence: 'simulated' }, 'local-disposable'),
    /does not match its source/
  )
  assert.equal(
    receiptEvidence({ evidence: 'local-disposable' }, 'local-disposable'),
    'local-disposable'
  )
})

test('recovery is a forward-fix or a Railway backup/restore, and nothing else', () => {
  assert.deepEqual(RECOVERY_METHODS, ['forward-fix', 'railway-backup-restore'])
  assert.equal(assertRecoveryMethod('forward-fix'), 'forward-fix')
  assert.equal(assertRecoveryMethod('railway-backup-restore'), 'railway-backup-restore')
  for (const method of [
    'neon-rollback',
    'legacy-artifact',
    'previous-deployment',
    'forward-compatibility',
    '',
  ]) {
    assert.throws(() => assertRecoveryMethod(method), /unsupported recovery method/)
  }
})

/**
 * A real checkout with one commit, so the provenance is read from a tree
 * instead of being asserted against a constant.
 */
function temporaryRepository() {
  const root = mkdtempSync(join(tmpdir(), 'fresh-recovery-repo-'))
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git(['init', '-q'])
  writeFileSync(join(root, 'README.md'), 'synthetic\n')
  git(['add', '-A'])
  git([
    '-c',
    'user.name=synthetic',
    '-c',
    'user.email=synthetic@example.invalid',
    'commit',
    '-q',
    '-m',
    'synthetic',
  ])
  return { root, git }
}

test('the checkout provenance is read from the tree it describes', () => {
  const { root, git } = temporaryRepository()
  try {
    const provenance = readCheckoutProvenance(root)
    assert.equal(provenance.sha, git(['rev-parse', 'HEAD']))
    assert.equal(provenance.dirty, false)
    assert.equal(provenance.source, git(['rev-parse', '--abbrev-ref', 'HEAD']))
    writeFileSync(join(root, 'README.md'), 'changed\n')
    assert.equal(readCheckoutProvenance(root).dirty, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** A passed fresh-account acceptance receipt, as the lane publishes it. */
function passedAcceptanceReceipt(provenance) {
  return {
    status: 'passed',
    migrations: 60,
    verificationRequired: true,
    postgres: 'disposable-instance',
    evidence: 'local-disposable',
    proofKind: 'fresh-schema-acceptance',
    checkout: provenance,
    module: provenance,
  }
}

/** A passed disposable PostgreSQL proof receipt, as the proof publishes it. */
function passedDisposableProofReceipt(provenance) {
  return {
    status: 'passed',
    proofKind: 'disposable-postgres-proof',
    evidence: 'local-disposable',
    migrations: {
      checks: [
        { command: 'bun', args: ['--no-env-file', 'run', '--cwd', 'packages/db', 'db:check'] },
      ],
    },
    auth: { applied: true, created: ['user'], replayApplied: false, schema: 'auth_ci' },
    checkout: provenance,
    module: provenance,
  }
}

test('the recovery artifact is the one a proof receipt names, with its provenance', () => {
  const { root, git } = temporaryRepository()
  try {
    const provenance = readCheckoutProvenance(root)
    const receipt = passedAcceptanceReceipt(provenance)
    const artifact = assertTestedRecoveryArtifact(receipt)
    assert.equal(artifact.commit, git(['rev-parse', 'HEAD']))
    assert.equal(artifact.dirty, false)
    assert.equal(artifact.source, provenance.source)
    assert.equal(artifact.evidence, 'local-disposable')
    assert.equal(artifact.proofKind, 'fresh-schema-acceptance')
    assert.ok(
      artifact.proved.some((entry) => entry.includes('migration journal')),
      'the guarantees of the acceptance lane are stated'
    )
    assert.ok(
      !artifact.proved.some((entry) => entry.includes('backup restores')),
      'a guarantee the acceptance lane did not observe is not stamped on it'
    )
    assert.ok(
      artifact.notProved.some((entry) => entry.includes('UNKNOWN')),
      'the state that was not observed is recorded as unknown'
    )
    const plan = recoveryPlan(receipt)
    assert.equal(plan.artifact.commit, artifact.commit)
    assert.deepEqual(
      plan.methods.map((entry) => entry.method),
      ['forward-fix', 'railway-backup-restore']
    )
    for (const entry of plan.methods) {
      assert.ok(entry.steps.length > 0, 'every method names its steps')
      assert.match(entry.liveAction, /root-owned live operation/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the acceptance lane receipt is consumable by the recovery procedure', () => {
  const { root, git } = temporaryRepository()
  try {
    const provenance = readCheckoutProvenance(root)
    // The receipt is built by the lane's own builder, so the receipt the lane
    // publishes and the receipt the recovery procedure consumes are the same
    // code path.
    const receipt = buildAcceptanceReceipt({
      migrations: 60,
      evidence: 'local-disposable',
      checkout: provenance,
      module: provenance,
      desktopPrincipal: { accounts: 3, mappedUsers: 3, orphanUsers: 0 },
    })
    assert.deepEqual(assertDatabaseProof(receipt), {
      proofKind: 'fresh-schema-acceptance',
      evidence: 'local-disposable',
    })
    const artifact = recoveryArtifact(receipt)
    assert.equal(artifact.commit, git(['rev-parse', 'HEAD']))
    assert.equal(artifact.proofKind, 'fresh-schema-acceptance')
    assert.ok(
      !artifact.proved.some((entry) => entry.includes('backup restores')),
      'the acceptance lane does not claim the backup and restore proof'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the disposable proof names its own guarantees, and the acceptance lane does not', () => {
  const { root } = temporaryRepository()
  try {
    const provenance = readCheckoutProvenance(root)
    const artifact = assertTestedRecoveryArtifact(passedDisposableProofReceipt(provenance))
    assert.equal(artifact.proofKind, 'disposable-postgres-proof')
    assert.ok(
      artifact.proved.some((entry) => entry.includes('backup restores')),
      'the backup and restore guarantee belongs to the disposable proof'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a receipt that is not a passed database proof names no artifact', () => {
  const { root } = temporaryRepository()
  try {
    const provenance = readCheckoutProvenance(root)
    const base = passedAcceptanceReceipt(provenance)

    // A failed run is not a proof.
    assert.throws(
      () => assertTestedRecoveryArtifact({ ...base, status: 'failed' }),
      /not a passed proof/
    )
    // A receipt without a status is not a proof.
    assert.throws(
      () => assertTestedRecoveryArtifact({ ...base, status: undefined }),
      /not a passed proof/
    )
    // A memory receipt is not a database proof, however clean its tree is.
    assert.throws(
      () =>
        assertTestedRecoveryArtifact({
          ...base,
          proofKind: 'memory-journey',
          postgres: 'not-run',
        }),
      /not a database proof/
    )
    // A simulated result does not prove a database.
    assert.throws(
      () => assertTestedRecoveryArtifact({ ...base, evidence: 'simulated' }),
      /simulated result does not prove a database/
    )
    // A receipt without an evidence class is refused.
    assert.throws(
      () => assertTestedRecoveryArtifact({ ...base, evidence: undefined }),
      /unknown acceptance evidence class/
    )
    // A receipt that does not carry the result it claims to have observed is
    // refused, and it carries no guarantee in its place.
    assert.throws(
      () => assertTestedRecoveryArtifact({ ...base, migrations: undefined }),
      /does not carry the result the proof observed/
    )
    assert.throws(
      () => assertTestedRecoveryArtifact({ ...base, migrations: 0 }),
      /does not carry the result the proof observed/
    )
    assert.throws(
      () => assertTestedRecoveryArtifact({ ...base, verificationRequired: false }),
      /does not carry the result the proof observed/
    )
    // A receipt from two different checkouts is refused.
    assert.throws(
      () =>
        assertTestedRecoveryArtifact({
          ...base,
          module: { ...provenance, sha: 'f'.repeat(40) },
        }),
      /mixes two checkouts/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a receipt without reproducible provenance names no artifact', () => {
  const { root } = temporaryRepository()
  try {
    // A receipt with no checkout names no commit.
    assert.throws(
      () => assertTestedRecoveryArtifact({ evidence: 'local-disposable' }),
      /not a passed proof/
    )
    // A forged commit is refused.
    assert.throws(
      () =>
        assertTestedRecoveryArtifact(
          passedAcceptanceReceipt({ sha: 'not-a-sha', dirty: false, source: 'a-source' })
        ),
      /does not name the exact commit/
    )
    // A receipt produced from a dirty tree is refused, because the commit does
    // not contain what ran.
    writeFileSync(join(root, 'README.md'), 'changed\n')
    assert.throws(
      () => assertTestedRecoveryArtifact(passedAcceptanceReceipt(readCheckoutProvenance(root))),
      /not clean/
    )
    assert.throws(() => assertReproducibleProvenance(undefined), /does not name the exact commit/)
    // A receipt without a checkout names no commit.
    assert.throws(
      () => assertTestedRecoveryArtifact({ evidence: 'local-disposable' }),
      /not a passed proof/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the compatibility scope never claims a Control Plane item with an Adea receipt', () => {
  assert.equal(assertCpScope(), CP_COMPATIBILITY_SCOPE)
  const open = cpOpenItems()
  assert.ok(open.length > 0, 'the Control Plane items stay open')
  for (const item of open) {
    assert.equal(item.owner, 'control-plane')
    assert.equal(item.qualifiedBy, 'control-plane-receipt')
  }
  assert.throws(
    () =>
      assertCpScope([
        {
          id: 'cp-migration-journal',
          owner: 'control-plane',
          qualifiedBy: 'adea-receipt',
        },
      ]),
    /qualified by an evidence its owner does not hold/
  )
  assert.throws(
    () =>
      assertCpScope([
        {
          id: 'adea-application-migrations',
          owner: 'adea',
          qualifiedBy: 'control-plane-receipt',
        },
      ]),
    /qualified by an evidence its owner does not hold/
  )
  assert.throws(() => assertCpScope([]), /scope is empty/)
})

test('the fresh-account scope carries no legacy import, dual write or remote target', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const files = freshAccountScopeFiles(root)
  assert.ok(files.length > 0, 'the scope is not empty')
  assert.deepEqual(scanFreshAccountScope(root), [])
  assert.equal(assertFreshAccountOnly(root), true)
})

test('no source of this lane carries legacy provider coupling', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const files = laneSourceFiles(root)
  assert.ok(files.length > freshAccountScopeFiles(root).length, 'the lane files are in the scope')
  assert.deepEqual(scanNoNeonScope(root), [])
  assert.equal(assertNoNeonInScope(root), true)
  for (const [source, kind] of [
    ['const url = process.env.NEON_AUTH_BASE_URL\n', 'legacy-environment'],
    ['const url = process.env.NEON_API_KEY\n', 'legacy-environment'],
    ["const host = 'db.neon.tech'\n", 'legacy-host'],
    ["import { neon } from '@neondatabase/serverless'\n", 'legacy-package'],
  ]) {
    const violations = noNeonViolations('synthetic.ts', source)
    assert.ok(
      violations.some((violation) => violation.kind === kind),
      'expected ' + kind + ' for ' + source
    )
  }
  // A comment that names the legacy provider is not a coupling.
  assert.deepEqual(
    noNeonViolations(
      'synthetic.ts',
      '// the legacy provider names NEON_AUTH_BASE_URL\nconst a = 1\n'
    ),
    []
  )
})

test('a comment marker inside a string does not hide the code around it', () => {
  const cases = [
    ['const marker="/*"; await importLegacyIdentities(pool); const end="*/";', 'legacy-import'],
    ['const url = "http://x"; await importLegacyIdentities(pool);', 'legacy-import'],
    ['const t = `/*`; await importLegacyIdentities(pool);', 'legacy-import'],
    ['const t = `x ${await importLegacyIdentities(pool)} y`;', 'legacy-import'],
    ['const s = "he said \\"hi\\""; await importLegacyIdentities(pool);', 'legacy-import'],
    // A comment between two tokens is whitespace, so the tokens stay two.
    ['await/*note*/importLegacyIdentities(pool)', 'legacy-import'],
    // A comment marker inside a string must not remove the code around it.
    ['const a = "/*"; dualWriteToBoth(pool); const b = "*/";', 'dual-write'],
    ['await /*note*/ importLegacyIdentities(pool)', 'legacy-import'],
    // A comment between the keywords of a statement is whitespace too.
    ["await pool.query('INSERT/**/INTO app.users SELECT * FROM legacy.users')", 'row-copy'],
    ["await pool.query('INSERT -- note\\n INTO app.users SELECT * FROM legacy.users')", 'row-copy'],
  ]
  for (const [source, kind] of cases) {
    const violations = freshAccountOnlyViolations('synthetic.ts', source)
    assert.ok(
      violations.some((violation) => violation.kind === kind),
      'expected ' + kind + ' for ' + source
    )
  }
  // A real comment is still a comment, and a division is still a division.
  assert.deepEqual(
    freshAccountOnlyViolations('synthetic.ts', '// importLegacyIdentities(pool)\nconst a = 1\n'),
    []
  )
  assert.deepEqual(
    freshAccountOnlyViolations('synthetic.ts', '/* importLegacyIdentities(pool) */\nconst a = 1\n'),
    []
  )
  assert.deepEqual(freshAccountOnlyViolations('synthetic.ts', 'const a = total / count\n'), [])
  assert.deepEqual(
    freshAccountOnlyViolations(
      'synthetic.ts',
      "await pool.query('INSERT INTO app.users VALUES (1)')\n"
    ),
    []
  )
})

test('the fresh-account rule catches every construct it claims to catch', () => {
  const cases = [
    ['const url = process.env.NEON_AUTH_BASE_URL\n', 'legacy-environment'],
    ["const host = 'db.neon.tech'\n", 'legacy-host'],
    ['await importLegacyIdentities(pool)\n', 'legacy-import'],
    ['await seedLegacyUsers(pool)\n', 'legacy-import'],
    ["const mode = 'dual-write'\n", 'dual-write'],
    ['await dualWriteToBoth(pool)\n', 'dual-write'],
    ["await pool.query('INSERT INTO app.users SELECT * FROM legacy.users')\n", 'row-copy'],
    ["await pool.query('\\\\copy app.users FROM /tmp/users.csv')\n", 'row-copy'],
    ["const url = 'postgresql://user:secret@db.example.test/app'\n", 'remote-database-target'],
    [
      "const url = 'postgresql://user:secret@127.0.0.1/app?host=db.example.test'\n",
      'database-routing-override',
    ],
  ]
  for (const [source, kind] of cases) {
    const violations = freshAccountOnlyViolations('synthetic.ts', source)
    assert.ok(
      violations.some((violation) => violation.kind === kind),
      'expected ' + kind + ' for ' + source
    )
  }
  assert.deepEqual(freshAccountOnlyViolations('synthetic.ts', 'const local = 1\n'), [])
  assert.deepEqual(
    freshAccountOnlyViolations(
      'synthetic.ts',
      "// the lane must not import legacy identities\nconst local = 'postgresql://u:p@127.0.0.1:5432/db'\n"
    ),
    []
  )
})
