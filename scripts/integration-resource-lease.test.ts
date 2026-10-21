import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
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
import { join } from 'node:path'

import {
  CLEANUP_DECISION,
  CLEANUP_REFUSAL,
  CLAIM_STATE,
  scanLeases,
  DISK_PRESSURE,
  LEASE_STATE,
  RESOURCE_DISPOSITION,
  RESOURCE_MODE,
  callerIdentity,
  claimResource,
  claimSharedResource,
  buildInventory,
  classifyClaim,
  classifyDockerResource,
  isLeaseRecord,
  classifyLease,
  cleanupReceipt,
  createRunToken,
  currentOwner,
  deriveDisposablePort,
  diskPressureAdmission,
  leaseDirectory,
  leasePath,
  listLeases,
  planCleanup,
  processIsAlive,
  pruneSettledLeases,
  readLease,
  reconcileLeases,
  releaseLease,
  releaseSharedResource,
  resolveResourceMode,
  resourceIdentity,
  runTokenFor,
  summariseReceipt,
} from './integration-resource-lease.mjs'

// The lease model is exercised entirely with synthetic state. No test here
// creates a container, a volume, a database or a worktree: the model decides
// what may be done to a resource, and the decision is what is under test.
//
// Every directory the tests write to is created by the test, labelled with the
// test's own run id, and removed by the test that created it. Nothing here
// touches a resource the repository did not create for this purpose.

const directories: string[] = []

function leaseDirectoryForTest(): string {
  const directory = mkdtempSync(join(tmpdir(), 'adea-lease-model-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true })
  }
})

const owner = { pid: 4242, hostname: 'synthetic-host', startedAt: '2026-10-21T00:00:00.000Z' }

/** Writes a settled lease record, the way a finished run leaves it. */
function settledLease(directory: string, runId: string, updatedAt: number) {
  const claim = claimResource({
    directory,
    runId,
    mode: RESOURCE_MODE.disposable,
    identity: disposableIdentity(runId, '20001'),
    owner,
  })
  releaseLease({
    directory,
    runId,
    receipt: cleanupReceipt({
      lease: claim.lease,
      decision: CLEANUP_DECISION.remove,
      reason: 'disposable-instance-owned-by-this-run',
      resources: [],
      child: { status: 0, signal: null },
    }),
  })
  const record = readLease(directory, runId)!
  record.updatedAt = updatedAt
  writeFileSync(join(directory, `${runId}.json`), JSON.stringify(record))
}

function disposableIdentity(runToken = 'syntheticrun', port = '20001') {
  return resourceIdentity({ mode: RESOURCE_MODE.disposable, runToken, port })
}

describe('the resource mode', () => {
  test('defaults to a disposable instance, because a run that did not choose may not share one', () => {
    expect(resolveResourceMode({})).toBe(RESOURCE_MODE.disposable)
    expect(resolveResourceMode({ ADEA_INTEGRATION_RESOURCE_MODE: '' })).toBe(
      RESOURCE_MODE.disposable
    )
  })

  test('reads the mode that was asked for', () => {
    expect(resolveResourceMode({ ADEA_INTEGRATION_RESOURCE_MODE: 'reusable' })).toBe(
      RESOURCE_MODE.reusable
    )
    expect(resolveResourceMode({ ADEA_INTEGRATION_RESOURCE_MODE: 'disposable' })).toBe(
      RESOURCE_MODE.disposable
    )
  })

  test('refuses a mode it does not understand instead of guessing one', () => {
    expect(() => resolveResourceMode({ ADEA_INTEGRATION_RESOURCE_MODE: 'shared' })).toThrow(
      /ADEA_INTEGRATION_RESOURCE_MODE must be reusable or disposable/
    )
  })
})

describe('the resource identity', () => {
  test('a disposable instance is labelled for its run alone', () => {
    const first = disposableIdentity('runone', '20001')
    const second = disposableIdentity('runtwo', '20002')
    expect(first.project).not.toBe(second.project)
    expect(first.volume).not.toBe(second.volume)
    expect(first.container).not.toBe(second.container)
    expect(first.label).not.toBe(second.label)
    expect(first.project).toContain('runone')
  })

  test('a reusable instance has one identity, so sequential runs find the same instance', () => {
    const first = resourceIdentity({ mode: RESOURCE_MODE.reusable, runToken: 'a', port: '55432' })
    const second = resourceIdentity({ mode: RESOURCE_MODE.reusable, runToken: 'b', port: '55432' })
    expect(first.project).toBe(second.project)
    expect(first.label).toBe(second.label)
    expect(first.volume).toBe('agent-hq_agent-hq-postgres-data')
  })

  test('a derived port belongs to its run and does not move between restarts', () => {
    expect(deriveDisposablePort('syntheticrun')).toBe(deriveDisposablePort('syntheticrun'))
    expect(deriveDisposablePort('syntheticrun')).not.toBe(deriveDisposablePort('synthetictwo'))
    const port = Number(deriveDisposablePort('syntheticrun'))
    expect(port).toBeGreaterThanOrEqual(20_000)
    expect(port).toBeLessThan(60_000)
  })

  test('a caller-owned target is named by its endpoint and never by a credential', () => {
    const identity = callerIdentity('postgresql://adea_local_app:secret@127.0.0.1:55432/agent_hq')
    expect(identity.label).toBe('caller:127.0.0.1:55432/agent_hq')
    expect(JSON.stringify(identity)).not.toContain('secret')
    expect(identity.project).toBeNull()
  })
})

describe('the claim', () => {
  test('a first run takes its own instance and records the ownership before it exists', () => {
    const directory = leaseDirectoryForTest()
    const identity = disposableIdentity()
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity,
      owner,
    })
    expect(claim.decision).toBe('granted')
    const lease = readLease(directory, 'run-a')
    expect(lease?.identity.label).toBe(identity.label)
    expect(lease?.owner.pid).toBe(owner.pid)
    expect(lease?.state).toBe('claimed')
  })

  test('a live owner keeps the shared instance, and a second run is refused it', () => {
    const directory = leaseDirectoryForTest()
    const identity = resourceIdentity({
      mode: RESOURCE_MODE.reusable,
      runToken: 'a',
      port: '55432',
    })
    const first = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-a',
      identity,
      owner,
      isProcessAlive: () => true,
    })
    expect(first.decision).toBe('granted')
    const second = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-b',
      identity,
      owner: { ...owner, pid: 5151 },
      isProcessAlive: () => true,
    })
    expect(second.decision).toBe('refused')
    expect(second.reason).toBe(CLEANUP_REFUSAL.active)
  })

  test('two concurrent claims of the shared instance leave exactly one holder', () => {
    const directory = leaseDirectoryForTest()
    const identity = resourceIdentity({
      mode: RESOURCE_MODE.reusable,
      runToken: 'a',
      port: '55432',
    })
    const claims = ['run-a', 'run-b'].map((runId, index) =>
      claimSharedResource({
        directory,
        resourceKey: identity.label,
        runId,
        identity,
        owner: { ...owner, pid: 1000 + index },
        isProcessAlive: (pid) => pid === 1000,
      })
    )
    expect(claims.filter((claim) => claim.decision === 'granted')).toHaveLength(1)
    expect(claims.filter((claim) => claim.decision === 'refused')).toHaveLength(1)
    expect(claims.find((claim) => claim.decision === 'refused')?.reason).toBe(
      CLEANUP_REFUSAL.active
    )
  })

  test('concurrent runs never share a resource identity', () => {
    const directory = leaseDirectoryForTest()
    const identities = ['run-a', 'run-b', 'run-c'].map((runId, index) => {
      const token = createRunToken({ now: () => 1_700_000_000_000, random: () => index / 4 })
      const identity = disposableIdentity(token, String(20_001 + index))
      const claim = claimResource({
        directory,
        runId,
        mode: RESOURCE_MODE.disposable,
        identity,
        owner: { ...owner, pid: 2000 + index },
      })
      expect(claim.decision).toBe('granted')
      return identity
    })
    expect(new Set(identities.map((identity) => identity.project)).size).toBe(3)
    expect(new Set(identities.map((identity) => identity.volume)).size).toBe(3)
    expect(new Set(identities.map((identity) => identity.port)).size).toBe(3)
  })

  test('a lease that names another resource is refused, because it is foreign', () => {
    const directory = leaseDirectoryForTest()
    const first = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity: disposableIdentity('one', '20001'),
      owner,
    })
    expect(first.decision).toBe('granted')
    const second = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity: disposableIdentity('two', '20002'),
      owner,
    })
    expect(second.decision).toBe('refused')
    expect(second.reason).toBe(CLEANUP_REFUSAL.foreign)
  })

  test('a lease that cannot be understood is refused, because its owner is unknown', () => {
    const directory = leaseDirectoryForTest()
    const identity = disposableIdentity()
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity,
      owner,
    })
    expect(claim.decision).toBe('granted')
    // A record of another version is not understood, and an understood record
    // is the only basis for a decision.
    const lease = readLease(directory, 'run-a')!
    lease.version = 99
    writeFileSync(join(directory, 'run-a.json'), JSON.stringify(lease))
    const again = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity,
      owner,
    })
    expect(again.decision).toBe('refused')
    expect(again.reason).toBe(CLEANUP_REFUSAL.uncertain)
  })
})

