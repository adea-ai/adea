import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const workflowText = readFileSync(resolve(root, '.github/workflows/neon_workflow.yml'), 'utf8')

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
  strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown> }
  steps: Step[]
}
const workflow = Bun.YAML.parse(workflowText) as {
  on: { pull_request: { types: string[] } }
  permissions?: unknown
  concurrency: { 'cancel-in-progress': string }
  jobs: Record<string, Job>
}
const jobs = workflow.jobs
const stepNamed = (job: Job, name: string) => {
  const step = job.steps.find((candidate) => candidate.name === name)
  if (!step) throw new Error(`missing step: ${name}`)
  return step
}

describe('Neon branch lifecycle workflow', () => {
  test('keeps the required check name on one fail-closed gate over setup and the provider proof', () => {
    const named = Object.entries(jobs).filter(([, job]) => job.name === 'Migrate Neon Branch')
    expect(named.map(([id]) => id)).toEqual(['migrate_gate'])
    expect(Object.values(jobs).some((job) => job.name?.startsWith('Migrate Neon Branch ('))).toBe(
      false
    )

    const gate = jobs.migrate_gate!
    expect([...(gate.needs as string[])].toSorted()).toEqual(['neon_proof', 'setup'])
    expect(gate.if).toContain('always()')
    expect(gate.if).toContain('github.event.pull_request.draft == false')
    expect(gate.if).toContain("github.event.action == 'ready_for_review'")
    const check = stepNamed(gate, 'Require setup and provider proof to succeed').run ?? ''
    expect(check).toContain('test "$SETUP_RESULT" = success')
    expect(check).toContain('test "$PROOF_RESULT" = success')
  })

  test('runs one bounded Neon proof', () => {
    const proof = jobs.neon_proof!
    expect(proof.strategy).toBeUndefined()
    expect(proof['timeout-minutes']).toBe(5)
    expect(proof.name).toBe('Neon Preview Proof')
    expect(jobs.migrate_gate!['timeout-minutes']).toBe(5)
  })

  test('keeps provider-specific proof on Neon without the remote full suite', () => {
    const create = stepNamed(jobs.neon_proof!, 'Create Neon branch')
    expect(create.with?.branch_name).toBe(
      'preview/pr-${{ github.event.number }}-${{ needs.setup.outputs.branch }}-proof'
    )
    const urlStep = stepNamed(jobs.neon_proof!, 'Build restricted database URLs')
    expect(urlStep.run).toContain('connect_timeout", "10"')
    const auth = stepNamed(jobs.neon_proof!, 'Verify isolated Neon Auth endpoint')
    expect(auth.run).toContain('AbortSignal.timeout(15_000)')
    const verify = stepNamed(jobs.neon_proof!, 'Verify Neon connections and migrations')
    expect(verify.run).toContain('node scripts/database-health.mjs')
    expect(verify.run).toContain('bun run --cwd packages/db db:check')
    expect(verify.run).toContain('bun run --cwd packages/db db:verify')
    expect(verify.run).toContain('test -n "$DATABASE_URL"')
    expect(verify.run).toContain(
      'bun --conditions=react-server test packages/db/tests/integration/migrations.test.ts'
    )
    const databaseHealthIndex = verify.run!.indexOf('node scripts/database-health.mjs')
    const migrationCheckIndex = verify.run!.indexOf('bun run --cwd packages/db db:check')
    const migrationVerifyIndex = verify.run!.indexOf('bun run --cwd packages/db db:verify')
    const requiredDatabaseUrlIndex = verify.run!.indexOf('test -n "$DATABASE_URL"')
    const integrationTestIndex = verify.run!.indexOf(
      'bun --conditions=react-server test packages/db/tests/integration/migrations.test.ts'
    )
    expect(databaseHealthIndex).toBeLessThan(migrationCheckIndex)
    expect(migrationCheckIndex).toBeLessThan(migrationVerifyIndex)
    expect(migrationVerifyIndex).toBeLessThan(requiredDatabaseUrlIndex)
    expect(requiredDatabaseUrlIndex).toBeLessThan(integrationTestIndex)
    expect(verify.run).not.toContain('bun run test:integration')
    expect(verify.env?.ADEA_INTEGRATION_SHARD).toBeUndefined()
  })

  test('keeps the restricted application and migration roles and the secret set unchanged', () => {
    expect(workflowText).toContain('"adea_dev_app"')
    expect(workflowText).toContain('"adea_dev_migration"')
    const secrets = [...workflowText.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1])
    expect([...new Set(secrets)].toSorted()).toEqual([
      'NEON_API_KEY',
      'NEON_CI_APP_PASSWORD',
      'NEON_CI_MIGRATION_PASSWORD',
    ])
    expect(workflow.permissions).toEqual({})
  })

  test('pins the create and delete actions to the reviewed commits', () => {
    expect(workflowText).toContain(
      'neondatabase/create-branch-action@72ed4f69a12b6be9c16aebfad893f6a21e9aba8b # v6.4.0'
    )
    expect(workflowText).toContain(
      'neondatabase/delete-branch-action@4468d825d5a88ef4012f1705a82f02ec3072f776 # v3.2.1'
    )
  })

  test('cleans up the proof branch plus previous shard and legacy branches', () => {
    const cleanup = jobs.delete_neon_branch!
    expect(cleanup['timeout-minutes']).toBe(10)
    const lookup = stepNamed(cleanup, "Resolve this pull request's Neon branches")
    expect(lookup.env?.LEGACY_BRANCH).toBe(
      'preview/pr-${{ github.event.number }}-${{ steps.branch_name.outputs.current_branch }}'
    )
    expect(lookup.env?.SHARD_1_BRANCH).toBe(
      'preview/pr-${{ github.event.number }}-${{ steps.branch_name.outputs.current_branch }}-s1'
    )
    expect(lookup.env?.SHARD_2_BRANCH).toBe(
      'preview/pr-${{ github.event.number }}-${{ steps.branch_name.outputs.current_branch }}-s2'
    )
    expect(lookup.env?.PROOF_BRANCH).toBe(
      'preview/pr-${{ github.event.number }}-${{ steps.branch_name.outputs.current_branch }}-proof'
    )
    expect(lookup.run).toContain('`legacy=${idFor(LEGACY_BRANCH)}')
    expect(lookup.run).toContain('shard_1=${idFor(SHARD_1_BRANCH)}')
    expect(lookup.run).toContain('shard_2=${idFor(SHARD_2_BRANCH)}')
    expect(lookup.run).toContain('proof=${idFor(PROOF_BRANCH)}')

    const deletes = cleanup.steps.filter((step) =>
      step.uses?.startsWith('neondatabase/delete-branch')
    )
    expect(deletes.map((step) => step.with?.branch_id)).toEqual([
      '${{ steps.resolve.outputs.legacy }}',
      '${{ steps.resolve.outputs.shard_1 }}',
      '${{ steps.resolve.outputs.shard_2 }}',
      '${{ steps.resolve.outputs.proof }}',
    ])
    for (const step of deletes) {
      expect(step.with?.branch).toBeUndefined()
      expect(step.if).toContain("!cancelled() && github.event.action == 'closed'")
      expect(step.if).toContain("!= ''")
    }
  })
})

