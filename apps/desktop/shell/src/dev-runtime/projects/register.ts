import type {
  DevCommand,
  DevOperation,
  ProjectScanEntry,
  ProjectScanPage,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import type { ChannelAuthority } from '../channel/authority'
import { DevAuthorityError } from '../authority'
import { rootScanFingerprint, scanDirectoryRoot, type ScanBudgets } from './scan'

export type ProjectScanRuntime = Readonly<{
  providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>>
}>

/**
 * The `dev.project.scan` provider (#398): enumerates importable workspace
 * packages under one authorized root bookmark. The canonical root never comes
 * from the command — the composition resolves it through the roots
 * authority's fail-closed recheck, so a revoked, drifted, or replaced root
 * refuses before any filesystem work starts.
 *
 * Results are cached by bookmark identity plus the manifest/ignore
 * fingerprint; `force: true` rescans. Pagination rides an opaque cursor that
 * binds the cached fingerprint: a scan that changed under a paginated client
 * refuses with `stale_version` instead of mixing pages from two scans.
 * Budget exhaustion and cancellation surface as a partial successful page
 * with diagnostics, never a silent truncation.
 */

const SCAN_PAGE_SIZE = 200

type CachedScan = Readonly<{
  fingerprint: string
  entries: readonly ProjectScanEntry[]
  partial: boolean
  diagnostics: readonly string[]
}>

type ScanCursor = Readonly<{ fingerprint: string; offset: number }>

function encodeCursor(cursor: ScanCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(raw: string): ScanCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new DevAuthorityError('not_found', 'unknown scan cursor')
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as ScanCursor).fingerprint !== 'string' ||
    !Number.isSafeInteger((parsed as ScanCursor).offset) ||
    (parsed as ScanCursor).offset < 0
  ) {
    throw new DevAuthorityError('not_found', 'unknown scan cursor')
  }
  return parsed as ScanCursor
}

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

export function registerProjectScanRuntime(input: {
  authority: ChannelAuthority
  scope: Scope
  /** Fail-closed bookmark resolution: the roots authority's validate. */
  resolveScanRoot: (rootBookmarkId: string) => { canonicalRoot: string }
  /** Scan budget overrides (tests use tiny budgets to prove partial pages). */
  budgets?: Partial<ScanBudgets>
  /** Test seam: inject the directory scan instead of the real walker. */
  scan?: (canonicalRoot: string) => ReturnType<typeof scanDirectoryRoot>
}): ProjectScanRuntime {
  const cache = new Map<string, CachedScan>()
  const scanOf = input.scan ?? ((canonicalRoot: string) => scanDirectoryRoot({ canonicalRoot }))

  const provider = (command: DevCommand): ProjectScanPage => {
    if (!sameScope(command.scope, input.scope))
      throw new DevAuthorityError('unauthorized', 'project scan scope is not authorized')
    const body = devOperationDecoders['dev.project.scan'].request(command.body)
    const rootBookmarkId = body.rootBookmarkId as string
    const force = body.force === true
    const root = input.resolveScanRoot(rootBookmarkId)
    const fingerprint = rootScanFingerprint(root.canonicalRoot)
    let cached = cache.get(rootBookmarkId)
    if (!cached || force || cached.fingerprint !== fingerprint) {
      const result = scanOf(root.canonicalRoot)
      cached = {
        fingerprint,
        entries: result.entries,
        partial: result.partial,
        diagnostics: result.diagnostics,
      }
      cache.set(rootBookmarkId, cached)
    }
    let offset = 0
    if (typeof body.cursor === 'string') {
      const cursor = decodeCursor(body.cursor)
      if (cursor.fingerprint !== fingerprint)
        throw new DevAuthorityError(
          'stale_version',
          'the scan moved on while it was being paginated; request it again without the cursor'
        )
      offset = cursor.offset
    }
    const items = cached.entries.slice(offset, offset + SCAN_PAGE_SIZE)
    const nextOffset = offset + SCAN_PAGE_SIZE
    return {
      rootBookmarkId,
      items,
      partial: cached.partial,
      diagnostics: [...cached.diagnostics],
      observedAt: new Date().toISOString(),
      ...(nextOffset < cached.entries.length
        ? { nextCursor: encodeCursor({ fingerprint, offset: nextOffset }) }
        : {}),
    }
  }

  input.authority.registerCommandProvider('dev.project.scan', provider)
  return { providers: { 'dev.project.scan': provider } }
}
