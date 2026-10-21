import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  HEALTHY_DEPLOYMENT_STATUSES,
  LIVE_READS,
  REFUSAL_CODES,
  planProductionDeployment,
  readProductionSource,
  refusalEvidenceDigest,
} from '../scripts/railway-production-plan.mjs'

const root = resolve(import.meta.dir, '..')

// The declaration the tests plan against: one production target and the
// metadata every production deployment must publish.
const declaration = {
  environment: 'production',
  targets: [{ project: 'adea', service: 'auth', environment: 'production' }],
  requiredMetadata: ['release', 'imageDigest', 'region', 'promotedAt'],
  pinnedMetadata: {},
}

const observedTarget = { project: 'adea', service: 'auth', environment: 'production' }

const observedDeployment = {
  release: 'v0.99.0-dev.488',
  imageDigest: 'sha256:1f0a',
  region: 'iad1',
  promotedAt: '2026-10-20T00:00:00Z',
}

/** A command runner that answers with the staged reads and records its calls. */
function fakeRunner(reads) {
  const calls = []
  const run = (request) => {
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
  run.calls = calls
  return run
}

/** A staged read that answers with a payload. */
function read(payload) {
  return { status: 0, stdout: JSON.stringify(payload), stderr: '' }
}

/** A command runner that could not start. */
function throwingRunner() {
  throw new Error('the runner could not start')
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
        { id: 'd_2', status: 'success', createdAt: '2026-10-20T00:00:00Z' },
        { id: 'd_1', status: 'error', createdAt: '2026-10-19T00:00:00Z' },
      ],
    }),
  }
}

/** The codes of the refusals a plan carries. */
function codes(plan) {
  return plan.refusals.map((refusal) => refusal.code)
}

