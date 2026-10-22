// Safe development-resource reuse and cleanup (adea-ai/adea#1567).
//
// The reported problem is repeated Docker growth and stale worktrees after a
// cleanup. This file is the source tooling that decides what may be reused,
// what may be reclaimed and what must be preserved, and it produces the
// dry-run eligibility report that records those decisions.
//
// It is deliberately built on the ownership model that #1543 already owns
// (`integration-resource-lease.mjs`): a lease is the ownership proof, a claim
// is the exclusive right to use one resource, and a resource whose owner
// cannot be established is protected rather than reclaimed.
//
// The rules this file encodes:
//
//   * A resource is only ever reclaimed when this run owns it and the lease
//     that names it records a pid no process holds on this host. An active,
//     foreign or uncertain owner is protected, and so is a resource nobody has
//     claimed: an unlabelled volume is not evidence of anything.
//   * A stale worktree is reused only when the local work is already
//     committed, the remote's current branch head contains the checkout's head
//     and the fetched ref is that same commit, and no live owner holds it.
//     Local work is never overwritten: a checkout with changes is preserved,
//     and a checkout whose origin is behind is refused until the owner
//     refreshes it.
//   * Ignored content is content until its own bytes are accounted for. A name
//     and the presence of a build script are not a proof of reproducibility.
//   * Every ownership question is answered by every record that bears on it.
//     One stale lease does not speak for a second live one, and an owner whose
//     state cannot be established is an owner, not an absence.
//   * Nothing here reaches Docker, Git or a process boundary. Every input is
//     injected, so the whole model can be exercised without a daemon, a
//     container, a volume or a network.
//
// It is not a cleanup command, and it grants nothing. It decides and reports;
// the report is evidence of what the tooling found, and the permission to
// remove anything remains with the operator who holds it, applied to the
// eligible items after reading every reason.

import {
  CLEANUP_REFUSAL,
  DISK_PRESSURE,
  LEASE_STATE,
  RESOURCE_DISPOSITION,
  RESOURCE_KIND,
  classifyDockerResource,
  classifyLease,
  diskPressureAdmission,
} from './integration-resource-lease.mjs'

/** What may be done with one stale worktree. */
export const REUSE_DECISION = {
  reuse: 'reuse',
  refuse: 'refuse',
}

/** Whether one item is eligible for a cleanup at all. */
export const ELIGIBILITY = {
  eligible: 'eligible',
  ineligible: 'ineligible',
}

/** The disposition of an item that a cleanup would never touch. */
export const PRESERVATION = {
  preserved: 'preserved',
}

/** Why a worktree reuse was refused. A refusal is never silent. */
export const REUSE_REFUSAL = {
  // The checkout carries work that is not committed anywhere.
  localWork: 'local_work',
  // The checkout carries ignored artifacts that are not known generated output.
  unknownIgnored: 'unknown_ignored',
  // The checkout's ignored paths could not be read, so it may hold content that
  // this report cannot account for.
  unreadableIgnored: 'unreadable_ignored',
  // The fetched origin ref does not contain the checkout's head.
  originStale: 'origin_stale',
  // Another live owner holds the checkout.
  owned: 'owned',
  // An owner's state could not be established, so the checkout is not free.
  uncertainOwner: 'uncertain_owner',
  // The checkout's commits exist nowhere else.
  unpublished: 'unpublished',
  // The checkout could not be read, so nothing may be done with it.
  uncertain: 'uncertain',
  // A lease record that could not be read may name this checkout, so nothing may
  // be done with it.
  uncertainLeaseEvidence: 'uncertain_lease_evidence',
}

/**
 * The proof an ignored path needs before its content may be called reproducible.
 *
 * The proof is about the content, not about the name. A path's name is not
 * evidence: `.wrangler` holds local persisted state that exists nowhere else,
 * and a directory called `dist` may hold the only copy of a result. The
 * presence of a build script is not evidence either: a script that does
 * nothing produces nothing, and a script that runs may write somewhere else
 * entirely.
 *
 * So a path is regenerable only when its own bytes are accounted for: either it
 * holds nothing, or a rebuild in an isolated copy reproduced exactly those
 * bytes. Every other ignored path is content the checkout holds, and it is
 * preserved and named.
 */
