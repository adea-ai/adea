// Memory provenance and audience guards (ADR 0012, "Memory";
// docs/specs/local-content.md "Workspace memory").
//
// One entry lives in exactly one workspace audience and keeps the provenance
// that created it: `user` for a note the owner wrote, `agent` for a proposal
// the harness submitted. Promotion (an agent proposal becoming active memory)
// is explicit and may change only `status` and `revision`; it may never
// re-label provenance or move the entry to another workspace. A persona,
// profile or connection change elsewhere on the device therefore cannot
// broaden what a launch receives: the preamble compiler stays bound to one
// workspace and reads the store under the authorized workspace.
//
// This module is pure. The desktop store applies the decision it returns and
// remains the only writer; refusals are stable typed reasons, never entry
// text.
import type { WorkspaceMemoryEntry } from '../../../../../packages/types/src/index'

export const memoryProvenanceKinds = ['user', 'agent'] as const

/** How an entry entered the store. Immutable for the entry's lifetime. */
export type MemoryProvenance = (typeof memoryProvenanceKinds)[number]

export type MemoryProvenanceRefusal =
  | 'memory_audience_mismatch'
  | 'memory_provenance_mismatch'
  | 'memory_stale_revision'
  | 'memory_invalid_state'

export type MemoryProvenanceError = Error & { readonly reason: MemoryProvenanceRefusal }

function refusal(reason: MemoryProvenanceRefusal): MemoryProvenanceError {
  const error = new Error(reason) as MemoryProvenanceError
  Object.defineProperty(error, 'reason', { enumerable: true, value: reason })
  error.name = 'MemoryProvenanceError'
  return error
}

/**
 * The provenance/audience projection of one entry: everything a promotion
 * decision needs and nothing else. Text never enters this shape.
 */
export type MemoryProvenanceRecord = Readonly<{
  id: string
  workspaceId: string
  provenance: MemoryProvenance
  status: WorkspaceMemoryEntry['status']
  revision: number
}>

export function memoryProvenanceRecord(
  entry: Pick<WorkspaceMemoryEntry, 'id' | 'workspaceId' | 'source' | 'status' | 'revision'>
): MemoryProvenanceRecord {
  return Object.freeze({
    id: entry.id,
    workspaceId: entry.workspaceId,
    provenance: entry.source,
    status: entry.status,
    revision: entry.revision,
  })
}

/** An entry is in the audience of exactly the workspace it names. */
export function isMemoryAudience(
  entry: Pick<WorkspaceMemoryEntry, 'workspaceId'>,
  authorizedWorkspaceId: string
): boolean {
  return entry.workspaceId === authorizedWorkspaceId
}

export type MemoryPromotionPlan = Readonly<{
  entryId: string
  /** The workspace whose memory gains the entry; never re-derived from input. */
  audienceWorkspaceId: string
  /** The provenance is carried through promotion unchanged. */
  provenance: MemoryProvenance
  from: 'pending'
  to: 'active'
  observedRevision: number
  nextRevision: number
}>

export type MemoryPromotionDecision =
  | Readonly<{ allowed: true; plan: MemoryPromotionPlan }>
  | Readonly<{ allowed: false; reason: MemoryProvenanceRefusal }>

/**
 * The one promotion decision. It is deliberately strict:
 *
 * - the entry must already be in the authorized workspace's audience;
 * - the caller may not present a different provenance, so `source` cannot be
 *   rewritten by passing it through the promotion call;
 * - the expected revision must match exactly, so a stale accept after another
 *   edit refuses instead of overwriting; and
 * - only `pending` entries can be promoted, exactly once.
 */
export function decideMemoryPromotion(input: {
  entry: MemoryProvenanceRecord
  authorizedWorkspaceId: string
  expectedRevision: number
  /** When present it must equal the entry's provenance; anything else refuses. */
  nextProvenance?: MemoryProvenance
}): MemoryPromotionDecision {
  const { entry } = input
  if (entry.workspaceId !== input.authorizedWorkspaceId) {
    return { allowed: false, reason: 'memory_audience_mismatch' }
  }
  if (input.nextProvenance !== undefined && input.nextProvenance !== entry.provenance) {
    return { allowed: false, reason: 'memory_provenance_mismatch' }
  }
  if (entry.revision !== input.expectedRevision) {
    return { allowed: false, reason: 'memory_stale_revision' }
  }
  if (entry.status !== 'pending') {
    return { allowed: false, reason: 'memory_invalid_state' }
  }
  return {
    allowed: true,
    plan: Object.freeze({
      entryId: entry.id,
      audienceWorkspaceId: entry.workspaceId,
      provenance: entry.provenance,
      from: 'pending',
      to: 'active',
      observedRevision: entry.revision,
      nextRevision: entry.revision + 1,
    }),
  }
}

/**
 * The throwing form used by callers that guard an existing mutation. The
 * store maps `memory_audience_mismatch` to `memory_not_found` so existence
 * never leaks across workspaces.
 */
export function requireMemoryPromotion(input: {
  entry: MemoryProvenanceRecord
  authorizedWorkspaceId: string
  expectedRevision: number
  nextProvenance?: MemoryProvenance
}): MemoryPromotionPlan {
  const decision = decideMemoryPromotion(input)
  if (!decision.allowed) throw refusal(decision.reason)
  return decision.plan
}
