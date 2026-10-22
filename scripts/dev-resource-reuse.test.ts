import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ELIGIBILITY,
  LIVENESS,
  REUSE_DECISION,
  REUSE_REFUSAL,
  boundedLivenessProbe,
  concurrencyAdmission,
  diskTelemetry,
  eligibilityReport,
  inventoryOwnedResources,
  isRegenerableIgnored,
  livenessOf,
  planWorktreeReuse,
  physicalPath,
  preservationProof,
  REGENERABLE_PROOF,
  regenerableKind,
  reuseDiskAdmission,
  unknownIgnoredPaths,
} from './dev-resource-reuse.mjs'
import {
  DISK_PRESSURE,
  LEASE_STATE,
  LEASE_VERSION,
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

/** A liveness probe that cannot answer. */
function failingProbe() {
  throw new Error('the probe could not run')
}

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

  test('every lease that names a resource is read, and one uncertain owner protects it', () => {
    // The first matching lease does not speak for the rest: a lease whose owner
    // cannot be established is an owner, and it protects the resource.
    const uncertain = {
      ...lease(),
      owner: { hostname: 'host-a', startedAt: '2026-10-21T00:00:00.000Z' },
    }
    const inventory = inventoryOwnedResources({
      runId: 'run-a',
      identity,
      leases: [lease(), uncertain],
      dockerResources: [
        { kind: RESOURCE_KIND.container, name: identity.container, label: identity.project },
      ],
      isProcessAlive: dead,
    })
    expect(inventory.summary.reclaimable).toBe(0)
    expect(inventory.resources[0]?.leaseState).toBe(LEASE_STATE.uncertain)
    expect(inventory.resources[0]?.leaseEvidence).toHaveLength(2)
  })

  test('a lease record that could not be read protects every resource', () => {
    const inventory = inventoryOwnedResources({
      runId: 'run-a',
      identity,
      leases: [lease()],
      unreadableLeases: ['broken.json'],
      dockerResources: [
        { kind: RESOURCE_KIND.container, name: identity.container, label: identity.project },
      ],
      isProcessAlive: dead,
    })
    expect(inventory.summary.reclaimable).toBe(0)
    expect(inventory.resources[0]?.reason).toContain('could not be read')
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
          // The inventory proved it reclaimable and the report called it
          // ineligible: the two answers cannot both be true.
          reclaimable: true,
          evidence: { leaseMatched: true },
        },
      ],
    })
    expect(proof.ok).toBe(false)
    expect(proof.violations).toHaveLength(1)
  })

  test('a removable disposition without a lease is a fail-closed case, not a contradiction', () => {
    const proof = preservationProof({
      resources: [
        {
          kind: RESOURCE_KIND.volume,
          name: 'unproven',
          eligibility: ELIGIBILITY.ineligible,
          disposition: RESOURCE_DISPOSITION.removable,
          reason: 'no lease of this run names the resource',
          reclaimable: false,
          evidence: { leaseMatched: false },
        },
      ],
    })
    expect(proof.ok).toBe(true)
    expect(proof.preserved).toHaveLength(1)
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

describe('the liveness of an owner', () => {
  test('an owner that names no host cannot be located, so it is not established', () => {
    const owner = { owner: { pid: 4242 } }
    const liveness = livenessOf(owner, { host: 'here', probe: () => false })
    expect(liveness.state).toBe(LIVENESS.notEstablished)
    expect(liveness.reason).toContain('no host')
    // The bounded probe answers "alive" for it, so the lease protects what it
    // may name: an owner that cannot be shown to be absent is an owner.
    const probe = boundedLivenessProbe({ host: 'here', probe: () => false })
    expect(probe(4242, undefined)).toBe(true)
    expect(probe(4242, '')).toBe(true)
  })

  test('an owner on another host is not established', () => {
    const liveness = livenessOf(
      { owner: { pid: 4242, hostname: 'elsewhere' } },
      { host: 'here', probe: () => false }
    )
    expect(liveness.state).toBe(LIVENESS.notEstablished)
    expect(liveness.reason).toContain('another host')
    const probe = boundedLivenessProbe({ host: 'here', probe: () => false })
    expect(probe(4242, 'elsewhere')).toBe(true)
  })

  test('a probe that fails leaves the owner unestablished', () => {
    const failing = failingProbe
    const liveness = livenessOf(
      { owner: { pid: 4242, hostname: 'here' } },
      { host: 'here', probe: failing }
    )
    expect(liveness.state).toBe(LIVENESS.notEstablished)
    expect(liveness.reason).toContain('probe failed')
    const probe = boundedLivenessProbe({ host: 'here', probe: failing })
    expect(probe(4242, 'here')).toBe(true)
  })

  test('a pid no process holds is an absent owner, not a dead one', () => {
    const liveness = livenessOf(
      { owner: { pid: 4242, hostname: 'here' } },
      { host: 'here', probe: () => false }
    )
    expect(liveness.state).toBe(LIVENESS.absent)
    expect(liveness.reason).toContain('no process holds the recorded pid')
    expect(liveness.reason).not.toContain('gone')
    const probe = boundedLivenessProbe({ host: 'here', probe: () => false })
    expect(probe(4242, 'here')).toBe(false)
  })

  test('a process that holds the recorded pid is present', () => {
    const liveness = livenessOf(
      { owner: { pid: 4242, hostname: 'here' } },
      { host: 'here', probe: () => true }
    )
    expect(liveness.state).toBe(LIVENESS.present)
  })

  test('a lease whose owner names no host protects what it may name', () => {
    const plan = planWorktreeReuse({
      worktree: {
        path: '/tmp/worktrees/no-host',
        head: 'abc',
        branch: 'b',
        localChanges: false,
        published: true,
        ignoredUnknown: [],
        origin: { fresh: true, containsHead: true },
      },
      leases: [
        {
          version: LEASE_VERSION,
          runId: 'run-a',
          identity: { label: 'label-a', worktree: '/tmp/worktrees/no-host' },
          owner: { pid: 4242 },
        },
      ],
      isProcessAlive: boundedLivenessProbe({ host: 'here', probe: () => false }),
      host: 'here',
      probe: () => false,
    })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.owned)
    expect(plan.evidence.matchingLeases[0]?.liveness?.state).toBe(LIVENESS.notEstablished)
  })
})

describe('the ignored paths a checkout holds', () => {
  test('an ignored path is regenerable only when its content is accounted for', () => {
    // The proof is about the bytes, not the name. Nothing is regenerable
    // without one.
    expect(isRegenerableIgnored('node_modules/')).toBe(false)
    expect(isRegenerableIgnored('apps/web/dist/')).toBe(false)
    expect(isRegenerableIgnored('apps/web/cloudflare-env.d.ts')).toBe(false)
    expect(isRegenerableIgnored('apps/web/public/assets/logo.png')).toBe(false)

    // A path that holds nothing has nothing to reproduce.
    expect(isRegenerableIgnored('node_modules/', { kind: REGENERABLE_PROOF.empty })).toBe(true)
    expect(isRegenerableIgnored('apps/web/dist/', { kind: REGENERABLE_PROOF.empty })).toBe(true)
    // A rebuild in an isolated copy that reproduced exactly those bytes.
    expect(isRegenerableIgnored('apps/web/dist/', { kind: REGENERABLE_PROOF.contentMatch })).toBe(
      true
    )
    // A name that resembles a build output is not a proof of anything.
    expect(isRegenerableIgnored('apps/web/dist/', { kind: 'build_output' })).toBe(false)
    expect(isRegenerableIgnored('apps/web/dist/', { kind: 'dependency_tree' })).toBe(false)
    expect(isRegenerableIgnored('tsconfig.tsbuildinfo', { kind: 'build_output' })).toBe(false)
  })

  test('local persisted state is never regenerable output', () => {
    // `.wrangler` holds the local state of a development runtime. No proof
    // makes it build output, so it is content the checkout holds.
    expect(isRegenerableIgnored('.wrangler/', { kind: REGENERABLE_PROOF.empty })).toBe(true)
    expect(
      isRegenerableIgnored('.wrangler/state/v3/do/resource', { kind: REGENERABLE_PROOF.empty })
    ).toBe(true)
    // It is never regenerable on the strength of what it looks like either.
    expect(regenerableKind('.wrangler/state/v3/do/resource')).toBe(null)
  })

  test('an ignored path that is not proven reproducible is content the checkout holds', () => {
    expect(isRegenerableIgnored('docs/evals/calibration-verdicts/grader-verdicts.json')).toBe(false)
    expect(isRegenerableIgnored('apps/web/start/.checks/fixture/loopback-key.pem')).toBe(false)
    // Without proofs, nothing is regenerable: the paths are content the
    // checkout holds.
    expect(unknownIgnoredPaths(['node_modules/', 'docs/evals/verdicts.json'])).toEqual([
      'node_modules/',
      'docs/evals/verdicts.json',
    ])
    // With a content-bound proof, that one path is not content.
    expect(
      unknownIgnoredPaths(['node_modules/', 'docs/evals/verdicts.json'], {
        'node_modules/': { kind: REGENERABLE_PROOF.contentMatch, digest: 'abc' },
      })
    ).toEqual(['docs/evals/verdicts.json'])
    // A path that only resembles a build output is still content.
    expect(
      unknownIgnoredPaths(['node_modules/', 'docs/evals/verdicts.json'], {
        'node_modules/': { kind: 'build_output' },
      })
    ).toEqual(['node_modules/', 'docs/evals/verdicts.json'])
  })

  test('an ignored list that could not be read is not an empty one', () => {
    const plan = planWorktreeReuse({
      worktree: {
        path: '/tmp/worktrees/unreadable-ignored',
        head: 'abc',
        branch: 'b',
        localChanges: false,
        published: true,
        ignoredUnknown: [],
        ignoredUnreadable: true,
        origin: { fresh: true, containsHead: true },
      },
      leases: [],
    })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.unreadableIgnored)
    expect(plan.evidence.ignoredUnreadable).toBe(true)
  })

  test('a lease record that could not be read protects every checkout', () => {
    const plan = planWorktreeReuse({
      worktree: {
        path: '/tmp/worktrees/lease-evidence',
        head: 'abc',
        branch: 'b',
        localChanges: false,
        published: true,
        ignoredUnknown: [],
        origin: { fresh: true, containsHead: true },
      },
      leases: [],
      unreadableLeases: ['broken.json'],
    })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.uncertainLeaseEvidence)
    expect(plan.evidence.unreadableLeaseRecords).toEqual(['broken.json'])
  })

  test('a lease scan that failed protects every checkout', () => {
    const plan = planWorktreeReuse({
      worktree: {
        path: '/tmp/worktrees/lease-scan',
        head: 'abc',
        branch: 'b',
        localChanges: false,
        published: true,
        ignoredUnknown: [],
        origin: { fresh: true, containsHead: true },
      },
      leases: [],
      leaseScanFailed: true,
    })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.uncertainLeaseEvidence)
    expect(plan.evidence.leaseScanFailed).toBe(true)
  })

  test('a checkout that holds an ignored artifact is not free to reuse', () => {
    const plan = planWorktreeReuse({
      worktree: {
        path: '/tmp/worktrees/ignored',
        head: 'abc',
        branch: 'b',
        localChanges: false,
        published: true,
        ignoredUnknown: ['docs/evals/calibration-verdicts/grader-verdicts.json'],
        origin: { fresh: true, containsHead: true },
      },
      leases: [],
    })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.unknownIgnored)
    expect(plan.evidence.ignoredUnknown).toHaveLength(1)
  })
})