export const REGENERABLE_PROOF = {
  // The path holds nothing, so there is nothing to reproduce.
  empty: 'empty_content',
  // A rebuild in an isolated copy produced exactly the bytes the path holds.
  contentMatch: 'content_match',
}

/**
 * The liveness answer used when nothing can be established.
 *
 * An owner whose liveness is unknown may still be running, so an unknown owner
 * is a live owner. The alternative would let an unreadable record hand a live
 * resource to a second run.
 */
const UNKNOWN_LIVENESS_IS_ALIVE = () => true

/**
 * The liveness answers this model is willing to stand behind.
 *
 * The honest answer about a process is what was established, not what is
 * assumed. A process that is present is present. A process that is not present
 * under its recorded pid is not present - that is exactly what the probe
 * establishes, and it is not the same as a claim that the owner is gone: a
 * record names a pid, not a person. Anything that could not be established is
 * not established, and an owner that could not be established protects what it
 * may name.
 */
export const LIVENESS = {
  present: 'owner_present',
  absent: 'owner_pid_absent',
  notEstablished: 'owner_not_established',
}

/**
 * The liveness of one lease's owner, with the reason for the answer.
 *
 * The probe is the null signal: it asks whether a process exists without
 * disturbing it. It is only used when the owner record names this host. An
 * owner on another host cannot be probed from here, so it is not established;
 * and an owner whose record names no host at all cannot be located, so it is
 * not established either. A probe that fails leaves the answer unestablished.
 *
 * Nothing here reaches a process boundary: the host and the probe are
 * injected, so the whole answer can be exercised without touching a process.
 */
export function livenessOf(lease, { host = null, probe = null } = {}) {
  const owner = lease?.owner
  if (!owner || typeof owner !== 'object') {
    return { state: LIVENESS.notEstablished, reason: 'the lease names no owner' }
  }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
    return { state: LIVENESS.notEstablished, reason: 'the lease names no usable process id' }
  }
  if (typeof owner.hostname !== 'string' || owner.hostname === '') {
    return {
      state: LIVENESS.notEstablished,
      reason: 'the owner names no host, so the owner cannot be located',
    }
  }
  if (host === null || owner.hostname !== host) {
    return {
      state: LIVENESS.notEstablished,
      reason: 'the owner runs on another host, so it cannot be probed from here',
    }
  }
  if (typeof probe !== 'function') {
    return { state: LIVENESS.notEstablished, reason: 'no liveness probe was supplied' }
  }
  let alive
  try {
    alive = probe(owner.pid, owner.hostname)
  } catch (error) {
    return {
      state: LIVENESS.notEstablished,
      reason: 'the liveness probe failed: ' + (error?.message ?? String(error)),
    }
  }
  if (alive) {
    return { state: LIVENESS.present, reason: 'a process holds the recorded pid on this host' }
  }
  return { state: LIVENESS.absent, reason: 'no process holds the recorded pid on this host' }
}

/**
 * The probe the model hands to the lease classifier.
 *
 * The classifier asks one question - is the owner alive? - and reads "no" as
 * an owner that is gone. That answer is only allowed when it is established:
 * the owner names this host, the probe ran, and the probe found no process
 * under the recorded pid. Everything else answers "alive", because an owner
 * that cannot be shown to be absent protects what it may name.
 */
export function boundedLivenessProbe({ host = null, probe = null } = {}) {
  return (pid, ownerHostname) => {
    if (!Number.isInteger(pid) || pid <= 0) return true
    if (typeof ownerHostname !== 'string' || ownerHostname === '') return true
    if (host === null || ownerHostname !== host) return true
    if (typeof probe !== 'function') return true
    try {
      return probe(pid, ownerHostname) === true
    } catch {
      return true
    }
  }
}

/**
 * The ignored paths that a build regenerates from the checkout's own sources.
 *
 * `git status --porcelain` does not list ignored paths at all, so a checkout
 * that carries an ignored artifact is indistinguishable from one that carries
 * nothing. That distinction decides whether a checkout may be reused, so it is
 * made here rather than assumed.
 *
 * A path is only regenerable when the runner supplies the matching proof. The
 * proof is the tracked tooling that regenerates the path; the name alone is
 * not a proof, and the paths that hold local persisted state never are.
 */
