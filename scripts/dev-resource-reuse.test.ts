import { describe, expect, test } from 'bun:test'

import {
  ELIGIBILITY,
  REUSE_DECISION,
  REUSE_REFUSAL,
  concurrencyAdmission,
  diskTelemetry,
  eligibilityReport,
  inventoryOwnedResources,
  planWorktreeReuse,
  preservationProof,
  reuseDiskAdmission,
} from './dev-resource-reuse.mjs'
import {
  DISK_PRESSURE,
  LEASE_STATE,
  RESOURCE_DISPOSITION,
  RESOURCE_KIND,
  RESOURCE_MODE,
  resourceIdentity,
} from './integration-resource-lease.mjs'

const identity = resourceIdentity({
  mode: RESOURCE_MODE.disposable,
  runToken: 'run-a',
  port: 40_001,
})

const otherIdentity = resourceIdentity({
  mode: RESOURCE_MODE.disposable,
  runToken: 'run-b',
  port: 40_002,
})

function lease({
  runId = 'run-a',
  leaseIdentity = identity,
  pid = 4242,
  hostname = 'host-a',
  state = 'claimed',
}: {
  runId?: string
  leaseIdentity?: ReturnType<typeof resourceIdentity>
  pid?: number
  hostname?: string
  state?: string
} = {}) {
  return {
    version: 1,
    runId,
    mode: RESOURCE_MODE.disposable,
    identity: leaseIdentity,
    owner: { pid, hostname, startedAt: '2026-10-21T00:00:00.000Z' },
    state,
    createdAt: 0,
    updatedAt: 0,
    cleanup: null,
  }
}

const alive = () => true
const dead = () => false

describe('the owned-resource inventory', () => {
  test('a resource this run created and whose owner is gone is reclaimable', () => {
    const inventory = inventoryOwnedResources({
      runId: 'run-a',
      identity,
      leases: [lease()],
      dockerResources: [
        { kind: RESOURCE_KIND.container, name: identity.container, label: identity.project },
        { kind: RESOURCE_KIND.volume, name: identity.volume, label: identity.project },
      ],
      isProcessAlive: dead,
    })
    expect(inventory.summary).toEqual({ total: 2, reclaimable: 2, protected: 0 })
    expect(inventory.resources[0]?.leaseState).toBe(LEASE_STATE.stale)
  })

  test('a resource a live run still holds is protected', () => {
    const inventory = inventoryOwnedResources({
      runId: 'run-a',
      identity,
      leases: [lease()],
      dockerResources: [
        { kind: RESOURCE_KIND.container, name: identity.container, label: identity.project },
      ],
      isProcessAlive: alive,
    })
    expect(inventory.summary).toEqual({ total: 1, reclaimable: 0, protected: 1 })
    expect(inventory.resources[0]?.reason).toContain('live run')
  })

  test("another run's resource is protected", () => {
    const inventory = inventoryOwnedResources({
      runId: 'run-a',
      identity,
      leases: [lease({ runId: 'run-b', leaseIdentity: otherIdentity })],
      dockerResources: [
        {
          kind: RESOURCE_KIND.container,
          name: otherIdentity.container,
          label: otherIdentity.project,
        },
      ],
      isProcessAlive: dead,
    })
    expect(inventory.summary.reclaimable).toBe(0)
    expect(inventory.resources[0]?.disposition).toBe(RESOURCE_DISPOSITION.protected)
  })

  test('an unlabelled resource has an unknown owner and is protected', () => {
    const inventory = inventoryOwnedResources({
      runId: 'run-a',
      identity,
      leases: [],
      dockerResources: [{ kind: RESOURCE_KIND.volume, name: 'orphan-volume', label: null }],
      isProcessAlive: dead,
    })
    expect(inventory.summary).toEqual({ total: 1, reclaimable: 0, protected: 1 })
    expect(inventory.resources[0]?.reason).toContain('unattached volume')
  })

  test("this run's label without a lease is not an ownership proof", () => {
    const inventory = inventoryOwnedResources({
      runId: 'run-a',
      identity,
      leases: [],
      dockerResources: [
        { kind: RESOURCE_KIND.container, name: identity.container, label: identity.project },
      ],
      isProcessAlive: dead,
    })
    expect(inventory.summary.reclaimable).toBe(0)
    expect(inventory.resources[0]?.reason).toContain('lease')
  })
})