describe('the crash and restart path', () => {
  test('a restarted run takes its own lease back', () => {
    const directory = leaseDirectoryForTest()
    const identity = disposableIdentity()
    const first = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity,
      owner: { ...owner, pid: 1000 },
    })
    expect(first.decision).toBe('granted')
    // The process is gone: the run crashed before it settled its lease.
    const restarted = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity,
      owner: { ...owner, pid: 2000 },
      isProcessAlive: () => false,
    })
    expect(restarted.decision).toBe('granted')
    expect(restarted.reclaimed).toBe(true)
    expect(readLease(directory, 'run-a')?.owner.pid).toBe(2000)
  })

  test('another run does not take over a lease that is not its own', () => {
    const directory = leaseDirectoryForTest()
    const identity = disposableIdentity()
    claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity,
      owner: { ...owner, pid: 1000 },
    })
    const other = claimResource({
      directory,
      runId: 'run-b',
      mode: RESOURCE_MODE.disposable,
      identity: disposableIdentity('other', '20002'),
      owner: { ...owner, pid: 2000 },
      isProcessAlive: () => false,
    })
    expect(other.decision).toBe('granted')
    expect(other.lease?.identity.label).not.toBe(identity.label)
    // The crashed run's lease is still there: nothing reclaimed it.
    expect(readLease(directory, 'run-a')).not.toBeNull()
  })

  test('a lease whose owner is still alive is never taken over', () => {
    const directory = leaseDirectoryForTest()
    const identity = disposableIdentity()
    claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity,
      owner: { ...owner, pid: 1000 },
    })
    const again = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity,
      owner: { ...owner, pid: 2000 },
      isProcessAlive: (pid) => pid === 1000,
    })
    expect(again.decision).toBe('refused')
    expect(again.reason).toBe(CLEANUP_REFUSAL.active)
  })
})

describe('the cleanup plan', () => {
  test('a disposable instance this run created is removed', () => {
    const directory = leaseDirectoryForTest()
    const identity = disposableIdentity()
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity,
      owner,
    })
    const plan = planCleanup({ lease: claim.lease, startedByThisRun: true, ownerPid: owner.pid })
    expect(plan.decision).toBe(CLEANUP_DECISION.remove)
    // The container, the volume and the network this run created, the
    // database inside it, and the isolated test data that goes with it.
    expect(plan.resources.map((resource) => resource.name)).toEqual([
      identity.container,
      identity.volume,
      identity.network,
      'agent_hq',
      'agent_hq data',
    ])
    expect(plan.resources.every((resource) => resource.action === 'removed')).toBe(true)
    expect(plan.resources.map((resource) => resource.kind)).toEqual([
      'container',
      'volume',
      'network',
      'database',
      'data',
    ])
  })

  test('a shared instance is kept, and the run that did not start it does not stop it', () => {
    const directory = leaseDirectoryForTest()
    const identity = resourceIdentity({
      mode: RESOURCE_MODE.reusable,
      runToken: 'a',
      port: '55432',
    })
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.reusable,
      identity,
      owner,
    })
    const plan = planCleanup({ lease: claim.lease, startedByThisRun: false, ownerPid: owner.pid })
    expect(plan.decision).toBe(CLEANUP_DECISION.stop)
    expect(plan.resources.find((resource) => resource.kind === 'container')?.action).toBe(
      'retained'
    )
    expect(plan.resources.find((resource) => resource.kind === 'volume')?.action).toBe('retained')
  })

  test('a shared instance this run started is stopped and kept for the next run', () => {
    const directory = leaseDirectoryForTest()
    const identity = resourceIdentity({
      mode: RESOURCE_MODE.reusable,
      runToken: 'a',
      port: '55432',
    })
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.reusable,
      identity,
      owner,
    })
    const plan = planCleanup({ lease: claim.lease, startedByThisRun: true, ownerPid: owner.pid })
    expect(plan.decision).toBe(CLEANUP_DECISION.stop)
    expect(plan.resources.find((resource) => resource.kind === 'container')?.action).toBe('stopped')
    expect(plan.resources.find((resource) => resource.kind === 'volume')?.action).toBe('retained')
  })

  test('a caller-owned target is refused, and nothing is named for removal', () => {
    const directory = leaseDirectoryForTest()
    const identity = callerIdentity('postgresql://adea_local_app:secret@127.0.0.1:55432/agent_hq')
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: 'caller',
      identity,
      owner,
    })
    const plan = planCleanup({
      lease: claim.lease,
      ownership: 'caller',
      ownerPid: owner.pid,
    })
    expect(plan.decision).toBe(CLEANUP_DECISION.refuse)
    expect(plan.reason).toBe(CLEANUP_REFUSAL.callerOwned)
    expect(plan.resources.every((resource) => resource.action === 'refused')).toBe(true)
  })

  test('a resource another live run holds is refused', () => {
    const directory = leaseDirectoryForTest()
    const identity = disposableIdentity()
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity,
      owner: { ...owner, pid: 1000 },
    })
    const plan = planCleanup({
      lease: claim.lease,
      ownerPid: 2000,
      isProcessAlive: (pid) => pid === 1000,
    })
    expect(plan.decision).toBe(CLEANUP_DECISION.refuse)
    expect(plan.reason).toBe(CLEANUP_REFUSAL.active)
  })

  test('the checkout the run used is named as kept, because the lane never removes one', () => {
    const directory = leaseDirectoryForTest()
    const identity = disposableIdentity()
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity,
      owner,
    })
    const plan = planCleanup({
      lease: claim.lease,
      startedByThisRun: true,
      ownerPid: owner.pid,
      retainedPaths: ['/synthetic/checkout'],
    })
    const worktree = plan.resources.find((resource) => resource.kind === 'worktree')
    expect(worktree?.action).toBe('retained')
    expect(worktree?.name).toBe('/synthetic/checkout')
  })
})

