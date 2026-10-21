// Safe development-resource reuse and cleanup (adea-ai/adea#1567).
//
// The reported problem is repeated Docker growth and stale worktrees after a
// cleanup. This file is the source tooling that decides what may be reused,
// what may be reclaimed and what must be preserved, and it produces the
// dry-run eligibility report that a cleanup is authorised from.
//
// It is deliberately built on the ownership model that #1543 already owns
// (`integration-resource-lease.mjs`): a lease is the ownership proof, a claim
// is the exclusive right to use one resource, and a resource whose owner
// cannot be established is protected rather than reclaimed.
//
// The rules this file encodes:
//
//   * A resource is only ever reclaimed when this run owns it and its owner is
//     gone. An active, foreign or uncertain owner is protected, and so is a
//     resource nobody has claimed: an unlabelled volume is not evidence of
//     anything.
//   * A stale worktree is reused only when the local work is already
//     committed, the fetched origin ref contains the checkout's head, and no
//     live owner holds it. Local work is never overwritten: a checkout with
//     changes is preserved, and a checkout whose origin is behind is refused
//     until the owner refreshes it.
//   * Nothing here reaches Docker, Git or a process boundary. Every input is
//     injected, so the whole model can be exercised without a daemon, a
//     container, a volume or a network.
//
// It is not a cleanup command. It decides and reports; a caller that holds
// the applicable permission performs the removal, and the report is the
// evidence that the removal was authorised.

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
  // The fetched origin ref does not contain the checkout's head.
  originStale: 'origin_stale',
  // Another live owner holds the checkout.
  owned: 'owned',
  // The checkout's commits exist nowhere else.
  unpublished: 'unpublished',
  // The checkout could not be read, so nothing may be done with it.
  uncertain: 'uncertain',
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
 * model says this run created it, a lease of *this* run names it, and that
 * lease's owner is gone. A resource this run's label covers but no lease
 * proves is protected: a running container is not a lease.
 */
export function inventoryOwnedResources({
  runId = null,
  leases = [],
  dockerResources = [],
  identity = null,
  isProcessAlive = UNKNOWN_LIVENESS_IS_ALIVE,
} = {}) {
  const resources = dockerResources.map((resource) => {
    const classification = classifyDockerResource(resource, {
      identity,
      leases,
      isProcessAlive,
    })
    const lease =
      leases.find((candidate) => candidate?.identity?.project === resource.label) ?? null
    const leaseState = lease
      ? classifyLease(lease, { isProcessAlive, expectedIdentity: identity })
      : LEASE_STATE.uncertain
    const owned = lease !== null && runId !== null && lease.runId === runId
    let reason = classification.reason
    if (classification.disposition === RESOURCE_DISPOSITION.removable && !owned) {
      reason =
        runId === null
          ? 'the caller named no run, so no lease proves this run owns the resource'
          : 'the resource carries this run’s label but no lease of this run proves it owns the resource'
    } else if (
      classification.disposition === RESOURCE_DISPOSITION.removable &&
      owned &&
      leaseState !== LEASE_STATE.stale
    ) {
      reason = `the lease of this run is ${leaseState}, so the resource is not provably reclaimable`
    }
    return {
      kind: resource.kind ?? RESOURCE_KIND.container,
      name: resource.name ?? null,
      label: resource.label ?? null,
      leaseRunId: lease?.runId ?? null,
      leaseState,
      disposition: classification.disposition,
      reason,
      reclaimable:
        classification.disposition === RESOURCE_DISPOSITION.removable &&
        owned &&
        leaseState === LEASE_STATE.stale,
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
 *   * the fetched origin ref contains the checkout's head (the origin is fresh
 *     for this branch);
 *   * the checkout's commits are published, so nothing is lost if the
 *     checkout is rebuilt;
 *   * no live owner holds it.
 *
 * A refusal names which condition failed, so the owner is told what to do
 * rather than only that it failed.
 */
export function planWorktreeReuse({
  worktree,
  leases = [],
  origin = null,
  isProcessAlive = UNKNOWN_LIVENESS_IS_ALIVE,
} = {}) {
  const refusals = []
  const evidence = {
    localWork: null,
    originFresh: null,
    headInOrigin: null,
    published: null,
    ownerLive: null,
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
  evidence.originFresh = Boolean(origin?.fresh)
  if (!evidence.originFresh) {
    refusals.push(REUSE_REFUSAL.originStale)
  } else {
    evidence.headInOrigin = Boolean(origin?.containsHead)
    if (!evidence.headInOrigin) refusals.push(REUSE_REFUSAL.originStale)
  }
  evidence.published = Boolean(worktree.published)
  if (!evidence.published) refusals.push(REUSE_REFUSAL.unpublished)
  const owner = leases.find((lease) => lease?.identity?.worktree === worktree.path) ?? null
  evidence.ownerLive = owner
    ? classifyLease(owner, { isProcessAlive }) === LEASE_STATE.active
    : false
  if (evidence.ownerLive) refusals.push(REUSE_REFUSAL.owned)

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
      'the checkout is clean, its head is in the fetched origin ref and no live owner holds it',
    evidence,
  }
}

/** The plain-language reason for a set of refusals. */
export function describeRefusals(refusals) {
  const parts = []
  for (const refusal of refusals) {
    if (refusal === REUSE_REFUSAL.localWork) {
      parts.push('the checkout carries local work that is not committed anywhere')
    } else if (refusal === REUSE_REFUSAL.originStale) {
      parts.push('the fetched origin ref does not contain the checkout head')
    } else if (refusal === REUSE_REFUSAL.owned) {
      parts.push('a live owner holds the checkout')
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
 * rests on, so the report is a permission, not a summary. Nothing in the
 * report is an instruction to delete: a caller that holds the applicable
 * permission acts on the eligible items, and every other item is preserved.
 */
export function eligibilityReport({
  resources = [],
  worktrees = [],
  disk = null,
  now = null,
} = {}) {
  const resourceItems = resources.map((resource) => ({
    kind: resource.kind,
    name: resource.name,
    eligibility:
      resource.disposition === RESOURCE_DISPOSITION.removable
        ? ELIGIBILITY.eligible
        : ELIGIBILITY.ineligible,
    disposition: resource.disposition,
    reason: resource.reason,
    evidence: {
      label: resource.label ?? null,
      leaseRunId: resource.leaseRunId ?? null,
      leaseState: resource.leaseState ?? null,
    },
  }))
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
 * Proves that nothing protected was scheduled for reclamation.
 *
 * An active, shared, foreign or unknown resource, and any checkout with
 * unique work, must survive. A violation is a reportable failure of the
 * model, not a warning.
 */
export function preservationProof({ resources = [], worktrees = [] } = {}) {
  const violations = []
  const preserved = []
  for (const resource of resources) {
    if (resource.eligibility === ELIGIBILITY.eligible) continue
    preserved.push({ kind: resource.kind, name: resource.name, reason: resource.reason })
    if (resource.disposition === RESOURCE_DISPOSITION.removable) {
      violations.push({
        kind: resource.kind,
        name: resource.name,
        reason: 'a resource marked removable was also recorded as ineligible',
      })
    }
  }
  for (const worktree of worktrees) {
    if (worktree.eligibility === ELIGIBILITY.eligible) continue
    preserved.push({ path: worktree.path, reason: worktree.reason })
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