const REGENERABLE_BUILD_DIRECTORIES = new Set(['coverage', 'dist', 'dist-desktop', 'test-results'])
const REGENERABLE_GENERATED_FILES = new Set(['cloudflare-env.d.ts'])

/**
 * What an ignored path looks like, described rather than proved.
 *
 * These labels say what a path *resembles*, so the report can name it. They
 * never make the path regenerable: that takes the content, not the name.
 */
const REGENERABLE_LOOKS = {
  dependencyTree: 'dependency_tree',
  buildOutput: 'build_output',
  generatedFile: 'generated_file',
  syncedAssets: 'synced_assets',
  pinnedRuntime: 'pinned_runtime',
}

/**
 * The kind of output an ignored path could be, or null when no kind describes it.
 *
 * This is a description, not a proof. It says what a path looks like so the
 * report can name it; it never says the path's content may be discarded. A
 * path is regenerable only on the evidence of its own bytes.
 *
 * `.wrangler` is never a build output: it holds the local persisted state of a
 * development runtime, and nothing rebuilds it.
 */
export function regenerableKind(entry) {
  if (typeof entry !== 'string' || entry === '') return null
  const trimmed = entry.replace(/\/+$/u, '')
  if (trimmed === '') return null
  const segments = trimmed.split('/')
  const name = segments[segments.length - 1]
  if (segments.includes('.wrangler')) return null
  if (name.endsWith('tsbuildinfo')) return REGENERABLE_LOOKS.buildOutput
  if (REGENERABLE_GENERATED_FILES.has(name)) return REGENERABLE_LOOKS.generatedFile
  if (name === 'node_modules') return REGENERABLE_LOOKS.dependencyTree
  if (REGENERABLE_BUILD_DIRECTORIES.has(name)) return REGENERABLE_LOOKS.buildOutput
  // The pinned source-contract runtime and the synced public assets are both
  // written by a repository script from tracked sources.
  if (segments.includes('.runtime') && trimmed.includes('source-contracts')) {
    return REGENERABLE_LOOKS.pinnedRuntime
  }
  if (segments.includes('assets') && segments.includes('public')) {
    return REGENERABLE_LOOKS.syncedAssets
  }
  return null
}

/**
 * Whether one ignored path is proven to hold nothing that would be lost.
 *
 * The answer is deliberately narrow, and it is about the content: a path with
 * no content-bound proof is content the checkout holds, whether it is named
 * like a build output or not. A name, and the presence of a producer script,
 * are not a proof of reproducibility, so they no longer grant one.
 */
export function isRegenerableIgnored(entry, proof = null) {
  if (proof == null || typeof proof !== 'object') return false
  if (proof.kind === REGENERABLE_PROOF.empty) return true
  if (proof.kind === REGENERABLE_PROOF.contentMatch) return true
  return false
}

/**
 * The ignored paths of a checkout that are not proven regenerable output.
 *
 * The proofs are the runner's, one per ignored path: a path with no proof is
 * content the checkout holds.
 */
export function unknownIgnoredPaths(entries = [], proofs = {}) {
  return entries.filter((entry) => !isRegenerableIgnored(entry, proofs?.[entry] ?? null))
}

/**
 * The lease states that mean an owner is present.
 *
 * An active owner holds the resource, a foreign owner belongs to another run,
 * and an uncertain owner is an owner whose state could not be established. Any
 * of them protects the resource.
 */
const BLOCKING_LEASE_STATES = [LEASE_STATE.active, LEASE_STATE.foreign, LEASE_STATE.uncertain]

/**
 * The state that describes a set of leases.
 *
 * The most protective state wins: an uncertain owner among the leases means the
 * ownership is uncertain, whatever the others say.
 */
function worstLeaseState(states) {
  if (states.includes(LEASE_STATE.uncertain)) return LEASE_STATE.uncertain
  if (states.includes(LEASE_STATE.active)) return LEASE_STATE.active
  if (states.includes(LEASE_STATE.foreign)) return LEASE_STATE.foreign
  if (states.includes(LEASE_STATE.stale)) return LEASE_STATE.stale
  if (states.includes(LEASE_STATE.settled)) return LEASE_STATE.settled
  return LEASE_STATE.uncertain
}