type Event = { action: string; draft: boolean }

// Evaluates the expression subset these conditions use. GitHub's single-quoted strings and
// operators are valid JavaScript once the context names are bound to the event.
function evaluate(source: string, event: Event) {
  const script = source
    .replaceAll('always()', 'true')
    .replaceAll('github.event.pull_request.draft', 'draft')
    .replaceAll('github.event.action', 'action')
  return Boolean(new Function('action', 'draft', `return (${script})`)(event.action, event.draft))
}

// Mirrors the runner for job-level conditions: a job starts when its condition holds and every
// job it needs succeeded. Only always() lets a skipped or failed dependency leave a job running.
// `forced` replaces the outcome of a job that starts, so a test can fail, cancel or skip setup.
type Result = 'success' | 'failure' | 'cancelled' | 'skipped'
const jobOrder = ['setup', 'neon_proof', 'migrate_gate', 'delete_neon_branch']
function jobResults(event: Event, forced: Partial<Record<string, Result>> = {}) {
  const results = new Map<string, Result>()
  for (const id of jobOrder) {
    const job = jobs[id]!
    const dependenciesSucceeded = [job.needs ?? []]
      .flat()
      .every((need) => results.get(need) === 'success')
    const condition = job.if === undefined || evaluate(job.if, event)
    const bypassesDependencies = job.if?.includes('always()') === true
    const starts = condition && (dependenciesSucceeded || bypassesDependencies)
    results.set(id, starts ? (forced[id] ?? 'success') : 'skipped')
  }
  return results
}
function jobsThatRun(event: Event) {
  const results = jobResults(event)
  return Object.fromEntries(jobOrder.map((id) => [id, results.get(id) !== 'skipped']))
}

