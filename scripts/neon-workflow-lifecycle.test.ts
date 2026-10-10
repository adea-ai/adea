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
  permissions?: unknown
  jobs: Record<string, Job>
}
const jobs = workflow.jobs
const stepNamed = (job: Job, name: string) => {
  const step = job.steps.find((candidate) => candidate.name === name)
  if (!step) throw new Error(`missing step: ${name}`)
  return step
}

describe('Neon branch lifecycle workflow', () => {
  test('keeps the required check name on one fail-closed gate over setup and both legs', () => {
    const named = Object.entries(jobs).filter(([, job]) => job.name === 'Migrate Neon Branch')
    expect(named.map(([id]) => id)).toEqual(['migrate_gate'])
    expect(Object.values(jobs).some((job) => job.name?.startsWith('Migrate Neon Branch ('))).toBe(
      false
    )

    const gate = jobs.migrate_gate!
    expect([...(gate.needs as string[])].toSorted()).toEqual(['create_neon_branch', 'setup'])
    expect(gate.if).toContain('always()')
    expect(gate.if).toContain('github.event.pull_request.draft == false')
    expect(gate.if).toContain("github.event.action == 'ready_for_review'")
    const check = stepNamed(gate, 'Require setup and both shards to succeed').run ?? ''
    expect(check).toContain('test "$SETUP_RESULT" = success')
    expect(check).toContain('test "$SHARDS_RESULT" = success')
  })

  test('runs two static legs under the unchanged 35-minute cap', () => {
    const shards = jobs.create_neon_branch!
    expect(shards.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2] } })
    expect(shards['timeout-minutes']).toBe(35)
    expect(shards.name).toBe('Migrate Neon Shard (${{ matrix.shard }}/2)')
    expect(jobs.migrate_gate!['timeout-minutes']).toBe(5)
  })

  test('gives each leg its own preview branch and its own shard of the inventory', () => {
    const create = stepNamed(jobs.create_neon_branch!, 'Create Neon branch')
    expect(create.with?.branch_name).toBe(
      'preview/pr-${{ github.event.number }}-${{ needs.setup.outputs.branch }}-s${{ matrix.shard }}'
    )
    const verify = stepNamed(jobs.create_neon_branch!, 'Verify migrations and transactions')
    expect(verify.env?.ADEA_INTEGRATION_SHARD).toBe('${{ matrix.shard }}/2')
    expect(verify.run).toContain('bun run test:integration')
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

  test('cleans up both shard branches and the legacy branch, skipping names that do not exist', () => {
    const cleanup = jobs.delete_neon_branch!
    expect(cleanup['timeout-minutes']).toBe(10)
    const lookup = stepNamed(cleanup, "Resolve this pull request's Neon branches")
    expect(lookup.env?.LEGACY_BRANCH).toBe(
      'preview/pr-${{ github.event.number }}-${{ needs.setup.outputs.branch }}'
    )
    expect(lookup.env?.SHARD_1_BRANCH).toBe(
      'preview/pr-${{ github.event.number }}-${{ needs.setup.outputs.branch }}-s1'
    )
    expect(lookup.env?.SHARD_2_BRANCH).toBe(
      'preview/pr-${{ github.event.number }}-${{ needs.setup.outputs.branch }}-s2'
    )
    expect(lookup.run).toContain('`legacy=${idFor(LEGACY_BRANCH)}')
    expect(lookup.run).toContain('shard_1=${idFor(SHARD_1_BRANCH)}')
    expect(lookup.run).toContain('shard_2=${idFor(SHARD_2_BRANCH)}')

    const deletes = cleanup.steps.filter((step) =>
      step.uses?.startsWith('neondatabase/delete-branch')
    )
    expect(deletes.map((step) => step.with?.branch_id)).toEqual([
      '${{ steps.resolve.outputs.legacy }}',
      '${{ steps.resolve.outputs.shard_1 }}',
      '${{ steps.resolve.outputs.shard_2 }}',
    ])
    for (const step of deletes) {
      expect(step.with?.branch).toBeUndefined()
      expect(step.if).toContain("!cancelled() && github.event.action == 'closed'")
      expect(step.if).toContain("!= ''")
    }
  })
})
