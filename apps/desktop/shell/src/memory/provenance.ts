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
// Origin (who created the entry) is derived by the store from the trusted path
// that wrote it: `memory_create` is always `user`, and `dev.memory.propose`
// records the harness run the host resolved for the session. No command
// argument, proposal body or note text can name an origin. An agent entry
// written before runs were recorded reads back as `provenance: 'unknown'`; it
// is never given a run after the fact.
//
// This module is pure. The desktop store applies the decision it returns and
// remains the only writer; refusals are stable typed reasons, never entry
// text.
import type {
  WorkspaceMemoryEntry,
  WorkspaceMemoryOrigin,
} from '../../../../../packages/types/src/index'

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
  origin: WorkspaceMemoryOrigin
  status: WorkspaceMemoryEntry['status']
  revision: number
}>

export function memoryProvenanceRecord(
  entry: Pick<WorkspaceMemoryEntry, 'id' | 'workspaceId' | 'source' | 'status' | 'revision'> & {
    origin: WorkspaceMemoryOrigin
  }
): MemoryProvenanceRecord {
  return Object.freeze({
    id: entry.id,
    workspaceId: entry.workspaceId,
    provenance: entry.source,
    origin: entry.origin,
    status: entry.status,
    revision: entry.revision,
  })
}

/** The harness facts a trusted proposal path records; every field is host-resolved. */
export type MemoryAgentTrace = Readonly<{
  harnessId: string | null
  agentProfileId: string
  runtimeSessionId: string
  runId: string
}>

// Ids the host mints (uuids, profile ids, harness families): short, printable, no whitespace.
const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/

function traceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID.test(value)
}

/**
 * The origin recorded for one agent proposal, or undefined when the trace is
 * not a well-formed host-resolved one. Only the four known fields are read, so
 * anything else a caller attaches is dropped.
 */
export function recordedAgentOrigin(trace: unknown): WorkspaceMemoryOrigin | undefined {
  if (typeof trace !== 'object' || trace === null) return undefined
  const { harnessId, agentProfileId, runtimeSessionId, runId } = trace as Record<string, unknown>
  if (harnessId !== null && !traceId(harnessId)) return undefined
  if (!traceId(agentProfileId) || !traceId(runtimeSessionId) || !traceId(runId)) return undefined
  return Object.freeze({
    kind: 'agent' as const,
    provenance: 'recorded' as const,
    harnessId: harnessId as string | null,
    agentProfileId,
    runtimeSessionId,
    runId,
  })
}

/**
 * The origin to report for a stored record. A stored origin is trusted only when
 * it is well formed AND agrees with the record's `source`; a record written
 * before origins existed (or a mismatched one) reads as `user` for a user note
 * and as an explicit `unknown` agent origin for an agent entry.
 */
export function storedMemoryOrigin(record: {
  source: WorkspaceMemoryEntry['source']
  origin?: unknown
}): WorkspaceMemoryOrigin {
  const stored = record.origin
  if (typeof stored === 'object' && stored !== null) {
    const { kind, provenance } = stored as Record<string, unknown>
    if (kind === 'user' && record.source === 'user') return Object.freeze({ kind: 'user' as const })
    if (kind === 'agent' && record.source === 'agent') {
      if (provenance === 'recorded') {
        const recorded = recordedAgentOrigin(stored)
        if (recorded) return recorded
      }
    }
  }
  return record.source === 'user'
    ? Object.freeze({ kind: 'user' as const })
    : Object.freeze({ kind: 'agent' as const, provenance: 'unknown' as const })
}

export function memoryOriginsEqual(left: WorkspaceMemoryOrigin, right: WorkspaceMemoryOrigin) {
  if (left.kind !== right.kind) return false
  if (left.kind === 'user' || right.kind === 'user') return true
  if (left.provenance !== right.provenance) return false
  if (left.provenance === 'unknown' || right.provenance === 'unknown') return true
  return (
    left.harnessId === right.harnessId &&
    left.agentProfileId === right.agentProfileId &&
    left.runtimeSessionId === right.runtimeSessionId &&
    left.runId === right.runId
  )
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
  /** So is the recorded origin: promotion never re-labels who created the entry. */
  origin: WorkspaceMemoryOrigin
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
 * - the caller may not present a different provenance or origin, so neither can
 *   be rewritten by passing it through the promotion call;
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
  /** When present it must equal the entry's recorded origin; anything else refuses. */
  nextOrigin?: WorkspaceMemoryOrigin
}): MemoryPromotionDecision {
  const { entry } = input
  if (entry.workspaceId !== input.authorizedWorkspaceId) {
    return { allowed: false, reason: 'memory_audience_mismatch' }
  }
  if (input.nextProvenance !== undefined && input.nextProvenance !== entry.provenance) {
    return { allowed: false, reason: 'memory_provenance_mismatch' }
  }
  if (input.nextOrigin !== undefined && !memoryOriginsEqual(input.nextOrigin, entry.origin)) {
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
      origin: entry.origin,
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
  nextOrigin?: WorkspaceMemoryOrigin
}): MemoryPromotionPlan {
  const decision = decideMemoryPromotion(input)
  if (!decision.allowed) throw refusal(decision.reason)
  return decision.plan
}