describe('the cleanup receipt', () => {
  test('separates the child outcome from the fate of the resources', () => {
    const directory = leaseDirectoryForTest()
    const identity = disposableIdentity()
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity,
      owner,
    })
    const plan = planCleanup({ lease: claim.lease, startedByThisRun: true, ownerPid: owner.pid })
    const receipt = cleanupReceipt({
      lease: claim.lease,
      decision: plan.decision,
      reason: plan.reason,
      resources: plan.resources.map((resource) => ({ ...resource, verifiedAbsent: true })),
      child: { status: 1, signal: null },
    })
    expect(receipt.child).toEqual({ exited: true, status: 1, signal: null })
    expect(receipt.removed).toEqual([
      identity.container,
      identity.volume,
      identity.network,
      'agent_hq',
      'agent_hq data',
    ])
    expect(receipt.retained).toEqual([])
    expect(receipt.errors).toEqual([])
  })

  test('a retained resource is not reported as removed', () => {
    const directory = leaseDirectoryForTest()
    const identity = resourceIdentity({
      mode: RESOURCE_MODE.reusable,
      runToken: 'a',
      port: '55432',
    })
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.reusable,
      identity,
      owner,
    })
    const plan = planCleanup({ lease: claim.lease, startedByThisRun: true, ownerPid: owner.pid })
    const receipt = cleanupReceipt({
      lease: claim.lease,
      decision: plan.decision,
      reason: plan.reason,
      resources: plan.resources,
      child: { status: 0, signal: null },
    })
    expect(receipt.removed).toEqual([])
    expect(receipt.stopped).toEqual([identity.container])
    expect(receipt.retained).toEqual([
      identity.volume,
      identity.network,
      'agent_hq',
      'agent_hq data',
    ])
    expect(summariseReceipt(receipt)).toContain('retained=')
  })

  test('a cleanup that could not remove everything says so', () => {
    const directory = leaseDirectoryForTest()
    const identity = disposableIdentity()
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity,
      owner,
    })
    const plan = planCleanup({ lease: claim.lease, startedByThisRun: true, ownerPid: owner.pid })
    const receipt = cleanupReceipt({
      lease: claim.lease,
      decision: plan.decision,
      reason: plan.reason,
      resources: plan.resources.map((resource) => ({ ...resource, verifiedAbsent: false })),
      child: { status: 0, signal: null },
      errors: ['removing the owned volume failed with exit code 1'],
    })
    expect(receipt.errors).toHaveLength(1)
    expect(summariseReceipt(receipt)).toContain('child=exited:0')
  })

  test('the receipt is kept with the lease, so the evidence outlives the run', () => {
    const directory = leaseDirectoryForTest()
    const identity = disposableIdentity()
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity,
      owner,
    })
    const plan = planCleanup({ lease: claim.lease, startedByThisRun: true, ownerPid: owner.pid })
    const receipt = cleanupReceipt({
      lease: claim.lease,
      decision: plan.decision,
      reason: plan.reason,
      resources: plan.resources,
      child: { status: 0, signal: null },
    })
    releaseLease({ directory, runId: 'run-a', receipt })
    const settled = readLease(directory, 'run-a')
    expect(settled?.state).toBe('released')
    expect(settled?.cleanup?.decision).toBe(CLEANUP_DECISION.remove)
    expect(settled?.cleanup?.resources).toHaveLength(5)
    expect(listLeases(directory)).toHaveLength(1)
  })

  test('a run that ended without a child records that it does not know the child outcome', () => {
    const directory = leaseDirectoryForTest()
    const identity = disposableIdentity()
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity,
      owner,
    })
    const plan = planCleanup({ lease: claim.lease, startedByThisRun: true, ownerPid: owner.pid })
    const receipt = cleanupReceipt({
      lease: claim.lease,
      decision: plan.decision,
      reason: plan.reason,
      resources: plan.resources,
    })
    expect(receipt.child).toEqual({ exited: false, status: null, signal: null })
  })
})

describe('the lease classification', () => {
  test('a record of another version is uncertain, not stale', () => {
    expect(classifyLease({ version: 99, runId: 'run-a' })).toBe(LEASE_STATE.uncertain)
    expect(classifyLease(null)).toBe(LEASE_STATE.uncertain)
    expect(classifyLease({ version: 1, runId: 'run-a' })).toBe(LEASE_STATE.uncertain)
  })

  test('a record whose owner is alive is active, and one whose owner is gone is stale', () => {
    const lease = {
      version: 1,
      runId: 'run-a',
      identity: { label: 'adea-integration-disposable:synthetic' },
      owner: { pid: 1000 },
      state: 'claimed',
    }
    expect(classifyLease(lease, { isProcessAlive: (pid) => pid === 1000 })).toBe(LEASE_STATE.active)
    expect(classifyLease(lease, { isProcessAlive: () => false })).toBe(LEASE_STATE.stale)
  })

  test('a record that names another resource is foreign', () => {
    const lease = {
      version: 1,
      runId: 'run-a',
      identity: { label: 'adea-integration-disposable:other' },
      owner: { pid: 1000 },
      state: 'claimed',
    }
    expect(
      classifyLease(lease, { expectedIdentity: { label: 'adea-integration-disposable:mine' } })
    ).toBe(LEASE_STATE.foreign)
  })
})

describe('the lease directory and the records in it', () => {
  test('the directory is the one the caller named, and otherwise the temporary one', () => {
    expect(leaseDirectory({ ADEA_INTEGRATION_LEASE_DIR: '/synthetic/leases' })).toBe(
      '/synthetic/leases'
    )
    expect(leaseDirectory({})).toContain('adea-integration-leases')
  })

  test('a run id that is not a safe file name is refused', () => {
    expect(() => leasePath('/synthetic/leases', '../escape')).toThrow(/not a safe lease name/)
  })

  test('a record that cannot be parsed is not an absent lease', () => {
    const directory = leaseDirectoryForTest()
    writeFileSync(join(directory, 'run-a.json'), 'not json at all')
    // The record exists and cannot be read, so its ownership is unknown. It is
    // not an absence, and it is not silently ignored.
    expect(() => readLease(directory, 'run-a')).toThrow(/cannot be read/)
    expect(listLeases(directory)).toEqual([])
    const scan = scanLeases(directory)
    expect(scan.leases).toEqual([])
    expect(scan.unreadable).toEqual(['run-a.json'])
  })

  test('a directory that holds nothing holds no lease', () => {
    expect(listLeases(join(leaseDirectoryForTest(), 'never-created'))).toEqual([])
  })

  test('the owner of this process is named with its process and its host', () => {
    const processOwner = currentOwner(4321)
    expect(processOwner.pid).toBe(4321)
    expect(processOwner.hostname.length).toBeGreaterThan(0)
    expect(processOwner.startedAt).toContain('T')
  })
})

describe('the refusals the plan makes', () => {
  test('a lease that names another resource is refused', () => {
    const directory = leaseDirectoryForTest()
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity: disposableIdentity(),
      owner,
    })
    const foreign = {
      ...claim.lease,
      identity: { ...claim.lease.identity, label: 'adea-integration-disposable:someone-else' },
    }
    const plan = planCleanup({
      lease: foreign,
      expectedIdentity: claim.lease.identity,
      ownerPid: owner.pid,
    })
    expect(plan.decision).toBe(CLEANUP_DECISION.refuse)
    expect(plan.reason).toBe(CLEANUP_REFUSAL.foreign)
    expect(plan.resources.every((resource) => resource.action === 'refused')).toBe(true)
  })

  test('a lease that cannot be understood is refused', () => {
    const plan = planCleanup({ lease: { version: 99 }, ownerPid: owner.pid })
    expect(plan.decision).toBe(CLEANUP_DECISION.refuse)
    expect(plan.reason).toBe(CLEANUP_REFUSAL.uncertain)
  })

  test('a record whose identity has no label is uncertain', () => {
    expect(classifyLease({ version: 1, runId: 'run-a', identity: { label: '' } })).toBe(
      LEASE_STATE.uncertain
    )
  })
})