/**
 * Inventories every Docker resource the caller can see, with the ownership
 * answer that decides its fate.
 *
 * The resource disposition itself comes from the lane's own model
 * (`classifyDockerResource`), so there is one answer about a Docker resource and
 * not two. The lane's own dry-run builder is not used here because it fixes the
 * liveness answer to "unknown means alive"; this inventory needs the real
 * probe, so a resource whose owner crashed is recognised as reclaimable instead
 * of being protected forever.
 *
 * This adds the two things that model does not decide on its own: which lease
 * owns the resource, and the rule that a lease is the ownership proof.
 *
 * A resource is reclaimable only when all of the following hold: the lane's
 * model says this run created it, a lease of *this* run names it, that lease's
 * owner is gone, and no other lease that names the resource leaves its owner in
 * doubt. Every matching lease is read: the first one does not speak for the
 * rest, and a lease whose owner could not be established is an owner.
 */
export function inventoryOwnedResources({
  runId = null,
  leases = [],
  unreadableLeases = [],
  dockerResources = [],
  identity = null,
  isProcessAlive = UNKNOWN_LIVENESS_IS_ALIVE,
  host = null,
  probe = null,
} = {}) {
  // A lease record that could not be read may name this resource. It cannot be
  // attributed, so it protects every resource until it can be.
  const unreadable = Array.isArray(unreadableLeases) ? unreadableLeases : []
  const resources = dockerResources.map((resource) => {
    const classification = classifyDockerResource(resource, {
      identity,
      leases,
      isProcessAlive,
    })
    // Every lease that names this resource is read, not the first one: a stale
    // lease does not speak for a live one that follows it.
    const matching = leases.filter((candidate) => candidate?.identity?.project === resource.label)
    const states = matching.map((candidate) =>
      classifyLease(candidate, { isProcessAlive, expectedIdentity: identity })
    )
    const leaseState = worstLeaseState(states)
    const ownLeases = matching.filter((candidate) => candidate.runId === runId)
    const ownStates = ownLeases.map((candidate) =>
      classifyLease(candidate, { isProcessAlive, expectedIdentity: identity })
    )
    // A resource this run's label covers is not reclaimable unless a lease of
    // this run names it. A removable disposition without that lease is a
    // fail-closed case, and it is reported as such.
    const leaseMatched = runId !== null && ownLeases.length > 0
    const blockedByLease = states.some((state) => BLOCKING_LEASE_STATES.includes(state))
    const ownLeaseStale =
      ownStates.length > 0 && ownStates.every((state) => state === LEASE_STATE.stale)
    let reason = classification.reason
    if (classification.disposition === RESOURCE_DISPOSITION.removable && !leaseMatched) {
      reason =
        runId === null
          ? 'the caller named no run, so no lease proves this run owns the resource'
          : 'the resource carries this run’s label but no lease of this run proves it owns the resource'
    } else if (
      classification.disposition === RESOURCE_DISPOSITION.removable &&
      unreadable.length > 0
    ) {
      reason = 'a lease record that could not be read may name this resource, so it is protected'
    } else if (classification.disposition === RESOURCE_DISPOSITION.removable && blockedByLease) {
      reason = `a lease that names this resource has an owner in ${leaseState} state, so the resource is protected`
    } else if (
      classification.disposition === RESOURCE_DISPOSITION.removable &&
      leaseMatched &&
      !ownLeaseStale
    ) {
      reason = `the lease of this run is ${leaseState}, so the resource is not provably reclaimable`
    } else if (
      classification.disposition === RESOURCE_DISPOSITION.removable &&
      leaseMatched &&
      ownLeaseStale
    ) {
      // The lease's owner is not present under its recorded pid. That is what
      // the probe established; it is not a claim that the owner is gone.
      reason =
        'the lease of this run names a pid no process holds on this host, so the resource is not provably reclaimable'
    }
    const reclaimable =
      classification.disposition === RESOURCE_DISPOSITION.removable &&
      leaseMatched &&
      ownLeaseStale &&
      !blockedByLease &&
      unreadable.length === 0
    return {
      kind: resource.kind ?? RESOURCE_KIND.container,
      name: resource.name ?? null,
      label: resource.label ?? null,
      leaseRunId: ownLeases[0]?.runId ?? null,
      leaseState,
      leaseMatched,
      disposition: classification.disposition,
      reason,
      reclaimable,
      // The ownership evidence travels with the decision, so a reader can
      // re-check it instead of believing it. The liveness answer travels with
      // it too, and it says what was established rather than what is assumed.
      leaseEvidence: matching.map((candidate, index) => ({
        runId: candidate.runId ?? null,
        state: states[index] ?? LEASE_STATE.uncertain,
        liveness: livenessOf(candidate, { host, probe }),
      })),
    }
  })
  return {
    resources,
    summary: {
      total: resources.length,
      reclaimable: resources.filter((resource) => resource.reclaimable).length,
      protected: resources.filter((resource) => !resource.reclaimable).length,
    },
  }
}

