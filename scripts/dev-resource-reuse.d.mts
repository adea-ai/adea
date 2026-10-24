// Types for `dev-resource-reuse.mjs`.
//
// Every input of the model is injected and optional, and the `.mjs` source
// declares them with `null` and `[]` defaults. Inferred from those defaults, a
// parameter such as `host = null` can only ever be `null`, so a strict caller
// could not pass the value the model is built to accept. This file states what
// each parameter and result is.

export const REUSE_DECISION: { readonly reuse: 'reuse'; readonly refuse: 'refuse' }
export const ELIGIBILITY: { readonly eligible: 'eligible'; readonly ineligible: 'ineligible' }
export const PRESERVATION: { readonly preserved: 'preserved' }
export const REUSE_REFUSAL: {
  readonly localWork: 'local_work'
  readonly unknownIgnored: 'unknown_ignored'
  readonly unreadableIgnored: 'unreadable_ignored'
  readonly originStale: 'origin_stale'
  readonly owned: 'owned'
  readonly uncertainOwner: 'uncertain_owner'
  readonly unpublished: 'unpublished'
  readonly uncertain: 'uncertain'
  readonly uncertainLeaseEvidence: 'uncertain_lease_evidence'
}
export const REGENERABLE_PROOF: {
  readonly empty: 'empty_content'
  readonly contentMatch: 'content_match'
}
export const LIVENESS: {
  readonly present: 'owner_present'
  readonly absent: 'owner_pid_absent'
  readonly notEstablished: 'owner_not_established'
}
export { CLEANUP_REFUSAL } from './integration-resource-lease.mjs'

/** A lease record as the lane writes it. Every field is optional because a record may be damaged. */
export interface LeaseRecord {
  version?: number
  runId?: string | null
  mode?: string
  identity?: {
    label?: string
    project?: string
    worktree?: string | null
    [key: string]: unknown
  } | null
  owner?: { pid?: number; hostname?: string; startedAt?: string } | null
  state?: string
  createdAt?: number
  updatedAt?: number
  cleanup?: unknown
  physicalWorktreePath?: string | null
  physicalWorktreePathResolved?: boolean
}

/** Answers whether the process holding a recorded pid is alive. */
export type ProcessProbe = (pid: number, ownerHostname?: string) => boolean

export interface LivenessAnswer {
  state: (typeof LIVENESS)[keyof typeof LIVENESS]
  reason: string
}

export interface LivenessOptions {
  host?: string | null
  probe?: ProcessProbe | null
}

export function livenessOf(
  lease: LeaseRecord | null | undefined,
  options?: LivenessOptions
): LivenessAnswer
export function boundedLivenessProbe(options?: LivenessOptions): ProcessProbe

export function regenerableKind(entry: unknown): string | null

/** The proof that one ignored path's content is accounted for. */
export interface IgnoredProof {
  kind: string
  digest?: string
}
export function isRegenerableIgnored(entry: string, proof?: IgnoredProof | null): boolean
export function unknownIgnoredPaths(
  entries?: string[],
  proofs?: Record<string, IgnoredProof | null | undefined>
): string[]

/** A Docker resource as the host lists it. */
export interface DockerResource {
  kind?: string
  name?: string | null
  label?: string | null
}

export interface LeaseEvidenceEntry {
  runId: string | null
  state: string
  liveness: LivenessAnswer
}

export interface ResourceInventoryItem {
  kind: string
  name: string | null
  label: string | null
  leaseRunId: string | null
  leaseState: string
  leaseMatched: boolean
  disposition: string
  reason: string
  reclaimable: boolean
  leaseEvidence: LeaseEvidenceEntry[]
}

export interface InventoryOptions extends LivenessOptions {
  runId?: string | null
  leases?: LeaseRecord[]
  unreadableLeases?: string[]
  dockerResources?: DockerResource[]
  identity?: { [key: string]: unknown } | null
  isProcessAlive?: ProcessProbe
}

export function inventoryOwnedResources(options?: InventoryOptions): {
  resources: ResourceInventoryItem[]
  summary: { total: number; reclaimable: number; protected: number }
}

/** What the runner established about the remote for one checkout. */
export interface OriginFacts {
  fresh?: boolean
  containsHead?: boolean
  remoteBranchPresent?: boolean
  remoteSha?: string | null
  fetchedSha?: string | null
  bound?: boolean
}

/** What one ignored path holds, with the digest a rebuild would have to reproduce. */
export interface IgnoredContentEntry {
  digest?: string
  files?: number
  bytes?: number
  truncated?: boolean
  looks?: string | null
}

/** One checkout and the facts a reuse decision is made from. */
export interface WorktreeFacts {
  path?: string | null
  physicalPath?: string | null
  physicalPathResolved?: boolean
  head?: string | null
  branch?: string | null
  localChanges?: boolean
  ignoredUnknown?: string[]
  ignoredUnreadable?: boolean
  ignoredProofs?: Record<string, IgnoredProof>
  ignoredContent?: Record<string, IgnoredContentEntry>
  published?: boolean
  origin?: OriginFacts | null
  unresolvedLeasePaths?: string[]
  sizeBytes?: number | null
}