describe('the origin facts travel with the checkout', () => {
  const worktree = {
    path: '/tmp/worktrees/verified',
    head: 'abc',
    branch: 'b',
    localChanges: false,
    published: true,
    origin: { fresh: true, containsHead: true },
  }

  test('a verified origin is read from the checkout when none is passed', () => {
    const plan = planWorktreeReuse({ worktree, leases: [] })
    expect(plan.decision).toBe(REUSE_DECISION.reuse)
    expect(plan.evidence.originFresh).toBe(true)
    expect(plan.evidence.headInOrigin).toBe(true)
  })

  test('a checkout with no verified origin is refused', () => {
    const plan = planWorktreeReuse({
      worktree: { ...worktree, origin: { fresh: false, containsHead: false } },
      leases: [],
    })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.originStale)
  })
})

describe('every lease that names a checkout is read', () => {
  const worktree = {
    path: '/tmp/worktrees/contended',
    head: 'abc',
    branch: 'b',
    localChanges: false,
    published: true,
    origin: { fresh: true, containsHead: true },
  }
  const named = (runId, pid) => ({
    ...lease({ runId, pid }),
    identity: { ...identity, worktree: worktree.path },
  })

  test('a stale lease does not speak for a live one that follows it', () => {
    const plan = planWorktreeReuse({
      worktree,
      leases: [named('run-stale', 1111), named('run-live', 2222)],
      isProcessAlive: (pid) => pid === 2222,
    })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.owned)
    expect(plan.evidence.matchingLeases.map((entry) => entry.state)).toEqual([
      LEASE_STATE.stale,
      LEASE_STATE.active,
    ])
  })

  test('an owner whose state cannot be established is an owner, not an absence', () => {
    const plan = planWorktreeReuse({
      worktree,
      leases: [
        {
          version: 99,
          runId: 'run-unreadable',
          identity: { ...identity, worktree: worktree.path },
        },
      ],
      isProcessAlive: () => true,
    })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.uncertainOwner)
  })

  test('a shared or unknown scope is preserved and never authorises anything', () => {
    const plan = planWorktreeReuse({
      worktree,
      leases: [{ ...lease({ runId: 'run-shared' }), identity: { ...identity, worktree: null } }],
      isProcessAlive: () => true,
    })
    expect(plan.evidence.preservedScopes).toHaveLength(1)
    expect(plan.evidence.preservedScopes[0]?.scope).toBeNull()
    expect(plan.decision).toBe(REUSE_DECISION.reuse)
  })
})