/**
 * Decides whether one stale worktree may be reused.
 *
 * The checkout is reused only when every condition holds, and each condition
 * is recorded so the decision can be re-checked rather than believed:
 *
 *   * the checkout carries no local work (nothing is overwritten);
 *   * the checkout carries no ignored content that is not proven reproducible,
 *     because `git status --porcelain` does not list ignored paths and an
 *     ignored receipt is the only copy of itself;
 *   * the remote's current branch head contains the checkout's head, and the
 *     fetched ref is that same commit, so the origin is fresh for this branch
 *     and no stale tracking ref is standing in for the remote;
 *   * the checkout's commits are published by the remote's current state, so
 *     nothing is lost if the checkout is rebuilt;
 *   * no owner holds it: not a live one, not an uncertain one, and not a
 *     foreign one.
 *
 * Every lease that names the checkout is read. One stale lease does not speak
 * for a live lease that follows it, and an owner whose state cannot be
 * established is an owner, not an absence. Leases that name a shared or an
 * unknown scope are preserved and reported, and they never authorise anything.
 *
 * A refusal names which condition failed, so the owner is told what to do
 * rather than only that it failed.
 */
export function planWorktreeReuse({
  worktree,
  leases = [],
  origin = null,
  isProcessAlive = UNKNOWN_LIVENESS_IS_ALIVE,
  host = null,
  probe = null,
  unreadableLeases = [],
  leaseScanFailed = false,
} = {}) {
  const refusals = []
  const evidence = {
    localWork: null,
    ignoredUnknown: [],
    // What each ignored path holds, with the digest a rebuild would have to
    // reproduce. The content is named and measured, not assumed.
    ignoredContent: {},
    ignoredUnreadable: null,
    originFresh: null,
    headInOrigin: null,
    published: null,
    ownerLive: null,
    ownerUncertain: null,
    ownerForeign: null,
    matchingLeases: [],
    preservedScopes: [],
    unreadableLeaseRecords: [],
    leaseScanFailed,
  }
  if (!worktree || typeof worktree.path !== 'string' || worktree.path === '') {
    return {
      path: worktree?.path ?? null,
      decision: REUSE_DECISION.refuse,
      reasons: [REUSE_REFUSAL.uncertain],
      reason: 'the checkout could not be read, so nothing may be done with it',
      evidence,
    }
  }
  evidence.localWork = Boolean(worktree.localChanges)
  if (evidence.localWork) {
    refusals.push(REUSE_REFUSAL.localWork)
  }
  // The ignored paths are read from the checkout's own record, and anything
  // that is not proven reproducible is content the checkout holds.
  evidence.ignoredUnknown = Array.isArray(worktree.ignoredUnknown)
    ? [...worktree.ignoredUnknown]
    : []
  // The content of those paths travels with the decision: the report names what
  // it preserves, and the digest is what a rebuild would have to reproduce.
  evidence.ignoredContent =
    worktree.ignoredContent && typeof worktree.ignoredContent === 'object'
      ? { ...worktree.ignoredContent }
      : {}
  if (evidence.ignoredUnknown.length > 0) {
    refusals.push(REUSE_REFUSAL.unknownIgnored)
  }
  // An ignored list that could not be read is not an empty one: the checkout may
  // hold content this report cannot account for, so it is not free.
  evidence.ignoredUnreadable = worktree.ignoredUnreadable === true
  if (evidence.ignoredUnreadable) {
    refusals.push(REUSE_REFUSAL.unreadableIgnored)
  }
  // The origin facts travel with the checkout, so a caller that has already
  // verified them does not have to repeat them, and a caller that has not
  // gets the pessimistic answer.
  //
  // The remote's current state is what counts. The facts the runner carries say
  // which commit the remote holds now, which commit the fetched ref holds, and
  // whether those are the same commit. A ref that is behind the remote, or a
  // branch the remote no longer holds, is not the remote's state, so it never
  // makes the origin fresh.
  const originFacts = origin ?? worktree.origin ?? null
  evidence.originFresh = Boolean(originFacts?.fresh)
  if (!evidence.originFresh) {
    refusals.push(REUSE_REFUSAL.originStale)
  } else {
    evidence.headInOrigin = Boolean(originFacts?.containsHead)
    if (!evidence.headInOrigin) refusals.push(REUSE_REFUSAL.originStale)
  }
  evidence.published = Boolean(worktree.published)
  if (!evidence.published) refusals.push(REUSE_REFUSAL.unpublished)

  // Every lease that names this checkout is read, and every lease that names
  // something else is preserved rather than discarded.
  const matching = leases.filter((lease) => lease?.identity?.worktree === worktree.path)
  const preserved = leases.filter((lease) => lease?.identity?.worktree !== worktree.path)
  evidence.matchingLeases = matching.map((lease) => ({
    runId: lease?.runId ?? null,
    state: classifyLease(lease, { isProcessAlive }),
    liveness: livenessOf(lease, { host, probe }),
  }))
  evidence.preservedScopes = preserved.map((lease) => ({
    runId: lease?.runId ?? null,
    scope: lease?.identity?.worktree ?? null,
    state: classifyLease(lease, { isProcessAlive }),
    liveness: livenessOf(lease, { host, probe }),
  }))
  const states = evidence.matchingLeases.map((lease) => lease.state)
  evidence.ownerLive = states.includes(LEASE_STATE.active)
  evidence.ownerUncertain = states.includes(LEASE_STATE.uncertain)
  evidence.ownerForeign = states.includes(LEASE_STATE.foreign)
  if (evidence.ownerLive) refusals.push(REUSE_REFUSAL.owned)
  if (evidence.ownerUncertain) refusals.push(REUSE_REFUSAL.uncertainOwner)
  if (evidence.ownerForeign) refusals.push(REUSE_REFUSAL.owned)
  // A lease record that could not be read, or one that is not yet valid, may
  // name this checkout. It cannot be attributed to a path, so it protects every
  // checkout until it can be.
  evidence.unreadableLeaseRecords = Array.isArray(unreadableLeases) ? [...unreadableLeases] : []
  if (evidence.unreadableLeaseRecords.length > 0 || leaseScanFailed) {
    refusals.push(REUSE_REFUSAL.uncertainLeaseEvidence)
  }

  if (refusals.length > 0) {
    return {
      path: worktree.path,
      decision: REUSE_DECISION.refuse,
      reasons: refusals,
      reason: describeRefusals(refusals),
      evidence,
    }
  }
  return {
    path: worktree.path,
    decision: REUSE_DECISION.reuse,
    reasons: [],
    reason:
      'the checkout is clean, the remote’s current branch head contains its head and no owner holds it',
    evidence,
  }
}