export interface ReuseEvidence {
  localWork: boolean | null
  pathIdentity: string | null
  ignoredUnknown: string[]
  ignoredContent: Record<string, IgnoredContentEntry>
  ignoredUnreadable: boolean | null
  originFresh: boolean | null
  headInOrigin: boolean | null
  published: boolean | null
  ownerLive: boolean | null
  ownerUncertain: boolean | null
  ownerForeign: boolean | null
  matchingLeases: LeaseEvidenceEntry[]
  preservedScopes: Array<LeaseEvidenceEntry & { scope: string | null }>
  unreadableLeaseRecords: string[]
  leaseScanFailed: boolean
  unresolvedLeasePaths?: string[]
}

export interface ReusePlan {
  path: string | null
  decision: (typeof REUSE_DECISION)[keyof typeof REUSE_DECISION]
  reasons: string[]
  reason: string
  evidence: ReuseEvidence
}

export interface PlanOptions extends LivenessOptions {
  worktree?: WorktreeFacts | null
  leases?: LeaseRecord[]
  origin?: OriginFacts | null
  isProcessAlive?: ProcessProbe
  unreadableLeases?: string[]
  leaseScanFailed?: boolean
}
export function planWorktreeReuse(options?: PlanOptions): ReusePlan

export function describeRefusals(refusals: string[]): string

export interface DiskTelemetry {
  docker: {
    totalBytes: number
    reclaimableBytes: number
    reported: boolean
    volumesBytes: number
  }
  worktrees: { count: number; bytes: number }
  totalBytes: number
}
export interface DiskTelemetryOptions {
  dockerSystemDf?: { totalBytes?: number; reclaimableBytes?: number } | null
  dockerVolumes?: Array<{ sizeBytes?: number | null }>
  worktrees?: Array<{ sizeBytes?: number | null }>
}
export function diskTelemetry(options?: DiskTelemetryOptions): DiskTelemetry

export interface ReportResourceItem {
  kind: string | undefined
  name: string | null | undefined
  eligibility: (typeof ELIGIBILITY)[keyof typeof ELIGIBILITY]
  disposition: string | undefined
  reason: string | undefined
  reclaimable: boolean
  evidence: {
    label: string | null
    leaseRunId: string | null
    leaseState: string | null
    leaseMatched: boolean
    leaseEvidence: LeaseEvidenceEntry[]
  }
}

export interface ReportWorktreeItem {
  path: string | null | undefined
  eligibility: (typeof ELIGIBILITY)[keyof typeof ELIGIBILITY]
  decision: ReusePlan['decision']
  reason: string
  reasons: string[]
  evidence: ReuseEvidence
}

/** What `eligibilityReport` takes for one resource: an inventory item, in whole or in part. */
export type EligibilityResourceInput = Partial<ResourceInventoryItem>

/** What `eligibilityReport` takes for one checkout: the facts, and optionally their plan. */
export type EligibilityWorktreeInput = WorktreeFacts & { plan?: ReusePlan | null }

export interface EligibilityReport {
  generatedAt: string | null
  summary: {
    resources: number
    eligibleResources: number
    worktrees: number
    eligibleWorktrees: number
    preserved: number
  }
  resources: ReportResourceItem[]
  worktrees: ReportWorktreeItem[]
  disk: DiskTelemetry | null
}

export function eligibilityReport(options?: {
  resources?: EligibilityResourceInput[]
  worktrees?: EligibilityWorktreeInput[]
  disk?: DiskTelemetry | null
  now?: string | null
}): EligibilityReport

/** An item as `preservationProof` reads it: a report item, in whole or in part. */
export interface PreservationInput {
  kind?: string
  name?: string | null
  path?: string | null
  eligibility?: string
  disposition?: string
  decision?: string
  reason?: string
  reclaimable?: boolean
  evidence?: {
    leaseMatched?: boolean
    originFresh?: boolean | null
    ownerLive?: boolean | null
  }
}
export interface InventoryError {
  source?: string
  reason?: string
}
export interface PreservationProof {
  preserved: Array<{ kind?: string; name?: string | null; path?: string | null; reason?: string }>
  violations: Array<{ kind?: string; name?: string | null; path?: string | null; reason: string }>
  ok: boolean
}
export function preservationProof(options?: {
  resources?: PreservationInput[]
  worktrees?: PreservationInput[]
  inventoryErrors?: InventoryError[]
}): PreservationProof

export function concurrencyAdmission(options?: { running?: number; limit?: number }): {
  admitted: boolean
  reason: string
  running: number
  limit: number
}

export function reuseDiskAdmission(options?: {
  availableBytes?: number | null
  requiredBytes?: number
  limitBytes?: number
}): {
  decision: string
  reason: string
  availableBytes: number | null
  pressure: string
}
