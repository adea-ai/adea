import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  HEALTHY_DEPLOYMENT_STATUSES,
  IDENTITY_FIELDS,
  LIVE_READS,
  REFUSAL_CODES,
  planProductionDeployment,
  readProductionSource,
  refusalEvidenceDigest,
} from './railway-production-plan.mjs'

const root = resolve(import.meta.dir, '..')

/** The read a command runner is asked for. */
type ReadRequest = { command: string[]; kind: string; timeoutMs: number }

/** What a staged read answers with. */
type StagedRead = { status: number; stderr: string; stdout: string; timedOut?: boolean }

/** The command runner the plan is given. */
type Runner = (request: ReadRequest) => StagedRead

/** A command runner that also records the calls it was asked for. */
type RecordingRunner = Runner & { calls: ReadRequest[] }

/** One refusal a plan carries. */
type Refusal = {
  code: string
  detail: string
  evidence: Record<string, unknown>
  evidenceDigest: string
}

/** The finished plan. */
type Plan = {
  deployment: Record<string, unknown> | null
  history: { count: number; newest: unknown } | null
  refusals: Refusal[]
  target: unknown
  verdict: string
}

/** What a plan is asked for. */
type PlanInput = { root?: string; run?: Runner; source?: unknown }

/** The plan, typed for the assertions below. */
function planFor(input: PlanInput): Plan {
  return planProductionDeployment(input) as Plan
}

/**
 * The declaration the tests plan against.
 *
 * The identity values are placeholders. They are not the repository's
 * production identity — the repository has not configured one — and they are
 * not a claim about the provider's schema. They are the concrete values a
 * configured declaration has to carry, so that the machinery that checks a
 * recorded identity can be exercised offline.
 */
const declaration = {
  configured: true,
  environment: 'production',
  targets: [{ project: 'example-project', service: 'example-service', environment: 'production' }],
  requiredMetadata: ['release', 'imageDigest', 'region', 'promotedAt'],
  pinnedMetadata: {},
}

const observedTarget = {
  project: 'example-project',
  service: 'example-service',
  environment: 'production',
}

const observedDeployment = {
  release: 'v0.99.0-dev.488',
  imageDigest: 'sha256:1f0a',
  region: 'iad1',
  promotedAt: '2026-10-20T00:00:00Z',
}

/** A command runner that answers with the staged reads and records its calls. */
function fakeRunner(reads: Record<string, StagedRead>): RecordingRunner {
  const calls: ReadRequest[] = []
  const run: Runner = (request) => {
    calls.push({
      kind: request.kind,
      command: [...request.command],
      timeoutMs: request.timeoutMs,
    })
    const staged = reads[request.kind]
    if (staged === undefined) {
      return { status: 1, stdout: '', stderr: 'no read was staged' }
    }
    return staged
  }
  const recording = run as RecordingRunner
  recording.calls = calls
  return recording
}

/** A staged read that answers with a payload. */
function read(payload: unknown): StagedRead {
  return { status: 0, stdout: JSON.stringify(payload), stderr: '' }
}

/** A command runner that could not start. */
const throwingRunner: Runner = () => {
  throw new Error('the runner could not start')
}

/**
 * One deployment of the target's history.
 *
 * Every deployment names the project and the service it belongs to: that is
 * what binds the history to the target that was read.
 */
function deployment(
  id: string,
  status: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    createdAt: '2026-10-20T00:00:00Z',
    id,
    project: 'example-project',
    service: 'example-service',
    status,
    ...overrides,
  }
}

/** The reads a healthy production deployment answers with. */
function healthyReads() {
  return {
    status: read({
      targets: [observedTarget],
      deployment: observedDeployment,
    }),
    deployments: read({
      deployments: [
        deployment('d_2', 'success'),
        deployment('d_1', 'error', { createdAt: '2026-10-19T00:00:00Z' }),
      ],
    }),
  }
}

/** The codes of the refusals a plan carries. */
function codes(plan: { refusals: { code: string }[] }) {
  return plan.refusals.map((refusal) => refusal.code)
}

/**
 * The refusal a plan carries for a code.
 *
 * It throws when the plan carries none, so a case cannot pass by asserting on
 * a refusal that is not there.
 */