/** The plain-language reason for a set of refusals. */
export function describeRefusals(refusals) {
  const parts = []
  for (const refusal of refusals) {
    if (refusal === REUSE_REFUSAL.localWork) {
      parts.push('the checkout carries local work that is not committed anywhere')
    } else if (refusal === REUSE_REFUSAL.unknownIgnored) {
      parts.push('the checkout carries ignored content that is not proven reproducible')
    } else if (refusal === REUSE_REFUSAL.unreadableIgnored) {
      parts.push(
        'the checkout’s ignored paths could not be read, so it may hold content this report cannot account for'
      )
    } else if (refusal === REUSE_REFUSAL.uncertainLeaseEvidence) {
      parts.push('a lease record that could not be read may name this checkout, so it is protected')
    } else if (refusal === REUSE_REFUSAL.originStale) {
      parts.push('the fetched origin ref does not contain the checkout head')
    } else if (refusal === REUSE_REFUSAL.owned) {
      parts.push('another owner holds the checkout')
    } else if (refusal === REUSE_REFUSAL.uncertainOwner) {
      parts.push('an owner of the checkout could not be established')
    } else if (refusal === REUSE_REFUSAL.unpublished) {
      parts.push('the checkout commits are published nowhere else')
    } else {
      parts.push('the checkout could not be read')
    }
  }
  return parts.join('; ')
}

