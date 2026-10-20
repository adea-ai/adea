import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
      'disposable_postgres_gate',
      'disposable_postgres_proof',
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
    expect(bun.with?.['bun-version']).toBe('1.4.3')
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
    expect([...(gate.needs as string[])]).toEqual(['disposable_postgres_proof'])
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
