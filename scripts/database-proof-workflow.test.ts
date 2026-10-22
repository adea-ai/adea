import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The pull-request database proof lane. It proves one disposable PostgreSQL
// instance on the loopback interface and nothing else: there is no hosted
// branch, no provider API and no secret in it, so the lane has no dependency on
// a database vendor to run.

const root = resolve(import.meta.dir, '..')
const workflowPath = resolve(root, '.github/workflows/database-proof.yml')
const workflowText = readFileSync(workflowPath, 'utf8')

type Step = {
  name?: string
  id?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, string>
  uses?: string
  run?: string
}
type Job = {
  name?: string
  needs?: string | string[]
  if?: string
  env?: Record<string, string>
  'timeout-minutes'?: number
  steps: Step[]
}
type Workflow = {
  on: { pull_request: { types: string[] } }
  permissions?: unknown
  concurrency: { 'cancel-in-progress': string }
  jobs: Record<string, Job>
}
const workflow = Bun.YAML.parse(workflowText) as Workflow
const jobs = workflow.jobs
const stepNamed = (job: Job, name: string) => {
  const step = job.steps.find((candidate) => candidate.name === name)
  if (!step) throw new Error(`missing step: ${name}`)
  return step
}

describe('the database proof lane proves only a disposable local instance', () => {
  test('it runs one disposable proof and its own fail-closed gate', () => {
    expect(Object.keys(jobs).toSorted()).toEqual([
      'built_worker_desktop_auth_proof',
      'disposable_postgres_gate',
      'disposable_postgres_proof',
      'fresh_account_acceptance_proof',
    ])

    const proof = jobs.disposable_postgres_proof!
    expect(proof.name).toBe('Disposable PostgreSQL Proof')
    expect(proof['timeout-minutes']).toBe(15)
    expect(proof.permissions).toEqual({ contents: 'read' })
    expect(proof.if).toContain('github.event.pull_request.draft == false')

    const named = Object.entries(jobs).filter(
      ([, job]) => job.name === 'Prove Disposable PostgreSQL'
    )
    expect(named.map(([id]) => id)).toEqual(['disposable_postgres_gate'])
  })

  test('it runs the disposable proof script and the pinned toolchain', () => {
    const proof = jobs.disposable_postgres_proof!
    const run = stepNamed(proof, 'Prove the disposable PostgreSQL boundary')
    expect(run.run).toContain('scripts/disposable-postgres-cli.ts')
    const bun = stepNamed(proof, 'Install Bun')
    expect(bun.uses).toBe('oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6')
    expect(bun.with?.['bun-version']).toBe('1.4.4')
    expect(stepNamed(proof, 'Install dependencies').run).toBe('bun install --frozen-lockfile')
  })

  test('it installs the PostgreSQL 18 client tools before the proof runs', () => {
    const proof = jobs.disposable_postgres_proof!
    const names = proof.steps.map((step: { name?: string }) => step.name)
    const install = names.indexOf('Install the PostgreSQL 18 client tools')
    const prove = names.indexOf('Prove the disposable PostgreSQL boundary')
    expect(install).toBeGreaterThan(names.indexOf('Install dependencies'))
    expect(install).toBeLessThan(prove)
    const run = stepNamed(proof, 'Install the PostgreSQL 18 client tools').run
    expect(run).toContain('postgresql-client-18')
    expect(run).toContain('/usr/lib/postgresql/18/bin')
    expect(run).toContain('$GITHUB_PATH')
    expect(run).not.toContain('AUTH_POSTGRES_TEST_URL')
    expect(stepNamed(proof, 'Checkout pull request').uses).toBe(
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
    )
  })

  test('it reads no secret and reaches no hosted database API', () => {
    const proof = jobs.disposable_postgres_proof!
    const body = JSON.stringify(proof)
    expect(body).not.toContain('secrets.')
    expect(body).not.toContain('console.neon.tech')
    expect(body).not.toContain('NEON_')
  })

  test('the whole lane names no database vendor secret, variable or endpoint', () => {
    expect(workflowText).not.toContain('secrets.')
    expect(workflowText).not.toContain('vars.')
    expect(workflowText).not.toContain('console.neon.tech')
    expect(workflowText).not.toContain('neondatabase/')
    expect(workflowText).not.toContain('NEON_')
    expect(workflowText).not.toContain('neon')
    // The whole workflow names no provider at all, in any case: the lane has
    // no provider to name.
    expect(workflowText.toLowerCase()).not.toContain('neon')
  })

  test('it has its own fail-closed gate', () => {
    const gate = jobs.disposable_postgres_gate!
    expect(gate.if).toContain('always()')
    expect(gate.if).toContain('github.event.pull_request.draft == false')
    const check = stepNamed(gate, 'Require the disposable proof to succeed')
    expect(check.run).toContain('test "$PROOF_RESULT" = success')
    expect(check.env?.PROOF_RESULT).toBe('${{ needs.disposable_postgres_proof.result }}')
  })

  test('it triggers only on the events that may run heavy validation', () => {
    expect([...workflow.on.pull_request.types].toSorted()).toEqual([
      'ready_for_review',
      'synchronize',
    ])
    expect(workflow.concurrency['cancel-in-progress']).toBe(true)
    expect(workflow.permissions).toEqual({})
  })

  test('the disposable proof binds to the loopback interface and pins its image', () => {
    const helper = readFileSync(resolve(root, 'scripts/disposable-postgres-ci.ts'), 'utf8')
    expect(helper).toContain("export const LOOPBACK_HOST = '127.0.0.1'")

    const cli = readFileSync(resolve(root, 'scripts/disposable-postgres-cli.ts'), 'utf8')
    expect(cli).toContain('${LOOPBACK_HOST}::5432')
    expect(cli).toContain('captureProvisioningImage')
    expect(cli).not.toContain('postgres:18-alpine@sha256:')
  })

  test('the canonical roles the disposable proof uses are the canonical fixture roles', () => {
    const helper = readFileSync(resolve(root, 'scripts/disposable-postgres-ci.ts'), 'utf8')
    expect(helper).toContain("export const CANONICAL_MIGRATION_ROLE = 'agent_hq_local_migration'")
    expect(helper).toContain("export const CANONICAL_RUNTIME_ROLE = 'agent_hq_local_app'")

    const fixture = readFileSync(
      resolve(root, 'packages/db/tests/fixtures/canonical-boundary.ts'),
      'utf8'
    )
    expect(fixture).toContain("export const MIGRATION_ROLE = 'agent_hq_local_migration'")
    expect(fixture).toContain("export const RUNTIME_ROLE = 'agent_hq_local_app'")
  })

  test('the disposable proof reuses the merged auth schema initializer', () => {
    const cli = readFileSync(resolve(root, 'scripts/disposable-postgres-cli.ts'), 'utf8')
    expect(cli).toContain("from '../packages/auth/src/schema-init'")
    expect(cli).toContain('applyAuthSchema')

    const helper = readFileSync(resolve(root, 'scripts/disposable-postgres-ci.ts'), 'utf8')
    expect(helper).toContain("export const PROOF_AUTH_SCHEMA = 'auth_ci'")
    expect(helper).toContain('the auth schema initializer did not apply the provider tables')
    expect(helper).toContain('replaying the auth schema initializer was not a no-op')
  })

  test('the disposable proof keeps the migration checks and their order', () => {
    const helper = readFileSync(resolve(root, 'scripts/disposable-postgres-ci.ts'), 'utf8')
    const health = helper.indexOf("args: ['scripts/database-health.mjs']")
    const check = helper.indexOf("'db:check'")
    const verify = helper.indexOf("'db:verify'")
    const url = helper.indexOf("{ kind: 'assert-url-present', name: 'DATABASE_URL' }")
    const integration = helper.indexOf('packages/db/tests/integration/migrations.test.ts')
    expect(health).toBeGreaterThanOrEqual(0)
    expect(health).toBeLessThan(check)
    expect(check).toBeLessThan(verify)
    expect(verify).toBeLessThan(url)
    expect(url).toBeLessThan(integration)
  })

  test('the disposable proof proves the server-side TLS and the canonical role boundary', () => {
    const helper = readFileSync(resolve(root, 'scripts/disposable-postgres-ci.ts'), 'utf8')
    expect(helper).toContain('pg_stat_ssl')
    expect(helper).toContain('the disposable instance connection was not encrypted')
    expect(helper).toContain('has_schema_privilege')
    expect(helper).toContain('the runtime role created an object in the application schema')
    expect(helper).toContain('the application schema is not owned by the canonical migration role')
  })

  test('the disposable proof removes only its own container and fails when cleanup fails', () => {
    const helper = readFileSync(resolve(root, 'scripts/disposable-postgres-ci.ts'), 'utf8')
    expect(helper).toContain('dependencies.removeContainer(name)')
    expect(helper).toContain('could not clean up its container')
    expect(helper).toContain('cleanup also failed')
    expect(helper).toContain('attachOwnedContainerCleanup')
    expect(helper).toContain('removeTemporaryMaterial')

    const cli = readFileSync(resolve(root, 'scripts/disposable-postgres-cli.ts'), 'utf8')
    expect(cli).toContain('containerRemovalCommand(name)')
    expect(cli).toContain('killSignal:')
    expect(cli).toContain('timeout: 60_000')
  })

  test('the removal takes the owned container’s volumes and never prunes', () => {
    const helper = readFileSync(resolve(root, 'scripts/disposable-postgres-ci.ts'), 'utf8')
    expect(helper).toContain("return ['rm', '--force', '--volumes', name]")
    // No command may prune, and no command may name a docker volume or every
    // container: the removal is scoped to the one container it created.
    expect(helper).not.toContain("'prune'")
    expect(helper).not.toContain("'volume',")

    const cli = readFileSync(resolve(root, 'scripts/disposable-postgres-cli.ts'), 'utf8')
    expect(cli).not.toContain("'prune'")
    expect(cli).not.toContain("'volume',")
    expect(cli).not.toContain("'--all'")
  })

  test('the teardown is idempotent and detaches before it re-raises the signal', () => {
    const helper = readFileSync(resolve(root, 'scripts/disposable-postgres-ci.ts'), 'utf8')
    // The teardown runs at most once.
    expect(helper).toContain('if (handled) return')
    expect(helper).toContain('containerRemovalAttempted')
    expect(helper).toContain('materialRemovalAttempted')
    // The listener is detached before the signal is re-raised, so the default
    // action ends the process.
    const detachIndex = helper.indexOf('    detach()\n    const failure = runSteps()')
    const reRaiseIndex = helper.indexOf('reRaise(signal)')
    expect(detachIndex).toBeGreaterThanOrEqual(0)
    expect(detachIndex).toBeLessThan(reRaiseIndex)
    // A cleanup failure is reported, never thrown out of the signal handler.
    expect(helper).toContain('options.reportFailure?.(describeFailure(failure))')
  })

  test('the disposable proof never prints a credential', () => {
    const helper = readFileSync(resolve(root, 'scripts/disposable-postgres-ci.ts'), 'utf8')
    expect(helper).toContain('redactSecrets')
    const cli = readFileSync(resolve(root, 'scripts/disposable-postgres-cli.ts'), 'utf8')
    expect(cli).toContain('DISPOSABLE_POSTGRES_PROOF')
    expect(cli).not.toContain('console.log(adminUrl')
    expect(cli).not.toContain('console.log(provisioned')
  })
})