/**
 * The dry-run eligibility report.
 *
 * Every item carries its decision, its reason and the evidence the decision
 * rests on, so the report can be re-checked rather than believed. The report
 * is evidence of what the tooling found; it grants nothing, and every other
 * item is preserved.
 *
 * A resource is eligible only when the inventory proved it reclaimable: the
 * lane's own disposition says this run created it, a lease of this run names
 * it, and the lease records a pid no process holds on this host. A removable
 * disposition without a matching lease is a fail-closed case, and it is
 * reported as ineligible with the reason that decided it.
 */
export function eligibilityReport({
  resources = [],
  worktrees = [],
  disk = null,
  now = null,
} = {}) {
  const resourceItems = resources.map((resource) => {
    const leaseMatched = resource.leaseMatched === true
    const removable = resource.disposition === RESOURCE_DISPOSITION.removable
    // The inventory's own answer travels end to end. A resource the inventory
    // did not prove reclaimable is never eligible, whatever its disposition
    // says on its own.
    const eligible = removable && leaseMatched && resource.reclaimable === true
    let reason = resource.reason
    if (removable && !leaseMatched) {
      reason = 'no lease of this run names the resource, so it is not provably reclaimable'
    }
    return {
      kind: resource.kind,
      name: resource.name,
      eligibility: eligible ? ELIGIBILITY.eligible : ELIGIBILITY.ineligible,
      disposition: resource.disposition,
      reason,
      reclaimable: resource.reclaimable === true,
      evidence: {
        label: resource.label ?? null,
        leaseRunId: resource.leaseRunId ?? null,
        leaseState: resource.leaseState ?? null,
        leaseMatched,
        leaseEvidence: resource.leaseEvidence ?? [],
      },
    }
  })
  const worktreeItems = worktrees.map((worktree) => {
    const plan = worktree.plan ?? planWorktreeReuse({ worktree })
    return {
      path: worktree.path,
      eligibility:
        plan.decision === REUSE_DECISION.reuse ? ELIGIBILITY.eligible : ELIGIBILITY.ineligible,
      decision: plan.decision,
      reason: plan.reason,
      reasons: plan.reasons,
      evidence: plan.evidence,
    }
  })
  return {
    generatedAt: now,
    summary: {
      resources: resourceItems.length,
      eligibleResources: resourceItems.filter((item) => item.eligibility === ELIGIBILITY.eligible)
        .length,
      worktrees: worktreeItems.length,
      eligibleWorktrees: worktreeItems.filter((item) => item.eligibility === ELIGIBILITY.eligible)
        .length,
      preserved:
        resourceItems.filter((item) => item.eligibility === ELIGIBILITY.ineligible).length +
        worktreeItems.filter((item) => item.eligibility === ELIGIBILITY.ineligible).length,
    },
    resources: resourceItems,
    worktrees: worktreeItems,
    disk,
  }
}

/**
 * Proves that nothing protected was scheduled for reclamation, and that
 * nothing eligible contradicts its own evidence.
 *
 * Every item is examined, eligible ones included: an item that was marked
 * eligible while its own evidence says otherwise is a failure of the model, not
 * a summary detail, and a report that hides it is not a proof of anything.
 */