describe('the Railway production source plan', () => {
  test('plans the production source when the declaration, the read and the history agree', () => {
    const run = fakeRunner(healthyReads())
    const plan = planProductionDeployment({ source: declaration, run })

    expect(plan.verdict).toBe('planned')
    expect(plan.refusals).toEqual([])
    expect(plan.target).toEqual(observedTarget)
    expect(plan.deployment).toEqual(observedDeployment)
    expect(plan.history.count).toBe(2)
    expect(run.calls.map((call) => call.kind)).toEqual(['status', 'deployments'])
    expect(run.calls[0].command).toEqual([...LIVE_READS.status.command])
  })

  test('refuses a declaration that names no production target', () => {
    const plan = planProductionDeployment({
      source: { ...declaration, targets: [] },
      run: fakeRunner(healthyReads()),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.targetMissing)
  })

  test('refuses a declaration that names more than one production target', () => {
    const plan = planProductionDeployment({
      source: {
        ...declaration,
        targets: [
          { project: 'adea', service: 'auth', environment: 'production' },
          { project: 'adea', service: 'web', environment: 'production' },
        ],
      },
      run: fakeRunner(healthyReads()),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.targetAmbiguous)
    const refusal = plan.refusals.find((entry) => entry.code === REFUSAL_CODES.targetAmbiguous)
    expect(refusal.evidence.candidates).toHaveLength(2)
  })

  test('refuses a live read that names more than one production target', () => {
    const reads = healthyReads()
    reads.status = read({
      targets: [observedTarget, { project: 'adea', service: 'web', environment: 'production' }],
      deployment: observedDeployment,
    })

    const plan = planProductionDeployment({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.targetAmbiguous)
    const refusal = plan.refusals.find((entry) => entry.code === REFUSAL_CODES.targetAmbiguous)
    expect(refusal.evidence.candidates).toHaveLength(2)
  })

  test('refuses a live read that names no production target', () => {
    const reads = healthyReads()
    reads.status = read({ targets: [], deployment: observedDeployment })

    const plan = planProductionDeployment({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.targetMissing)
  })

  test('refuses a live target that contradicts the declared target', () => {
    const reads = healthyReads()
    reads.status = read({
      targets: [{ project: 'adea', service: 'web', environment: 'production' }],
      deployment: observedDeployment,
    })

    const plan = planProductionDeployment({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.targetContradictory)
    const refusal = plan.refusals.find((entry) => entry.code === REFUSAL_CODES.targetContradictory)
    expect(refusal.evidence.field).toBe('service')
    expect(refusal.evidence.expected).toBe('auth')
    expect(refusal.evidence.observed).toBe('web')
  })

  test('refuses a live target outside the declared production environment', () => {
    const reads = healthyReads()
    reads.status = read({
      targets: [{ project: 'adea', service: 'auth', environment: 'staging' }],
      deployment: observedDeployment,
    })

    const plan = planProductionDeployment({
      // The candidate pins the project and the service, and both agree. The
      // environment is the declaration's own rule, and the live target is not
      // in it, so the refusal comes from the rule and not from the candidate.
      source: { ...declaration, targets: [{ project: 'adea', service: 'auth' }] },
      run: fakeRunner(reads),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.targetContradictory)
    const refusal = plan.refusals.find((entry) => entry.code === REFUSAL_CODES.targetContradictory)
    expect(refusal.evidence.field).toBe('environment')
    expect(refusal.evidence.expected).toBe('production')
    expect(refusal.evidence.observed).toBe('staging')
  })

  test('refuses a deployment that does not publish the required metadata', () => {
    const reads = healthyReads()
    const { imageDigest: _omitted, ...withoutDigest } = observedDeployment
    reads.status = read({ targets: [observedTarget], deployment: withoutDigest })

    const plan = planProductionDeployment({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.metadataMissing)
    const refusal = plan.refusals.find((entry) => entry.code === REFUSAL_CODES.metadataMissing)
    expect(refusal.evidence.field).toBe('imageDigest')
  })

  test('refuses a deployment that contradicts the pinned metadata', () => {
    const reads = healthyReads()
    reads.status = read({
      targets: [observedTarget],
      deployment: { ...observedDeployment, release: 'v0.99.0-dev.487' },
    })

    const plan = planProductionDeployment({
      source: { ...declaration, pinnedMetadata: { release: 'v0.99.0-dev.488' } },
      run: fakeRunner(reads),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.metadataContradictory)
    const refusal = plan.refusals.find(
      (entry) => entry.code === REFUSAL_CODES.metadataContradictory
    )
    expect(refusal.evidence).toEqual({
      field: 'release',
      expected: 'v0.99.0-dev.488',
      observed: 'v0.99.0-dev.487',
    })
  })

  test('refuses a stopped deployment history', () => {
    const reads = healthyReads()
    reads.deployments = read({
      deployments: [{ id: 'd_3', status: 'stopped', createdAt: '2026-10-21T00:00:00Z' }],
    })

    const plan = planProductionDeployment({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.historyUnhealthy)
    const refusal = plan.refusals.find((entry) => entry.code === REFUSAL_CODES.historyUnhealthy)
    expect(refusal.evidence.status).toBe('stopped')
    expect(refusal.evidence.healthy).toEqual([...HEALTHY_DEPLOYMENT_STATUSES])
  })

  test('refuses an errored deployment history', () => {
    const reads = healthyReads()
    reads.deployments = read({
      deployments: [{ id: 'd_3', status: 'error', createdAt: '2026-10-21T00:00:00Z' }],
    })

    const plan = planProductionDeployment({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.historyUnhealthy)
    const refusal = plan.refusals.find((entry) => entry.code === REFUSAL_CODES.historyUnhealthy)
    expect(refusal.evidence.status).toBe('error')
  })

  test('refuses an empty deployment history', () => {
    const reads = healthyReads()
    reads.deployments = read({ deployments: [] })

    const plan = planProductionDeployment({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.historyMissing)
  })

  test('refuses a command that fails', () => {
    const reads = healthyReads()
    reads.status = { status: 1, stdout: '', stderr: 'the target does not exist' }

    const plan = planProductionDeployment({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.commandFailed)
    const refusal = plan.refusals.find((entry) => entry.code === REFUSAL_CODES.commandFailed)
    expect(refusal.evidence.kind).toBe('status')
    expect(refusal.evidence.exitStatus).toBe(1)
  })

  test('refuses a command that times out', () => {
    const reads = healthyReads()
    reads.deployments = { status: 0, stdout: '', stderr: '', timedOut: true }

    const plan = planProductionDeployment({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.commandTimedOut)
    const refusal = plan.refusals.find((entry) => entry.code === REFUSAL_CODES.commandTimedOut)
    expect(refusal.evidence.kind).toBe('deployments')
    expect(refusal.evidence.timeoutMs).toBeGreaterThan(0)
  })

  test('refuses a command runner that throws', () => {
    const plan = planProductionDeployment({ source: declaration, run: throwingRunner })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.commandFailed)
    const refusal = plan.refusals.find((entry) => entry.code === REFUSAL_CODES.commandFailed)
    expect(refusal.evidence.reason).toBe('the runner threw')
  })

  test('refuses a live read that is not JSON', () => {
    const reads = healthyReads()
    reads.status = { status: 0, stdout: 'not json at all', stderr: '' }

    const plan = planProductionDeployment({ source: declaration, run: fakeRunner(reads) })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toContain(REFUSAL_CODES.readUnparsable)
  })

  test('refuses a plan that has no command runner', () => {
    const plan = planProductionDeployment({ source: declaration })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.commandRunnerUnavailable])
  })

  test('refuses a declaration that is not shaped as one', () => {
    const plan = planProductionDeployment({
      source: { environment: 'production', targets: 'auth' },
      run: fakeRunner(healthyReads()),
    })

    expect(plan.verdict).toBe('refused')
    expect(codes(plan)).toEqual([REFUSAL_CODES.sourceInvalid])
    const refusal = plan.refusals[0]
    expect(refusal.evidence.field).toBe('targets')
  })

  test('refuses a repository that declares no production source', () => {
    const declarationRead = readProductionSource(resolve(root, 'docs'))

    expect(declarationRead.source).toBeNull()
    expect(declarationRead.refusal.code).toBe(REFUSAL_CODES.sourceUnreadable)
  })

  test('reads the repository’s own declaration and plans against it', () => {
    const declarationRead = readProductionSource(root)

    expect(declarationRead.refusal).toBeNull()
    expect(declarationRead.source.environment).toBe('production')
    expect(declarationRead.source.targets).toHaveLength(1)
    expect(declarationRead.source.requiredMetadata).toContain('imageDigest')
    expect(declarationRead.source.pinnedMetadata).toEqual({})

    const plan = planProductionDeployment({ root, run: fakeRunner(healthyReads()) })
    expect(plan.verdict).toBe('planned')
  })

  test('the same input always produces the same plan and the same evidence', () => {
    const first = planProductionDeployment({
      source: declaration,
      run: fakeRunner(healthyReads()),
    })
    const second = planProductionDeployment({
      source: declaration,
      run: fakeRunner(healthyReads()),
    })

    expect(second).toEqual(first)
  })

  test('the refusal evidence digest covers the refusal and is stable', () => {
    const reads = healthyReads()
    reads.deployments = read({
      deployments: [{ id: 'd_3', status: 'stopped', createdAt: '2026-10-21T00:00:00Z' }],
    })

    const plan = planProductionDeployment({ source: declaration, run: fakeRunner(reads) })
    const refusal = plan.refusals[0]

    expect(refusal.evidenceDigest).toBe(refusalEvidenceDigest(refusal))
    expect(refusal.evidenceDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(
      planProductionDeployment({ source: declaration, run: fakeRunner(healthyReads()) }).refusals
    ).toEqual([])
  })

  test('two refusals with the same code and different evidence have different digests', () => {
    const stopped = healthyReads()
    stopped.deployments = read({
      deployments: [{ id: 'd_3', status: 'stopped', createdAt: '2026-10-21T00:00:00Z' }],
    })
    const errored = healthyReads()
    errored.deployments = read({
      deployments: [{ id: 'd_3', status: 'error', createdAt: '2026-10-21T00:00:00Z' }],
    })

    const stoppedRefusal = planProductionDeployment({
      source: declaration,
      run: fakeRunner(stopped),
    }).refusals[0]
    const erroredRefusal = planProductionDeployment({
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
