// The integration lane's resource ownership model.
//
// The lane can start, reuse and stop a local PostgreSQL instance. Every one of
// those actions has to answer the same question first: may this run touch this
// resource? A resource name is not an ownership proof, a running container is
// not a lease, and a process that exited is not a cleanup.
//
// The model has three parts:
//
//   * a lease: a durable per-run record of what this run owns, written before
//     anything is created, so an interrupted run leaves evidence instead of an
//     unexplained resource;
//   * a claim: the exclusive right to use one resource, so two runs cannot
//     share an instance while one of them is live;
//   * a cleanup plan: what may be removed, what must be retained, and what
//     must be refused, with the reason recorded either way.
//
// Nothing here reaches Docker or a process boundary directly: the file system
// is local, and everything else is injected. The lifecycle can therefore be
// exercised with synthetic children and synthetic transports, and a test never
// needs a daemon, a container or a volume to prove the model.

import { hostname, tmpdir } from 'node:os'
import {
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** The two ways the lane may own its database instance. */
export const RESOURCE_MODE = {
  // One shared instance, reused by sequential runs. Its data outlives a run.
  reusable: 'reusable',
  // One uniquely labelled instance per run, removed when the run ends.
  disposable: 'disposable',
}

/** What a cleanup decision does to the resources it names. */
export const CLEANUP_DECISION = {
  remove: 'remove',
  stop: 'stop',
  retain: 'retain',
  refuse: 'refuse',
}

/** Why a cleanup was refused. A refusal is never silent. */
export const CLEANUP_REFUSAL = {
  // Another live run holds the resource.
  active: 'active',
  // The resource is not the one this run recorded.
  foreign: 'foreign',
  // The ownership could not be established, so nothing may be touched.
  uncertain: 'uncertain',
  // The caller supplied the target, so the caller owns it.
  callerOwned: 'caller-owned',
}

/** The states a lease can be in. */
export const LEASE_STATE = {
  active: 'active',
  stale: 'stale',
  foreign: 'foreign',
  uncertain: 'uncertain',
  settled: 'settled',
}

/** The kinds of resource the lane accounts for. */
export const RESOURCE_KIND = {
  container: 'container',
  volume: 'volume',
  network: 'network',
  database: 'database',
  data: 'data',
  worktree: 'worktree',
}

/**
 * What the lane may do with a resource it found.
 *
 * The vocabulary is deliberately small. A resource is reused, removed because
 * this run created it, kept on purpose, or protected because removing it would
 * be unsafe. Nothing else is a reason to touch a resource.
 */
export const RESOURCE_DISPOSITION = {
  reuse: 'reuse',
  removable: 'removable',
  retained: 'retained',
  protected: 'protected',
}

/** The outcome of the disk-pressure admission check. */
export const DISK_PRESSURE = {
  admitted: 'admitted',
  refused: 'refused',
}

/** How long a settled lease record is kept before the lane prunes it. */
export const DEFAULT_LEASE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** The claim record's version. A record of another version is not understood. */
export const CLAIM_VERSION = 1

/** The states a shared-resource claim can be in. */
export const CLAIM_STATE = {
  active: 'active',
  stale: 'stale',
  uncertain: 'uncertain',
}

/**
 * The liveness answer used when nothing can be established.
 *
 * A resource whose owner's liveness is unknown is a resource somebody else may
 * still be using, so an unknown liveness is treated as alive. The alternative
 * would let an unreadable ownership record hand a live resource to a second
 * run, and that is the failure this model exists to prevent.
 */
const UNKNOWN_LIVENESS_IS_ALIVE = () => true

/** The lease record's version. A record of another version is not understood. */
export const LEASE_VERSION = 1

/** The Compose project the shared, reusable instance lives in. */
export const REUSABLE_PROJECT = 'agent-hq'

/** The port the shared, reusable instance listens on. */
export const REUSABLE_PORT = '55432'

/** The volume the Compose stack declares, before the project name is added. */
const COMPOSE_VOLUME_KEY = 'agent-hq-postgres-data'

/** The database the Compose stack initialises. */
const COMPOSE_DATABASE = 'agent_hq'

/**
 * Reads the requested resource mode.
 *
 * The mode is explicit when it is set, and an unknown value is refused rather
 * than guessed: a run that cannot say which ownership rules apply must not
 * create a resource under rules it did not choose.
 */
export function resolveResourceMode(env = {}) {
  const requested = env.ADEA_INTEGRATION_RESOURCE_MODE
  if (requested === undefined || requested === '') return RESOURCE_MODE.disposable
  if (requested === RESOURCE_MODE.reusable || requested === RESOURCE_MODE.disposable) {
    return requested
  }
  throw new Error(
    `ADEA_INTEGRATION_RESOURCE_MODE must be ${RESOURCE_MODE.reusable} or ${RESOURCE_MODE.disposable}, not ${requested}`
  )
}

/**
 * Builds the run token that names a run's own resources.
 *
 * The token is derived from the clock and the process's own entropy, so two
 * concurrent runs never choose the same name for the same thing. It is
 * restricted to characters that are safe in a Compose project name, a file
 * name and a label, because the same token names all three.
 */
export function createRunToken({ now = Date.now, random = Math.random } = {}) {
  const clock = Math.trunc(now()).toString(36)
  const entropy = Math.trunc(random() * 0xffffffffff).toString(36)
  return `${clock}${entropy}`
}

/**
 * Derives the token a run's resources are named after.
 *
 * When the caller names the run, the token comes from that name. A restarted
 * run therefore keeps the same project, the same port and the same database
 * identity, which is what makes a restart a recovery rather than a second,
 * conflicting run. A generated token is only used for a run that did not name
 * itself.
 */
export function runTokenFor(runId, { now = Date.now, random = Math.random } = {}) {
  if (runId) {
    const token = String(runId)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (token === '') throw new Error('the run id does not name a resource')
    return token.slice(0, 48)
  }
  return createRunToken({ now, random })
}

/**
 * Reads whether a process is still running.
 *
 * The answer is conservative on purpose. A process on another host cannot be
 * probed from here, so its liveness is unknown, and an unknown liveness is
 * reported as alive: a resource held by a process we cannot see is a resource
 * we must not touch. A process we can see is probed with the null signal,
 * which asks whether it exists without disturbing it.
 */
export function processIsAlive(pid, ownerHostname) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (ownerHostname && ownerHostname !== hostname()) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // The process exists but this user may not signal it.
    return error?.code === 'EPERM'
  }
}