describe('the disk-pressure admission', () => {
  test('a disk with room admits the run', () => {
    const decision = diskPressureAdmission({
      availableBytes: 10_000_000_000,
      requiredBytes: 1_000_000_000,
      limitBytes: 2_000_000_000,
    })
    expect(decision.decision).toBe(DISK_PRESSURE.admitted)
    expect(decision.availableBytes).toBe(10_000_000_000)
  })

  test('a disk below the floor refuses the run before it creates anything', () => {
    const decision = diskPressureAdmission({
      availableBytes: 100,
      requiredBytes: 1_000,
      limitBytes: 2_000,
    })
    expect(decision.decision).toBe(DISK_PRESSURE.refused)
    expect(decision.reason).toContain('below the lane')
  })

  test('a disk that cannot be read is refused, because an unknown disk is not a free disk', () => {
    expect(diskPressureAdmission({ availableBytes: Number.NaN }).decision).toBe(
      DISK_PRESSURE.refused
    )
    expect(diskPressureAdmission({ availableBytes: undefined }).reason).toContain(
      'could not be established'
    )
  })
})

describe('the reclamation safety of one resource', () => {
  const identity = { ...disposableIdentity(), runId: 'run-a' }

  test('a pinned image is reused, never removed', () => {
    const decision = classifyDockerResource(
      { kind: 'image', name: 'postgres:18-alpine@sha256:abc' },
      { identity }
    )
    expect(decision.disposition).toBe(RESOURCE_DISPOSITION.reuse)
  })

  test('a resource this run created and labelled is removable', () => {
    const decision = classifyDockerResource(
      { kind: 'container', name: identity.container, label: identity.project },
      { identity }
    )
    expect(decision.disposition).toBe(RESOURCE_DISPOSITION.removable)
  })

  test('a resource of another project is protected', () => {
    const decision = classifyDockerResource(
      { kind: 'container', name: 'someone-elses-postgres-1', label: 'someone-else' },
      { identity }
    )
    expect(decision.disposition).toBe(RESOURCE_DISPOSITION.protected)
    expect(decision.reason).toContain('someone-else')
  })

  test('a volume with no label is protected, and an unattached volume is never safe to delete', () => {
    const decision = classifyDockerResource(
      { kind: 'volume', name: 'agent-hq_agent-hq-postgres-data', label: null, attached: false },
      { identity }
    )
    expect(decision.disposition).toBe(RESOURCE_DISPOSITION.protected)
    expect(decision.reason).toContain('never safe to delete')
  })

  test('a resource held by a live run is protected', () => {
    const leases = [
      {
        version: 1,
        runId: 'run-b',
        identity: { label: identity.label },
        owner: { pid: 1000 },
        state: 'claimed',
      },
    ]
    const decision = classifyDockerResource(
      { kind: 'volume', name: identity.volume, label: identity.project },
      { identity, leases, isProcessAlive: (pid) => pid === 1000 }
    )
    expect(decision.disposition).toBe(RESOURCE_DISPOSITION.protected)
    expect(decision.reason).toContain('live run run-b')
  })

  test('a run that owns no project owns no resource', () => {
    const decision = classifyDockerResource(
      { kind: 'volume', name: 'anything', label: 'anything' },
      { identity: { project: null, label: 'caller:127.0.0.1:5432/agent_hq' } }
    )
    expect(decision.disposition).toBe(RESOURCE_DISPOSITION.protected)
  })
})

describe('the dry-run inventory', () => {
  test('names every resource with the disposition it would receive and the reason', () => {
    const identity = { ...disposableIdentity(), runId: 'run-a' }
    const inventory = buildInventory({
      identity,
      resources: [
        { kind: 'image', name: 'postgres:18-alpine@sha256:abc' },
        { kind: 'container', name: identity.container, label: identity.project },
        { kind: 'volume', name: 'agent-hq_agent-hq-postgres-data', label: null, attached: false },
      ],
    })
    expect(inventory.items).toHaveLength(3)
    expect(inventory.items[0].disposition).toBe(RESOURCE_DISPOSITION.reuse)
    expect(inventory.items[1].disposition).toBe(RESOURCE_DISPOSITION.removable)
    expect(inventory.items[2].disposition).toBe(RESOURCE_DISPOSITION.protected)
    expect(inventory.counts).toEqual({ reuse: 1, removable: 1, protected: 1 })
  })
})

describe('the restart reconciliation', () => {
  test('reports the records, prunes the settled ones past the bound, and keeps the rest', () => {
    const directory = leaseDirectoryForTest()
    const identity = disposableIdentity()
    // A settled record from long ago: it is past the retention bound.
    const settled = claimResource({
      directory,
      runId: 'run-old',
      mode: RESOURCE_MODE.disposable,
      identity: disposableIdentity('old', '20001'),
      owner,
    })
    releaseLease({
      directory,
      runId: 'run-old',
      receipt: cleanupReceipt({
        lease: settled.lease,
        decision: CLEANUP_DECISION.remove,
        reason: 'disposable-instance-owned-by-this-run',
        resources: [],
        child: { status: 0, signal: null },
      }),
    })
    const settledRecord = readLease(directory, 'run-old')!
    settledRecord.updatedAt = 1_000
    writeFileSync(join(directory, 'run-old.json'), JSON.stringify(settledRecord))
    // A live run's record: it is never pruned.
    claimResource({
      directory,
      runId: 'run-live',
      mode: RESOURCE_MODE.disposable,
      identity: disposableIdentity('live', '20002'),
      owner: { ...owner, pid: 1000 },
    })

    const reconciliation = reconcileLeases({
      directory,
      runId: 'run-new',
      identity,
      now: 10_000_000_000,
      retentionMs: 1_000,
      isProcessAlive: (pid) => pid === 1000,
    })
    expect(reconciliation.pruned).toEqual(['run-old'])
    expect(reconciliation.found.map((record) => record.runId).toSorted()).toEqual([
      'run-live',
      'run-old',
    ])
    expect(reconciliation.found.find((record) => record.runId === 'run-live')?.state).toBe(
      LEASE_STATE.active
    )
    expect(readLease(directory, 'run-old')).toBeNull()
    expect(readLease(directory, 'run-live')).not.toBeNull()
  })

  test('a record left by a dead run is reported, and its resource is not reclaimed', () => {
    const directory = leaseDirectoryForTest()
    claimResource({
      directory,
      runId: 'run-dead',
      mode: RESOURCE_MODE.disposable,
      identity: disposableIdentity('dead', '20003'),
      owner: { ...owner, pid: 1000 },
    })
    const reconciliation = reconcileLeases({
      directory,
      runId: 'run-new',
      identity: disposableIdentity(),
      now: 10_000_000_000,
      isProcessAlive: () => false,
    })
    expect(reconciliation.found).toEqual([
      {
        runId: 'run-dead',
        label: 'adea-integration-disposable:adea-int-d-dead',
        state: LEASE_STATE.stale,
        own: false,
      },
    ])
    // The record is evidence. The lane reports it and leaves it alone.
    expect(reconciliation.pruned).toEqual([])
    expect(readLease(directory, 'run-dead')).not.toBeNull()
  })
})