describe('the fresh-account acceptance job wires the acceptance lane into CI', () => {
  const job = jobs.fresh_account_acceptance_proof!

  test('it is the lane’s own job, with the same draft filter as the proof', () => {
    expect(job.name).toBe('Fresh account acceptance proof')
    expect(job['timeout-minutes']).toBe(30)
    expect(job.permissions).toEqual({ contents: 'read' })
    expect(job.if).toContain('github.event.pull_request.draft == false')
  })

  test('it checks out the exact head and requires the receipt to name it', () => {
    const checkout = stepNamed(job, 'Checkout pull request')
    expect(checkout.uses).toBe('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1')
    expect(checkout.with?.ref).toBe('${{ github.event.pull_request.head.sha }}')
    expect(checkout.with?.['persist-credentials']).toBe(false)
    expect(job.env?.EXPECTED_HEAD).toBe('${{ github.event.pull_request.head.sha }}')
    const gate = stepNamed(job, 'Gate and publish the acceptance receipt')
    expect(gate.run).toContain('"$EXPECTED_HEAD"')
  })

  test('it runs the acceptance lane’s own entrypoint, unchanged', () => {
    const lane = stepNamed(job, 'Run the fresh-account acceptance lane')
    expect(lane.run).toContain('node scripts/fresh-postgres-acceptance/run.mjs')
    // The lane prints its receipt on stdout and the tree it names must stay the
    // clean tree the run happened in, so the output goes outside the checkout.
    expect(lane.run).toContain('"$RUNNER_TEMP/fresh-account-acceptance.out"')
  })

  test('it gates the receipt before it publishes anything', () => {
    const names = job.steps.map((step: { name?: string }) => step.name)
    const gate = names.indexOf('Gate and publish the acceptance receipt')
    const publish = names.indexOf('Publish the acceptance receipt')
    expect(gate).toBeGreaterThan(names.indexOf('Run the fresh-account acceptance lane'))
    expect(gate).toBeLessThan(publish)
    const step = stepNamed(job, 'Gate and publish the acceptance receipt')
    expect(step.run).toContain('node scripts/ci-fresh-account-acceptance.mjs')
    const upload = stepNamed(job, 'Publish the acceptance receipt')
    expect(upload.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a')
    expect(upload.with?.['if-no-files-found']).toBe('error')
    expect(upload.with?.path).toContain('fresh-account-acceptance-receipt.json')
  })

  test('it reads no secret and reaches no hosted database', () => {
    const body = JSON.stringify(job)
    expect(body).not.toContain('secrets.')
    expect(body).not.toContain('vars.')
    expect(body).not.toContain('console.neon.tech')
    expect(body).not.toContain('NEON_')
    expect(body.toLowerCase()).not.toContain('neon')
  })

  test('the gate it calls is the CI gate this lane owns', () => {
    const gate = readFileSync(resolve(root, 'scripts/ci-fresh-account-acceptance.mjs'), 'utf8')
    expect(gate).toContain('assertFreshAccountReceipt')
    expect(gate).toContain('does not name the exact head the job checked out')
    expect(gate).toContain('no executed ')
    // The lane’s own contract is reused, not restated: the gate imports the
    // acceptance lane’s proof and provenance checks.
    expect(gate).toContain("from './fresh-postgres-acceptance/recovery.mjs'")
    expect(gate).toContain("from './fresh-postgres-acceptance/provenance.mjs'")
  })

  test('a failed lane publishes no receipt and no artifact', () => {
    const body = JSON.stringify(job)
    // A step that runs whatever happened before it would publish a receipt the
    // gate refused, or one the lane never proved.
    expect(body).not.toContain('continue-on-error')
    const publish = stepNamed(job, 'Publish the acceptance receipt')
    expect(publish.if).toBeUndefined()
    const gate = stepNamed(job, 'Gate and publish the acceptance receipt')
    expect(gate.if).toBeUndefined()
    // The receipt is published only after the gate, and the gate is the step
    // that fails the job when the receipt is not a proof of the exact head.
    const names = job.steps.map((step: { name?: string }) => step.name)
    expect(names.indexOf('Gate and publish the acceptance receipt')).toBeLessThan(
      names.indexOf('Publish the acceptance receipt')
    )
  })

  test('a hung lane is cancelled by the job timeout, and a cancelled job publishes nothing', () => {
    expect(job['timeout-minutes']).toBe(30)
    // The cleanup check runs even when the lane failed and even when the job
    // was cancelled, so a leaked resource is reported next to the primary
    // failure instead of being hidden by it. The publish step and the gate
    // have no condition of their own, so a cancelled run publishes nothing.
    const cleanup = stepNamed(job, 'Require no newly observed container to remain')
    expect(cleanup.if).toBe('always()')
  })

  test('the cleanup check reports newly observed resources and removes nothing', () => {
    const names = job.steps.map((step: { name?: string }) => step.name)
    const before = names.indexOf('Record the containers the runner has')
    const lane = names.indexOf('Run the fresh-account acceptance lane')
    const cleanup = names.indexOf('Require no newly observed container to remain')
    expect(before).toBeGreaterThanOrEqual(0)
    expect(before).toBeLessThan(lane)
    expect(lane).toBeLessThan(cleanup)

    const step = stepNamed(job, 'Require no newly observed container to remain')
    // The difference between the two snapshots is a difference of two
    // snapshots, not a prefix sweep, and it is reported as newly observed
    // resources: it is never proof of ownership.
    expect(step.run).toContain('containers-before.txt')
    expect(step.run).toContain('containers-after.txt')
    expect(step.run).toContain('comm -13')
    expect(step.run).not.toContain('--filter')
    expect(step.run).toContain('newly observed container resources')
    // Nothing is removed here, and the difference never authorises a removal.
    expect(step.run).not.toContain('docker rm')
    expect(step.run).not.toContain('prune')
    expect(step.run).not.toContain('docker system')
    expect(step.run).not.toContain('docker kill')
    expect(step.run).not.toContain('docker stop')
  })

  test('the snapshots name every container, in every state, by its identifier', () => {
    // A container that was stopped and left behind is still a resource the
    // runner holds, so the listing covers every state, and it names the
    // immutable identifier rather than the mutable name.
    for (const name of [
      'Record the containers the runner has',
      'Require no newly observed container to remain',
    ]) {
      const step = stepNamed(job, name)
      expect(step.run).toContain('docker ps -a')
      expect(step.run).toContain("'{{.ID}}'")
      expect(step.run).not.toContain("'{{.Names}}'")
    }
  })

  test('a stopped container that is newly observed fails the check', () => {
    // The check runs its own script, so the regression is about what the job
    // does: a container that was stopped and left behind is visible in the
    // listing, it fails the check, and nothing is removed.
    const step = stepNamed(job, 'Require no newly observed container to remain')
    const directory = mkdtempSync(join(tmpdir(), 'adea-container-check-'))
    try {
      const bin = join(directory, 'bin')
      mkdirSync(bin, { recursive: true })
      const calls = join(directory, 'docker-calls.txt')
      // A Docker that answers like the real one: it lists every state, and it
      // holds a container that was stopped and left behind.
      writeFileSync(
        join(bin, 'docker'),
        [
          '#!/bin/sh',
          `echo "$@" >> ${JSON.stringify(calls)}`,
          'case "$*" in',
          '  *-a*) echo "deadbeefcafe0123456789abcdef0123456789abcdef0123456789abcdef01234567" ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n')
      )
      chmodSync(join(bin, 'docker'), 0o755)
      const script = join(directory, 'check.sh')
      writeFileSync(script, step.run ?? '')
      const result = spawnSync('bash', [script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          RUNNER_TEMP: directory,
        },
      })
      // The stopped container is newly observed, so the check fails and names
      // it.
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('deadbeefcafe')
      // The difference never authorises a removal: the check asked Docker to
      // list and nothing else.
      const asked = readFileSync(calls, 'utf8')
      for (const command of asked.split('\n').filter((line) => line.length > 0)) {
        expect(command.split(' ')[0]).toBe('ps')
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('the job runs the lane and the gate on the repository Node runtime', () => {
    const node = stepNamed(job, 'Install the repository Node runtime')
    expect(node.uses).toBe('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020')
    // The runtime the repository pins, so the job cannot drift from it.
    const mise = readFileSync(resolve(root, '.mise.toml'), 'utf8')
    expect(node.with?.['node-version']).toBe(mise.match(/node = "([^"]+)"/)?.[1])
    const names = job.steps.map((step: { name?: string }) => step.name)
    expect(names.indexOf('Install the repository Node runtime')).toBeLessThan(
      names.indexOf('Run the fresh-account acceptance lane')
    )
  })

  test('the fail-closed aggregate covers every disposable proof', () => {
    const gate = jobs.disposable_postgres_gate!
    // The aggregate's own check name and threshold are unchanged; it now also
    // requires the fresh-account acceptance result and the built-Worker desktop
    // auth result.
    expect(gate.name).toBe('Prove Disposable PostgreSQL')
    expect(gate['timeout-minutes']).toBe(5)
    expect([...(gate.needs as string[])]).toEqual([
      'disposable_postgres_proof',
      'fresh_account_acceptance_proof',
      'built_worker_desktop_auth_proof',
    ])
    const check = stepNamed(gate, 'Require the disposable proof to succeed')
    expect(check.run).toContain('test "$PROOF_RESULT" = success')
    expect(check.run).toContain('test "$ACCEPTANCE_RESULT" = success')
    expect(check.run).toContain('test "$WORKER_RESULT" = success')
    expect(check.env?.PROOF_RESULT).toBe('${{ needs.disposable_postgres_proof.result }}')
    expect(check.env?.ACCEPTANCE_RESULT).toBe('${{ needs.fresh_account_acceptance_proof.result }}')
    expect(check.env?.WORKER_RESULT).toBe('${{ needs.built_worker_desktop_auth_proof.result }}')
  })

  test('the job removes nothing and reaches no hosted database', () => {
    const body = JSON.stringify(job)
    // The job reports a leak; it never removes a resource it did not create,
    // and it never prunes.
    expect(body).not.toContain('docker rm')
    expect(body).not.toContain('prune')
    expect(body).not.toContain('docker system')
  })
})

describe('the built-Worker desktop auth job wires the qualification into CI', () => {
  const worker = jobs.built_worker_desktop_auth_proof!

  test('it is the qualification’s own job, with the same draft filter as the proof', () => {
    expect(worker.name).toBe('Built Worker desktop auth proof')
    expect(worker.permissions).toEqual({ contents: 'read' })
    expect(worker.if).toContain('github.event.pull_request.draft == false')
    // The qualification builds the web application itself, and its own build
    // budget is thirty minutes, so the job needs more room than that.
    expect(worker['timeout-minutes']).toBe(45)
  })

  test('it checks out the exact head and requires the receipt to name it', () => {
    const checkout = stepNamed(worker, 'Checkout pull request')
    expect(checkout.with?.ref).toBe('${{ github.event.pull_request.head.sha }}')
    expect(checkout.with?.['persist-credentials']).toBe(false)
    expect(worker.env?.EXPECTED_HEAD).toBe('${{ github.event.pull_request.head.sha }}')
    const gate = stepNamed(worker, 'Gate and publish the acceptance receipt')
    expect(gate.run).toContain('"$EXPECTED_HEAD"')
  })

  test('it runs the qualification unchanged, with the pinned toolchain', () => {
    const run = stepNamed(worker, 'Run the built-Worker desktop auth qualification')
    expect(run.run).toContain('bun scripts/built-worker-desktop-auth-cli.ts')
    // The receipt goes outside the checkout, so the tree the receipt names is
    // still the clean tree the run happened in.
    expect(run.run).toContain('$RUNNER_TEMP/built-worker-desktop-auth.out')
    const bun = stepNamed(worker, 'Install Bun')
    expect(bun.with?.['bun-version']).toBe('1.4.4')
    const node = stepNamed(worker, 'Install the repository Node runtime')
    expect(node.with?.['node-version']).toBe('24.21.0')
    expect(stepNamed(worker, 'Install dependencies').run).toBe('bun install --frozen-lockfile')
    expect(stepNamed(worker, 'Build the workspace packages the web build imports').run).toBe(
      'bun run build:web-deps'
    )
  })

  test('it installs the same PostgreSQL 18 client tools the proof job uses', () => {
    const proof = jobs.disposable_postgres_proof!
    const install = stepNamed(worker, 'Install the PostgreSQL 18 client tools')
    expect(install.run).toBe(stepNamed(proof, 'Install the PostgreSQL 18 client tools').run)
    expect(install.run).toContain('postgresql-client-18')
    const check = stepNamed(worker, 'Check the PostgreSQL 18 client tools')
    expect(check.run).toContain('/usr/lib/postgresql/18/bin/pg_dump --version')
    expect(check.run).toContain('/usr/lib/postgresql/18/bin/pg_restore --version')
  })

  test('a failed or a missing proof publishes no receipt', () => {
    const body = JSON.stringify(worker)
    expect(body).not.toContain('continue-on-error')
    // The publish step and the gate have no condition of their own, so a failed
    // or a skipped qualification publishes nothing.
    expect(stepNamed(worker, 'Publish the acceptance receipt').if).toBeUndefined()
    expect(stepNamed(worker, 'Gate and publish the acceptance receipt').if).toBeUndefined()
    const upload = stepNamed(worker, 'Publish the acceptance receipt')
    expect(upload.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a')
    expect(upload.with?.['if-no-files-found']).toBe('error')
    expect(upload.with?.name).toBe('built-worker-desktop-auth-receipt')
  })

  test('the leak check reports newly observed resources and removes nothing', () => {
    const step = stepNamed(worker, 'Require no newly observed container to remain')
    expect(step.if).toBe('always()')
    expect(step.run).toContain('docker ps -a')
    expect(step.run).toContain("'{{.ID}}'")
    expect(step.run).toContain('comm -13')
    expect(step.run).toContain('newly observed container resources')
    expect(step.run).not.toContain('docker rm')
    expect(step.run).not.toContain('prune')
    expect(step.run).not.toContain('docker system')
    // The snapshot is taken before the qualification runs.
    const names = worker.steps.map((candidate: { name?: string }) => candidate.name)
    expect(names.indexOf('Record the containers the runner has')).toBeLessThan(
      names.indexOf('Run the built-Worker desktop auth qualification')
    )
  })

  test('the gate it calls is the CI gate this lane owns', () => {
    const gate = readFileSync(resolve(root, 'scripts/ci-built-worker-desktop-auth.mjs'), 'utf8')
    expect(gate).toContain('assertBuiltWorkerReceipt')
    expect(gate).toContain('does not name the exact head the job checked out')
    expect(gate).toContain('did not clean up after itself')
    // The gate is a Node program, like the fresh-account gate, and it reads
    // the shared provenance contract rather than restating it. It does not
    // claim a runtime it is not run with.
    expect(gate).toContain("from './fresh-postgres-acceptance/provenance.mjs'")
    expect(gate).not.toContain('The gate runs with Bun')
    const step = stepNamed(worker, 'Gate and publish the acceptance receipt')
    expect(step.run).toContain('node scripts/ci-built-worker-desktop-auth.mjs')
  })

  test('the gate it calls counts the assertions instead of believing them', () => {
    const gate = readFileSync(resolve(root, 'scripts/ci-built-worker-desktop-auth.mjs'), 'utf8')
    // A receipt that carries no assertion cannot claim that it passed some.
    expect(gate).toContain('carries no assertion list')
    expect(gate).toContain('carries no assertion')
    // The assertions have to have the shape the contract declares.
    expect(gate).toContain('without a name')
    expect(gate).toContain('without a result')
    expect(gate).toContain('without a detail')
    expect(gate).toContain('without a usable attempt count')
    expect(gate).toContain('without an outcome')
    // The counts have to be the numbers the assertions say.
    expect(gate).toContain('does not carry integer assertion counters')
    expect(gate).toContain('counters do not match the assertions it carries')
    // The artifact has to name the build it proved.
    expect(gate).toContain('no usable artifact digest')
  })
})