/**
 * A checkout that is clean, published, and carries a verified origin: the only
 * question left for the planner is who owns it.
 */
const checkoutWorktree = (path: string) => ({
  path,
  head: 'abc',
  branch: 'b',
  localChanges: false,
  published: true,
  origin: { fresh: true, containsHead: true },
})

/**
 * A plan for a checkout that is clean, published, and carries a verified
 * origin, held by one owner recorded at `leasePath`. The owner is present
 * wherever its lease is filed, so the only question the planner answers is
 * whether that lease is read as naming this checkout.
 */
const planWithOwnerAt = (worktreePath: string, leasePath: string) =>
  planWorktreeReuse({
    worktree: checkoutWorktree(worktreePath),
    leases: [
      {
        ...lease({ runId: 'run-live', pid: 2222 }),
        identity: { ...identity, worktree: leasePath },
      },
    ],
    isProcessAlive: () => true,
  })

/**
 * A checkout is identified by where it physically is, not by how it is spelled.
 *
 * The regression this covers is a live-ownership bypass: `/tmp` is a symlink
 * into `/private/tmp` on macOS, so one lease can record a checkout under one
 * spelling while `git worktree list` reports the other. A literal comparison
 * answers "a different scope", files the live owner away as somebody else's,
 * and reports the checkout it holds as reusable. The lease is the ownership
 * proof, so the comparison has to be made on the physical identity.
 */
