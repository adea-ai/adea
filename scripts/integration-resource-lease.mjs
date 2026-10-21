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

import { randomUUID } from 'node:crypto'
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
  // Two reclaimers could reach for the same stale record, and nothing here can
  // prove which of them is entitled to it.
  unsafeArbitration: 'unsafe-arbitration',
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

/**
 * The shape of a token. Only this model issues one.
 */
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

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
 * The directory the lease locks live in.
 */
function leaseLocksDirectory(directory) {
  return join(directory, 'locks')
}

/**
 * The file that holds the lock on one lease record.
 */
function leaseLockPath(directory, runId) {
  const name = String(runId).replace(/[^A-Za-z0-9._-]+/g, '-')
  if (name === '' || name === '.' || name === '..') {
    throw new Error('the run id is not a safe lock name')
  }
  return join(leaseLocksDirectory(directory), `${name}.lock`)
}

/**
 * Waits without yielding the event loop.
 *
 * The lock is held for a moment and the wait is a few milliseconds, so a
 * writer that meets the pruner waits rather than failing.
 */
function sleepSync(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/**
 * Takes the lock that serialises the writers and the pruner of one record.
 *
 * The lease's writers and the pruner take the same lock, so a record is never
 * written while it is being pruned, and a record is never pruned while it is
 * being written. A lock that cannot be taken is not taken: the caller either
 * waits for it or preserves the record.
 */
function acquireLeaseLock(directory, runId, { attempts = 1, sleepMs = 0 } = {}) {
  try {
    mkdirSync(leaseLocksDirectory(directory), { recursive: true })
  } catch {
    return { acquired: false, reason: CLEANUP_REFUSAL.uncertain }
  }
  const path = leaseLockPath(directory, runId)
  const token = uniqueToken()
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    const temporary = `${path}.${token}.tmp`
    try {
      writeFileSync(
        temporary,
        `${JSON.stringify({ version: LEASE_VERSION, runId, token, pid: process.pid, at: Date.now() })}\n`,
        { flag: 'wx' }
      )
      linkSync(temporary, path)
      try {
        rmSync(temporary, { force: true })
      } catch {
        // The lock is durable through the link.
      }
      return { acquired: true, token }
    } catch (error) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // The temporary record is not the lock.
      }
      if (error?.code !== 'EEXIST') {
        return { acquired: false, reason: CLEANUP_REFUSAL.uncertain }
      }
      if (attempt + 1 < attempts) sleepSync(sleepMs)
    }
  }
  return { acquired: false, reason: CLEANUP_REFUSAL.active }
}

/**
 * Releases the lock on one lease record.
 *
 * The lock's token is what says the lock is this call's, so a lock that
 * belongs to another holder is left alone.
 */
function releaseLeaseLock(directory, runId, token) {
  try {
    const held = JSON.parse(readFileSync(leaseLockPath(directory, runId), 'utf8'))
    if (held.token !== token) return { released: false }
    rmSync(leaseLockPath(directory, runId), { force: true })
    return { released: true }
  } catch {
    return { released: false }
  }
}

/**
 * Writes a lease without holding its lock.
 *
 * The write is atomic: the record is written beside its target and renamed
 * over it, so a reader never sees half a lease and an interrupted write never
 * destroys the previous record.
 */