/**
 * Derives a port for a uniquely labelled instance.
 *
 * The port is derived from the run token rather than drawn at random, so a
 * restarted run keeps the port its own lease already names. The derivation can
 * collide with another process; the caller checks the port is free before it
 * binds it and refuses rather than sharing a port.
 */
export function deriveDisposablePort(runToken) {
  const value = Number.parseInt(String(runToken).slice(-8), 36)
  const offset = Number.isFinite(value) ? value % 40_000 : 0
  return String(20_000 + offset)
}

/**
 * Names the resources one run owns.
 *
 * A reusable instance has a fixed identity, because sequential runs must find
 * the same instance. A disposable instance carries the run token in its
 * identity, because its identity has to be unique to the run that created it.
 */
export function resourceIdentity({ mode, runToken, port, project = REUSABLE_PROJECT }) {
  if (mode === RESOURCE_MODE.reusable) {
    return {
      mode,
      label: `adea-integration-reusable:${project}`,
      project,
      container: `${project}-postgres-1`,
      volume: `${project}_${COMPOSE_VOLUME_KEY}`,
      network: `${project}_default`,
      port: String(port),
      database: COMPOSE_DATABASE,
    }
  }
  const disposableProject = `adea-int-d-${runToken}`
  return {
    mode,
    label: `adea-integration-disposable:${disposableProject}`,
    project: disposableProject,
    container: `${disposableProject}-postgres-1`,
    volume: `${disposableProject}_${COMPOSE_VOLUME_KEY}`,
    network: `${disposableProject}_default`,
    port: String(port),
    database: COMPOSE_DATABASE,
  }
}

/**
 * Names a target the caller owns.
 *
 * The identity names the endpoint and never a credential. A lease is a file,
 * and a file must not hold a password.
 */
export function callerIdentity(databaseUrl) {
  let url
  try {
    url = new URL(databaseUrl)
  } catch {
    throw new Error('the caller-owned target must be a database URL')
  }
  const database = url.pathname.replace(/^\//, '')
  return {
    mode: 'caller',
    label: `caller:${url.hostname}:${url.port || '5432'}/${database}`,
    project: null,
    container: null,
    volume: null,
    network: null,
    port: url.port || '5432',
    database,
  }
}

/**
 * The directory the leases are kept in.
 *
 * The directory is outside the checkout, so a run's evidence never becomes
 * repository state, and it can be pointed elsewhere by a caller that wants the
 * receipts to outlive the machine's temporary directory.
 */
export function leaseDirectory(env = {}) {
  const configured = env.ADEA_INTEGRATION_LEASE_DIR
  if (configured) return configured
  return join(tmpdir(), 'adea-integration-leases')
}

/** The lease file one run owns. */
export function leasePath(directory, runId) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(runId))) {
    throw new Error(`the run id ${runId} is not a safe lease name`)
  }
  return join(directory, `${runId}.json`)
}

/**
 * Writes a lease.
 *
 * The write is atomic: the record is written beside its target and renamed
 * over it, so a reader never sees half a lease and an interrupted write never
 * destroys the previous record.
 */