describe('a checkout is identified by where it is, not by how it is spelled', () => {
  let root: string
  let checkout: string
  let alias: string
  let loop: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'adea-reuse-alias-'))
    checkout = join(root, 'checkout')
    mkdirSync(checkout)
    // A second spelling of the same directory. The checkout also carries the
    // host's own alias when there is one: on macOS `tmpdir()` is
    // `/var/folders/...`, whose physical location is `/private/var/folders/...`.
    alias = join(root, 'alias-checkout')
    symlinkSync(checkout, alias)
    // A path whose physical identity cannot be established at all: a symlink
    // that follows itself. Resolving it fails, so it must never be treated as
    // proof that a scope differs from this checkout.
    loop = join(root, 'loop')
    symlinkSync(loop, loop)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('two spellings of one directory are one physical identity', () => {
    expect(physicalPath(checkout)).not.toBeNull()
    expect(physicalPath(checkout)).toBe(physicalPath(alias))
  })

  test('an owner recorded under another spelling of the checkout still holds it', () => {
    const plan = planWithOwnerAt(checkout, alias)
    expect(plan.evidence.matchingLeases.map((entry) => entry.state)).toEqual([LEASE_STATE.active])
    expect(plan.evidence.preservedScopes).toHaveLength(0)
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.owned)
  })

  test('a checkout named by its alias is still the checkout an owner holds', () => {
    const plan = planWithOwnerAt(alias, checkout)
    expect(plan.evidence.matchingLeases).toHaveLength(1)
    expect(plan.evidence.preservedScopes).toHaveLength(0)
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.owned)
  })

  test('an owner recorded under the host path git reports still holds the checkout', () => {
    // What `git worktree list` reports is the physical path. A lease written
    // with the path the caller was handed may be the unaliased spelling of it.
    const plan = planWithOwnerAt(realpathOf(checkout), checkout)
    expect(plan.evidence.matchingLeases).toHaveLength(1)
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.owned)
  })

  test('a scope that cannot be located is not set aside as another scope', () => {
    const plan = planWorktreeReuse({
      worktree: checkoutWorktree(checkout),
      leases: [
        {
          ...lease({ runId: 'run-unlocatable' }),
          identity: { ...identity, worktree: loop },
        },
      ],
      isProcessAlive: () => true,
    })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toContain(REUSE_REFUSAL.unresolvedLeaseScope)
    expect(plan.evidence.unresolvedLeaseScopes.map((entry) => entry.scope)).toEqual([loop])
    // It authorises nothing and it blocks: it is not filed away as another
    // checkout's scope, and it is not mistaken for an absent owner.
    expect(plan.evidence.preservedScopes).toHaveLength(0)
    expect(plan.evidence.matchingLeases).toHaveLength(0)
  })

  test('a checkout whose own location cannot be established is refused', () => {
    const plan = planWorktreeReuse({
      worktree: checkoutWorktree(loop),
      leases: [],
    })
    expect(plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan.reasons).toEqual([REUSE_REFUSAL.uncertain])
  })
})

