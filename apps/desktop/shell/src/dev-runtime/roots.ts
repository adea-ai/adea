// M10 #34: the authorized-root (RootBookmark) authority.
//
// A RootBookmark is the durable record that an owner authorized one directory
// or repository root on one account/workspace/runtime-node scope. `dev.files.*`
// and `dev.git.*` operations resolve every path through `resolvePath`, which
// revalidates the bookmark and the target identity immediately before the side
// effect: no string-prefix authorization, no ambient absolute paths, symlinked
// spellings rejected, and identity drift marked stale instead of trusted.
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  DevAuthorityError,
  isUuid,
  newRecordId,
  nowIso,
  requireApproval,
  requireLabel,
  sameScope,
  type DevScope,
  type OwnerApproval,
  type OwnerApprovalVerifier,
} from './authority'
import type { AuthorityAudit } from './audit'
import { createDurableJsonStore } from './host-store'

export type FileIdentityValue = Readonly<{
  device?: string
  inode?: string
  birthtimeNs?: string
  mtimeNs: string
  size: string
}>

export type RootBookmarkRecord = Readonly<{
  id: string
  scope: DevScope
  label: string
  kind: 'directory' | 'repository'
  canonicalRoot: string
  rootIdentity: FileIdentityValue
  state: 'active' | 'stale' | 'revoked'
  generation: number
  version: number
  createdAt: string
  revokedAt?: string
  revokedReason?: string
}>

export type RootBookmarkPage = Readonly<{
  items: ReadonlyArray<RootBookmarkRecord>
  nextCursor?: string
  observedAt: string
}>

export type PathKind = 'file' | 'directory' | 'special'

const MAX_PAGE_LIMIT = 500
const DEFAULT_PAGE_LIMIT = 100

/** A malformed id and a foreign-scope id read identically: not found. */
function findBookmark(
  records: ReadonlyArray<RootBookmarkRecord>,
  scope: DevScope,
  bookmarkId: string
): RootBookmarkRecord | undefined {
  const record = records.find((entry) => entry.id === bookmarkId)
  if (!record || !isUuid(bookmarkId) || !sameScope(record.scope, scope)) return undefined
  return record
}
const RELATIVE_PATH_MAX = 4096

function identityOf(absolutePath: string): FileIdentityValue {
  const stats = statSync(absolutePath, { bigint: true })
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    birthtimeNs: String(stats.birthtimeNs),
    mtimeNs: String(stats.mtimeNs),
    size: String(stats.size),
  }
}

/** Stable identity comparison: only the replacement-proof fields, never the
 * mutable directory metadata (mtime/size change with content). */
function sameRootIdentity(a: FileIdentityValue, b: FileIdentityValue): boolean {
  return a.device === b.device && a.inode === b.inode
}

function pageOf(
  records: ReadonlyArray<RootBookmarkRecord>,
  cursor?: string,
  limit?: number
): RootBookmarkPage {
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT)
  ) {
    throw new DevAuthorityError('limit_exceeded', `limit must be an integer 1..${MAX_PAGE_LIMIT}`)
  }
  const pageSize = limit ?? DEFAULT_PAGE_LIMIT
  let start = 0
  if (cursor !== undefined) {
    const decoded = Number(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!Number.isSafeInteger(decoded) || decoded < 0) {
      throw new DevAuthorityError('not_found', 'unknown listing cursor')
    }
    start = decoded
  }
  const items = records.slice(start, start + pageSize)
  const nextCursor =
    start + pageSize < records.length
      ? Buffer.from(String(start + pageSize)).toString('base64url')
      : undefined
  return { items, ...(nextCursor ? { nextCursor } : {}), observedAt: nowIso() }
}

