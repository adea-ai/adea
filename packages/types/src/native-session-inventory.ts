import {
  MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION,
  type MigrationSnapshotSection,
  type NativeSessionSnapshotRecord,
} from './migration-snapshot'
import type { RuntimeSession } from './dev-runtime'

/**
 * Bounded read-only composition adapter for the runtime-owned session
 * inventory.
 *
 * The canonical authority is the execution host's `dev.session.list` read
 * (registry `packages/types/src/dev-runtime-registry.ts`, capability
 * `dev.session.read`, reply `Page<RuntimeSession>`), consumed by Adea through
 * the authenticated desktop bridge. This browser-safe module composes that
 * read into the migration snapshot contract: it owns no catalogue, caches
 * nothing, resolves no credentials and derives nothing from the wall clock.
 * A deployment without an authenticated source keeps the domain unknown
 * instead of reading an absent inventory as empty.
 */

/** One page of the canonical runtime session read. */
export type NativeSessionInventorySession = Pick<
  RuntimeSession,
  | 'activeHarnessRunId'
  | 'agentProfileId'
  | 'agentProfileVersion'
  | 'archived'
  | 'generation'
  | 'harnessInstallationId'
  | 'id'
  | 'lifecycle'
  | 'projectId'
  | 'scope'
  | 'version'
  | 'worktreeId'
>

export type NativeSessionInventoryPage = Readonly<{
  items: readonly NativeSessionInventorySession[]
  nextCursor?: string
}>

export const NATIVE_SESSION_INVENTORY_PAGE_TIMEOUT_MS = 15_000

/**
 * The canonical registry bound for `dev.session.list`:
 * `limit integer(1..500)` (`packages/types/src/dev-runtime-registry.ts`).
 * Every composed request is capped here so a large snapshot bound never
 * produces a call the canonical validator would refuse.
 */
export const NATIVE_SESSION_INVENTORY_PAGE_LIMIT = 500

/** Maximum serialized JSON size of one captured section. */
export const NATIVE_SESSION_INVENTORY_MAX_OUTPUT_BYTES = 1_048_576

/** Maximum length of any projected identifier string from an untrusted source. */
const NATIVE_SESSION_INVENTORY_MAX_IDENTIFIER_LENGTH = 512

/**
 * The injected authoritative read. Authentication and transport belong to the
 * source; `authorizedScopes` is the source's explicit declaration of the
 * scope(s) it is authorized to read. The adapter validates every record
 * against that declaration — it never infers a scope, and an empty
 * declaration is refused rather than silently disabling the check. A source
 * that composes several authenticated scopes lists each one.
 */
export type NativeSessionInventorySource = Readonly<{
  authorizedScopes: readonly NativeSessionInventoryScope[]
  listRuntimeSessions: (
    input: Readonly<{ cursor?: string; limit: number }>
  ) => Promise<NativeSessionInventoryPage>
}>

/** Why the runtime session inventory could not be composed. */
export type NativeSessionInventoryFailure = 'denied' | 'invalid' | 'unavailable'

/** The account/workspace/node scope an authoritative read must stay inside. */
export type NativeSessionInventoryScope = Readonly<{
  accountId: string
  runtimeNodeId: string
  workspaceId: string
}>

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
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= NATIVE_SESSION_INVENTORY_MAX_IDENTIFIER_LENGTH
  )
}

/**
 * Canonical runtime identifiers are opaque references, not filesystem paths.
 * Refuse obvious absolute/home/file URLs at this export boundary so an invalid
 * host reply cannot smuggle a private native path into the snapshot DTO.
 */
function isPathShapedIdentifier(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\\\') ||
    value.startsWith('\\') ||
    /^[a-z]:[\\/]/i.test(value) ||
    /^~[\\/]/.test(value) ||
    /^(?:\.\.?)[\\/]/.test(value) ||
    /^file:/i.test(value)
  )
}

function isSafeIdentifier(value: unknown): value is string {
  return isNonEmptyString(value) && !isPathShapedIdentifier(value)
}

function isNullableString(value: unknown): boolean {
  return value === undefined || value === null || isSafeIdentifier(value)
}

function isNullableCount(value: unknown): boolean {
  return (
    value === undefined || value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
  )
}