// A pull_request event starts the workflow only when its action is listed under `types`; then the
// job conditions decide which jobs run.
function lifecycle(event: Event) {
  const started = workflow.on.pull_request.types.includes(event.action)
  const idle = Object.fromEntries(jobOrder.map((id) => [id, false]))
  return { started, jobs: started ? jobsThatRun(event) : idle }
}

describe('Neon branch lifecycle triggers', () => {
  test('starts only on the actions that may run heavy validation', () => {
    expect([...workflow.on.pull_request.types].toSorted()).toEqual([
      'closed',
      'ready_for_review',
      'synchronize',
    ])
  })

  test('opened and reopened never start the workflow, so Draft Guard can convert them first', () => {
    for (const action of ['opened', 'reopened']) {
      for (const draft of [true, false]) {
        expect(lifecycle({ action, draft }).started).toBe(false)
      }
    }
  })

  test('a ready pull request runs the provider proof and gate on ready_for_review and each push', () => {
    for (const action of ['ready_for_review', 'synchronize']) {
      expect(lifecycle({ action, draft: false })).toEqual({
        started: true,
        jobs: {
          setup: true,
          neon_proof: true,
          migrate_gate: true,
          delete_neon_branch: false,
        },
      })
    }
  })

  test('draft pushes start the workflow but run no job, so no migration runs', () => {
    expect(lifecycle({ action: 'synchronize', draft: true })).toEqual({
      started: true,
      jobs: {
        setup: false,
        neon_proof: false,
        migrate_gate: false,
        delete_neon_branch: false,
      },
    })
  })

  test('closed pull requests only clean up, whether or not they were drafts', () => {
    for (const draft of [true, false]) {
      expect(lifecycle({ action: 'closed', draft })).toEqual({
        started: true,
        jobs: {
          setup: true,
          neon_proof: false,
          migrate_gate: false,
          delete_neon_branch: true,
        },
      })
    }
  })

  test('only closed events bypass cancel-in-progress', () => {
    const cancel = workflow.concurrency['cancel-in-progress'].replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    expect(evaluate(cancel, { action: 'closed', draft: false })).toBe(false)
    for (const action of ['ready_for_review', 'synchronize']) {
      expect(evaluate(cancel, { action, draft: false })).toBe(true)
    }
  })
})

// Renders a name template for one pull request, binding both branch-name sources to the same value.
const render = (template: string, branch: string) =>
  template
    .replaceAll('${{ github.event.number }}', '42')
    .replaceAll('${{ needs.setup.outputs.branch }}', branch)
    .replaceAll('${{ steps.branch_name.outputs.current_branch }}', branch)