describe('the liveness of an owner', () => {
  test('a process that is running is alive', () => {
    expect(processIsAlive(process.pid)).toBe(true)
  })

  test('a process that is not running is not alive', () => {
    // A process id that cannot be running: the kernel has no such process.
    const dead = 2 ** 30
    expect(processIsAlive(dead)).toBe(false)
  })

  test('an owner on another host cannot be probed, and is treated as alive', () => {
    // The probe cannot reach another host, so its liveness is unknown, and an
    // unknown liveness must not hand a live resource to a second run.
    expect(processIsAlive(process.pid, 'another-host')).toBe(true)
  })

  test('a lease with no probe at all is treated as held by a live owner', () => {
    const lease = {
      version: 1,
      runId: 'run-a',
      identity: { label: 'adea-integration-disposable:adea-int-d-a' },
      owner: { pid: 4242, hostname: 'synthetic-host' },
      state: 'claimed',
    }
    // The production default must fail closed: without a probe, the owner is
    // assumed to be alive, so the claim is refused.
    expect(classifyLease(lease)).toBe(LEASE_STATE.active)
  })
})

describe('the shared-resource claim', () => {
  const identity = resourceIdentity({ mode: RESOURCE_MODE.reusable, runToken: 'a', port: '55432' })

  test('the first run holds the claim and the second is refused it', () => {
    const directory = leaseDirectoryForTest()
    const first = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-a',
      identity,
      owner,
      isProcessAlive: () => true,
    })
    expect(first.decision).toBe('granted')
    const second = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-b',
      identity,
      owner: { ...owner, pid: 5151 },
      isProcessAlive: () => true,
    })
    expect(second.decision).toBe('refused')
    expect(second.reason).toBe(CLEANUP_REFUSAL.active)
  })

  test('a claim whose owner is gone is taken over by the same identity', () => {
    const directory = leaseDirectoryForTest()
    const first = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-a',
      identity,
      owner: { ...owner, pid: 4242 },
      isProcessAlive: () => false,
    })
    expect(first.decision).toBe('granted')
    const restarted = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-a',
      identity,
      owner: { ...owner, pid: 5151 },
      isProcessAlive: () => false,
    })
    expect(restarted.decision).toBe('granted')
    expect(restarted.claim?.owner.pid).toBe(5151)
  })

  test('a claim is never taken over by a different identity', () => {
    const directory = leaseDirectoryForTest()
    claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-a',
      identity,
      owner: { ...owner, pid: 4242 },
      isProcessAlive: () => false,
    })
    const other = resourceIdentity({ mode: RESOURCE_MODE.disposable, runToken: 'b', port: '20002' })
    const refused = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-b',
      identity: other,
      owner: { ...owner, pid: 5151 },
      isProcessAlive: () => false,
    })
    expect(refused.decision).toBe('refused')
    expect(refused.reason).toBe(CLEANUP_REFUSAL.foreign)
  })

  test('a claim that cannot be read is uncertain, and an uncertain claim is refused', () => {
    const directory = leaseDirectoryForTest()
    claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-a',
      identity,
      owner,
      isProcessAlive: () => false,
    })
    const claimFile = join(directory, 'claims', 'adea-integration-reusable-agent-hq.claim')
    writeFileSync(claimFile, 'not json at all')
    const refused = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-b',
      identity,
      owner: { ...owner, pid: 5151 },
      isProcessAlive: () => false,
    })
    expect(refused.decision).toBe('refused')
    expect(refused.reason).toBe(CLEANUP_REFUSAL.uncertain)
  })

  test('a claim is released only by the run that holds it', () => {
    const directory = leaseDirectoryForTest()
    const claim = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-a',
      identity,
      owner,
      isProcessAlive: () => true,
    })
    expect(claim.decision).toBe('granted')
    const foreign = releaseSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-b',
      identity,
      token: claim.claim?.token,
    })
    expect(foreign.released).toBe(false)
    const released = releaseSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-a',
      identity,
      token: claim.claim?.token,
    })
    expect(released.released).toBe(true)
  })

  test('a release that presents no token removes nothing, whoever asks', () => {
    const directory = leaseDirectoryForTest()
    const claim = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-a',
      identity,
      owner,
      isProcessAlive: () => true,
    })
    expect(claim.decision).toBe('granted')
    const claimFile = join(directory, 'claims', 'adea-integration-reusable-agent-hq.claim')
    // The same run and the same identity, with no token at all: the run id is
    // not a process identity, so this proves nothing.
    for (const token of [undefined, '', 'not-a-token', 'run-a']) {
      const released = releaseSharedResource({
        directory,
        resourceKey: identity.label,
        runId: 'run-a',
        identity,
        token,
      })
      expect(released.released).toBe(false)
      expect(released.reason).toContain('no valid token')
      // The claim is exactly as it was.
      expect(JSON.parse(readFileSync(claimFile, 'utf8')).token).toBe(claim.claim?.token)
    }
  })

  test('a release that presents the wrong token leaves the claim alone', () => {
    const directory = leaseDirectoryForTest()
    const claim = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-a',
      identity,
      owner,
      isProcessAlive: () => true,
    })
    expect(claim.decision).toBe('granted')
    const claimFile = join(directory, 'claims', 'adea-integration-reusable-agent-hq.claim')
    const released = releaseSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-a',
      identity,
      token: '2e99c7a1-0000-4000-8000-000000000000',
    })
    expect(released.released).toBe(false)
    expect(released.reason).toContain('not taken by this holder')
    expect(JSON.parse(readFileSync(claimFile, 'utf8')).token).toBe(claim.claim?.token)
  })

  test('a claim that carries no token is not released', () => {
    const directory = leaseDirectoryForTest()
    mkdirSync(join(directory, 'claims'), { recursive: true })
    const claimFile = join(directory, 'claims', 'adea-integration-reusable-agent-hq.claim')
    // A record written before this model issued tokens carries none.
    writeFileSync(
      claimFile,
      `${JSON.stringify({
        version: 1,
        resourceKey: identity.label,
        runId: 'run-a',
        identity,
        owner: { pid: 4242, hostname: 'synthetic-host', startedAt: null },
        createdAt: 0,
      })}\n`
    )
    const released = releaseSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-a',
      identity,
      token: '2e99c7a1-0000-4000-8000-000000000000',
    })
    expect(released.released).toBe(false)
    expect(released.reason).toContain('no valid token')
    // The record is left exactly as it was.
    expect(JSON.parse(readFileSync(claimFile, 'utf8')).runId).toBe('run-a')
  })

  test('a claim record that cannot be understood is uncertain', () => {
    expect(classifyClaim(null)).toBe(CLAIM_STATE.uncertain)
    expect(classifyClaim({ version: 99 })).toBe(CLAIM_STATE.uncertain)
    expect(
      classifyClaim({
        version: 1,
        resourceKey: 'k',
        identity: { label: 'l' },
        owner: { pid: 1 },
      })
    ).toBe(CLAIM_STATE.active)
  })
})

describe('the run identity', () => {
  test('a named run keeps the same token, project and port across a restart', () => {
    const first = runTokenFor('run-stable')
    const second = runTokenFor('run-stable')
    expect(first).toBe(second)
    const identity = resourceIdentity({
      mode: RESOURCE_MODE.disposable,
      runToken: first,
      port: '20001',
    })
    const restarted = resourceIdentity({
      mode: RESOURCE_MODE.disposable,
      runToken: second,
      port: '20001',
    })
    expect(restarted.project).toBe(identity.project)
    expect(restarted.label).toBe(identity.label)
    expect(deriveDisposablePort(second)).toBe(deriveDisposablePort(first))
  })

  test('a run that names nothing is given a token of its own', () => {
    const token = runTokenFor(undefined, { now: () => 1_700_000_000_000, random: () => 0.5 })
    expect(token).not.toBe('')
    expect(token).toBe(runTokenFor(undefined, { now: () => 1_700_000_000_000, random: () => 0.5 }))
  })
})