describe('stale-worktree reuse', () => {
  const worktree = {
    path: '/tmp/worktrees/stale-one',
    head: 'abc123',
    branch: 'codex/example',
    localChanges: false,
    published: true,
  }
  const freshOrigin = { fresh: true, containsHead: true }

  test('a clean checkout with a fresh origin and no owner is reused', () => {
    const plan = planWorktreeReuse({ worktree, origin: freshOrigin, leases: [] })
    expect(plan.decision).toBe(REUSE_DECISION.reuse)
    expect(plan.evidence).toMatchObject({
      localWork: false,
      originFresh: true,
      headInOrigin: true,
      published: true,
      ownerLive: false,
    })
  })

  test('local work is never overwritten', () => {
    const plan = planWorktreeReuse({
      worktree: { ...worktree, localChanges: true },
      origin: freshOrigin,
      leases: [],
    })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.localWork)
    expect(plan.reason).toContain('local work')
  })

  test('an origin that does not contain the checkout head is refused', () => {
    const plan = planWorktreeReuse({
      worktree,
      origin: { fresh: true, containsHead: false },
      leases: [],
    })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.originStale)
  })

  test('an unpublished checkout is refused even when it is clean and fresh', () => {
    const plan = planWorktreeReuse({
      worktree: { ...worktree, published: false },
      origin: freshOrigin,
      leases: [],
    })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.unpublished)
  })

  test('a checkout a live owner holds is refused', () => {
    const plan = planWorktreeReuse({
      worktree,
      origin: freshOrigin,
      leases: [{ ...lease(), identity: { ...identity, worktree: worktree.path } }],
      isProcessAlive: alive,
    })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.owned)
  })

  test('a checkout that cannot be read is refused', () => {
    const plan = planWorktreeReuse({ worktree: { path: '' }, origin: freshOrigin })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.uncertain)
  })
})

describe('the dry-run eligibility report', () => {
  test('every item carries a decision, a reason and its evidence', () => {
    const report = eligibilityReport({
      resources: [
        {
          kind: RESOURCE_KIND.container,
          name: 'container-a',
          eligibility: ELIGIBILITY.ineligible,
          disposition: RESOURCE_DISPOSITION.protected,
          reason: 'the resource belongs to another project',
          evidence: { label: 'other', leaseRunId: null, leaseState: LEASE_STATE.foreign },
        },
      ],
      worktrees: [
        {
          path: '/tmp/worktrees/one',
          plan: planWorktreeReuse({
            worktree: {
              path: '/tmp/worktrees/one',
              head: 'abc',
              branch: 'b',
              localChanges: false,
              published: true,
            },
            origin: { fresh: true, containsHead: true },
          }),
        },
      ],
      now: '2026-10-21T00:00:00.000Z',
    })
    expect(report.summary).toEqual({
      resources: 1,
      eligibleResources: 0,
      worktrees: 1,
      eligibleWorktrees: 1,
      preserved: 1,
    })
    expect(report.resources[0]?.reason).toBeTruthy()
    expect(report.worktrees[0]?.reason).toBeTruthy()
    expect(report.worktrees[0]?.evidence).toMatchObject({ originFresh: true })
  })
})

describe('the preservation proof', () => {
  test('a protected item is never scheduled for reclamation', () => {
    const proof = preservationProof({
      resources: [
        {
          kind: RESOURCE_KIND.container,
          name: 'held',
          eligibility: ELIGIBILITY.ineligible,
          disposition: RESOURCE_DISPOSITION.protected,
          reason: 'held by a live run',
        },
      ],
      worktrees: [
        {
          path: '/tmp/worktrees/local',
          eligibility: ELIGIBILITY.ineligible,
          decision: REUSE_DECISION.refuse,
          reason: 'the checkout carries local work',
        },
      ],
    })
    expect(proof.ok).toBe(true)
    expect(proof.violations).toEqual([])
    expect(proof.preserved).toHaveLength(2)
  })

  test('a contradiction between the two answers is a reportable violation', () => {
    const proof = preservationProof({
      resources: [
        {
          kind: RESOURCE_KIND.volume,
          name: 'contradiction',
          eligibility: ELIGIBILITY.ineligible,
          disposition: RESOURCE_DISPOSITION.removable,
          reason: 'contradictory',
        },
      ],
    })
    expect(proof.ok).toBe(false)
    expect(proof.violations).toHaveLength(1)
  })
})