/** A path's physical identity, for a checkout that exists on disk. */
function realpathOf(path: string) {
  return physicalPath(path) ?? path
}

describe('the report carries the ownership evidence end to end', () => {
  test('a removable disposition without a matching lease is not eligible', () => {
    const inventory = inventoryOwnedResources({
      runId: 'run-a',
      identity,
      leases: [],
      dockerResources: [
        { kind: RESOURCE_KIND.container, name: identity.container, label: identity.project },
      ],
      isProcessAlive: dead,
    })
    expect(inventory.resources[0]?.disposition).toBe(RESOURCE_DISPOSITION.removable)
    expect(inventory.resources[0]?.reclaimable).toBe(false)

    const report = eligibilityReport({ resources: inventory.resources })
    expect(report.resources[0]?.eligibility).toBe(ELIGIBILITY.ineligible)
    expect(report.resources[0]?.reclaimable).toBe(false)
    expect(report.resources[0]?.evidence.leaseMatched).toBe(false)
    expect(report.summary.eligibleResources).toBe(0)
  })

  test('a resource the inventory proved reclaimable is eligible and carries the lease', () => {
    const inventory = inventoryOwnedResources({
      runId: 'run-a',
      identity,
      leases: [lease()],
      dockerResources: [
        { kind: RESOURCE_KIND.container, name: identity.container, label: identity.project },
      ],
      isProcessAlive: dead,
    })
    const report = eligibilityReport({ resources: inventory.resources })
    expect(report.resources[0]?.eligibility).toBe(ELIGIBILITY.eligible)
    expect(report.resources[0]?.reclaimable).toBe(true)
    expect(report.resources[0]?.evidence.leaseMatched).toBe(true)
    expect(report.resources[0]?.evidence.leaseEvidence).toHaveLength(1)
  })
})