describe('the claim under real processes', () => {
  const modelUrl = new URL('./integration-resource-lease.mjs', import.meta.url).href

  // A helper that claims the shared instance the way the lane does, with the
  // real liveness probe, and holds the claim while it is alive.
  function claimScript(): string {
    return `
import { hostname } from 'node:os'
import { claimSharedResource, processIsAlive, resourceIdentity, runTokenFor } from ${JSON.stringify(
      modelUrl
    )}
const [directory, runId, mode] = process.argv.slice(2)
const identity = resourceIdentity({ mode, runToken: runTokenFor(runId), port: '20001' })
const claim = claimSharedResource({
  directory,
  resourceKey: identity.label,
  runId,
  identity,
  owner: { pid: process.pid, hostname: hostname(), startedAt: null },
  isProcessAlive: processIsAlive,
})
console.log(JSON.stringify({ decision: claim.decision, reason: claim.reason ?? null, label: identity.label }))
if (claim.decision === 'granted') setInterval(() => {}, 1000)
`
  }

  test('only one of several processes at once holds the shared instance', async () => {
    const directory = leaseDirectoryForTest()
    const script = join(directory, 'claim.mjs')
    writeFileSync(script, claimScript())
    const children = Array.from({ length: 4 }, (_, index) =>
      spawn(process.execPath, [script, directory, `run-${index}`, 'reusable'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    )
    try {
      const decisions = await Promise.all(
        children.map(
          (child) =>
            new Promise<{ decision: string; reason: string | null; label: string }>((resolve) => {
              let output = ''
              child.stdout!.on('data', (chunk) => {
                output += String(chunk)
                if (!output.includes('\n')) return
                try {
                  resolve(JSON.parse(output.trim().split('\n').at(-1) ?? '{}'))
                } catch {
                  resolve({ decision: 'unknown', reason: 'no answer', label: '' })
                }
              })
              child.once('exit', () => {
                if (output.includes('\n')) return
                resolve({ decision: 'unknown', reason: 'no answer', label: '' })
              })
            })
        )
      )
      // Exactly one process created the claim, and every other one read the
      // winner's record and was refused it.
      expect(decisions.filter((decision) => decision.decision === 'granted')).toHaveLength(1)
      expect(decisions.filter((decision) => decision.decision === 'refused')).toHaveLength(3)
      for (const decision of decisions.filter((entry) => entry.decision === 'refused')) {
        // A loser is refused because the lock is held by a live process, or
        // because it could not read the lock at that moment.
        expect([CLEANUP_REFUSAL.active, CLEANUP_REFUSAL.uncertain]).toContain(decision.reason)
      }
      // Every process named the same resource, so none of them was a different
      // project that happened to lose.
      expect(new Set(decisions.map((decision) => decision.label)).size).toBe(1)
    } finally {
      for (const child of children) child.kill('SIGKILL')
    }
  }, 30_000)

  test('a restarted run recovers the claim and the identity it recorded', async () => {
    const directory = leaseDirectoryForTest()
    const script = join(directory, 'claim.mjs')
    writeFileSync(script, claimScript())
    const first = spawn(process.execPath, [script, directory, 'run-stable', 'disposable'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const firstDecision = await new Promise<string>((resolve) => {
      let output = ''
      first.stdout!.on('data', (chunk) => {
        output += String(chunk)
        if (output.includes('\n')) resolve(output.trim())
      })
    })
    const firstRecord = JSON.parse(firstDecision)
    expect(firstRecord.decision).toBe('granted')
    // The process dies without releasing anything, exactly as a crashed run
    // would.
    first.kill('SIGKILL')
    await new Promise((resolve) => first.once('exit', resolve))

    const restarted = spawn(process.execPath, [script, directory, 'run-stable', 'disposable'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const decision = await new Promise<{
        decision: string
        reason: string | null
        label: string
      }>((resolve) => {
        let output = ''
        restarted.stdout!.on('data', (chunk) => {
          output += String(chunk)
          if (output.includes('\n')) {
            try {
              resolve(JSON.parse(output.trim().split('\n').at(-1) ?? '{}'))
            } catch {
              resolve({ decision: 'unknown', reason: 'no answer', label: '' })
            }
          }
        })
      })
      expect(decision.decision).toBe('granted')
      // The restart recovered the recorded identity. It did not mint a second
      // project for the same run.
      expect(decision.label).toBe(firstRecord.label)
    } finally {
      restarted.kill('SIGKILL')
    }
  }, 30_000)
})

describe('the retention bound on the lane own records', () => {
  test('a fresh settled record is kept when the production clock is used', () => {
    const directory = leaseDirectoryForTest()
    settledLease(directory, 'run-fresh', Date.now())
    // The production call passes no clock. The clock is a function, and the
    // age of a record that was just settled is not a number of milliseconds
    // past the bound, so the record is kept.
    expect(pruneSettledLeases({ directory })).toEqual([])
    expect(readLease(directory, 'run-fresh')).not.toBeNull()
  })

  test('a settled record past the bound is pruned', () => {
    const directory = leaseDirectoryForTest()
    settledLease(directory, 'run-old', 1_000)
    expect(pruneSettledLeases({ directory, now: () => 10_000_000, retentionMs: 1_000 })).toEqual([
      'run-old',
    ])
    expect(readLease(directory, 'run-old')).toBeNull()
  })

  test('a clock that cannot be established prunes nothing', () => {
    const directory = leaseDirectoryForTest()
    settledLease(directory, 'run-old', 1_000)
    expect(pruneSettledLeases({ directory, now: () => Number.NaN, retentionMs: 1_000 })).toEqual([])
    expect(
      pruneSettledLeases({ directory, now: 'not a clock' as never, retentionMs: 1_000 })
    ).toEqual([])
    expect(readLease(directory, 'run-old')).not.toBeNull()
  })

  test('a bound that is not a duration prunes nothing', () => {
    const directory = leaseDirectoryForTest()
    settledLease(directory, 'run-old', 1_000)
    expect(
      pruneSettledLeases({ directory, now: () => 10_000_000, retentionMs: Number.NaN })
    ).toEqual([])
    expect(pruneSettledLeases({ directory, now: () => 10_000_000, retentionMs: -1 })).toEqual([])
    expect(readLease(directory, 'run-old')).not.toBeNull()
  })
})

describe('the stale takeover', () => {
  const identity = resourceIdentity({ mode: RESOURCE_MODE.reusable, runToken: 'a', port: '55432' })

  test('a reclaimer that read a stale claim does not delete the live claim written since', () => {
    const directory = leaseDirectoryForTest()
    // The first holder's claim is left behind by a process that died.
    claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-dead',
      identity,
      owner: { ...owner, pid: 4242 },
      isProcessAlive: () => false,
    })

    const claimFile = join(directory, 'claims', 'adea-integration-reusable-agent-hq.claim')

    // While the reclaimer is between its read and its move, a writer that does
    // not hold the lock replaces the record with its own.
    const first = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-dead',
      identity,
      owner: { ...owner, pid: 5151 },
      isProcessAlive: () => false,
      afterClaimRead: () => {
        writeFileSync(
          claimFile,
          `${JSON.stringify({
            version: 1,
            resourceKey: identity.label,
            runId: 'run-foreign',
            identity,
            owner: { pid: 9999, hostname: 'foreign-host', startedAt: null },
            token: 'foreign-token',
            createdAt: 0,
          })}\n`
        )
      },
    })

    // The reclaimer refuses, and the record that was written since is intact.
    expect(first.decision).toBe('refused')
    expect(first.reason).toBe(CLEANUP_REFUSAL.active)
    const held = JSON.parse(readFileSync(claimFile, 'utf8'))
    expect(held.runId).toBe('run-foreign')
    expect(held.token).toBe('foreign-token')
  })

  test('three contenders for one stale claim never overlap and never overwrite a live claim', () => {
    const directory = leaseDirectoryForTest()
    // A process died holding the claim.
    claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-dead',
      identity,
      owner: { ...owner, pid: 4242 },
      isProcessAlive: () => false,
    })
    const claimFile = join(directory, 'claims', 'adea-integration-reusable-agent-hq.claim')

    // A reads the stale claim and pauses between its read and its move. The
    // liveness is realistic: the holder of the lock is alive, so a contender
    // cannot break it.
    let contenderB = null
    let contenderC = null
    const a = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-dead',
      identity,
      owner: { ...owner, pid: 5151 },
      isProcessAlive: (pid) => pid === 5151,
      afterClaimRead: () => {
        // B reaches for the same stale record. It belongs to another run, so
        // the arbitration cannot be proved and B is refused.
        contenderB = claimSharedResource({
          directory,
          resourceKey: identity.label,
          runId: 'run-b',
          identity,
          owner: { ...owner, pid: 6161 },
          isProcessAlive: (pid) => pid === 5151,
        })
        // C reaches for it as well.
        contenderC = claimSharedResource({
          directory,
          resourceKey: identity.label,
          runId: 'run-c',
          identity,
          owner: { ...owner, pid: 7171 },
          isProcessAlive: (pid) => pid === 5151,
        })
      },
    })

    // Exactly one holder: A, which owns the record it took back. B and C used
    // the same run id as A and are still refused, because the lock is held by
    // a live process and a run id is not a process identity.
    expect(a.decision).toBe('granted')
    expect(contenderB?.decision).toBe('refused')
    expect([CLEANUP_REFUSAL.active, CLEANUP_REFUSAL.uncertain]).toContain(contenderB?.reason)
    expect(contenderC?.decision).toBe('refused')
    expect([CLEANUP_REFUSAL.active, CLEANUP_REFUSAL.uncertain]).toContain(contenderC?.reason)

    // The claim on disk is A's, and nobody else's record replaced it.
    const held = JSON.parse(readFileSync(claimFile, 'utf8'))
    expect(held.runId).toBe('run-dead')
    expect(held.owner.pid).toBe(5151)

    // A claim that is still live is never moved aside, so it is never
    // overwritten by a reclaimer.
    const live = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-dead',
      identity,
      owner: { ...owner, pid: 5151 },
      isProcessAlive: () => true,
    })
    expect(live.decision).toBe('refused')
    expect(live.reason).toBe(CLEANUP_REFUSAL.active)
    expect(JSON.parse(readFileSync(claimFile, 'utf8')).owner.pid).toBe(5151)
  })

  test('a reclaimer that reads the stale claim itself still takes it over', () => {
    const directory = leaseDirectoryForTest()
    claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-dead',
      identity,
      owner: { ...owner, pid: 4242 },
      isProcessAlive: () => false,
    })
    // The same run, restarting, takes its own record back.
    const takeover = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-dead',
      identity,
      owner: { ...owner, pid: 5151 },
      isProcessAlive: () => false,
    })
    expect(takeover.decision).toBe('granted')
    expect(takeover.claim?.runId).toBe('run-dead')
    expect(takeover.claim?.owner.pid).toBe(5151)
  })

  test('another run may take a stale record over, because the lock arbitrates it', () => {
    const directory = leaseDirectoryForTest()
    claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-dead',
      identity,
      owner: { ...owner, pid: 4242 },
      isProcessAlive: () => false,
    })
    const takeover = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-other',
      identity,
      owner: { ...owner, pid: 5151 },
      isProcessAlive: () => false,
    })
    expect(takeover.decision).toBe('granted')
    expect(takeover.claim?.runId).toBe('run-other')
    // The record on disk is the new holder's, and the lock is free again.
    const claimFile = join(directory, 'claims', 'adea-integration-reusable-agent-hq.claim')
    expect(JSON.parse(readFileSync(claimFile, 'utf8')).owner.pid).toBe(5151)
    const lockFile = join(directory, 'claims', 'adea-integration-reusable-agent-hq.lock')
    expect(existsSync(lockFile)).toBe(false)
  })

  test('a live lock is never broken, so a live claim is never displaced', () => {
    const directory = leaseDirectoryForTest()
    // A live process holds the claim.
    const held = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-live',
      identity,
      owner: { ...owner, pid: 4242 },
      isProcessAlive: (pid) => pid === 4242,
    })
    expect(held.decision).toBe('granted')
    // Another run, with the same run id and a different one, is refused.
    for (const runId of ['run-live', 'run-other']) {
      const refused = claimSharedResource({
        directory,
        resourceKey: identity.label,
        runId,
        identity,
        owner: { ...owner, pid: 5151 },
        isProcessAlive: (pid) => pid === 4242,
      })
      expect(refused.decision).toBe('refused')
      expect(refused.reason).toBe(CLEANUP_REFUSAL.active)
    }
    // The live holder's claim is exactly as it was.
    const claimFile = join(directory, 'claims', 'adea-integration-reusable-agent-hq.claim')
    expect(JSON.parse(readFileSync(claimFile, 'utf8')).owner.pid).toBe(4242)
  })
})