export function writeLease(directory, lease) {
  mkdirSync(directory, { recursive: true })
  const target = leasePath(directory, lease.runId)
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(lease, null, 2)}\n`)
  renameSync(temporary, target)
  return lease
}

/**
 * Reads one run's lease.
 *
 * An absent record and a record that cannot be read are different things. An
 * absent record is a run that never wrote one. A record that cannot be parsed
 * is a record whose ownership is unknown, and an unknown owner is never
 * overwritten, so the read fails loudly instead of looking like an absence.
 */
export function readLease(directory, runId) {
  let content
  try {
    content = readFileSync(leasePath(directory, runId), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(content)
  } catch (error) {
    throw new Error(`the lease for ${runId} cannot be read: ${error.message}`, { cause: error })
  }
}

/**
 * Reads every lease in the directory.
 *
 * The records that cannot be read are reported separately: they are not
 * leases, and they are not an absence either.
 */
export function scanLeases(directory) {
  const leases = []
  const unreadable = []
  let names
  try {
    names = readdirSync(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return { leases, unreadable }
    throw error
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      leases.push(JSON.parse(readFileSync(join(directory, name), 'utf8')))
    } catch {
      unreadable.push(name)
    }
  }
  return { leases, unreadable }
}

/** Reads every lease in the directory. An unreadable record is not a lease. */
export function listLeases(directory) {
  return scanLeases(directory).leases
}

/** Builds the lease one run starts with. */
export function leaseRecord({ runId, mode, identity, owner, now = Date.now }) {
  const startedAt = now()
  return {
    version: LEASE_VERSION,
    runId,
    mode,
    identity,
    owner: {
      pid: owner.pid,
      hostname: owner.hostname,
      startedAt: owner.startedAt ?? new Date(startedAt).toISOString(),
    },
    state: 'claimed',
    createdAt: startedAt,
    updatedAt: startedAt,
    cleanup: null,
  }
}

/** The owner record of the running process. */
export function currentOwner(pid = process.pid) {
  return { pid, hostname: hostname(), startedAt: new Date().toISOString() }
}

/**
 * Classifies a lease.
 *
 * The order matters. A record that is not understood is uncertain, and an
 * uncertain record is never treated as permission. A record that names a
 * different resource than the caller expects is foreign. Only a record whose
 * owner is still alive is active, and only a record whose owner is gone is
 * stale.
 */
export function classifyLease(
  lease,
  { isProcessAlive = UNKNOWN_LIVENESS_IS_ALIVE, expectedIdentity = null } = {}
) {
  if (!lease || typeof lease !== 'object') return LEASE_STATE.uncertain
  if (lease.version !== LEASE_VERSION) return LEASE_STATE.uncertain
  if (typeof lease.runId !== 'string' || lease.runId === '') return LEASE_STATE.uncertain
  if (!lease.identity || typeof lease.identity !== 'object') return LEASE_STATE.uncertain
  if (typeof lease.identity.label !== 'string' || lease.identity.label === '') {
    return LEASE_STATE.uncertain
  }
  if (expectedIdentity && lease.identity.label !== expectedIdentity.label) {
    return LEASE_STATE.foreign
  }
  if (lease.state === 'released' || lease.state === 'retained') return LEASE_STATE.settled
  if (!lease.owner || typeof lease.owner.pid !== 'number') return LEASE_STATE.uncertain
  // The owner is alive unless the probe says otherwise. A lease whose owner
  // lives on another host cannot be probed from here, and an unprobeable owner
  // is treated as a live owner.
  if (isProcessAlive(lease.owner.pid, lease.owner.hostname)) return LEASE_STATE.active
  return LEASE_STATE.stale
}

/**
 * The directory the shared claims live in.
 */
function claimsDirectory(directory) {
  return join(directory, 'claims')
}

/**
 * The file that holds the claim on one resource.
 *
 * The name is the resource's key, not a run's name: there is one file per
 * shared resource, so two runs that want the same resource argue over the
 * same file.
 */
function claimPath(directory, resourceKey) {
  const name = String(resourceKey).replace(/[^A-Za-z0-9._-]+/g, '-')
  if (name === '' || name === '.' || name === '..') {
    throw new Error('the resource key is not a safe claim name')
  }
  return join(claimsDirectory(directory), `${name}.claim`)
}

/**
 * Classifies a claim.
 *
 * A record that cannot be understood is uncertain, and an uncertain claim is
 * never taken: the owner of a record we cannot read is unknown, and an unknown
 * owner keeps what it holds.
 */
export function classifyClaim(claim, { isProcessAlive = UNKNOWN_LIVENESS_IS_ALIVE } = {}) {
  if (!claim || typeof claim !== 'object') return CLAIM_STATE.uncertain
  if (claim.version !== CLAIM_VERSION) return CLAIM_STATE.uncertain
  if (typeof claim.resourceKey !== 'string' || claim.resourceKey === '') {
    return CLAIM_STATE.uncertain
  }
  if (!claim.identity || typeof claim.identity.label !== 'string') {
    return CLAIM_STATE.uncertain
  }
  if (!claim.owner || typeof claim.owner.pid !== 'number') return CLAIM_STATE.uncertain
  if (isProcessAlive(claim.owner.pid, claim.owner.hostname)) return CLAIM_STATE.active
  return CLAIM_STATE.stale
}

/**
 * Takes the exclusive right to use one shared resource.
 *
 * The claim is one file per resource, created with an exclusive create. Two
 * processes that ask at the same time cannot both create it: one wins, and
 * the other reads the winner's record and refuses. A scan of per-run records
 * cannot do that, because two processes can both read an empty directory and
 * then both write into it.
 *
 * A claim whose owner is gone may be taken over, but only by a run that names
 * the same resource identity, so a takeover can never point a shared resource
 * at a different project. A claim that cannot be read is uncertain, and an
 * uncertain claim is never taken.
 */
export function claimSharedResource({
  directory,
  resourceKey,
  runId,
  identity,
  owner,
  now = Date.now,
  isProcessAlive = UNKNOWN_LIVENESS_IS_ALIVE,
  // A seam for the interleaving regression: it runs after a stale claim has
  // been read and before it is moved aside, so a test can let a second
  // reclaimer finish in between.
  afterClaimRead = null,
}) {
  mkdirSync(claimsDirectory(directory), { recursive: true })
  const path = claimPath(directory, resourceKey)
  for (let attempt = 0; attempt < 4; attempt++) {
    let raw = null
    let existing = null
    try {
      raw = readFileSync(path, 'utf8')
      existing = JSON.parse(raw)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // The claim is there but cannot be understood. Its owner is unknown,
        // and an unknown owner is never displaced.
        return { decision: 'refused', reason: CLEANUP_REFUSAL.uncertain, claim: null }
      }
    }
    if (existing) {
      const state = classifyClaim(existing, { isProcessAlive })
      if (state === CLAIM_STATE.active) {
        return { decision: 'refused', reason: CLEANUP_REFUSAL.active, claim: existing }
      }
      if (state === CLAIM_STATE.uncertain) {
        return { decision: 'refused', reason: CLEANUP_REFUSAL.uncertain, claim: existing }
      }
      if (existing.identity?.label && existing.identity.label !== identity.label) {
        // The resource belongs to another identity. It is never taken.
        return { decision: 'refused', reason: CLEANUP_REFUSAL.foreign, claim: existing }
      }
      // The owner is gone and the identity matches. The stale record is moved
      // aside before it is replaced, and the moved file is compared with the
      // one that was read. If they differ, another reclaimer wrote a fresh
      // claim in between, and this one puts it back and refuses: two reclaimers
      // must never both end up holding the claim, and one of them must never
      // delete the other's live claim.
      if (typeof afterClaimRead === 'function') {
        afterClaimRead({ raw, claim: existing })
      }
      const aside = `${path}.aside-${runId}-${attempt}`
      try {
        renameSync(path, aside)
      } catch {
        // The claim moved or vanished under us. The next attempt reads again.
        continue
      }
      let asideContent = null
      try {
        asideContent = readFileSync(aside, 'utf8')
      } catch {
        asideContent = null
      }
      if (asideContent !== raw) {
        // The record that was moved was not the record that was read, so a live
        // claim was displaced. It is put back and the claim is refused.
        try {
          renameSync(aside, path)
        } catch {
          // The claim stays where it is; the holder reads it and refuses.
        }
        return { decision: 'refused', reason: CLEANUP_REFUSAL.active, claim: null }
      }
      try {
        rmSync(aside, { force: true })
      } catch {
        // The stale record is out of the claim path either way.
      }
      continue
    }
    const record = {
      version: CLAIM_VERSION,
      resourceKey,
      runId,
      identity,
      owner: {
        pid: owner.pid,
        hostname: owner.hostname,
        startedAt: owner.startedAt ?? null,
      },
      createdAt: now(),
    }
    // The record is written in full beside the claim and then linked onto it.
    // A link is atomic and refuses an existing target, so the claim path only
    // ever appears complete, and only one reclaimer can create it. A reader
    // never sees a half-written record and never has to guess what it says.
    const temporary = `${path}.${runId}.${attempt}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`)
      linkSync(temporary, path)
      return { decision: 'granted', claim: record }
    } catch (error) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // The temporary record is not the claim; leaving it behind is untidy
        // but harmless.
      }
      if (error?.code === 'EEXIST') continue
      return { decision: 'refused', reason: CLEANUP_REFUSAL.uncertain, claim: null }
    }
  }
  return { decision: 'refused', reason: CLEANUP_REFUSAL.active, claim: null }
}

/**
 * Releases a claim on a shared resource.
 *
 * Only the run that holds the claim may release it, and only for the same
 * identity it recorded. A claim held by another run is left alone.
 */
export function releaseSharedResource({ directory, resourceKey, runId, identity }) {
  const path = claimPath(directory, resourceKey)
  let existing = null
  try {
    existing = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { released: false, reason: 'the claim could not be read' }
  }
  if (existing.runId !== runId) {
    return { released: false, reason: 'the claim belongs to another run' }
  }
  if (existing.identity?.label !== identity.label) {
    return { released: false, reason: 'the claim names another identity' }
  }
  try {
    rmSync(path, { force: true })
    return { released: true }
  } catch (error) {
    return { released: false, reason: error.message }
  }
}

/**
 * The marker for a lease record that exists but cannot be read.
 */
const UNREADABLE = Symbol('unreadable-lease')

/**
 * Reads one run's lease, or the marker when the record cannot be read.
 */
function readLeaseSafely(directory, runId) {
  try {
    return readLease(directory, runId)
  } catch {
    return UNREADABLE
  }
}

/**
 * Claims the right to use one resource.
 *
 * A run that already holds a lease for this run id may take it back: that is
 * the restart path, and the run id is the proof that the resource is its own.
 * A live owner refuses the claim, because two live runs must not share one
 * instance. A shared, reusable instance is additionally exclusive, so a
 * second live run cannot take it while the first one holds it.
 */
export function claimResource({
  directory,
  runId,
  mode,
  identity,
  owner,
  now = Date.now,
  isProcessAlive = UNKNOWN_LIVENESS_IS_ALIVE,
}) {
  const existing = readLeaseSafely(directory, runId)
  if (existing === UNREADABLE) {
    // The run's own record cannot be read. Its ownership is unknown, and an
    // unknown owner is never overwritten.
    return { decision: 'refused', reason: CLEANUP_REFUSAL.uncertain, lease: null }
  }
  if (existing) {
    const state = classifyLease(existing, { isProcessAlive, expectedIdentity: identity })
    if (state === LEASE_STATE.foreign) {
      return { decision: 'refused', reason: CLEANUP_REFUSAL.foreign, lease: existing }
    }
    if (state === LEASE_STATE.active) {
      return { decision: 'refused', reason: CLEANUP_REFUSAL.active, lease: existing }
    }
    if (state === LEASE_STATE.uncertain) {
      return { decision: 'refused', reason: CLEANUP_REFUSAL.uncertain, lease: existing }
    }
    const lease = leaseRecord({ runId, mode, identity, owner, now })
    lease.adopted = {
      from: existing.runId,
      previousState: state,
      previousOwner: existing.owner ?? null,
    }
    writeLease(directory, lease)
    return { decision: 'granted', reason: 'reclaimed', lease, reclaimed: true }
  }

  const lease = leaseRecord({ runId, mode, identity, owner, now })
  writeLease(directory, lease)
  return { decision: 'granted', reason: 'claimed', lease }
}

/**
 * Decides what may be done to the resources a run names.
 *
 * The decision is about ownership, not about convenience. A caller-owned
 * target is refused outright, because the caller owns it. A resource another
 * live run holds is refused, because it is in use. A record that does not
 * describe the resource at hand is refused, because its ownership is foreign.
 * A reusable instance is retained, because that is what reuse means. Only an
 * instance this run created and labelled is removed.
 */
export function planCleanup({
  lease,
  expectedIdentity = null,
  ownership = 'owned',
  startedByThisRun = false,
  ownerPid = process.pid,
  retainedPaths = [],
  isProcessAlive = UNKNOWN_LIVENESS_IS_ALIVE,
}) {
  const identity = lease?.identity
  const named = [
    { kind: RESOURCE_KIND.container, name: identity?.container ?? null },
    { kind: RESOURCE_KIND.volume, name: identity?.volume ?? null },
    { kind: RESOURCE_KIND.network, name: identity?.network ?? null },
  ].filter((resource) => typeof resource.name === 'string' && resource.name !== '')
  // The database and the isolated test data inside it travel with the volume.
  // The lease's own records are this lane's evidence: they are kept, and the
  // retention bound is what keeps them bounded.
  const data = [
    {
      kind: RESOURCE_KIND.database,
      name: identity?.database ?? null,
      attachedTo: identity?.volume ?? null,
    },
    {
      kind: RESOURCE_KIND.data,
      name: identity?.database ? `${identity.database} data` : null,
      attachedTo: identity?.volume ?? null,
    },
  ].filter((resource) => typeof resource.name === 'string' && resource.name !== '')
  // A checkout is never this lane's to remove. It is named in the receipt so
  // that a reader can see the lane kept it.
  const checkouts = retainedPaths.map((path) => ({
    kind: RESOURCE_KIND.worktree,
    name: path,
    action: 'retained',
    reason: 'the integration lane never removes a checkout',
    verifiedAbsent: null,
  }))

  if (ownership === 'caller' || lease?.mode === 'caller') {
    return {
      decision: CLEANUP_DECISION.refuse,
      reason: CLEANUP_REFUSAL.callerOwned,
      // A caller-owned target names no container and no volume of its own, so
      // there is nothing here to remove. The receipt still names the target.
      resources: [
        ...data.map((resource) => ({
          ...resource,
          action: 'refused',
          reason: CLEANUP_REFUSAL.callerOwned,
          verifiedAbsent: null,
        })),
        ...checkouts,
      ],
    }
  }

  // The lease has to describe the resource the caller is about to act on. A
  // lease that names something else is foreign, and a foreign resource is not
  // this run's to touch.
  const state = classifyLease(lease, { isProcessAlive, expectedIdentity })
  if (state === LEASE_STATE.foreign) {
    return {
      decision: CLEANUP_DECISION.refuse,
      reason: CLEANUP_REFUSAL.foreign,
      resources: [
        ...[...named, ...data].map((resource) => ({
          ...resource,
          action: 'refused',
          reason: CLEANUP_REFUSAL.foreign,
          verifiedAbsent: null,
        })),
        ...checkouts,
      ],
    }
  }
  if (state === LEASE_STATE.uncertain) {
    return {
      decision: CLEANUP_DECISION.refuse,
      reason: CLEANUP_REFUSAL.uncertain,
      resources: [
        ...[...named, ...data].map((resource) => ({
          ...resource,
          action: 'refused',
          reason: CLEANUP_REFUSAL.uncertain,
          verifiedAbsent: null,
        })),
        ...checkouts,
      ],
    }
  }
  // A live owner that is not this process holds the resource in use. The run
  // that is cleaning up may only touch what it owns.
  if (state === LEASE_STATE.active && lease.owner?.pid !== ownerPid) {
    return {
      decision: CLEANUP_DECISION.refuse,
      reason: CLEANUP_REFUSAL.active,
      resources: [
        ...[...named, ...data].map((resource) => ({
          ...resource,
          action: 'refused',
          reason: CLEANUP_REFUSAL.active,
          verifiedAbsent: null,
        })),
        ...checkouts,
      ],
    }
  }

  if (lease.mode === RESOURCE_MODE.reusable) {
    return {
      decision: CLEANUP_DECISION.stop,
      reason: startedByThisRun ? 'reusable-instance-stopped' : 'reusable-instance-not-owned',
      resources: [
        {
          kind: RESOURCE_KIND.container,
          name: identity.container,
          action: startedByThisRun ? 'stopped' : 'retained',
          reason: startedByThisRun
            ? 'this run started the shared instance, so this run stops it'
            : 'the shared instance was already running and this run does not own it',
          verifiedAbsent: null,
        },
        {
          kind: RESOURCE_KIND.volume,
          name: identity.volume,
          action: 'retained',
          reason: 'the shared instance is kept for the next sequential run',
          verifiedAbsent: null,
        },
        {
          kind: RESOURCE_KIND.network,
          name: identity.network,
          action: 'retained',
          reason: 'the shared network is kept for the next sequential run',
          verifiedAbsent: null,
        },
        ...data.map((resource) => ({
          ...resource,
          action: 'retained',
          reason: 'the shared instance keeps its data for the next sequential run',
          verifiedAbsent: null,
        })),
        ...checkouts,
      ],
    }
  }

  return {
    decision: CLEANUP_DECISION.remove,
    reason: 'disposable-instance-owned-by-this-run',
    resources: [
      ...named.map((resource) => ({
        ...resource,
        action: 'removed',
        reason: 'this run created and labelled this resource',
        verifiedAbsent: null,
      })),
      ...data.map((resource) => ({
        ...resource,
        action: 'removed',
        reason: 'the isolated test data goes with the volume this run created',
        verifiedAbsent: null,
      })),
      ...checkouts,
    ],
  }
}

/**
 * Builds the cleanup receipt.
 *
 * The receipt separates what happened to the run's process from what happened
 * to the run's resources. A child that exited is not a removed container, and a
 * resource that was retained is not a failure. Every resource is accounted
 * for: removed, stopped, retained or refused, each with the reason it ended
 * that way.
 */
export function cleanupReceipt({ lease, decision, reason, resources, child = null, errors = [] }) {
  const accounted = resources.map((resource) => ({
    kind: resource.kind,
    name: resource.name,
    action: resource.action,
    reason: resource.reason ?? null,
    verifiedAbsent: resource.verifiedAbsent ?? null,
  }))
  return {
    version: LEASE_VERSION,
    runId: lease.runId,
    mode: lease.mode,
    identity: lease.identity,
    decidedAt: new Date().toISOString(),
    decision,
    reason: reason ?? null,
    child: child
      ? { exited: true, status: child.status ?? null, signal: child.signal ?? null }
      : { exited: false, status: null, signal: null },
    resources: accounted,
    // A resource counts as removed only when its absence was confirmed. A
    // removal that was attempted is not a removal that happened.
    removed: accounted
      .filter((resource) => resource.action === 'removed' && resource.verifiedAbsent === true)
      .map((r) => r.name),
    stopped: accounted.filter((resource) => resource.action === 'stopped').map((r) => r.name),
    retained: accounted.filter((resource) => resource.action === 'retained').map((r) => r.name),
    refused: accounted.filter((resource) => resource.action === 'refused').map((r) => r.name),
    unknown: accounted
      .filter(
        (resource) =>
          resource.action === 'unknown' ||
          (resource.action === 'removed' && resource.verifiedAbsent !== true)
      )
      .map((r) => r.name),
    errors: [...errors],
  }
}

/**
 * Settles a lease with its cleanup receipt.
 *
 * The receipt is kept in the lease, so the evidence outlives the process that
 * wrote it and a later run can read what the earlier run did and did not
 * remove.
 */
export function releaseLease({ directory, runId, receipt }) {
  const existing = readLeaseSafely(directory, runId)
  if (!existing || existing === UNREADABLE) return null
  const settled = {
    ...existing,
    state: 'released',
    updatedAt: Date.now(),
    cleanup: receipt,
  }
  writeLease(directory, settled)
  return settled
}

/**
 * Decides whether the lane may start a disposable instance on this disk.
 *
 * The lane creates storage, so it asks first. A run that cannot read the
 * available space is refused, because an unknown disk is not a free disk, and
 * a run that would fill it is refused before it creates anything. The floor is
 * the lane's own: below it, nothing is started and nothing is claimed.
 */
export function diskPressureAdmission({ availableBytes, requiredBytes = 0, limitBytes = 0 } = {}) {
  if (!Number.isFinite(availableBytes) || availableBytes < 0) {
    return {
      decision: DISK_PRESSURE.refused,
      reason: 'the available disk space could not be established',
      availableBytes: null,
    }
  }
  if (Number.isFinite(limitBytes) && limitBytes > 0 && availableBytes < limitBytes) {
    return {
      decision: DISK_PRESSURE.refused,
      reason: `the available disk space is below the lane's floor of ${limitBytes} bytes`,
      availableBytes,
    }
  }
  if (Number.isFinite(requiredBytes) && requiredBytes > 0 && availableBytes < requiredBytes) {
    return {
      decision: DISK_PRESSURE.refused,
      reason: `the available disk space is below the ${requiredBytes} bytes this run needs`,
      availableBytes,
    }
  }
  return {
    decision: DISK_PRESSURE.admitted,
    reason: 'there is room for this run',
    availableBytes,
  }
}