describe('the preservation proof examines every item', () => {
  test('an eligible resource that contradicts its own evidence is a violation', () => {
    const proof = preservationProof({
      resources: [
        {
          kind: RESOURCE_KIND.volume,
          name: 'contradiction',
          eligibility: ELIGIBILITY.eligible,
          disposition: RESOURCE_DISPOSITION.protected,
          reason: 'contradictory',
          reclaimable: false,
          evidence: { leaseMatched: false },
        },
      ],
    })
    expect(proof.ok).toBe(false)
    expect(proof.violations.length).toBeGreaterThan(0)
  })

  test('an eligible checkout without a verified origin is a violation', () => {
    const proof = preservationProof({
      worktrees: [
        {
          path: '/tmp/worktrees/eligible',
          eligibility: ELIGIBILITY.eligible,
          decision: REUSE_DECISION.reuse,
          reason: 'stated',
          evidence: { originFresh: false, ownerLive: false },
        },
      ],
    })
    expect(proof.ok).toBe(false)
  })

  test('a consistent report proves nothing protected was scheduled', () => {
    const proof = preservationProof({
      resources: [
        {
          kind: RESOURCE_KIND.container,
          name: 'held',
          eligibility: ELIGIBILITY.ineligible,
          disposition: RESOURCE_DISPOSITION.protected,
          reason: 'held by a live run',
          reclaimable: false,
          evidence: { leaseMatched: true },
        },
      ],
      worktrees: [
        {
          path: '/tmp/worktrees/local',
          eligibility: ELIGIBILITY.ineligible,
          decision: REUSE_DECISION.refuse,
          reason: 'the checkout carries local work',
          evidence: { originFresh: true, ownerLive: false },
        },
      ],
    })
    expect(proof.ok).toBe(true)
    expect(proof.preserved).toHaveLength(2)
  })
})

describe('the end-to-end report', () => {
  test('an unproven resource and a dirty checkout are both preserved', () => {
    const inventory = inventoryOwnedResources({
      runId: 'run-a',
      identity,
      leases: [],
      dockerResources: [
        { kind: RESOURCE_KIND.container, name: identity.container, label: identity.project },
      ],
      isProcessAlive: dead,
    })
    const report = eligibilityReport({
      resources: inventory.resources,
      worktrees: [
        {
          path: '/tmp/worktrees/dirty',
          head: 'abc',
          branch: 'b',
          localChanges: true,
          published: true,
          ignoredUnknown: ['docs/evals/verdicts.json'],
          origin: { fresh: true, containsHead: true },
        },
      ],
    })
    const proof = preservationProof({
      resources: report.resources,
      worktrees: report.worktrees,
    })
    expect(report.summary.eligibleResources).toBe(0)
    expect(report.summary.eligibleWorktrees).toBe(0)
    expect(report.summary.preserved).toBe(2)
    expect(proof.ok).toBe(true)
    expect(report.worktrees[0]?.reasons).toContain(REUSE_REFUSAL.localWork)
    expect(report.worktrees[0]?.reasons).toContain(REUSE_REFUSAL.unknownIgnored)
  })
})