describe('a run own record that cannot be read', () => {
  test('a corrupt lease is refused, not overwritten', () => {
    const directory = leaseDirectoryForTest()
    writeFileSync(join(directory, 'run-a.json'), 'not json at all')
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity: disposableIdentity(),
      owner,
    })
    expect(claim.decision).toBe('refused')
    expect(claim.reason).toBe(CLEANUP_REFUSAL.uncertain)
    // The record that could not be read is still there: it was not overwritten.
    expect(readFileSync(join(directory, 'run-a.json'), 'utf8')).toBe('not json at all')
  })

  test('the reconciliation reports a record it cannot read as uncertain', () => {
    const directory = leaseDirectoryForTest()
    writeFileSync(join(directory, 'run-a.json'), 'not json at all')
    const reconciliation = reconcileLeases({
      directory,
      runId: 'run-b',
      identity: disposableIdentity(),
      now: 10_000_000_000,
    })
    expect(reconciliation.found).toEqual([
      { runId: 'run-a', label: null, state: LEASE_STATE.uncertain, own: false },
    ])
  })
})

describe('the receipt and a removal that was not confirmed', () => {
  test('a removal without a confirmed absence is not reported as removed', () => {
    const directory = leaseDirectoryForTest()
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity: disposableIdentity(),
      owner,
    })
    const plan = planCleanup({ lease: claim.lease, startedByThisRun: true, ownerPid: owner.pid })
    const receipt = cleanupReceipt({
      lease: claim.lease,
      decision: plan.decision,
      reason: plan.reason,
      resources: plan.resources.map((resource) => ({ ...resource, verifiedAbsent: false })),
      child: { status: 0, signal: null },
    })
    expect(receipt.removed).toEqual([])
    expect(receipt.unknown).toHaveLength(5)
  })

  test('a removal with a confirmed absence is reported as removed', () => {
    const directory = leaseDirectoryForTest()
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity: disposableIdentity(),
      owner,
    })
    const plan = planCleanup({ lease: claim.lease, startedByThisRun: true, ownerPid: owner.pid })
    const receipt = cleanupReceipt({
      lease: claim.lease,
      decision: plan.decision,
      reason: plan.reason,
      resources: plan.resources.map((resource) => ({ ...resource, verifiedAbsent: true })),
      child: { status: 0, signal: null },
    })
    expect(receipt.removed).toHaveLength(5)
    expect(receipt.unknown).toEqual([])
  })
})