/**
 * Decides what may be done with one Docker resource.
 *
 * The Compose project label is the ownership proof. A resource that carries
 * this run's label was created by this run and may be removed. A resource that
 * carries another label belongs to someone else and is protected. A resource
 * whose label cannot be read has an unknown owner, and an unknown owner is
 * protected: a volume that is merely unattached is not evidence of anything,
 * and an unattached volume is never safe to delete.
 */
export function classifyDockerResource(
  resource,
  { identity, leases = [], isProcessAlive = UNKNOWN_LIVENESS_IS_ALIVE } = {}
) {
  const kind = resource.kind
  const name = resource.name
  const label = resource.label ?? null

  if (kind === 'image') {
    return {
      disposition: RESOURCE_DISPOSITION.reuse,
      reason: 'the image is pinned by digest and shared by every run',
    }
  }
  if (!name) {
    return {
      disposition: RESOURCE_DISPOSITION.protected,
      reason: 'the resource has no name, so it cannot be owned',
    }
  }
  if (!identity?.project) {
    return {
      disposition: RESOURCE_DISPOSITION.protected,
      reason: 'this run owns no project, so it owns no resource',
    }
  }
  if (!label) {
    return {
      disposition: RESOURCE_DISPOSITION.protected,
      reason:
        kind === RESOURCE_KIND.volume
          ? 'the volume carries no project label, and an unattached volume is never safe to delete'
          : 'the resource carries no project label, so its owner is unknown',
    }
  }
  if (label !== identity.project) {
    return {
      disposition: RESOURCE_DISPOSITION.protected,
      reason: `the resource belongs to the ${label} project`,
    }
  }
  for (const lease of leases) {
    if (lease.runId === identity.runId) continue
    if (lease.identity?.label !== identity.label) continue
    if (classifyLease(lease, { isProcessAlive }) === LEASE_STATE.active) {
      return {
        disposition: RESOURCE_DISPOSITION.protected,
        reason: `the resource is held by the live run ${lease.runId}`,
      }
    }
  }
  return {
    disposition: RESOURCE_DISPOSITION.removable,
    reason: 'this run created the resource and labelled it',
  }
}