describe('disk telemetry and the concurrency bound', () => {
  test('the docker cache and the checkouts are reported separately', () => {
    const telemetry = diskTelemetry({
      dockerSystemDf: { totalBytes: 1_000, reclaimableBytes: 400 },
      dockerVolumes: [{ sizeBytes: 100 }],
      worktrees: [{ sizeBytes: 25 }],
    })
    expect(telemetry.docker).toMatchObject({
      totalBytes: 1_000,
      reclaimableBytes: 400,
      volumesBytes: 100,
      reported: true,
    })
    expect(telemetry.worktrees).toEqual({ count: 1, bytes: 25 })
    expect(telemetry.totalBytes).toBe(1_125)
  })

  test('a run is admitted only while the bound has room', () => {
    expect(concurrencyAdmission({ running: 0, limit: 1 }).admitted).toBe(true)
    expect(concurrencyAdmission({ running: 1, limit: 1 }).admitted).toBe(false)
    expect(concurrencyAdmission({ running: 2, limit: 1 }).reason).toContain('bound')
  })

  test('an unestablished bound refuses rather than admits', () => {
    expect(concurrencyAdmission({ running: 0, limit: 0 }).admitted).toBe(false)
    expect(concurrencyAdmission({ running: Number.NaN, limit: 1 }).admitted).toBe(false)
  })

  test('the disk admission uses the lane vocabulary', () => {
    expect(
      reuseDiskAdmission({ availableBytes: 1_000, requiredBytes: 500, limitBytes: 100 }).decision
    ).toBe(DISK_PRESSURE.admitted)
    expect(
      reuseDiskAdmission({ availableBytes: 10, requiredBytes: 500, limitBytes: 100 }).decision
    ).toBe(DISK_PRESSURE.refused)
  })
})

describe('the crash and restart regressions', () => {
  test('a run that died leaves a reclaimable resource behind', () => {
    const inventory = inventoryOwnedResources({
      runId: 'run-a',
      identity,
      leases: [lease()],
      dockerResources: [
        { kind: RESOURCE_KIND.container, name: identity.container, label: identity.project },
      ],
      isProcessAlive: dead,
    })
    expect(inventory.summary.reclaimable).toBe(1)
  })

  test('a restarted run does not reclaim what it cannot prove it owns', () => {
    const inventory = inventoryOwnedResources({
      runId: 'run-b',
      identity: otherIdentity,
      leases: [lease({ runId: 'run-a' })],
      dockerResources: [
        { kind: RESOURCE_KIND.container, name: identity.container, label: identity.project },
      ],
      isProcessAlive: dead,
    })
    expect(inventory.summary.reclaimable).toBe(0)
    expect(inventory.resources[0]?.disposition).toBe(RESOURCE_DISPOSITION.protected)
  })

  test('an unreadable lease is uncertain, so nothing is reclaimed', () => {
    const inventory = inventoryOwnedResources({
      runId: 'run-a',
      identity,
      leases: [{ version: 99, runId: 'run-a' }],
      dockerResources: [
        { kind: RESOURCE_KIND.container, name: identity.container, label: identity.project },
      ],
      isProcessAlive: dead,
    })
    expect(inventory.summary.reclaimable).toBe(0)
    expect(inventory.resources[0]?.leaseState).toBe(LEASE_STATE.uncertain)
  })

  test('a checkout whose owner crashed is reusable once its origin is fresh', () => {
    const plan = planWorktreeReuse({
      worktree: {
        path: '/tmp/worktrees/crashed',
        head: 'abc',
        branch: 'b',
        localChanges: false,
        published: true,
      },
      origin: { fresh: true, containsHead: true },
      leases: [
        {
          ...lease(),
          identity: { ...identity, worktree: '/tmp/worktrees/crashed' },
        },
      ],
      isProcessAlive: dead,
    })
    expect(plan.decision).toBe(REUSE_DECISION.reuse)
  })
})

describe('the concurrent owner regressions', () => {
  test('a resource held by a second live run is protected', () => {
    const inventory = inventoryOwnedResources({
      runId: 'run-a',
      identity,
      leases: [lease(), { ...lease({ runId: 'run-b', pid: 4343 }), identity }],
      dockerResources: [
        { kind: RESOURCE_KIND.container, name: identity.container, label: identity.project },
      ],
      isProcessAlive: alive,
    })
    expect(inventory.summary.reclaimable).toBe(0)
    expect(inventory.resources[0]?.reason).toContain('live run')
  })

  test('a checkout a second live owner holds is refused for reuse', () => {
    const plan = planWorktreeReuse({
      worktree: {
        path: '/tmp/worktrees/contended',
        head: 'abc',
        branch: 'b',
        localChanges: false,
        published: true,
      },
      origin: { fresh: true, containsHead: true },
      leases: [
        { ...lease(), identity: { ...identity, worktree: '/tmp/worktrees/contended' } },
        {
          ...lease({ runId: 'run-b', leaseIdentity: otherIdentity, pid: 4343 }),
          identity: { ...otherIdentity, worktree: '/tmp/worktrees/contended' },
        },
      ],
      isProcessAlive: alive,
    })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.owned)
  })

  test('two owners cannot both pass the concurrency bound', () => {
    expect(concurrencyAdmission({ running: 1, limit: 1 }).admitted).toBe(false)
  })
})
