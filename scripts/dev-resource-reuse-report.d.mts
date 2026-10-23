// Types for `dev-resource-reuse-report.mjs`.
//
// The command's seams are injected so it can run without Docker, Git or a
// process boundary, and the `.mjs` source defaults each one to the real
// implementation (`runCommand = spawnSync`, `writeReport = writeFileSync`).
// Inferred from those defaults, a fake would have to be a full `spawnSync` or
// `writeFileSync`. This file states the narrow contract the command actually
// uses, so a strict caller can inject a fake of that shape.

import type {
  DiskTelemetry,
  DockerResource,
  EligibilityReport,
  IgnoredContentEntry,
  IgnoredProof,
  InventoryError,
  LeaseRecord,
  LivenessOptions,
  OriginFacts,
  PreservationProof,
  ProcessProbe,
  ReusePlan,
  WorktreeFacts,
} from './dev-resource-reuse.mjs'

/** The part of a spawned command's result that the command reads. */
export interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

/** Runs one command. The default is `spawnSync` with `encoding: 'utf8'`. */
export type RunCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; encoding?: string; timeout?: number }
) => CommandResult

export function dockerResourceInventory(runCommand?: RunCommand): {
  resources: DockerResource[]
  errors: InventoryError[]
}

export function physicalWorktreePath(path: unknown): string | null
export function isPrimaryWorktreePath(
  entryPath: string,
  repoPath: string,
  resolvePath?: (path: string) => string | null
): boolean

export function parseIgnoredPaths(stdout: unknown): string[]

/** The file-system reads `ignoredContent` makes, injectable so a failure can be exercised. */
export interface IgnoredContentIo {
  readdirSync?: (path: string, options: { withFileTypes: true }) => import('node:fs').Dirent[]
  lstatSync?: (
    path: string
  ) => Pick<import('node:fs').Stats, 'isSymbolicLink' | 'isDirectory' | 'isFile' | 'size'>
  readlinkSync?: (path: string) => string
  readFileSync?: (path: string) => { length: number } & Uint8Array
}
export function ignoredContent(
  worktreePath: string,
  entry: string,
  limits?: { fileLimit?: number; byteLimit?: number },
  io?: IgnoredContentIo
): { digest: string; files: number; bytes: number; truncated: boolean }

export function proofForIgnoredPath(
  entry: string,
  options?: {
    content?: { digest: string; files: number; truncated?: boolean } | null
    rebuildDigests?: Record<string, string>
    trackedClean?: boolean
  }
): IgnoredProof | null

export function originIsBound(remoteSha: unknown, fetchedSha: unknown): boolean
export function remoteBranchHeads(repo: string, runCommand?: RunCommand): Map<string, string> | null

export function readLeaseEvidence(
  directory: string,
  options?: { now?: number }
): { leases: LeaseRecord[]; unreadable: string[]; future: string[]; scanError: string | null }
/** A record is read defensively: a timestamp that is not a finite number is simply not in the future. */
export function isFutureLease(
  lease: { createdAt?: unknown; updatedAt?: unknown } | null | undefined,
  now?: number
): boolean

export interface FetchOutcome {
  requested: boolean
  ok: boolean
  error: string | null
}

/** A checkout as the runner observed it. */
export interface ObservedWorktree extends WorktreeFacts {
  path: string
  physicalPath: string | null
  physicalPathResolved: boolean
  head: string | null
  branch: string | null
  localChanges: boolean
  ignoredUnknown: string[]
  ignoredUnreadable: boolean
  ignoredProofs: Record<string, IgnoredProof>
  ignoredContent: Record<string, IgnoredContentEntry>
  published: boolean
  origin: Required<OriginFacts>
  sizeBytes: number | null
}

export function worktreesOf(
  repo: string,
  options?: {
    refresh?: boolean
    rebuildDigests?: Record<string, string>
    runCommand?: RunCommand
  }
): {
  worktrees: ObservedWorktree[]
  fetch: FetchOutcome
  inventoryError?: InventoryError
}

export interface PlanWorktreesOptions extends LivenessOptions {
  unreadableLeases?: string[]
  leaseScanFailed?: boolean
  physicalPathOf?: (path: string) => string | null
  isProcessAlive?: ProcessProbe
}
export function planWorktrees<T extends WorktreeFacts>(
  worktrees?: T[],
  leases?: LeaseRecord[],
  options?: PlanWorktreesOptions
): Array<T & { plan: ReusePlan }>

export interface CollectedReport extends EligibilityReport {
  leaseDirectory: string
  leases: number
  unreadableLeaseRecords: string[]
  futureLeaseRecords: string[]
  leaseScanError: string | null
  repository: string | null
  inventoryErrors: InventoryError[]
  inventoryComplete: boolean
  ownershipSources: string[]
  ownershipBoundary: string
  originRefreshed: boolean
  fetchRequested: boolean
  fetchError: string | null
  preservation: PreservationProof
  disk: DiskTelemetry | null
}

export function collectReport(options?: {
  repo?: string | null
  leaseDir?: string | null
  refresh?: boolean
  now?: string | null
  dockerResources?: DockerResource[]
  inventoryErrors?: InventoryError[]
  runId?: string | null
  host?: string
  probe?: ProcessProbe
  rebuildDigests?: Record<string, string>
  runCommand?: RunCommand
}): {
  report: CollectedReport
  fetch: FetchOutcome
  inventoryErrors: InventoryError[]
}

export function main(options?: {
  argv?: string[]
  env?: Record<string, string | undefined>
  runCommand?: RunCommand
  writeReport?: (path: string, content: string) => void
  writeOutput?: (text: string) => unknown
}): void