export function createRootBookmarkAuthority(options: {
  dataDir: string
  audit?: AuthorityAudit
  /**
   * Required. The durable, scope-bound, single-use owner-approval authority;
   * minting a root bookmark without one cannot prove owner consent.
   */
  approvalVerifier: OwnerApprovalVerifier
}) {
  const { dataDir, audit, approvalVerifier } = options
  if (!approvalVerifier) {
    // Startup guard for JavaScript callers that bypass the type.
    throw new DevAuthorityError(
      'auth_required',
      'the root bookmark authority requires an owner approval verifier'
    )
  }
  const storeDir = join(dataDir, 'dev-runtime', 'roots')
  const store = createDurableJsonStore<RootBookmarkRecord>({
    file: join(storeDir, 'bookmarks.json'),
    schemaVersion: 1,
    label: 'root bookmark',
  })

  function loadRecords(): RootBookmarkRecord[] {
    return [...store.load().records]
  }

  function persist(next: RootBookmarkRecord[]): void {
    store.save(next)
  }

  function log(
    action: string,
    subjectId: string,
    outcome: 'granted' | 'denied' | 'revoked' | 'recovered',
    detail?: Record<string, string>
  ): void {
    audit?.append({ action, subjectId, outcome, ...(detail ? { detail } : {}) })
  }

  /** Replace one record in the loaded list and persist durably. */
  function replace(
    current: RootBookmarkRecord,
    all: RootBookmarkRecord[],
    next: RootBookmarkRecord
  ): void {
    const index = all.findIndex((entry) => entry.id === current.id)
    if (index >= 0) all[index] = next
    persist(all)
  }

  function markDrifted(record: RootBookmarkRecord, all: RootBookmarkRecord[]): void {
    if (record.state === 'active') {
      replace(record, all, {
        ...record,
        state: 'stale',
        generation: record.generation + 1,
        version: record.version + 1,
      })
    }
  }

  function mint(input: {
    scope: DevScope
    label: string
    kind: 'directory' | 'repository'
    absolutePath: string
    approval?: OwnerApproval
  }): RootBookmarkRecord {
    const approval = requireApproval(input.approval, 'authorize a root bookmark')
    const label = requireLabel(input.label, 'root bookmark')
    if (input.kind !== 'directory' && input.kind !== 'repository') {
      throw new DevAuthorityError(
        'invalid_state',
        'root bookmark kind must be directory or repository'
      )
    }
    const absolutePath = input.absolutePath
    if (
      typeof absolutePath !== 'string' ||
      absolutePath.length < 1 ||
      absolutePath.length > 4096 ||
      absolutePath.includes('\0') ||
      !absolutePath.startsWith('/')
    ) {
      throw new DevAuthorityError('invalid_state', 'root bookmark requires an absolute host path')
    }
    // The bookmark binds the canonical real directory. The owner may pick a
    // path whose spelling traverses symlinks (macOS /var → /private/var), so
    // authorization canonicalizes; use-time validation is exact instead.
    const presented = lstatSync(absolutePath, { throwIfNoEntry: false })
    if (!presented) throw new DevAuthorityError('not_found', 'root path does not exist')
    let canonicalRoot: string
    try {
      canonicalRoot = realpathSync(absolutePath)
    } catch {
      throw new DevAuthorityError('not_found', 'root path does not resolve to a directory')
    }
    const canonical = statSync(canonicalRoot, { throwIfNoEntry: false })
    if (!canonical)
      throw new DevAuthorityError('not_found', 'root path does not resolve to a directory')
    if (!canonical.isDirectory()) {
      throw new DevAuthorityError('special_file_rejected', 'root path must be a directory')
    }
    const rootIdentity = identityOf(canonicalRoot)

    const all = loadRecords()
    const existing = all.find(
      (entry) =>
        sameScope(entry.scope, input.scope) &&
        entry.state !== 'revoked' &&
        entry.canonicalRoot === canonicalRoot
    )
    if (existing && existing.state === 'active') {
      // Durable mutations are idempotent: re-minting a live root is a no-op.
      return existing
    }
    if (existing && existing.state === 'stale') {
      approvalVerifier.consume(approval, input.scope, 'authorize a root bookmark')
      // Owner re-authorization of the same canonical root refreshes identity.
      const refreshed: RootBookmarkRecord = {
        ...existing,
        rootIdentity,
        state: 'active',
        generation: existing.generation + 1,
        version: existing.version + 1,
      }
      replace(existing, all, refreshed)
      log('root.reauthorized', refreshed.id, 'recovered', { kind: input.kind })
      return refreshed
    }

    approvalVerifier.consume(approval, input.scope, 'authorize a root bookmark')
    const record: RootBookmarkRecord = {
      id: newRecordId(),
      scope: { ...input.scope },
      label,
      kind: input.kind,
      canonicalRoot,
      rootIdentity,
      state: 'active',
      generation: 1,
      version: 1,
      createdAt: nowIso(),
    }
    all.push(record)
    persist(all)
    log('root.minted', record.id, 'granted', {
      kind: input.kind,
      approvalMethod: approval.method,
    })
    return record
  }

  function revoke(input: {
    scope: DevScope
    bookmarkId: string
    expectedVersion: number
    reason?: string
  }): RootBookmarkRecord {
    const all = loadRecords()
    const record = findBookmark(all, input.scope, input.bookmarkId)
    if (!record) throw new DevAuthorityError('not_found', 'root bookmark not found')
    if (record.state === 'revoked') return record
    if (record.version !== input.expectedVersion) {
      throw new DevAuthorityError('stale_version', 'root bookmark version conflict', record.version)
    }
    const revoked: RootBookmarkRecord = {
      ...record,
      state: 'revoked',
      generation: record.generation + 1,
      version: record.version + 1,
      revokedAt: nowIso(),
      ...(input.reason ? { revokedReason: input.reason.slice(0, 256) } : {}),
    }
    replace(record, all, revoked)
    log('root.revoked', record.id, 'revoked')
    return revoked
  }

  /** The fail-closed recheck every consumer runs immediately before its side
   * effect. Returns only when the bookmark is active and its canonical root
   * still stat-matches the minted identity. */
  function validate(input: { scope: DevScope; bookmarkId: string }): RootBookmarkRecord {
    const all = loadRecords()
    const record = findBookmark(all, input.scope, input.bookmarkId)
    if (!record) throw new DevAuthorityError('not_found', 'root bookmark not found')
    if (record.state === 'revoked') {
      throw new DevAuthorityError('unauthorized_root', 'root bookmark has been revoked')
    }

    const presented = lstatSync(record.canonicalRoot, { throwIfNoEntry: false })
    if (!presented) {
      markDrifted(record, all)
      throw new DevAuthorityError('unauthorized_root', 'authorized root is missing on disk')
    }
    if (presented.isSymbolicLink()) {
      markDrifted(record, all)
      throw new DevAuthorityError('symlink_rejected', 'authorized root was replaced by a symlink')
    }
    if (!presented.isDirectory()) {
      markDrifted(record, all)
      throw new DevAuthorityError(
        'special_file_rejected',
        'authorized root is no longer a directory'
      )
    }
    const freshIdentity = identityOf(record.canonicalRoot)
    if (!sameRootIdentity(freshIdentity, record.rootIdentity)) {
      markDrifted(record, all)
      throw new DevAuthorityError('identity_mismatch', 'authorized root was replaced on disk')
    }
    if (record.state === 'stale') {
      // Identity re-proven: bring the bookmark back without re-prompting.
      const restored: RootBookmarkRecord = {
        ...record,
        rootIdentity: freshIdentity,
        state: 'active',
        generation: record.generation + 1,
        version: record.version + 1,
      }
      replace(record, all, restored)
      log('root.restored', record.id, 'recovered')
      return restored
    }
    return record
  }

  /** Resolve one root-relative path to an exact host path with immediate
   * containment validation. Any symlink component below the root, escape
   * segment, or identity drift fails closed before the caller acts. */
  function resolvePath(input: { scope: DevScope; bookmarkId: string; relativePath: string }): {
    absolutePath: string
    identity: FileIdentityValue
    kind: PathKind
  } {
    const bookmark = validate(input)
    const relativePath = input.relativePath
    if (
      typeof relativePath !== 'string' ||
      relativePath.length < 1 ||
      relativePath.length > RELATIVE_PATH_MAX ||
      relativePath.includes('\0') ||
      relativePath.includes('\\') ||
      relativePath.startsWith('/') ||
      relativePath
        .split('/')
        .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    ) {
      throw new DevAuthorityError('path_escape', 'path escapes the authorized root')
    }
    const absolutePath = join(bookmark.canonicalRoot, relativePath)
    const presented = lstatSync(absolutePath, { throwIfNoEntry: false })
    if (!presented) throw new DevAuthorityError('not_found', 'path does not exist within the root')
    if (presented.isSymbolicLink()) {
      throw new DevAuthorityError('symlink_rejected', 'path must not traverse a symlink')
    }
    const real = realpathSync(absolutePath)
    if (real !== absolutePath) {
      // A parent component became a symlink after the bookmark was minted.
      throw new DevAuthorityError('symlink_rejected', 'path resolves through a symlinked parent')
    }
    if (!real.startsWith(bookmark.canonicalRoot + '/')) {
      throw new DevAuthorityError('path_escape', 'path escapes the authorized root')
    }
    const kind: PathKind = presented.isDirectory()
      ? 'directory'
      : presented.isFile()
        ? 'file'
        : 'special'
    return { absolutePath: real, identity: identityOf(real), kind }
  }

  function list(input: {
    scope: DevScope
    kind?: 'directory' | 'repository'
    cursor?: string
    limit?: number
  }): RootBookmarkPage {
    const filtered = loadRecords().filter(
      (entry) =>
        sameScope(entry.scope, input.scope) &&
        (input.kind === undefined || entry.kind === input.kind)
    )
    return pageOf(filtered, input.cursor, input.limit)
  }

  mkdirSync(storeDir, { recursive: true, mode: 0o700 })
  return Object.freeze({ mint, revoke, validate, resolvePath, list })
}

export type RootBookmarkAuthority = ReturnType<typeof createRootBookmarkAuthority>