export function preservationProof({ resources = [], worktrees = [] } = {}) {
  const violations = []
  const preserved = []
  for (const resource of resources) {
    const eligible = resource.eligibility === ELIGIBILITY.eligible
    if (!eligible) {
      preserved.push({ kind: resource.kind, name: resource.name, reason: resource.reason })
    }
    if (eligible) {
      // An eligible resource must agree with its own evidence.
      if (resource.disposition !== RESOURCE_DISPOSITION.removable) {
        violations.push({
          kind: resource.kind,
          name: resource.name,
          reason: 'a resource marked eligible is not removable',
        })
      }
      if (resource.reclaimable !== true) {
        violations.push({
          kind: resource.kind,
          name: resource.name,
          reason: 'a resource marked eligible was not proven reclaimable by its lease',
        })
      }
      if (resource.evidence?.leaseMatched !== true) {
        violations.push({
          kind: resource.kind,
          name: resource.name,
          reason: 'a resource marked eligible has no matching lease',
        })
      }
      continue
    }
    if (resource.disposition === RESOURCE_DISPOSITION.removable && resource.reclaimable === true) {
      violations.push({
        kind: resource.kind,
        name: resource.name,
        reason: 'a resource marked removable was also recorded as ineligible',
      })
    }
  }
  for (const worktree of worktrees) {
    const eligible = worktree.eligibility === ELIGIBILITY.eligible
    if (!eligible) {
      preserved.push({ path: worktree.path, reason: worktree.reason })
    }
    if (eligible) {
      if (worktree.decision !== REUSE_DECISION.reuse) {
        violations.push({
          path: worktree.path,
          reason: 'a checkout marked eligible does not carry a reuse decision',
        })
      }
      if (worktree.evidence?.originFresh !== true) {
        violations.push({
          path: worktree.path,
          reason: 'a checkout marked eligible does not carry a verified origin',
        })
      }
      if (worktree.evidence?.ownerLive !== false) {
        violations.push({
          path: worktree.path,
          reason: 'a checkout marked eligible still carries an owner',
        })
      }
      continue
    }
    if (worktree.decision === REUSE_DECISION.reuse) {
      violations.push({
        path: worktree.path,
        reason: 'a checkout marked for reuse was also recorded as ineligible',
      })
    }
  }
  return { preserved, violations, ok: violations.length === 0 }
}

/**
 * Reads the disk telemetry a cleanup decision needs.
 *
 * The Docker summary and the checkout sizes are reported separately, because
 * they are reclaimed by different means: a builder cache is reclaimed by
 * Docker, and a checkout is reclaimed by Git. A total without the split is a
 * number nobody can act on.
 */
export function diskTelemetry({ dockerSystemDf = null, dockerVolumes = [], worktrees = [] } = {}) {
  const docker = { totalBytes: 0, reclaimableBytes: 0, reported: false }
  if (dockerSystemDf) {
    docker.reported = true
    docker.totalBytes = Number(dockerSystemDf.totalBytes ?? 0)
    docker.reclaimableBytes = Number(dockerSystemDf.reclaimableBytes ?? 0)
  }
  const volumes = dockerVolumes.reduce((total, volume) => total + Number(volume.sizeBytes ?? 0), 0)
  const checkouts = worktrees.reduce(
    (total, worktree) => total + Number(worktree.sizeBytes ?? 0),
    0
  )
  return {
    docker: { ...docker, volumesBytes: volumes },
    worktrees: { count: worktrees.length, bytes: checkouts },
    totalBytes: docker.totalBytes + volumes + checkouts,
  }
}

/**
 * Bounds how many owners may hold a resource at once.
 *
 * A run that would exceed the bound is refused rather than queued here: the
 * queue is the scheduler's business, and this is the admission decision.
 */
export function concurrencyAdmission({ running = 0, limit = 1 } = {}) {
  if (!Number.isFinite(running) || running < 0) {
    return {
      admitted: false,
      reason: 'the current holder count could not be established',
      running,
      limit,
    }
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return {
      admitted: false,
      reason: 'the concurrency bound could not be established',
      running,
      limit,
    }
  }
  if (running >= limit) {
    return {
      admitted: false,
      reason: `the concurrency bound of ${limit} is already reached`,
      running,
      limit,
    }
  }
  return { admitted: true, reason: `there is room within the bound of ${limit}`, running, limit }
}

/**
 * The disk admission a reuse decision needs, expressed in the lane's own
 * vocabulary so the two decisions read the same way.
 */
export function reuseDiskAdmission({ availableBytes, requiredBytes = 0, limitBytes = 0 } = {}) {
  const admission = diskPressureAdmission({ availableBytes, requiredBytes, limitBytes })
  return {
    decision: admission.decision,
    reason: admission.reason,
    availableBytes: admission.availableBytes,
    pressure:
      admission.decision === DISK_PRESSURE.refused ? DISK_PRESSURE.refused : DISK_PRESSURE.admitted,
  }
}

/** The cleanup refusals this model can produce, re-exported so callers share one vocabulary. */
export { CLEANUP_REFUSAL }