function refusalFor(plan: Plan, code: string): Refusal {
  const found = plan.refusals.find((entry) => entry.code === code)
  if (!found) throw new Error(`the plan carries no ${code} refusal`)
  return found
}

/**
 * A repository root that declares a production source the given way.
 *
 * The declaration is read from disk, so the fixtures are real files in a real
 * directory and not objects handed to the plan.
 */
function repositoryDeclaring(source: string): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'railway-production-source-'))
  mkdirSync(resolve(directory, '.railway'), { recursive: true })
  writeFileSync(resolve(directory, '.railway/production-source.js'), source, 'utf8')
  return directory
}

describe('the Railway production source plan', () => {
  test('plans the production source when the declaration, the read and the history agree', () => {
    const run = fakeRunner(healthyReads())
    const plan = planFor({ source: declaration, run })

    expect(plan.verdict).toBe('planned')
    expect(plan.refusals).toEqual([])
    expect(plan.target).toEqual(observedTarget)
    expect(plan.deployment).toEqual(observedDeployment)
    expect(plan.history!.count).toBe(2)
    expect(run.calls.map((call) => call.kind)).toEqual(['status', 'deployments'])
    expect(run.calls[0].command).toEqual([...LIVE_READS.status.command])
  })

  test('refuses a declaration that names no production target', () => {
    const plan = planFor({
      source: { ...declaration, targets: [] },
      run: fakeRunner(healthyReads()),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.targetMissing)
  })

  test('refuses a declaration that names more than one production target', () => {
    const plan = planFor({
      source: {
        ...declaration,
        targets: [
          { project: 'example-project', service: 'example-service', environment: 'production' },
          {
            project: 'example-project',
            service: 'example-other-service',
            environment: 'production',
          },
        ],
      },
      run: fakeRunner(healthyReads()),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.targetAmbiguous)
    const refusal = refusalFor(plan, REFUSAL_CODES.targetAmbiguous)
    expect(refusal.evidence.candidates).toHaveLength(2)
  })

  test('refuses the shape that an identity-free declaration used to plan', () => {
    // The shape this plan used to accept: a target that names only an
    // environment, arbitrary non-empty metadata and a successful history
    // entry. It is not a plan, and it is not a plan any more.
    const reads = healthyReads()
    reads.status = read({
      targets: [{ environment: 'production' }],
      deployment: observedDeployment,
    })
    reads.deployments = read({
      deployments: [{ id: 'd_2', status: 'success', createdAt: '2026-10-20T00:00:00Z' }],
    })

    const plan = planFor({
      source: { ...declaration, targets: [{ environment: 'production' }] },
      run: fakeRunner(reads),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.sourceInvalid)
  })

  test('refuses a live read that names more than one production target', () => {
    const reads = healthyReads()
    reads.status = read({
      targets: [
        observedTarget,
        { project: 'example-project', service: 'example-other-service', environment: 'production' },
      ],
      deployment: observedDeployment,
    })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.targetAmbiguous)
    const refusal = refusalFor(plan, REFUSAL_CODES.targetAmbiguous)
    expect(refusal.evidence.candidates).toHaveLength(2)
  })

  test('refuses a live read that names no production target', () => {
    const reads = healthyReads()
    reads.status = read({ targets: [], deployment: observedDeployment })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.targetMissing)
  })

  test('refuses a live target that contradicts the declared target', () => {
    const reads = healthyReads()
    reads.status = read({
      targets: [
        { project: 'example-project', service: 'example-other-service', environment: 'production' },
      ],
      deployment: observedDeployment,
    })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.targetContradictory)
    const refusal = refusalFor(plan, REFUSAL_CODES.targetContradictory)
    expect(refusal.evidence.field).toBe('service')
    expect(refusal.evidence.expected).toBe('example-service')
    expect(refusal.evidence.observed).toBe('example-other-service')
  })

  test('refuses a live target outside the declared production environment', () => {
    const reads = healthyReads()
    reads.status = read({
      targets: [{ project: 'example-project', service: 'example-service', environment: 'staging' }],
      deployment: observedDeployment,
    })

    const plan = planFor({
      // The candidate pins the project and the service, and both agree. The
      // environment is the declaration's own rule, and the live target is not
      // in it, so the refusal comes from the rule and not from the candidate.
      source: {
        ...declaration,
        targets: [{ project: 'example-project', service: 'example-service' }],
      },
      run: fakeRunner(reads),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.targetContradictory)
    const refusal = refusalFor(plan, REFUSAL_CODES.targetContradictory)
    expect(refusal.evidence.field).toBe('environment')
    expect(refusal.evidence.expected).toBe('production')
    expect(refusal.evidence.observed).toBe('staging')
  })

  test('refuses a live target that names no project and service', () => {
    const reads = healthyReads()
    reads.status = read({
      targets: [{ environment: 'production' }],
      deployment: observedDeployment,
    })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.targetIdentityMissing)
    const refusal = refusalFor(plan, REFUSAL_CODES.targetIdentityMissing)
    expect(refusal.evidence.fields).toEqual(['project', 'service'])
    expect(refusal.evidence.observed).toEqual({ project: null, service: null })
  })

  test('refuses a declaration whose target names no project and service', () => {
    const plan = planFor({
      source: { ...declaration, targets: [{ environment: 'production' }] },
      run: fakeRunner(healthyReads()),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.sourceInvalid])
    expect(plan.refusals[0].evidence.field).toBe('targets.project')
  })

  test('refuses a deployment history that binds no deployment to the target', () => {
    const reads = healthyReads()
    reads.deployments = read({
      deployments: [
        {
          createdAt: '2026-10-20T00:00:00Z',
          id: 'd_2',
          status: 'success',
        },
      ],
    })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.historyUnbound)
    const refusal = refusalFor(plan, REFUSAL_CODES.historyUnbound)
    expect(refusal.evidence.reason).toBe('the deployment names no project and service')
    expect(refusal.evidence.observed).toEqual({ project: null, service: null })
    expect(refusal.evidence.id).toBe('d_2')
  })

  test('refuses a deployment history that belongs to another target', () => {
    const reads = healthyReads()
    reads.deployments = read({
      deployments: [deployment('d_2', 'success', { service: 'example-other-service' })],
    })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.historyContradictory)
    const refusal = refusalFor(plan, REFUSAL_CODES.historyContradictory)
    expect(refusal.evidence).toMatchObject({
      expected: 'example-service',
      field: 'service',
      id: 'd_2',
      observed: 'example-other-service',
    })
  })

  test('refuses a deployment history bound to another project', () => {
    const reads = healthyReads()
    reads.deployments = read({
      deployments: [deployment('d_2', 'success', { project: 'example-other-project' })],
    })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.historyContradictory)
    const refusal = refusalFor(plan, REFUSAL_CODES.historyContradictory)
    expect(refusal.evidence).toMatchObject({
      expected: 'example-project',
      field: 'project',
      observed: 'example-other-project',
    })
  })

  test('refuses a deployment that does not publish the required metadata', () => {
    const reads = healthyReads()
    const { imageDigest: _omitted, ...withoutDigest } = observedDeployment
    reads.status = read({ targets: [observedTarget], deployment: withoutDigest })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.metadataMissing)
    const refusal = refusalFor(plan, REFUSAL_CODES.metadataMissing)
    expect(refusal.evidence.field).toBe('imageDigest')
  })

  test('refuses a deployment that contradicts the pinned metadata', () => {
    const reads = healthyReads()
    reads.status = read({
      targets: [observedTarget],
      deployment: { ...observedDeployment, release: 'v0.99.0-dev.487' },
    })

    const plan = planFor({
      source: { ...declaration, pinnedMetadata: { release: 'v0.99.0-dev.488' } },
      run: fakeRunner(reads),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.metadataContradictory)
    const refusal = refusalFor(plan, REFUSAL_CODES.metadataContradictory)
    expect(refusal.evidence).toEqual({
      field: 'release',
      expected: 'v0.99.0-dev.488',
      observed: 'v0.99.0-dev.487',
    })
  })

  test('refuses a stopped deployment history', () => {
    const reads = healthyReads()
    reads.deployments = read({
      deployments: [deployment('d_3', 'stopped', { createdAt: '2026-10-21T00:00:00Z' })],
    })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.historyUnhealthy)
    const refusal = refusalFor(plan, REFUSAL_CODES.historyUnhealthy)
    expect(refusal.evidence.status).toBe('stopped')
    expect(refusal.evidence.healthy).toEqual([...HEALTHY_DEPLOYMENT_STATUSES])
  })

  test('refuses an errored deployment history', () => {
    const reads = healthyReads()
    reads.deployments = read({
      deployments: [deployment('d_3', 'error', { createdAt: '2026-10-21T00:00:00Z' })],
    })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.historyUnhealthy)
    const refusal = refusalFor(plan, REFUSAL_CODES.historyUnhealthy)
    expect(refusal.evidence.status).toBe('error')
  })

  test('refuses an empty deployment history', () => {
    const reads = healthyReads()
    reads.deployments = read({ deployments: [] })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.historyMissing)
  })

  test('refuses a command that fails', () => {
    const reads = healthyReads()
    reads.status = { status: 1, stdout: '', stderr: 'the target does not exist' }

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.commandFailed)
    const refusal = refusalFor(plan, REFUSAL_CODES.commandFailed)
    expect(refusal.evidence.kind).toBe('status')
    expect(refusal.evidence.exitStatus).toBe(1)
  })

  test('refuses a command that times out', () => {
    const reads = healthyReads()
    reads.deployments = { status: 0, stdout: '', stderr: '', timedOut: true }

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.commandTimedOut)
    const refusal = refusalFor(plan, REFUSAL_CODES.commandTimedOut)
    expect(refusal.evidence.kind).toBe('deployments')
    expect(refusal.evidence.timeoutMs).toBeGreaterThan(0)
  })

  test('refuses a command runner that throws', () => {
    const plan = planFor({ source: declaration, run: throwingRunner })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.commandFailed)
    const refusal = refusalFor(plan, REFUSAL_CODES.commandFailed)
    expect(refusal.evidence.reason).toBe('the runner threw')
  })

  test('refuses a live read that is not JSON', () => {
    const reads = healthyReads()
    reads.status = { status: 0, stdout: 'not json at all', stderr: '' }

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.readUnparsable)
  })

  test('refuses a live read that is not the normalized read the plan reads', () => {
    const reads = healthyReads()
    reads.status = read({ project: 'example-project', service: 'example-service' })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.readUnnormalized])
    const refusal = plan.refusals[0]
    expect(refusal.evidence.kind).toBe('status')
    expect(refusal.evidence.problems).toEqual([
      { field: 'targets', reason: 'it is not present' },
      { field: 'deployment', reason: 'it is not present' },
    ])
  })

  test('refuses a deployments read that is not the normalized read the plan reads', () => {
    const reads = healthyReads()
    reads.deployments = read({ items: [] })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.readUnnormalized)
    const refusal = refusalFor(plan, REFUSAL_CODES.readUnnormalized)
    expect(refusal.evidence.kind).toBe('deployments')
    expect(refusal.evidence.problems).toEqual([
      { field: 'deployments', reason: 'it is not present' },
    ])
  })

  test('names the normalized shape of every live read the plan needs', () => {
    expect(LIVE_READS.status.containers).toEqual(['targets', 'deployment'])
    expect(LIVE_READS.deployments.containers).toEqual(['deployments'])
    expect(IDENTITY_FIELDS).toEqual(['project', 'service'])
  })

  test('refuses a plan that has no command runner', () => {
    const plan = planFor({ source: declaration })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.commandRunnerUnavailable])
  })

  test('refuses a declaration that is not shaped as one', () => {
    const plan = planFor({
      source: { configured: true, environment: 'production', targets: 'not-a-target' },
      run: fakeRunner(healthyReads()),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.sourceInvalid])
    const refusal = plan.refusals[0]
    expect(refusal.evidence.field).toBe('targets')
  })

  test('refuses a declaration whose environment is not a non-empty string', () => {
    const plan = planFor({
      source: { ...declaration, environment: '' },
      run: fakeRunner(healthyReads()),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.sourceInvalid])
    expect(plan.refusals[0].evidence.field).toBe('environment')
  })

  test('refuses a declaration whose candidate target is not an object', () => {
    const plan = planFor({
      source: { ...declaration, targets: ['example-service'] },
      run: fakeRunner(healthyReads()),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.sourceInvalid])
    expect(plan.refusals[0].evidence.field).toBe('targets')
  })

  test('refuses a declaration whose candidate environment is not a string', () => {
    const plan = planFor({
      source: {
        ...declaration,
        targets: [{ project: 'example-project', service: 'example-service', environment: 1 }],
      },
      run: fakeRunner(healthyReads()),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.sourceInvalid])
    expect(plan.refusals[0].evidence.field).toBe('targets.environment')
  })

  test('refuses a declaration whose required metadata is not a list', () => {
    const plan = planFor({
      source: { ...declaration, requiredMetadata: 'release' },
      run: fakeRunner(healthyReads()),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.sourceInvalid])
    expect(plan.refusals[0].evidence.field).toBe('requiredMetadata')
  })

  test('refuses a command runner that returns no result', () => {
    const plan = planFor({ source: declaration, run: (() => undefined) as never })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.commandFailed)
    const refusal = refusalFor(plan, REFUSAL_CODES.commandFailed)
    expect(refusal.evidence.reason).toBe('the runner returned no result')
  })

  test('refuses a live read that is not an object', () => {
    const reads = healthyReads()
    reads.status = read('a string is not a normalized read')

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.readUnnormalized])
    expect(plan.refusals[0].evidence.problems).toEqual([
      { field: 'the read', reason: 'it is not an object' },
    ])
  })

  test('refuses a live read whose deployment is not an object', () => {
    const reads = healthyReads()
    reads.status = read({ targets: [observedTarget], deployment: 'not an object' })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.readUnnormalized])
    expect(plan.refusals[0].evidence.problems).toEqual([
      { field: 'deployment', reason: 'it is not an object' },
    ])
  })

  test('refuses a live read whose targets are not a list', () => {
    const reads = healthyReads()
    reads.status = read({ targets: {}, deployment: observedDeployment })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.readUnnormalized])
    expect(plan.refusals[0].evidence.problems).toEqual([
      { field: 'targets', reason: 'it is not an array' },
    ])
  })

  test('refuses a live read whose target is not an object', () => {
    const reads = healthyReads()
    reads.status = read({ targets: ['example-service'], deployment: observedDeployment })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.readUnnormalized])
    expect(plan.refusals[0].evidence.problems).toEqual([
      { field: 'targets[0]', reason: 'it is not an object' },
    ])
  })

  test('refuses a deployments read whose history is not a list', () => {
    const reads = healthyReads()
    reads.deployments = read({ deployments: 'not a list' })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.readUnnormalized)
    const refusal = refusalFor(plan, REFUSAL_CODES.readUnnormalized)
    expect(refusal.evidence.problems).toEqual([
      { field: 'deployments', reason: 'it is not an array' },
    ])
  })

  test('refuses a deployments read whose deployment is not an object', () => {
    const reads = healthyReads()
    reads.deployments = read({ deployments: ['d_2'] })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.readUnnormalized)
    const refusal = refusalFor(plan, REFUSAL_CODES.readUnnormalized)
    expect(refusal.evidence.problems).toEqual([
      { field: 'deployments[0]', reason: 'it is not an object' },
    ])
  })

  test('refuses a repository that declares no production source', () => {
    const declarationRead = readProductionSource(resolve(root, 'docs'))

    expect(declarationRead.source).toBeNull()
    expect(declarationRead.refusal.code).toBe(REFUSAL_CODES.sourceUnreadable)
  })

  test('refuses a plan whose repository declares no production source', () => {
    const plan = planFor({
      root: resolve(root, 'docs'),
      run: fakeRunner(healthyReads()),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.sourceUnreadable)
  })

  test('refuses a declaration on disk that is not shaped as a declaration', () => {
    const directory = repositoryDeclaring(
      "module.exports = { productionSource: 'not a declaration' }\n"
    )
    try {
      const declarationRead = readProductionSource(directory)

      expect(declarationRead.source).toBeNull()
      expect(declarationRead.refusal.code).toBe(REFUSAL_CODES.sourceInvalid)
      expect(declarationRead.refusal.evidence.field).toBe('the declaration')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('refuses a declaration on disk whose pinned metadata is not an object', () => {
    const directory = repositoryDeclaring(
      "module.exports = { productionSource: { configured: true, environment: 'production', targets: [{ project: 'example-project', service: 'example-service' }], requiredMetadata: [], pinnedMetadata: 'none' } }\n"
    )
    try {
      const declarationRead = readProductionSource(directory)

      expect(declarationRead.source).toBeNull()
      expect(declarationRead.refusal.code).toBe(REFUSAL_CODES.sourceInvalid)
      expect(declarationRead.refusal.evidence.field).toBe('pinnedMetadata')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('refuses a declaration whose pinned metadata is not an object', () => {
    const plan = planFor({
      source: { ...declaration, pinnedMetadata: 'none' },
      run: fakeRunner(healthyReads()),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.sourceInvalid])
    expect(plan.refusals[0].evidence.field).toBe('pinnedMetadata')
  })

  test('reads the repository’s own declaration, which is explicitly unconfigured', () => {
    const declarationRead = readProductionSource(root)

    expect(declarationRead.refusal).toBeNull()
    expect(declarationRead.source.environment).toBe('production')
    expect(declarationRead.source.requiredMetadata).toContain('imageDigest')
    expect(declarationRead.source.pinnedMetadata).toEqual({})

    // The repository has not configured a production identity, and the
    // declaration says so rather than guessing one: it names no target, and it
    // does not claim that a Railway project or service is known.
    expect(declarationRead.source.configured).toBe(false)
    expect(declarationRead.source.targets).toEqual([])

    // So the plan is fail-closed: it refuses, and it makes no live read at
    // all, because there is no declared target for a read to agree with.
    const run = fakeRunner(healthyReads())
    const plan = planFor({ root, run })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.sourceUnconfigured])
    expect(run.calls).toEqual([])
  })

  test('refuses a declaration that has not configured a production identity', () => {
    const run = fakeRunner(healthyReads())
    const plan = planFor({ source: { ...declaration, configured: false }, run })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.sourceUnconfigured])
    expect(run.calls).toEqual([])
  })

  test('refuses a declaration whose configured flag is not a boolean', () => {
    const plan = planFor({
      source: { ...declaration, configured: 'yes' },
      run: fakeRunner(healthyReads()),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.sourceInvalid])
    expect(plan.refusals[0].evidence.field).toBe('configured')
  })

  test('the same input always produces the same plan and the same evidence', () => {
    const first = planFor({
      source: declaration,
      run: fakeRunner(healthyReads()),
    })
    const second = planFor({
      source: declaration,
      run: fakeRunner(healthyReads()),
    })

    expect(second).toEqual(first)
  })

  test('the refusal evidence digest covers the refusal and is stable', () => {
    const reads = healthyReads()
    reads.deployments = read({
      deployments: [deployment('d_3', 'stopped', { createdAt: '2026-10-21T00:00:00Z' })],
    })

    const plan = planFor({ source: declaration, run: fakeRunner(reads) })
    const refusal = plan.refusals[0]

    expect(refusal.evidenceDigest).toBe(refusalEvidenceDigest(refusal))
    expect(refusal.evidenceDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(planFor({ source: declaration, run: fakeRunner(healthyReads()) }).refusals).toEqual([])
  })

  test('two refusals with the same code and different evidence have different digests', () => {
    const stopped = healthyReads()
    stopped.deployments = read({
      deployments: [deployment('d_3', 'stopped', { createdAt: '2026-10-21T00:00:00Z' })],
    })
    const errored = healthyReads()
    errored.deployments = read({
      deployments: [deployment('d_3', 'error', { createdAt: '2026-10-21T00:00:00Z' })],
    })

    const stoppedRefusal = planFor({
      source: declaration,
      run: fakeRunner(stopped),
    }).refusals[0]
    const erroredRefusal = planFor({
      source: declaration,
      run: fakeRunner(errored),
    }).refusals[0]

    expect(stoppedRefusal.code).toBe(erroredRefusal.code)
    expect(stoppedRefusal.evidenceDigest).not.toBe(erroredRefusal.evidenceDigest)
  })

  test('the plan starts no process of its own', () => {
    const source = readFileSync(resolve(root, 'scripts/railway-production-plan.mjs'), 'utf8')

    expect(source).not.toContain('child_process')
    expect(source).not.toContain('exec(')
    expect(source).not.toContain('spawn')
  })
})