describe('Neon cleanup is close-only and independent of setup', () => {
  const cleanup = jobs.delete_neon_branch!
  const branchNames = 'tj-actions/branch-names@5250492686b253f06fa55861556d1027b067aeb5'

  test('has no dependency on setup or any other job', () => {
    expect(cleanup.needs).toBeUndefined()
    expect(cleanup.if).toBe("github.event.action == 'closed'")
    expect(JSON.stringify(cleanup)).not.toContain('needs.')
  })

  test('resolves the branch name with the same pinned action setup uses', () => {
    const own = stepNamed(cleanup, 'Get branch name')
    const setupStep = stepNamed(jobs.setup!, 'Get branch name')
    expect(cleanup.steps[0]).toBe(own)
    expect(own.id).toBe('branch_name')
    expect(own.uses).toBe(branchNames)
    expect(setupStep.uses).toBe(branchNames)
    // Setup and cleanup are the only users, and both keep the reviewed version comment.
    expect(workflowText.split(`${branchNames} # v9.0.2`)).toHaveLength(3)
    expect(setupStep.id).toBe(own.id)
    expect((jobs.setup as unknown as { outputs: Record<string, string> }).outputs.branch).toBe(
      '${{ steps.branch_name.outputs.current_branch }}'
    )
  })

  test('cleans up when setup fails, is cancelled or is skipped, on draft and ready closes', () => {
    for (const draft of [true, false]) {
      for (const setup of ['failure', 'cancelled', 'skipped'] as const) {
        const results = jobResults({ action: 'closed', draft }, { setup })
        expect(results.get('setup')).toBe(setup)
        expect(results.get('delete_neon_branch')).toBe('success')
        expect(results.get('neon_proof')).toBe('skipped')
        expect(results.get('migrate_gate')).toBe('skipped')
      }
    }
  })

  test('the model still suppresses a job that needs a failed setup, so the check is sensitive', () => {
    const results = jobResults({ action: 'synchronize', draft: false }, { setup: 'failure' })
    expect(results.get('neon_proof')).toBe('skipped')
    expect(results.get('delete_neon_branch')).toBe('skipped')
  })

  test('never cleans up on any event other than a close', () => {
    for (const action of ['ready_for_review', 'synchronize', 'opened', 'reopened']) {
      for (const draft of [true, false]) {
        for (const setup of ['success', 'failure'] as const) {
          const results = jobResults({ action, draft }, { setup })
          expect(results.get('delete_neon_branch')).toBe('skipped')
        }
      }
    }
  })

  test('closed events are never superseded, so a queued close cleanup is not cancelled', () => {
    const cancel = workflow.concurrency['cancel-in-progress'].replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    expect(evaluate(cancel, { action: 'closed', draft: true })).toBe(false)
    expect(evaluate(cancel, { action: 'closed', draft: false })).toBe(false)
    for (const step of cleanup.steps.filter((candidate) => candidate.uses?.includes('delete'))) {
      expect(step.if).toContain('!cancelled()')
    }
  })

  test('resolves current, legacy, shard and proof names exactly as the proof lane creates them', () => {
    const created = stepNamed(jobs.neon_proof!, 'Create Neon branch').with?.branch_name ?? ''
    const lookup = stepNamed(cleanup, "Resolve this pull request's Neon branches").env ?? {}

    for (const branch of [
      'feat-x',
      'feat/x',
      'dependabot/npm_and_yarn/foo-1.2.3',
      'claude/p-f5kngn',
    ]) {
      const legacy = `preview/pr-42-${branch}`
      expect(render(lookup.LEGACY_BRANCH!, branch)).toBe(legacy)
      expect(render(lookup.SHARD_1_BRANCH!, branch)).toBe(`${legacy}-s1`)
      expect(render(lookup.SHARD_2_BRANCH!, branch)).toBe(`${legacy}-s2`)
      expect(render(lookup.PROOF_BRANCH!, branch)).toBe(`${legacy}-proof`)
      expect(render(lookup.PROOF_BRANCH!, branch)).toBe(render(created, branch))
      for (const name of Object.values(lookup)) {
        if (name.startsWith('preview/')) expect(render(name, branch)).not.toContain('${{')
      }
    }
  })

  test('keeps bounded pagination, strict id validation, the pinned delete action and permissions', () => {
    const lookup = stepNamed(cleanup, "Resolve this pull request's Neon branches")
    expect(lookup.run).toContain('const MAX_PAGES = 50')
    const idPattern = /const SAFE_BRANCH_ID = \/(.+)\/;/.exec(lookup.run ?? '')?.[1]
    expect(idPattern).toBeDefined()
    const safeId = new RegExp(idPattern!)
    for (const id of ['br-abc', 'br-abc-123-def']) expect(safeId.test(id)).toBe(true)
    for (const id of [
      '',
      'br-',
      'BR-abc',
      'br--a',
      'br-a_b',
      'br-a;b',
      'br-a b',
      'x-br-a',
      'br-a\n',
    ])
      expect(safeId.test(id)).toBe(false)
    expect(lookup.run).toContain('branch.id.length > 128')
    expect(lookup.run).toContain('refusing to claim absence')
    expect(lookup.env?.NEON_API_KEY).toBe('${{ secrets.NEON_API_KEY }}')
    expect(lookup.env?.NEON_PROJECT_ID).toBe('${{ vars.NEON_PROJECT_ID }}')
    const deletes = cleanup.steps.filter((step) => step.uses?.startsWith('neondatabase/delete'))
    expect(deletes).toHaveLength(4)
    for (const step of deletes) {
      expect(step.uses).toBe(
        'neondatabase/delete-branch-action@4468d825d5a88ef4012f1705a82f02ec3072f776'
      )
    }
    expect((cleanup as unknown as { permissions?: unknown }).permissions).toBeUndefined()
    expect(workflow.permissions).toEqual({})
  })
})