/**
 * Builds the dry-run inventory of what the lane can see.
 *
 * The inventory is a report, not an action. Every resource is named with the
 * disposition it would receive and the reason, so an operator can read what a
 * cleanup would do before anything is done. A resource that is merely
 * unattached is protected here, and a resource that belongs to another run is
 * protected here.
 */
export function buildInventory({ resources, identity, leases = [], now = Date.now } = {}) {
  const items = (resources ?? []).map((resource) => {
    const decision = classifyDockerResource(resource, { identity, leases })
    return {
      kind: resource.kind,
      name: resource.name ?? null,
      label: resource.label ?? null,
      present: resource.present !== false,
      attached: resource.attached ?? null,
      disposition: decision.disposition,
      reason: decision.reason,
    }
  })
  const counts = {}
  for (const item of items) {
    counts[item.disposition] = (counts[item.disposition] ?? 0) + 1
  }
  return {
    generatedAt: now(),
    identity: identity?.label ?? null,
    items,
    counts,
  }
}

/**
 * Prunes the lane's own settled lease records once they are older than the
 * retention bound.
 *
 * Only a settled record is pruned: a record whose owner is alive, a record that
 * cannot be understood, and a record that is still in use are all kept. The
 * pruning touches this lane's own records and nothing else. It never touches a
 * Docker resource, and a stale record is evidence, not an instruction.
 */