function isAuthorizedScope(
  scope: NativeSessionInventoryScope,
  authorizedScopes: readonly NativeSessionInventoryScope[]
): boolean {
  return authorizedScopes.some(
    (authorized) =>
      authorized.accountId === scope.accountId &&
      authorized.workspaceId === scope.workspaceId &&
      authorized.runtimeNodeId === scope.runtimeNodeId
  )
}

/**
 * Map one canonical `RuntimeSession` to its frozen snapshot record. A payload
 * that leaves the canonical contract — a bridge is an untrusted boundary — is
 * refused as `invalid` so the domain stays unknown instead of capturing a
 * fabricated row.
 */
function toRecord(
  session: NativeSessionInventorySession,
  authorizedScopes: readonly NativeSessionInventoryScope[]
): NativeSessionSnapshotRecord {
  const candidate = session as unknown as Record<string, unknown>
  const recordScope = candidate.scope as Record<string, unknown> | undefined
  if (
    !isSafeIdentifier(candidate.id) ||
    !recordScope ||
    !isSafeIdentifier(recordScope.accountId) ||
    !isSafeIdentifier(recordScope.workspaceId) ||
    !isSafeIdentifier(recordScope.runtimeNodeId) ||
    !isSafeIdentifier(candidate.projectId) ||
    !isSafeIdentifier(candidate.worktreeId) ||
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
  if (
    !isAuthorizedScope(
      {
        accountId: recordScope.accountId,
        runtimeNodeId: recordScope.runtimeNodeId,
        workspaceId: recordScope.workspaceId,
      },
      authorizedScopes
    )
  ) {
    throw new NativeSessionInventoryError(
      'invalid',
      'runtime session inventory returned a record outside the source authorized scopes'
    )
  }
  return Object.freeze({
    accountId: recordScope.accountId,
    activeHarnessRunId: (candidate.activeHarnessRunId as string | undefined) ?? null,
    agentProfileId: (candidate.agentProfileId as string | undefined) ?? null,
    agentProfileVersion: (candidate.agentProfileVersion as number | undefined) ?? null,
    archived: candidate.archived,
    family: 'nativeSessions',
    generation: candidate.generation as number,
    harnessInstallationId: (candidate.harnessInstallationId as string | undefined) ?? null,
    lifecycle: candidate.lifecycle,
    projectId: candidate.projectId,
    runtimeNodeId: recordScope.runtimeNodeId,
    sessionRef: candidate.id,
    version: candidate.version as number,
    workspaceId: recordScope.workspaceId,
    worktreeId: candidate.worktreeId,
  })
}

async function readPage(
  source: NativeSessionInventorySource,
  input: Readonly<{ cursor?: string; limit: number }>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<NativeSessionInventoryPage> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  try {
    if (signal?.aborted) {
      throw new NativeSessionInventoryError('unavailable', 'native session inventory was cancelled')
    }
    const pendingRead = source.listRuntimeSessions(input)
    const races: Promise<NativeSessionInventoryPage>[] = [
      pendingRead,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('native session inventory page timed out')),
          timeoutMs
        )
      }),
    ]
    if (signal) {
      races.push(
        new Promise<never>((_, reject) => {
          abortListener = () =>
            reject(
              new NativeSessionInventoryError(
                'unavailable',
                'native session inventory was cancelled'
              )
            )
          signal.addEventListener('abort', abortListener, { once: true })
          if (signal.aborted) abortListener()
        })
      )
    }
    const page = await Promise.race(races)
    if (signal?.aborted) {
      throw new NativeSessionInventoryError('unavailable', 'native session inventory was cancelled')
    }
    return page
  } catch (error) {
    if (error instanceof NativeSessionInventoryError) throw error
    if (error instanceof Error && error.message === 'native session inventory page timed out') {
      throw new NativeSessionInventoryError(
        'unavailable',
        'the runtime session inventory read timed out'
      )
    }
    throw new NativeSessionInventoryError(
      'unavailable',
      'the runtime session inventory read failed'
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal && abortListener) signal.removeEventListener('abort', abortListener)
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
  bound: number,
  options: Readonly<{ pageTimeoutMs?: number; signal?: AbortSignal }> = {}
): Promise<MigrationSnapshotSection> {
  const timeoutMs = options.pageTimeoutMs ?? NATIVE_SESSION_INVENTORY_PAGE_TIMEOUT_MS
  if (
    !Number.isSafeInteger(bound) ||
    bound < 1 ||
    bound > MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > NATIVE_SESSION_INVENTORY_PAGE_TIMEOUT_MS
  ) {
    throw new NativeSessionInventoryError(
      'invalid',
      'runtime session inventory bounds are outside the supported range'
    )
  }
  const declaredScopes = source.authorizedScopes
  if (
    !Array.isArray(declaredScopes) ||
    declaredScopes.length === 0 ||
    !declaredScopes.every(
      (scope) =>
        isNonEmptyString(scope?.accountId) &&
        isNonEmptyString(scope?.workspaceId) &&
        isNonEmptyString(scope?.runtimeNodeId)
    )
  ) {
    throw new NativeSessionInventoryError(
      'invalid',
      'runtime session inventory source declared no authorized scope'
    )
  }
  // Freeze the authority snapshot before the first await. A source may be
  // long-lived or mutable; changing its declared scopes during capture must
  // not widen which records this snapshot accepts.
  const authorizedScopes = Object.freeze(
    declaredScopes.map((scope) =>
      Object.freeze({
        accountId: scope.accountId,
        runtimeNodeId: scope.runtimeNodeId,
        workspaceId: scope.workspaceId,
      })
    )
  )
  const records: NativeSessionSnapshotRecord[] = []
  const seenSessionIds = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let truncated = false
  for (;;) {
    const remaining = bound - records.length
    // One probe row past the remaining budget observes exact truncation; the
    // canonical registry caps every request at 500, so large bounds page.
    const requestLimit = Math.min(remaining + 1, NATIVE_SESSION_INVENTORY_PAGE_LIMIT)
    const rawPage: unknown = await readPage(
      source,
      { cursor, limit: requestLimit },
      timeoutMs,
      options.signal
    )
    if (
      typeof rawPage !== 'object' ||
      rawPage === null ||
      !Array.isArray((rawPage as { items?: unknown }).items) ||
      (rawPage as { items: unknown[] }).items.length > requestLimit ||
      ((rawPage as { nextCursor?: unknown }).nextCursor !== undefined &&
        (typeof (rawPage as { nextCursor?: unknown }).nextCursor !== 'string' ||
          (rawPage as { nextCursor: string }).nextCursor.length === 0 ||
          (rawPage as { nextCursor: string }).nextCursor.length > 512))
    ) {
      throw new NativeSessionInventoryError(
        'invalid',
        'runtime session inventory returned a malformed or oversized page'
      )
    }
    const page = rawPage as NativeSessionInventoryPage
    // An empty page that claims a continuation can never terminate and would
    // stream forever; a cursor that repeats is a loop. Both fail closed.
    if (page.items.length === 0 && page.nextCursor !== undefined) {
      throw new NativeSessionInventoryError(
        'invalid',
        'runtime session inventory returned an empty page with a continuation cursor'
      )
    }
    const pageRecords = page.items.map((session) => toRecord(session, authorizedScopes))
    for (const record of pageRecords) {
      if (seenSessionIds.has(record.sessionRef)) {
        throw new NativeSessionInventoryError(
          'invalid',
          'runtime session inventory returned a duplicate stable identity'
        )
      }
      seenSessionIds.add(record.sessionRef)
    }
    const remainingBeforePage = bound - records.length
    const overflow = pageRecords.length > remainingBeforePage
    records.push(...pageRecords.slice(0, remainingBeforePage))
    // Truncation is exact: the probe row overflowed, or the bound is met while
    // the canonical read still declares a continuation.
    if (overflow || (records.length >= bound && page.nextCursor !== undefined)) {
      truncated = true
      break
    }
    if (page.nextCursor === undefined) break
    if (seenCursors.has(page.nextCursor)) {
      throw new NativeSessionInventoryError(
        'invalid',
        'runtime session inventory repeated a cursor; refusing to loop'
      )
    }
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  records.sort((left, right) =>
    left.sessionRef < right.sessionRef ? -1 : left.sessionRef > right.sessionRef ? 1 : 0
  )
  if (options.signal?.aborted) {
    throw new NativeSessionInventoryError('unavailable', 'native session inventory was cancelled')
  }
  const section = Object.freeze({
    limit: bound,
    records: Object.freeze(records),
    truncated,
  })
  if (
    new TextEncoder().encode(JSON.stringify(section)).byteLength >
    NATIVE_SESSION_INVENTORY_MAX_OUTPUT_BYTES
  ) {
    throw new NativeSessionInventoryError(
      'invalid',
      'runtime session inventory exceeded the supported output size'
    )
  }
  return section
}