describe('a lease record that is not a lease', () => {
  const invalidRecords: [string, string][] = [
    ['null', 'null'],
    ['false', 'false'],
    ['zero', '0'],
    ['an array', '[]'],
    ['an array of records', '[{"version":1}]'],
    ['a string', '"a lease"'],
    ['an object without a version', '{"runId":"run-a","identity":{"label":"l"}}'],
    ['an object without an identity', '{"version":1,"runId":"run-a"}'],
    ['an object with an empty label', '{"version":1,"runId":"run-a","identity":{"label":""}}'],
    ['an object with another version', '{"version":99,"runId":"run-a","identity":{"label":"l"}}'],
  ]

  for (const [name, content] of invalidRecords) {
    test(`${name} is not an absent lease, and the bytes on disk are not touched`, () => {
      const directory = leaseDirectoryForTest()
      const file = join(directory, 'run-a.json')
      writeFileSync(file, content)
      // The read distinguishes a file that is not there from a file that is
      // there and cannot be understood.
      expect(() => readLease(directory, 'run-a')).toThrow()
      // The bytes are exactly what they were.
      expect(readFileSync(file, 'utf8')).toBe(content)
    })
  }

  test('a file that is not there at all is an absence, not a failure', () => {
    const directory = leaseDirectoryForTest()
    expect(readLease(directory, 'run-never-wrote-one')).toBeNull()
  })

  test('a claim refuses a record it cannot understand and leaves it alone', () => {
    const directory = leaseDirectoryForTest()
    const file = join(directory, 'run-a.json')
    writeFileSync(file, 'null')
    const claim = claimResource({
      directory,
      runId: 'run-a',
      mode: RESOURCE_MODE.disposable,
      identity: disposableIdentity(),
      owner,
    })
    expect(claim.decision).toBe('refused')
    expect(claim.reason).toBe(CLEANUP_REFUSAL.uncertain)
    expect(readFileSync(file, 'utf8')).toBe('null')
  })

  test('a record that is not a lease is not a lease this model understands', () => {
    expect(isLeaseRecord(null)).toBe(false)
    expect(isLeaseRecord(false)).toBe(false)
    expect(isLeaseRecord(0)).toBe(false)
    expect(isLeaseRecord([])).toBe(false)
    expect(isLeaseRecord({})).toBe(false)
    expect(
      isLeaseRecord({
        version: 1,
        runId: 'run-a',
        identity: { label: 'adea-integration-reusable:x' },
      })
    ).toBe(true)
  })
})

/** The file that holds the claim on the shared instance. */
const claimFile = (directory: string) =>
  join(directory, 'claims', 'adea-integration-reusable-agent-hq.claim')

/** The file that holds the lock on the shared instance. */
const lockFile = (directory: string) =>
  join(directory, 'claims', 'adea-integration-reusable-agent-hq.lock')

describe('the lock and the token', () => {
  const identity = resourceIdentity({ mode: RESOURCE_MODE.reusable, runToken: 'a', port: '55432' })

  test('a residual lock is refused, and it is never recovered automatically', () => {
    const directory = leaseDirectoryForTest()
    mkdirSync(join(directory, 'claims'), { recursive: true })
    // A process died holding the lock. Its lock is still there.
    writeFileSync(
      lockFile(directory),
      `${JSON.stringify({
        version: 1,
        resourceKey: identity.label,
        runId: 'run-dead',
        identity,
        owner: { pid: 4242, hostname: 'synthetic-host', startedAt: null },
        token: 'residual-token',
        createdAt: 0,
      })}\n`
    )
    // Three contenders reach for the same resource. The lock is taken by no
    // automatic recovery, so every one of them is refused.
    for (const runId of ['run-a', 'run-b', 'run-c']) {
      const claim = claimSharedResource({
        directory,
        resourceKey: identity.label,
        runId,
        identity,
        owner: { ...owner, pid: 5151 },
        // The lock's owner is gone, and that is not a licence to bypass it.
        isProcessAlive: () => false,
      })
      expect(claim.decision).toBe('refused')
      expect(claim.reason).toBe(CLEANUP_REFUSAL.uncertain)
    }
    // The residual lock is exactly as it was, and no claim was written.
    expect(JSON.parse(readFileSync(lockFile(directory), 'utf8')).token).toBe('residual-token')
    expect(existsSync(claimFile(directory))).toBe(false)
  })

  test('two claims that share a run id never share a temporary record', () => {
    const directory = leaseDirectoryForTest()
    const first = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-shared',
      identity,
      owner: { ...owner, pid: 5151 },
      isProcessAlive: () => true,
    })
    expect(first.decision).toBe('granted')
    const firstToken = first.claim?.token
    // The claim is released, so the second claim of the same run id can be
    // taken, and it carries a record of its own.
    const released = releaseSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-shared',
      identity,
      token: firstToken,
    })
    expect(released.released).toBe(true)
    const second = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-shared',
      identity,
      owner: { ...owner, pid: 5151 },
      isProcessAlive: () => true,
    })
    expect(second.decision).toBe('granted')
    // The two records are told apart by their tokens, not by the run id.
    expect(second.claim?.token).not.toBe(firstToken)
    // No temporary record was left behind by either claim.
    const leftovers = readdirSync(join(directory, 'claims')).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  test('a claim is released only by the holder that took it', () => {
    const directory = leaseDirectoryForTest()
    const claim = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-holder',
      identity,
      owner: { ...owner, pid: 5151 },
      isProcessAlive: () => true,
    })
    expect(claim.decision).toBe('granted')
    // Another run, with the same run id, cannot release it: the token is what
    // says the claim is the holder's.
    const foreign = releaseSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-holder',
      identity,
      token: 'not-the-token',
    })
    expect(foreign.released).toBe(false)
    expect(existsSync(claimFile(directory))).toBe(true)
    // The holder can.
    const released = releaseSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-holder',
      identity,
      token: claim.claim?.token,
    })
    expect(released.released).toBe(true)
    expect(existsSync(claimFile(directory))).toBe(false)
  })

  test('a release is ordered under the lock, so it cannot interleave with a claim', () => {
    const directory = leaseDirectoryForTest()
    const claim = claimSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-holder',
      identity,
      owner: { ...owner, pid: 5151 },
      isProcessAlive: () => true,
    })
    expect(claim.decision).toBe('granted')
    // A residual lock stands in the way of the release, and the release
    // refuses rather than removing the record without the lock.
    mkdirSync(join(directory, 'claims'), { recursive: true })
    writeFileSync(
      lockFile(directory),
      `${JSON.stringify({
        version: 1,
        resourceKey: identity.label,
        runId: 'run-other',
        identity,
        owner: { pid: 9999, hostname: 'other-host', startedAt: null },
        token: 'residual-token',
        createdAt: 0,
      })}\n`
    )
    const released = releaseSharedResource({
      directory,
      resourceKey: identity.label,
      runId: 'run-holder',
      identity,
      token: claim.claim?.token,
    })
    expect(released.released).toBe(false)
    // The claim is still there, because the release never took the lock.
    expect(existsSync(claimFile(directory))).toBe(true)
  })
})