export function pruneSettledLeases({
  directory,
  now = Date.now,
  retentionMs = DEFAULT_LEASE_RETENTION_MS,
  isProcessAlive = UNKNOWN_LIVENESS_IS_ALIVE,
} = {}) {
  // The clock is a function, and it is called. A clock that is not callable, or
  // that answers something that is not a time, and a bound that is not a
  // duration, leave the records alone: an unusable clock is not a reason to
  // delete evidence.
  const clock = typeof now === 'function' ? now() : now
  if (!Number.isFinite(clock) || !Number.isFinite(retentionMs) || retentionMs < 0) {
    return []
  }
  const pruned = []
  for (const lease of listLeases(directory)) {
    if (classifyLease(lease, { isProcessAlive }) !== LEASE_STATE.settled) continue
    const settledAt = lease.updatedAt ?? lease.createdAt ?? 0
    if (!Number.isFinite(settledAt) || clock - settledAt < retentionMs) continue
    try {
      rmSync(leasePath(directory, lease.runId), { force: true })
      pruned.push(lease.runId)
    } catch {
      // A record that cannot be pruned is kept: a bound on the evidence is
      // better than losing the evidence.
    }
  }
  return pruned
}

/**
 * Reconciles the lease directory with the run that is starting.
 *
 * The reconciliation reports what the lane's own records say. It takes back
 * the record of a run that is restarting with the same identity, prunes the
 * settled records that are older than the retention bound, and leaves every
 * other record alone. A record left by a dead run is evidence of a resource
 * that still exists; removing that resource is an operator's decision, not the
 * lane's.
 */