function writeLeaseUnlocked(directory, lease) {
  mkdirSync(directory, { recursive: true })
  const target = leasePath(directory, lease.runId)
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(lease, null, 2)}\n`)
  renameSync(temporary, target)
  return lease
}

/**
 * Writes a lease under the record's lock.
 *
 * Every writer of a record takes the same lock the pruner takes, so a record
 * is never written while it is pruned. A lock that cannot be taken within the
 * wait is a failure, and the caller reports it rather than writing anyway.
 */
export function writeLease(directory, lease) {
  const lock = acquireLeaseLock(directory, lease.runId, { attempts: 60, sleepMs: 5 })
  if (!lock.acquired) {
    throw new Error(`the lease for ${lease.runId} could not be written: ${lock.reason}`)
  }
  try {
    return writeLeaseUnlocked(directory, lease)
  } finally {
    releaseLeaseLock(directory, lease.runId, lock.token)
  }
}

/**
 * Whether a value is a lease record this model understands.
 *
 * A record that parses into null, false, zero, an array, or an object that is
 * missing its shape is not a lease. It is a record whose ownership is unknown,
 * and an unknown owner is never overwritten.
 */
export function isLeaseRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.version !== LEASE_VERSION) return false
  if (typeof value.runId !== 'string' || value.runId === '') return false
  if (!value.identity || typeof value.identity !== 'object' || Array.isArray(value.identity)) {
    return false
  }
  if (typeof value.identity.label !== 'string' || value.identity.label === '') return false
  return true
}

/**
 * Reads one run's lease.
 *
 * An absent record and a record that cannot be read are different things. An
 * absent record is a run that never wrote one. A record that cannot be parsed,
 * or that parses into something this model does not understand, is a record
 * whose ownership is unknown, and the read fails loudly instead of looking like
 * an absence. The bytes on disk are never rewritten.
 */
export function readLease(directory, runId) {
  let content
  try {
    content = readFileSync(leasePath(directory, runId), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(`the lease for ${runId} cannot be read: ${error.message}`, { cause: error })
  }
  if (!isLeaseRecord(parsed)) {
    throw new Error(`the lease for ${runId} is not a lease record this model understands`)
  }
  return parsed
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
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(join(directory, name), 'utf8'))
    } catch {
      unreadable.push(name)
      continue
    }
    if (!isLeaseRecord(parsed)) {
      // The record parses into something this model does not understand. It is
      // not a lease, and it is not an absence either: it is evidence whose
      // ownership is unknown. The bytes on disk are left exactly as they are.
      unreadable.push(name)
      continue
    }
    leases.push(parsed)
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
 * The file that holds the lock on one resource's claim.
 *
 * The lock is what makes the claim's arbitration sound. A run id is not a
 * process identity, so two processes that share one can reach for the same
 * record; a lock that only one process can take is a process identity.
 */
function lockPath(directory, resourceKey) {
  return join(claimsDirectory(directory), `${safeClaimName(resourceKey)}.lock`)
}

/**
 * The name a resource's claim and lock files carry.
 */
function safeClaimName(resourceKey) {
  const name = String(resourceKey).replace(/[^A-Za-z0-9._-]+/g, '-')
  if (name === '' || name === '.' || name === '..') {
    throw new Error('the resource key is not a safe claim name')
  }
  return name
}

/**
 * A unique token for one lock or one claim record.
 *
 * A run id is not a process identity: two processes can share one, and a
 * process id can be recycled. A token is unique to the record that carries it,
 * so it is what says a lock or a claim belongs to the holder that took it.
 */
function uniqueToken() {
  return randomUUID()
}

/**
 * Whether a value is a token this model issued.
 *
 * A token is a UUID, and only this model produces one. A value that is
 * absent, empty, or not a token at all is not a proof of anything, so a
 * release that carries one removes nothing.
 */
export function isValidToken(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token)
}

/**
 * Takes the lock that serialises the claim and the release of one resource.
 *
 * The lock is taken with an exclusive create, so exactly one process holds it.
 * A lock that is already there is refused, whatever its owner is doing: this
 * call cannot prove that it is entitled to the resource, and a residual lock is
 * recovered by an operator on evidence, never by an automatic bypass. The
 * temporary record is named for this call and created exclusively, so two
 * processes that share a run id never write over each other's record.
 */
function acquireLock({ directory, resourceKey, runId, identity, owner, now, isProcessAlive }) {
  try {
    mkdirSync(claimsDirectory(directory), { recursive: true })
  } catch {
    // The claims directory could not be created, so no lock can be taken. That
    // is a refusal with a reason, not a failure that replaces whatever outcome
    // the caller already has.
    return { acquired: false, reason: CLEANUP_REFUSAL.uncertain }
  }
  const path = lockPath(directory, resourceKey)
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
    token: uniqueToken(),
    createdAt: now(),
  }
  const content = `${JSON.stringify(record, null, 2)}\n`
  const temporary = `${path}.${record.token}.tmp`
  try {
    writeFileSync(temporary, content, { flag: 'wx' })
    linkSync(temporary, path)
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The lock is durable through the link; the temporary record beside it
      // is not part of it.
    }
    return { acquired: true, record }
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The temporary record is not the lock; leaving it behind is untidy but
      // harmless.
    }
    if (error?.code === 'EEXIST') {
      // A lock is already there. Whether its owner is alive or gone, this call
      // cannot prove it is entitled to the resource, so the claim is refused.
      let held = null
      try {
        held = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        held = null
      }
      if (held?.owner && isProcessAlive(held.owner.pid, held.owner.hostname)) {
        return { acquired: false, reason: CLEANUP_REFUSAL.active }
      }
      return { acquired: false, reason: CLEANUP_REFUSAL.uncertain }
    }
    return { acquired: false, reason: CLEANUP_REFUSAL.uncertain }
  }
}

/**
 * Releases the lock on one resource's claim.
 *
 * The record's token is what says the lock is this call's: a process id can be
 * recycled, and a token cannot. A lock that carries another token is left
 * alone.
 */
function releaseLock({ directory, resourceKey, token }) {
  const path = lockPath(directory, resourceKey)
  try {
    const held = JSON.parse(readFileSync(path, 'utf8'))
    if (held.token !== token) return { released: false }
    rmSync(path, { force: true })
    return { released: true }
  } catch {
    return { released: false }
  }
}

/**
 * The file that holds the claim on one resource.
 *
 * The name is the resource's key, not a run's name: there is one file per
 * shared resource, so two runs that want the same resource argue over the
 * same file.
 */
function claimPath(directory, resourceKey) {
  return join(claimsDirectory(directory), `${safeClaimName(resourceKey)}.claim`)
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
  // The lock is held for the whole operation, so the record on disk is only
  // ever changed by the process that holds it. That is what makes the
  // arbitration sound: a run id is not a process identity, and the lock is
  // one. A run that cannot take the lock is refused rather than arbitrated.
  const lock = acquireLock({ directory, resourceKey, runId, identity, owner, now, isProcessAlive })
  if (!lock.acquired) {
    return { decision: 'refused', reason: lock.reason, claim: null }
  }
  try {
    return claimUnderLock({
      directory,
      resourceKey,
      runId,
      identity,
      owner,
      now,
      isProcessAlive,
      afterClaimRead,
    })
  } finally {
    releaseLock({ directory, resourceKey, token: lock.record.token })
  }
}

/**
 * The claim itself, taken with the resource's lock held.
 */
function claimUnderLock({
  directory,
  resourceKey,
  runId,
  identity,
  owner,
  now,
  isProcessAlive,
  afterClaimRead,
}) {
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
      // The owner is gone and the identity matches, and the lock is held, so
      // this is the only reclaimer in the operation. The stale record is moved
      // aside before it is replaced, and the moved file is compared with the
      // one that was read: if they differ, a live claim was displaced, so it
      // is put back and the claim is refused.
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
        // claim was displaced. It is put back with a link, which refuses to
        // replace a claim that is already there, and the claim is refused.
        try {
          linkSync(aside, path)
          rmSync(aside, { force: true })
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
      token: uniqueToken(),
      createdAt: now(),
    }
    const content = `${JSON.stringify(record, null, 2)}\n`
    // The temporary record is named for this claim and created exclusively, so
    // two processes that share a run id never write over each other's record.
    const temporary = `${path}.${record.token}.tmp`
    try {
      writeFileSync(temporary, content, { flag: 'wx' })
      linkSync(temporary, path)
      try {
        rmSync(temporary, { force: true })
      } catch {
        // The claim is durable through the link; the temporary record beside it
        // is not part of it.
      }
      // The claim is read back before the run treats the resource as claimed.
      // If the record on disk is not this run's, the claim was taken and this
      // run does not hold it.
      let held = null
      try {
        held = readFileSync(path, 'utf8')
      } catch {
        held = null
      }
      if (held !== content) {
        return { decision: 'refused', reason: CLEANUP_REFUSAL.active, claim: null }
      }
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
export function releaseSharedResource({ directory, resourceKey, runId, identity, token }) {
  const path = claimPath(directory, resourceKey)
  // The claim is released under the resource's own lock, so a claim and a
  // release cannot interleave: the holder of the lock is the only one that
  // changes the record. A lock that is already there refuses the release, and
  // the claim stays until the lock is resolved on evidence.
  const lock = acquireLock({
    directory,
    resourceKey,
    runId,
    identity,
    owner: { pid: process.pid, hostname: hostname(), startedAt: null },
    now: Date.now,
    isProcessAlive: () => true,
  })
  if (!lock.acquired) {
    return { released: false, reason: `the claim's lock could not be taken: ${lock.reason}` }
  }
  try {
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
    // The record's token is what says the claim is this holder's. A run id is
    // not a process identity, and a process id can be recycled, so a release
    // that presents no valid token proves nothing and removes nothing.
    if (!isValidToken(token)) {
      return { released: false, reason: 'the release presented no valid token' }
    }
    if (!isValidToken(existing.token)) {
      return { released: false, reason: 'the claim carries no valid token to match' }
    }
    if (existing.token !== token) {
      return { released: false, reason: 'the claim was not taken by this holder' }
    }
    try {
      rmSync(path, { force: true })
      return { released: true }
    } catch (error) {
      return { released: false, reason: error.message }
    }
  } finally {
    releaseLock({ directory, resourceKey, token: lock.record.token })
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
  // The receipt is settled under the record's lock, so the pruner cannot
  // remove the record between the read and the write.
  const lock = acquireLeaseLock(directory, runId, { attempts: 60, sleepMs: 5 })
  if (!lock.acquired) return null
  try {
    writeLeaseUnlocked(directory, settled)
  } catch {
    return null
  } finally {
    releaseLeaseLock(directory, runId, lock.token)
  }
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
  // A seam for the interleaving regression: it runs after a record has been
  // selected from the snapshot and before the pruner takes that record's
  // lock, so a test can let a writer change the record in between.
  afterLeaseRead = null,
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
    // The eligibility comes from the snapshot: a settled record, older than
    // the bound.
    if (classifyLease(lease, { isProcessAlive }) !== LEASE_STATE.settled) continue
    const settledAt = lease.updatedAt ?? lease.createdAt ?? 0
    if (!Number.isFinite(settledAt) || clock - settledAt < retentionMs) continue
    if (typeof afterLeaseRead === 'function') {
      afterLeaseRead({ runId: lease.runId, lease })
    }
    // The record's lock is the same lock its writers take, so the record is
    // neither written nor settled while it is pruned, and the pruner is never
    // reading a record that is being changed.
    const lock = acquireLeaseLock(directory, lease.runId)
    if (!lock.acquired) {
      // The record cannot be established as this run's alone, so it is kept.
      continue
    }
    try {
      // The record is read again under the lock and checked against the
      // snapshot it was selected from. A run that is restarting with the same
      // identity replaces the record with one of its own: that record is
      // active, and it is not the record the snapshot described, so it is
      // preserved rather than pruned. A record that was settled in the
      // meantime is preserved for the same reason.
      let current = null
      try {
        current = JSON.parse(readFileSync(leasePath(directory, lease.runId), 'utf8'))
      } catch {
        continue
      }
      if (!isLeaseRecord(current)) continue
      if (classifyLease(current, { isProcessAlive }) !== LEASE_STATE.settled) continue
      if (current.owner?.pid !== lease.owner?.pid) continue
      if ((current.updatedAt ?? null) !== (lease.updatedAt ?? null)) continue
      try {
        rmSync(leasePath(directory, lease.runId), { force: true })
        pruned.push(lease.runId)
      } catch {
        // A record that cannot be pruned is kept: a bound on the evidence is
        // better than losing the evidence.
      }
    } finally {
      releaseLeaseLock(directory, lease.runId, lock.token)
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
