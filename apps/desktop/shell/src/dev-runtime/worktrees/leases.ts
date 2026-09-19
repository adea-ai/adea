// Worktree lease authority.
//
// A lease is the durable ownership record a terminal, harness, browser, device,
// server, or editor holds on a worktree. Leases heartbeat every 15 seconds and
// become suspect after 45 seconds, but expiry and suspect state never grant
// destructive authority: cleanup must reconcile the owner (prove it gone) or
// obtain an explicit release. Expiry only makes the lease eligible for
// reconciliation, exactly as the Dev Runtime spec requires.
import { join } from 'node:path'

import { nowIso, newRecordId, sameScope, type DevScope } from '../authority'
import { createDurableJsonStore } from '../host-store'
import { WorktreeError } from './errors'

export const LEASE_HEARTBEAT_MS = 15_000
export const LEASE_SUSPECT_AFTER_MS = 45_000
export const LEASE_MIN_TTL_S = 15
export const LEASE_MAX_TTL_S = 86_400

export type LeaseOwnerKind = 'terminal' | 'harness' | 'browser' | 'device' | 'server' | 'editor'

export type LeaseRecord = Readonly<{
  id: string
  scope: DevScope
  worktreeId: string
  ownerKind: LeaseOwnerKind
  ownerId: string
  generation: number
  state: 'active' | 'suspect' | 'expired' | 'released'
  acquiredAt: string
  heartbeatAt: string
  expiresAt?: string
  releasedAt?: string
}>

export type LeaseView = Readonly<{
  lease: LeaseRecord
  effectiveState: LeaseRecord['state']
  heartbeatAgeMs: number
}>

function findOwned(
  records: LeaseRecord[],
  scope: DevScope,
  worktreeId: string,
  leaseId: string
): LeaseRecord {
  const record = records.find((entry) => entry.id === leaseId)
  if (!record || record.worktreeId !== worktreeId || !sameScope(record.scope, scope)) {
    // Cross-scope and unknown reads are indistinguishable: not found.
    throw new WorktreeError('not_found', 'lease not found')
  }
  return record
}

export function createLeaseStore(options: {
  dataDir: string
  clock?: () => Date
  suspectAfterMs?: number
}) {
  const { dataDir, clock = () => new Date(), suspectAfterMs = LEASE_SUSPECT_AFTER_MS } = options
  const store = createDurableJsonStore<LeaseRecord>({
    file: join(dataDir, 'dev-runtime', 'worktrees', 'leases.json'),
    schemaVersion: 1,
    label: 'worktree lease',
  })

  function loadAll(): LeaseRecord[] {
    return [...store.load().records]
  }

  function persist(records: LeaseRecord[]): void {
    store.save(records)
  }

  /** The observed state a consumer sees: stored state plus heartbeat-derived
   *  suspect/expiry. The stored record is the durable fact; the view is the
   *  projection. */
  function view(record: LeaseRecord): LeaseView {
    const at = clock().getTime()
    if (record.state === 'released')
      return { lease: record, effectiveState: 'released', heartbeatAgeMs: 0 }
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= at) {
      return {
        lease: record,
        effectiveState: 'expired',
        heartbeatAgeMs: at - new Date(record.heartbeatAt).getTime(),
      }
    }
    if (at - new Date(record.heartbeatAt).getTime() > suspectAfterMs) {
      return {
        lease: record,
        effectiveState: 'suspect',
        heartbeatAgeMs: at - new Date(record.heartbeatAt).getTime(),
      }
    }
    return {
      lease: record,
      effectiveState: record.state,
      heartbeatAgeMs: at - new Date(record.heartbeatAt).getTime(),
    }
  }

  function activeViews(worktreeId: string): LeaseView[] {
    return loadAll()
      .filter((entry) => entry.worktreeId === worktreeId && entry.state !== 'released')
      .map(view)
  }

  return Object.freeze({
    /** Acquire one lease for an owner. Callers bind the worktree's current
     *  generation so a lease can never outlive the generation it was granted
     *  against. */
    acquire(input: {
      scope: DevScope
      worktreeId: string
      worktreeGeneration: number
      ownerKind: LeaseOwnerKind
      ownerId: string
      ttlSeconds?: number
    }): LeaseRecord {
      if (input.ownerId.length < 1 || input.ownerId.length > 256) {
        throw new WorktreeError('invalid_state', 'lease owner id must be 1..256 characters')
      }
      const ttlSeconds = input.ttlSeconds ?? 900
      if (
        !Number.isSafeInteger(ttlSeconds) ||
        ttlSeconds < LEASE_MIN_TTL_S ||
        ttlSeconds > LEASE_MAX_TTL_S
      ) {
        throw new WorktreeError(
          'limit_exceeded',
          `lease ttl must be an integer ${LEASE_MIN_TTL_S}..${LEASE_MAX_TTL_S} seconds`
        )
      }
      const records = loadAll()
      const at = clock()
      const record: LeaseRecord = {
        id: newRecordId(),
        scope: { ...input.scope },
        worktreeId: input.worktreeId,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
        generation: input.worktreeGeneration,
        state: 'active',
        acquiredAt: at.toISOString(),
        heartbeatAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + ttlSeconds * 1_000).toISOString(),
      }
      records.push(record)
      persist(records)
      return record
    },

    heartbeat(input: { scope: DevScope; worktreeId: string; leaseId: string }): LeaseView {
      const records = loadAll()
      const record = findOwned(records, input.scope, input.worktreeId, input.leaseId)
      if (record.state === 'released') {
        throw new WorktreeError('invalid_state', 'released lease cannot heartbeat')
      }
      const at = clock()
      const next: LeaseRecord = { ...record, heartbeatAt: at.toISOString() }
      const index = records.indexOf(record)
      records[index] = next
      persist(records)
      return view(next)
    },

    release(input: { scope: DevScope; worktreeId: string; leaseId: string }): LeaseRecord {
      const records = loadAll()
      const record = findOwned(records, input.scope, input.worktreeId, input.leaseId)
      const next: LeaseRecord = { ...record, state: 'released', releasedAt: nowIso(clock) }
      const index = records.indexOf(record)
      records[index] = next
      persist(records)
      return next
    },

    /** Explicitly prove an owner gone and retire its lease (reconciliation).
     *  Destructive cleanup may proceed only through this or an explicit
     *  release by the owner — never through expiry alone. */
    reconcileExpired(input: { scope: DevScope; worktreeId: string; leaseId: string }): LeaseRecord {
      const records = loadAll()
      const record = findOwned(records, input.scope, input.worktreeId, input.leaseId)
      const observed = view(record)
      if (observed.effectiveState !== 'expired' && observed.effectiveState !== 'suspect') {
        throw new WorktreeError(
          'leased',
          'lease is still live; reconciliation requires expiry or suspect state'
        )
      }
      const next: LeaseRecord = { ...record, state: 'expired' }
      const index = records.indexOf(record)
      records[index] = next
      persist(records)
      return next
    },

    list(worktreeId: string): LeaseView[] {
      return activeViews(worktreeId)
    },

    view,

    /** Destructive-cleanup gate: true only when no live (active/suspect) lease
     *  remains. Expired leases must be reconciled or released explicitly first. */
    hasLiveLeases(worktreeId: string): boolean {
      return activeViews(worktreeId).some(
        (entry) => entry.effectiveState === 'active' || entry.effectiveState === 'suspect'
      )
    },
  })
}

export type LeaseStore = ReturnType<typeof createLeaseStore>