export function reconcileLeases({
  directory,
  runId,
  identity,
  now = Date.now,
  retentionMs = DEFAULT_LEASE_RETENTION_MS,
  isProcessAlive = UNKNOWN_LIVENESS_IS_ALIVE,
} = {}) {
  const { leases, unreadable } = scanLeases(directory)
  const found = []
  for (const lease of leases) {
    found.push({
      runId: lease.runId,
      label: lease.identity?.label ?? null,
      state: classifyLease(lease, { isProcessAlive }),
      own: lease.runId === runId,
    })
  }
  // A record that cannot be read is reported as uncertain. It is not an
  // absence, and it is not touched.
  for (const name of unreadable) {
    found.push({
      runId: name.replace(/\.json$/, ''),
      label: null,
      state: LEASE_STATE.uncertain,
      own: false,
    })
  }
  const pruned = pruneSettledLeases({ directory, now, retentionMs, isProcessAlive })
  return {
    runId,
    identity: identity?.label ?? null,
    found,
    pruned,
    takenBack: found.some((record) => record.own && record.state !== LEASE_STATE.settled),
  }
}

/**
 * Summarises a receipt as one line a run can print.
 *
 * The line is about outcomes, not intentions: what was removed, what was kept,
 * what was refused, and whether the child itself failed.
 */
export function summariseReceipt(receipt) {
  const parts = [
    `decision=${receipt.decision}`,
    receipt.reason ? `reason=${receipt.reason}` : null,
    receipt.removed.length ? `removed=${receipt.removed.join(',')}` : null,
    receipt.stopped.length ? `stopped=${receipt.stopped.join(',')}` : null,
    receipt.retained.length ? `retained=${receipt.retained.join(',')}` : null,
    receipt.refused.length ? `refused=${receipt.refused.join(',')}` : null,
    `child=${receipt.child.exited ? `exited:${receipt.child.status ?? receipt.child.signal}` : 'unknown'}`,
  ].filter(Boolean)
  return parts.join(' ')
}
