import type { MigrationSnapshotSection, NativeSessionSnapshotRecord } from '@adea-ai/types'
import type { RuntimeSession } from '@adea-ai/types/dev-runtime'

/**
 * Bounded read-only composition adapter for the runtime-owned session
 * inventory.
 *
 * The canonical authority is the execution host's `dev.session.list` read
 * (registry `packages/types/src/dev-runtime-registry.ts`, capability
 * `dev.session.read`, reply `Page<RuntimeSession>`), consumed by Adea through
 * the desktop bridge (`apps/web/src/lib/desktop-dev-runtime.ts`). This module
 * composes that read into the migration snapshot contract: it owns no
 * catalogue, caches nothing, resolves no credentials and derives nothing from
 * the wall clock. The caller injects the authenticated source; a deployment
 * without that source keeps the domain `unknown`/`unsupported_family` instead
 * of reading an absent inventory as empty.
 */

/** One page of the canonical runtime session read. */
export type NativeSessionInventoryPage = Readonly<{
  items: readonly RuntimeSession[]
  nextCursor?: string
}>

/** The injected authoritative read; authentication and scope belong to it. */
export type NativeSessionInventorySource = Readonly<{
  listRuntimeSessions: (
    input: Readonly<{ cursor?: string; limit: number }>
  ) => Promise<NativeSessionInventoryPage>
}>

/** Why the runtime session inventory could not be composed. */
export type NativeSessionInventoryFailure = 'denied' | 'invalid' | 'unavailable'

export class NativeSessionInventoryError extends Error {
  readonly kind: NativeSessionInventoryFailure

  constructor(kind: NativeSessionInventoryFailure, message: string) {
    super(message)
    this.name = 'NativeSessionInventoryError'
    this.kind = kind
  }
}

const nativeSessionLifecycles = new Set([
  'preparing',
  'ready',
  'active',
  'disconnected',
  'completed',
  'failed',
  'cancelled',
])

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNullableString(value: unknown): boolean {
  return value === undefined || value === null || isNonEmptyString(value)
}

function isNullableCount(value: unknown): boolean {
  return (
    value === undefined || value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
  )
}

/**
 * Map one canonical `RuntimeSession` to its frozen snapshot record. A payload
 * that leaves the canonical contract — a bridge is an untrusted boundary — is
 * refused as `invalid` so the domain stays unknown instead of capturing a
 * fabricated row.
 */
function toRecord(session: RuntimeSession): NativeSessionSnapshotRecord {
  const candidate = session as unknown as Record<string, unknown>
  const scope = candidate.scope as Record<string, unknown> | undefined
  if (
    !isNonEmptyString(candidate.id) ||
    !scope ||
    !isNonEmptyString(scope.accountId) ||
    !isNonEmptyString(scope.workspaceId) ||
    !isNonEmptyString(scope.runtimeNodeId) ||
    !isNonEmptyString(candidate.projectId) ||
    !isNonEmptyString(candidate.worktreeId) ||
    typeof candidate.lifecycle !== 'string' ||
    !nativeSessionLifecycles.has(candidate.lifecycle) ||
    typeof candidate.archived !== 'boolean' ||
    !Number.isSafeInteger(candidate.generation) ||
    (candidate.generation as number) < 0 ||
    !Number.isSafeInteger(candidate.version) ||
    (candidate.version as number) < 0 ||
    !isNullableString(candidate.agentProfileId) ||
    !isNullableCount(candidate.agentProfileVersion) ||
    !isNullableString(candidate.harnessInstallationId) ||
    !isNullableString(candidate.activeHarnessRunId)
  ) {
    throw new NativeSessionInventoryError(
      'invalid',
      'runtime session inventory returned a record outside the canonical contract'
    )
  }
  return Object.freeze({
    accountId: scope.accountId,
    activeHarnessRunId: (candidate.activeHarnessRunId as string | undefined) ?? null,
    agentProfileId: (candidate.agentProfileId as string | undefined) ?? null,
    agentProfileVersion: (candidate.agentProfileVersion as number | undefined) ?? null,
    archived: candidate.archived,
    family: 'nativeSessions',
    generation: candidate.generation as number,
    harnessInstallationId: (candidate.harnessInstallationId as string | undefined) ?? null,
    lifecycle: candidate.lifecycle,
    projectId: candidate.projectId,
    runtimeNodeId: scope.runtimeNodeId,
    sessionRef: candidate.id,
    version: candidate.version as number,
    workspaceId: scope.workspaceId,
    worktreeId: candidate.worktreeId,
  })
}

async function readPage(
  source: NativeSessionInventorySource,
  input: Readonly<{ cursor?: string; limit: number }>
): Promise<NativeSessionInventoryPage> {
  try {
    return await source.listRuntimeSessions(input)
  } catch (error) {
    if (error instanceof NativeSessionInventoryError) throw error
    throw new NativeSessionInventoryError(
      'unavailable',
      'the runtime session inventory read failed'
    )
  }
}

/**
 * Read the canonical inventory to exhaustion or the section bound and map it
 * to a frozen snapshot section. The read is bounded (one probe row past the
 * bound observes truncation), deterministic (records sorted by stable id) and
 * read-only. A source failure propagates as `NativeSessionInventoryError` so
 * the capture reports a typed unknown instead of an empty section.
 */
export async function captureNativeSessionSection(
  source: NativeSessionInventorySource,
  bound: number
): Promise<MigrationSnapshotSection> {
  const records: NativeSessionSnapshotRecord[] = []
  let cursor: string | undefined
  let truncated = false
  for (;;) {
    const remaining = bound - records.length
    const page = await readPage(source, { cursor, limit: remaining + 1 })
    for (const session of page.items) {
      if (records.length >= bound) {
        truncated = true
        break
      }
      records.push(toRecord(session))
    }
    if (truncated) break
    if (page.items.length <= remaining && !page.nextCursor) break
    if (!page.nextCursor) {
      truncated = records.length >= bound
      break
    }
    cursor = page.nextCursor
  }
  records.sort((left, right) =>
    left.sessionRef < right.sessionRef ? -1 : left.sessionRef > right.sessionRef ? 1 : 0
  )
  return Object.freeze({
    limit: bound,
    records: Object.freeze(records),
    truncated,
  })
}
