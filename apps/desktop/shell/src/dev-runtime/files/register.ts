// Production files/search registrar for the #399 Files/Source Control slice.
//
// Every operation is scope-bound through the M10 channel gate and re-proven
// here against the worktree service's canonical roots: the envelope resource
// (kind `workspace_root`, id, live worktree generation) must match a registered
// ready worktree before any filesystem effect, each WorkspacePath must pin the
// live worktree root identity (cross-worktree substitution is refused), the
// canonical relative path is re-validated segment by segment (no NUL /
// traversal / backslash / absolute forms), every symlink component is
// rejected, and containment plus final-target identity are re-proven
// immediately before each system call.
//
// File contents never enter errors or logs — messages carry identity facts
// (mtime/size) and paths only. Search spawns a supervised `rg` with fixed
// argv flags (the query is a single argv value, never shell text) under
// match/file/output/time budgets.
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  fsyncSync,
  type Stats,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { evaluateDenyPolicy } from './deny-policy'

import type { ChannelIdentity } from '../channel/authority'
import type { ChannelGateway } from '../channel/server'
import type {
  DevCommand,
  DevError,
  DevOperation,
  DevRuntimePage,
  DevStreamFrame,
  DevStreamGrant,
  ExternalOpenResult,
  FileEntry,
  FileIdentity,
  FileMutationResult,
  FileReadResult,
  FileTreeMutationResult,
  FileWriteResult,
  MutationPlan,
  Scope,
  SearchMatch,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import type { ChannelAuthority } from '../channel/authority'
import type { FileIdentityValue } from '../worktrees/identity'

/** The narrow worktree-service seam the composition root populates from
 *  `service.getWorktree(scope, id)`; the provider consumes canonical roots —
 *  never service internals. */
export type WorktreeRootContext = Readonly<{
  canonicalRoot: string
  rootIdentity: FileIdentityValue
  generation: number
  lifecycle: string
}>

export type FilesRegistrarInput = {
  authority: ChannelAuthority
  scope: Scope
  /** Fail-closed resolution of the live worktree record (undefined = no
   *  worktree context on this runtime node). */
  resolveWorktree(worktreeId: string): WorktreeRootContext | undefined
  /** Full-duplex gateway: when present the `file-bytes-v1` bulk stream
   *  (readStream/writeStream attach) is registered on it; without a gateway
   *  the stream operations stay unregistered and the composition fallback
   *  keeps them typed-unavailable. */
  gateway?: Pick<ChannelGateway, 'registerStreamHandler'>
  /** External-editor/OS handoff seam (fixed argv, no shell); defaults to the
   *  macOS `open` handoff and refuses elsewhere. */
  openPath?: (absolutePath: string) => Promise<string | undefined>
  /** Agent HQ authority directories (its encrypted content store, the vault,
   *  the dev-runtime state) that no grant may expose — see #622. */
  protectedRoots?: readonly string[]
  /** Test seam: rg binary resolution (undefined = PATH lookup). */
  rgPath?: () => string | undefined
  now?: () => number
}

// Limits registry defaults (dev-runtime spec, "Files and search").
const DIRECTORY_PAGE_MAX = 500
const READ_WINDOW_MAX = 256 * 1024
const EDITABLE_TEXT_MAX = 8 * 1024 * 1024
const COPY_BUDGET_MAX = 64 * 1024 * 1024
const SEARCH_MATCH_CAP = 10_000
const SEARCH_FILE_CAP = 1000
const SEARCH_RESULT_BYTES_CAP = 1024 * 1024
const SEARCH_TIMEOUT_MS = 30_000

// Bulk `file-bytes-v1` stream bounds (dev-runtime spec, "Files and search"):
// transfers above the 256 KiB control cap ride the stream, capped at the
// bounded read/preview budget; every frame obeys the grant's maxFrameBytes;
// read credit keeps at most one mebibyte in flight.
const BULK_STREAM_MAX = 64 * 1024 * 1024
const STREAM_FRAME_BYTES = 64 * 1024
const STREAM_CREDIT_HIGH_WATER = 1024 * 1024

// Recursive delete/copy plan bounds: bounded depth, bounded item count (each
// enumerated item becomes one plan step), bounded copy volume. Any symlink
// inside the tree refuses the whole plan — links are never followed out.
const TREE_DEPTH_MAX = 64
const TREE_ITEM_MAX = 5000
const TREE_COPY_TOTAL_MAX = 256 * 1024 * 1024
const PLAN_TTL_MS = 10 * 60_000

function searchOffset(cursor: unknown): number {
  if (cursor === undefined) return 0
  const decoded = Number(Buffer.from(String(cursor), 'base64url').toString('utf8'))
  if (!Number.isSafeInteger(decoded) || decoded < 0)
    throw devError('not_found', 'unknown search cursor')
  return decoded
}

function searchCursor(offset: number): string {
  return Buffer.from(String(offset)).toString('base64url')
}
const SEARCH_PREVIEW_MAX = 2000

const ABSENT_IDENTITY: FileIdentity = { mtimeNs: '0', size: '0' }

function devError(code: DevError['code'], message: string, retryable = false): DevError {
  return { code, retryable, message }
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString()
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Compact mtime/size fact line for plan factVersions (identity facts only —
 *  never content). */
function identityFactLine(identity: unknown): string {
  const candidate = identity as { mtimeNs?: unknown; size?: unknown } | undefined
  return `${String(candidate?.mtimeNs ?? '0')}:${String(candidate?.size ?? '0')}`
}

/** The per-item identity facts a tree plan records (lstat-based, so symlink
 *  rows can never appear here). */
function plannedItemOf(relativePath: string, stats: BigStats): PlannedTreeItem {
  return {
    relativePath,
    kind: stats.isDirectory() ? 'directory' : 'file',
    size: String(stats.size),
    mtimeNs: String(stats.mtimeNs),
    mode: Number(stats.mode & 0o777n),
  }
}

/** Step ids of a directory's direct children (delete plans delete children
 *  before the parent: the dependency edge documents that order). */
function directChildStepIds(
  items: readonly PlannedTreeItem[],
  directoryRelative: string,
  stepIds: readonly string[]
): string[] {
  const prefix = `${directoryRelative}/`
  const childIds: string[] = []
  for (const [index, item] of items.entries()) {
    if (!item.relativePath.startsWith(prefix)) continue
    const rest = item.relativePath.slice(prefix.length)
    if (rest.includes('/')) continue
    childIds.push(stepIds[index] as string)
  }
  return childIds
}

// ─── Path safety ────────────────────────────────────────────────────────────

/** Normalized relative-path grammar, re-proven at the provider (the shared
 *  WorkspacePath decoder enforces the same grammar on the wire). */
function safeSegments(relativePath: string): string[] {
  // '.' is the canonical spelling of the worktree root itself.
  if (relativePath === '.') return []
  if (relativePath.includes('\0')) throw devError('path_escape', 'path must not contain NUL')
  if (relativePath.includes('\\'))
    throw devError('path_escape', 'path must use path separators, not backslashes')
  if (relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath))
    throw devError('path_escape', 'absolute root substitution is refused')
  const segments = relativePath.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..'))
    throw devError('path_escape', 'traversal segments are refused')
  return segments
}

/** The default-deny policy with this register's protected roots bound in. */
function denyPolicy(path: string): ReturnType<typeof evaluateDenyPolicy> {
  return evaluateDenyPolicy(path, { protectedRoots: denyProtectedRoots })
}

let denyProtectedRoots: readonly string[] = []

function containsPath(parentPath: string, childPath: string): boolean {
  const rel = relative(parentPath, childPath)
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'))
}

/** Re-prove containment immediately before a system call: realpath the
 *  deepest existing ancestor of the target and require it to stay inside the
 *  canonical root. Catches symlink swaps that happened after listing. */
function proveContainment(canonicalRoot: string, target: string): void {
  // Sensitivity first (#622): a denied NAME must refuse even when the file does
  // not exist yet (a create), and a denied LOCATION must refuse once resolved —
  // which is why both the target and its deepest existing ancestor are checked.
  const targetVerdict = denyPolicy(target)
  if (targetVerdict.denied)
    throw devError('path_denied', `${targetVerdict.reason} (${targetVerdict.rule})`)
  let probe = target
  for (;;) {
    let resolved: string
    try {
      resolved = realpathSync(probe)
    } catch {
      const parent = dirname(probe)
      if (parent === probe)
        throw devError('path_escape', 'target escaped the worktree canonical root')
      probe = parent
      continue
    }
    if (!containsPath(canonicalRoot, resolved))
      throw devError('path_escape', 'resolved path escapes the worktree canonical root')
    const resolvedVerdict = denyPolicy(resolved)
    if (resolvedVerdict.denied)
      throw devError('path_denied', `${resolvedVerdict.reason} (${resolvedVerdict.rule})`)
    return
  }
}

/** Extract and re-prove the WorkspacePath body field: its worktreeId must
 *  match the request body (confused-deputy rejection), its rootIdentity must
 *  pin the live worktree root (cross-worktree substitution is refused), and
 *  its relativePath must satisfy the canonical grammar. */
function workspaceRelativePath(
  bodyWorktreeId: string,
  bodyPath: unknown,
  rootIdentity: FileIdentityValue
): string {
  const candidate = bodyPath as
    | { worktreeId?: unknown; rootIdentity?: unknown; relativePath?: unknown }
    | undefined
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    typeof candidate.relativePath !== 'string' ||
    candidate.relativePath.length === 0
  )
    throw devError('identity_mismatch', 'path must be a WorkspacePath bound to the worktree')
  if (candidate.worktreeId !== bodyWorktreeId)
    throw devError('identity_mismatch', 'path worktreeId does not match the request body')
  const pinned = candidate.rootIdentity as FileIdentity | undefined
  if (!pinned || typeof pinned !== 'object')
    throw devError('identity_mismatch', 'path must pin the worktree root identity')
  const sameRoot =
    pinned.device === rootIdentity.device &&
    pinned.inode === rootIdentity.inode &&
    pinned.mtimeNs === rootIdentity.mtimeNs &&
    pinned.size === rootIdentity.size
  if (!sameRoot)
    throw devError('unauthorized_root', 'path root identity does not match the live worktree root')
  safeSegments(candidate.relativePath)
  return candidate.relativePath
}

/** Lstat-based resolution; symlink components anywhere along the path are
 *  rejected so no resolution ever leaves the canonical root. A missing final
 *  component is allowed (create/write-new paths). */
function resolveTargetPath(
  canonicalRoot: string,
  relativePath: string,
  options: { allowFinalSymlink?: boolean } = {}
): string {
  const segments = safeSegments(relativePath)
  let current = canonicalRoot
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    const stats = lstatSync(current, { throwIfNoEntry: false })
    if (!stats) {
      // A missing component may only be the final one (creation paths).
      if (index === segments.length - 1) break
      throw devError('not_found', 'parent directory does not exist inside the worktree')
    }
    if (stats.isSymbolicLink()) {
      const final = index === segments.length - 1
      if (!final || !options.allowFinalSymlink)
        throw devError('symlink_rejected', 'symlink components are refused inside the worktree')
    }
  }
  return current
}

// ─── Identity and classification ────────────────────────────────────────────

/** Identity reads use bigint lstat so nanosecond timestamps survive as exact
 *  strings (the same convention the worktree identity helpers use). */
type BigStats = import('node:fs').BigIntStats

function bigintLstat(absolute: string): BigStats | undefined {
  return lstatSync(absolute, { bigint: true, throwIfNoEntry: false })
}

function fileIdentityOf(stats: BigStats): FileIdentity {
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    birthtimeNs: String(stats.birthtimeNs),
    mtimeNs: String(stats.mtimeNs),
    size: String(stats.size),
  }
}

function currentIdentity(absolute: string): FileIdentity {
  const stats = bigintLstat(absolute)
  return stats ? fileIdentityOf(stats) : { ...ABSENT_IDENTITY }
}

/** Compare-and-swap fact check: every identity field the caller pins must
 *  match the live lstat. `{ mtimeNs: '0', size: '0' }` pins absence. */
function assertExpectedIdentity(absolute: string, expected: FileIdentity): void {
  const current = currentIdentity(absolute)
  if (expected.mtimeNs !== current.mtimeNs || expected.size !== current.size) {
    throw devError(
      'file_changed',
      `file moved on disk (current mtimeNs=${current.mtimeNs} size=${current.size}); no write was performed`
    )
  }
  for (const key of ['device', 'inode', 'birthtimeNs'] as const) {
    const pinned = expected[key]
    if (pinned !== undefined && pinned !== current[key]) {
      throw devError('file_changed', `file identity changed on disk (${key}); no write performed`)
    }
  }
}

function classifyKind(stats: Stats | BigStats): FileEntry['kind'] {
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isDirectory()) return 'directory'
  if (stats.isFile()) return 'file'
  return 'special'
}

function toFileEntry(
  worktreeId: string,
  rootIdentity: FileIdentityValue,
  relativePath: string,
  absolute: string,
  observedAt: string
): FileEntry {
  const stats = bigintLstat(absolute)
  if (!stats) throw devError('not_found', 'path does not exist inside the worktree')
  return {
    path: { worktreeId, rootIdentity: { ...rootIdentity }, relativePath },
    identity: fileIdentityOf(stats),
    kind: classifyKind(stats),
    size: String(stats.size),
    observedAt,
  }
}

// ─── Content analysis (EOL / encoding) ──────────────────────────────────────

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

function analyzeBytes(bytes: Uint8Array): {
  encoding: 'utf8' | 'binary'
  eol: 'lf' | 'crlf' | 'mixed' | 'none'
} {
  for (const byte of bytes) {
    if (byte === 0) return { encoding: 'binary', eol: 'none' }
  }
  const body = hasUtf8Bom(bytes) ? bytes.slice(3) : bytes
  let validUtf8 = true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    validUtf8 = false
  }
  let lf = 0
  let crlf = 0
  for (const [index, byte] of bytes.entries()) {
    if (byte !== 0x0a) continue
    if (index > 0 && bytes[index - 1] === 0x0d) crlf += 1
    else lf += 1
  }
  const eol = lf + crlf === 0 ? 'none' : lf > 0 && crlf > 0 ? 'mixed' : crlf > 0 ? 'crlf' : 'lf'
  return { encoding: validUtf8 ? 'utf8' : 'binary', eol }
}

/** Explicit-policy EOL normalization. The BOM and the body are treated
 *  separately so a normalized write can never silently move the BOM; mixed
 *  files are only ever rewritten when the caller explicitly chose a policy. */
function applyEolPolicy(bytes: Uint8Array, policy: 'preserve' | 'lf' | 'crlf'): Uint8Array {
  if (policy === 'preserve') return bytes
  const bomPrefix = hasUtf8Bom(bytes) ? bytes.slice(0, 3) : undefined
  const body = bomPrefix ? bytes.slice(3) : bytes
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  const normalized = policy === 'lf' ? text.replace(/\r\n/g, '\n') : text.replace(/\r?\n/g, '\r\n')
  const encoded = new TextEncoder().encode(normalized)
  if (!bomPrefix) return encoded
  const merged = new Uint8Array(bomPrefix.length + encoded.length)
  merged.set(bomPrefix, 0)
  merged.set(encoded, bomPrefix.length)
  return merged
}

// ─── Atomic write machinery ─────────────────────────────────────────────────

function fsyncDirectory(directory: string): void {
  let fd: number | undefined
  try {
    fd = openSync(directory, 'r')
    fsyncSync(fd)
  } catch {
    // Directory fsync is a durability nicety, not a correctness gate here.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Owner-only same-directory temporary file, write, fsync, atomic rename —
 *  the reviewed permissions of the replaced file are preserved. */
function atomicWrite(absolute: string, content: Uint8Array, mode: number): void {
  const directory = dirname(absolute)
  const temp = join(directory, `.adea-tmp-${randomUUID()}`)
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', mode)
    writeSync(fd, content)
    fsyncSync(fd)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(temp)
    } catch {
      // The original error propagates.
    }
    throw error
  }
  closeSync(fd)
  try {
    renameSync(temp, absolute)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The original error propagates.
    }
    throw error
  }
  fsyncDirectory(directory)
}

/** Atomic create-without-overwrite: temp file, hardlink into place (fails on
 *  an existing destination), unlink the temp. */
function atomicCreateNew(absolute: string, content: Uint8Array, mode: number): void {
  const directory = dirname(absolute)
  const temp = join(directory, `.adea-tmp-${randomUUID()}`)
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', mode)
    writeSync(fd, content)
    fsyncSync(fd)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(temp)
    } catch {
      // The original error propagates.
    }
    throw error
  }
  closeSync(fd)
  try {
    linkSync(temp, absolute)
    unlinkSync(temp)
  } catch {
    try {
      unlinkSync(temp)
    } catch {
      // Temp cleanup; the typed error surfaces below.
    }
    throw devError('path_collision', 'creation lost a create race or destination exists')
  }
  fsyncDirectory(directory)
}

function requireRegularFileTarget(absolute: string, allowMissing: boolean): Stats | undefined {
  const stats = lstatSync(absolute, { throwIfNoEntry: false })
  if (!stats) {
    if (allowMissing) return undefined
    throw devError('not_found', 'path does not exist inside the worktree')
  }
  if (stats.isSymbolicLink())
    throw devError('symlink_rejected', 'refusing to write through a symlink')
  if (!stats.isFile())
    throw devError('special_file_rejected', 'only regular files accept text writes')
  return stats
}

// ─── Bounded read ───────────────────────────────────────────────────────────

function readWindow(
  absolute: string,
  offset: bigint,
  length: number
): {
  bytes: Uint8Array
  fileSize: bigint
} {
  let fd: number | undefined
  try {
    fd = openSync(absolute, 'r')
    const stats = fstatSync(fd)
    if (!stats.isFile()) throw devError('special_file_rejected', 'only regular files accept reads')
    const window = Buffer.alloc(length)
    const read = readSync(fd, window, 0, length, Number(offset))
    return { bytes: window.subarray(0, read), fileSize: BigInt(stats.size) }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// ─── Supervised search ──────────────────────────────────────────────────────

type RgEvent = {
  type: string
  data?: {
    path?: { text?: string }
    line_number?: number
    lines?: { text?: string }
    submatches?: ReadonlyArray<{ start?: number; end?: number }>
  }
}

async function runRipgrep(input: {
  rgPath: string
  canonicalRoot: string
  rootIdentity: FileIdentityValue
  worktreeId: string
  query: string
  globs: readonly string[]
  matchCap: number
  observedAt: string
}): Promise<SearchMatch[]> {
  const args = [
    '--json',
    '--no-config',
    ...(input.globs.length > 0 ? input.globs.flatMap((glob) => ['-g', glob]) : []),
    '-e',
    input.query,
    '.',
  ]
  const proc = Bun.spawn([input.rgPath, ...args], {
    cwd: input.canonicalRoot,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: process.env.HOME ?? '/',
      LC_ALL: 'C',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const decoder = new TextDecoder()
  let buffered = ''
  let emittedBytes = 0
  const matches: SearchMatch[] = []
  const matchedFiles = new Set<string>()

  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // Already exited.
    }
  }, SEARCH_TIMEOUT_MS)
  timer.unref?.()

  try {
    const stdout = proc.stdout.getReader()
    for (;;) {
      const { done, value } = await stdout.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      let newlineIndex = buffered.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffered.slice(0, newlineIndex).trim()
        buffered = buffered.slice(newlineIndex + 1)
        newlineIndex = buffered.indexOf('\n')
        if (line.length === 0) continue
        emittedBytes += line.length + 1
        if (emittedBytes > SEARCH_RESULT_BYTES_CAP) {
          try {
            proc.kill()
          } catch {
            // Already exiting.
          }
          return matches
        }
        let event: RgEvent
        try {
          event = JSON.parse(line) as RgEvent
        } catch {
          continue
        }
        if (event.type !== 'match' || !event.data) continue
        const fileText = event.data.path?.text ?? ''
        const relativeFile = fileText.replace(/^\.\//, '')
        if (relativeFile.length === 0 || relativeFile.startsWith('..')) continue
        if (matchedFiles.size >= SEARCH_FILE_CAP && !matchedFiles.has(relativeFile)) {
          try {
            proc.kill()
          } catch {
            // Already exiting.
          }
          return matches
        }
        matchedFiles.add(relativeFile)
        if (matches.length >= Math.min(input.matchCap, SEARCH_MATCH_CAP)) {
          try {
            proc.kill()
          } catch {
            // Already exiting.
          }
          return matches
        }
        const previewText = (event.data.lines?.text ?? '').replace(/\n$/, '')
        const submatches = event.data.submatches ?? []
        matches.push({
          path: {
            worktreeId: input.worktreeId,
            rootIdentity: { ...input.rootIdentity },
            relativePath: relativeFile,
          },
          identity: { ...ABSENT_IDENTITY },
          line: event.data.line_number ?? 1,
          column: (submatches[0]?.start ?? 0) + 1,
          preview: previewText.slice(0, SEARCH_PREVIEW_MAX),
          ranges: submatches
            .filter((range) => typeof range.start === 'number' && typeof range.end === 'number')
            .map((range) => ({ start: range.start as number, end: range.end as number })),
        })
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return matches
}

function probeRipgrep(rgPath: string): boolean {
  try {
    const proc = Bun.spawnSync([rgPath, '--version'], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 5000,
    })
    return proc.exitCode === 0
  } catch {
    return false
  }
}

// ─── Registrar ──────────────────────────────────────────────────────────────

/** One enumerated tree entry: the plan's per-item identity facts (the commit
 *  re-proves every row against the live lstat before touching anything). */
type PlannedTreeItem = {
  relativePath: string
  kind: 'file' | 'directory'
  size: string
  mtimeNs: string
  mode: number
}

type FilePlanEntry = {
  kind: 'rename_overwrite' | 'delete_tree' | 'copy_tree'
  worktreeId: string
  canonicalRoot: string
  generation: number
  expiresAt: number
  digest: string
  // rename_overwrite
  fromRelative?: string
  toRelative?: string
  expectedFromIdentity?: FileIdentity
  expectedToIdentity?: FileIdentity
  // trees
  rootRelative?: string
  destinationRelative?: string
  items?: readonly PlannedTreeItem[]
  totalBytes?: bigint
}

type PendingStreamRecord = {
  worktreeId: string
  canonicalRoot: string
  rootIdentity: FileIdentityValue
  relativePath: string
  absolute: string
  expectedIdentity: FileIdentity
  expiresAt: number
}

type PendingReadRecord = PendingStreamRecord & {
  offset: bigint
  declaredLength?: bigint
}

type PendingWriteRecord = PendingStreamRecord & {
  declaredByteLength: bigint
  declaredSha256: string
}

/** The narrow stream-session surface the file-bytes-v1 provider uses; the
 *  gateway's full session satisfies it structurally. */
type FileBytesSession = {
  grant: DevStreamGrant
  send: (frame: DevStreamFrame) => void
  close: (
    code: 'normal' | 'expired' | 'revoked' | 'stale_generation' | 'backpressure' | 'incompatible',
    reason?: string
  ) => void
  onFrame?: (frame: DevStreamFrame) => void
  onClose?: () => void
}

export function registerFilesRuntime(input: FilesRegistrarInput): {
  commands: readonly DevOperation[]
  registeredCommands: number
} {
  // Canonicalize: the policy compares against RESOLVED paths, so an unresolved
  // root (macOS /tmp -> /private/tmp) would never match and the guard would
  // silently not apply.
  denyProtectedRoots = (input.protectedRoots ?? []).map((root) => {
    try {
      return realpathSync(root)
    } catch {
      return root
    }
  })
  const now = input.now ?? Date.now
  const plans = new Map<string, FilePlanEntry>()
  const pendingReads = new Map<string, PendingReadRecord>()
  const pendingWrites = new Map<string, PendingWriteRecord>()

  /** Grant records die with their grant: anything past its expiry window is
   *  swept before each mint so an unattached grant cannot pin memory. */
  function sweepPendingStreams(): void {
    const at = now()
    for (const [grantId, record] of pendingReads)
      if (record.expiresAt <= at) pendingReads.delete(grantId)
    for (const [grantId, record] of pendingWrites)
      if (record.expiresAt <= at) pendingWrites.delete(grantId)
  }

  /** Gate re-check shared by every operation: scope, resource binding, live
   *  generation, ready lifecycle, and the canonical root snapshot. */
  function requireLiveWorktree(command: DevCommand): {
    worktreeId: string
    canonicalRoot: string
    rootIdentity: FileIdentityValue
  } {
    const body = command.body as { worktreeId?: unknown }
    const worktreeId = typeof body.worktreeId === 'string' ? body.worktreeId : ''
    const resource = command.resource
    if (resource === undefined)
      throw devError('identity_mismatch', 'files operations require a workspace_root resource')
    if (resource.kind !== 'workspace_root')
      throw devError('identity_mismatch', 'resource kind must be workspace_root')
    if (resource.id !== worktreeId)
      throw devError('identity_mismatch', 'resource id does not match the request body')
    if (
      command.scope.accountId !== input.scope.accountId ||
      command.scope.workspaceId !== input.scope.workspaceId ||
      command.scope.runtimeNodeId !== input.scope.runtimeNodeId
    )
      throw devError('unauthorized', 'files scope is not authorized on this runtime node')
    const record = input.resolveWorktree(worktreeId)
    if (!record)
      throw devError('not_found', 'no worktree context exists for this operation on this node')
    if (resource.generation !== record.generation)
      throw devError('stale_generation', 'resource generation does not match the worktree record')
    if (record.lifecycle !== 'ready')
      throw devError('invalid_state', 'files operations require a ready worktree')
    // Canonical root re-proof: the service root must itself be a real
    // directory (no symlinked spelling) on every operation.
    const stats = lstatSync(record.canonicalRoot, { throwIfNoEntry: false })
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory())
      throw devError('unauthorized_root', 'worktree canonical root is not a real directory')
    return {
      worktreeId,
      canonicalRoot: realpathSync(record.canonicalRoot),
      rootIdentity: record.rootIdentity,
    }
  }

  /** Re-proves the gate at stream-attach time: the worktree the grant was
   *  minted against must still be live, ready, at the same generation, and
   *  spelled by the same canonical root. Throws a typed DevError. */
  function requireAttachableWorktree(record: PendingStreamRecord, generation: number): void {
    const live = input.resolveWorktree(record.worktreeId)
    if (!live || live.lifecycle !== 'ready')
      throw devError('invalid_state', 'the worktree behind this stream is no longer ready')
    if (live.generation !== generation)
      throw devError(
        'stale_generation',
        'the worktree moved to a new generation after the grant was minted'
      )
    // Compare real paths: the mint stored the canonical (realpath) spelling.
    if (realpathSync(live.canonicalRoot) !== record.canonicalRoot)
      throw devError(
        'unauthorized_root',
        'the worktree canonical root changed after the grant was minted'
      )
  }

  /** Plan halves resolve their worktree by the plan's binding, not the body:
   *  scope, live record, generation, ready lifecycle, and the canonical-root
   *  re-proof, exactly like requireLiveWorktree but with an explicit target. */
  function requireWorktreeContextAt(
    command: DevCommand,
    worktreeId: string,
    generation: number
  ): { canonicalRoot: string; rootIdentity: FileIdentityValue } {
    if (
      command.scope.accountId !== input.scope.accountId ||
      command.scope.workspaceId !== input.scope.workspaceId ||
      command.scope.runtimeNodeId !== input.scope.runtimeNodeId
    )
      throw devError('unauthorized', 'files scope is not authorized on this runtime node')
    const record = input.resolveWorktree(worktreeId)
    if (!record)
      throw devError('not_found', 'no worktree context exists for this operation on this node')
    if (record.generation !== generation)
      throw devError('stale_generation', 'resource generation does not match the worktree record')
    if (record.lifecycle !== 'ready')
      throw devError('invalid_state', 'files operations require a ready worktree')
    const stats = lstatSync(record.canonicalRoot, { throwIfNoEntry: false })
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory())
      throw devError('unauthorized_root', 'worktree canonical root is not a real directory')
    return {
      canonicalRoot: realpathSync(record.canonicalRoot),
      rootIdentity: record.rootIdentity,
    }
  }

  /** requireLiveWorktree plus the live generation, for plan halves. */
  function requireLiveWorktreeExtended(command: DevCommand): {
    worktreeId: string
    canonicalRoot: string
    rootIdentity: FileIdentityValue
    generation: number
  } {
    const base = requireLiveWorktree(command)
    const record = input.resolveWorktree(base.worktreeId)
    if (!record) throw devError('not_found', 'no worktree context exists for this operation')
    return { ...base, generation: record.generation }
  }

  /** Bounded pre-order enumeration of a directory tree. Symlinks anywhere
   *  inside refuse the whole enumeration (links are never followed out),
   *  special files refuse, and the depth/item budgets are hard caps. */
  function enumerateTree(
    canonicalRoot: string,
    relativePath: string,
    options: { maxItems?: number } = {}
  ): { items: PlannedTreeItem[]; totalBytes: bigint } {
    const maxItems = options.maxItems ?? TREE_ITEM_MAX
    const rootAbsolute = resolveTargetPath(canonicalRoot, relativePath)
    const rootStats = bigintLstat(rootAbsolute)
    if (!rootStats) throw devError('not_found', 'path does not exist inside the worktree')
    if (rootStats.isSymbolicLink())
      throw devError('symlink_rejected', 'refusing to enumerate through a symlink')
    if (!rootStats.isDirectory())
      throw devError(
        'special_file_rejected',
        'recursive operations require a directory; use the single-path operations instead'
      )
    const items: PlannedTreeItem[] = [plannedItemOf(relativePath, rootStats)]
    let totalBytes = 0n
    const walk = (absolute: string, relativeChild: string, depth: number): void => {
      if (depth > TREE_DEPTH_MAX)
        throw devError('limit_exceeded', `tree exceeds the depth budget (${TREE_DEPTH_MAX})`)
      const entries = readdirSync(absolute).toSorted((left, right) => left.localeCompare(right))
      for (const entry of entries) {
        if (items.length >= maxItems)
          throw devError(
            'limit_exceeded',
            `tree exceeds the item budget (${maxItems} entries); operate on smaller batches`
          )
        const childAbsolute = join(absolute, entry)
        const childStats = bigintLstat(childAbsolute)
        if (!childStats)
          throw devError('not_found', 'the tree changed while it was being enumerated')
        if (childStats.isSymbolicLink())
          throw devError(
            'symlink_rejected',
            `refusing to descend through symlink ${relativeChild}/${entry}`
          )
        const childRelative = `${relativeChild}/${entry}`
        if (childStats.isDirectory()) {
          items.push(plannedItemOf(childRelative, childStats))
          walk(childAbsolute, childRelative, depth + 1)
        } else if (childStats.isFile()) {
          items.push(plannedItemOf(childRelative, childStats))
          totalBytes += childStats.size
        } else {
          throw devError(
            'special_file_rejected',
            `refusing a special file inside the tree: ${childRelative}`
          )
        }
      }
    }
    walk(rootAbsolute, relativePath, 0)
    return { items, totalBytes }
  }

  /** Live plan lookup shared by every commit half: the plan must exist, be
   *  unconsumed, inside its TTL, of the committing kind, presented with the
   *  exact digest it published, and bound to the envelope resource. The
   *  generation check happens in the handler once the worktree context is
   *  resolved (the plan carries the worktree id). */
  function liveFilePlan(
    planId: string,
    kind: FilePlanEntry['kind'],
    planDigest: unknown,
    resource: DevCommand['resource']
  ): FilePlanEntry {
    const entry = plans.get(planId)
    if (!entry || entry.expiresAt <= now())
      throw devError('plan_stale', 'the plan is unknown, expired, or already consumed')
    if (entry.kind !== kind) throw devError('plan_stale', 'the plan does not match this operation')
    if (entry.digest !== planDigest)
      throw devError('plan_stale', 'the plan digest does not match the approved plan')
    if (!resource || resource.kind !== 'workspace_root' || resource.id !== entry.worktreeId)
      throw devError('identity_mismatch', 'the plan is bound to another worktree resource')
    return entry
  }

  function consumeFilePlan(planId: string): void {
    plans.delete(planId)
  }

  /** Re-proves every planned tree row against the live tree: same path set,
   *  same order, same mtime/size facts. Any drift refuses the commit. */
  function reprovePlannedTree(canonicalRoot: string, entry: FilePlanEntry): void {
    const items = entry.items ?? []
    const fresh = enumerateTree(canonicalRoot, entry.rootRelative as string)
    if (
      fresh.items.length !== items.length ||
      fresh.items.some((item, index) => {
        const planned = items[index]
        return (
          planned === undefined ||
          item.relativePath !== planned.relativePath ||
          item.kind !== planned.kind ||
          item.mtimeNs !== planned.mtimeNs ||
          item.size !== planned.size
        )
      })
    )
      throw devError('plan_stale', 'the tree changed since the plan was made')
  }

  const handlers: Partial<
    Record<DevOperation, (command: DevCommand, identity?: ChannelIdentity) => unknown>
  > = {
    'dev.files.stat': (command) => {
      const body = devOperationDecoders['dev.files.stat'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const relativePath = workspaceRelativePath(worktreeId, body.path, rootIdentity)
      const absolute = resolveTargetPath(canonicalRoot, relativePath)
      proveContainment(canonicalRoot, absolute)
      return toFileEntry(worktreeId, rootIdentity, relativePath, absolute, nowIso(now))
    },

    'dev.files.list': (command) => {
      const body = devOperationDecoders['dev.files.list'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const relativePath = workspaceRelativePath(worktreeId, body.path, rootIdentity)
      const absolute = resolveTargetPath(canonicalRoot, relativePath)
      proveContainment(canonicalRoot, absolute)
      const stats = lstatSync(absolute, { throwIfNoEntry: false })
      if (!stats) throw devError('not_found', 'directory does not exist inside the worktree')
      if (stats.isSymbolicLink())
        throw devError('symlink_rejected', 'refusing to list through a symlink')
      if (!stats.isDirectory())
        throw devError('special_file_rejected', 'listing requires a directory')
      const names = readdirSync(absolute).toSorted((left, right) => left.localeCompare(right))
      const pageSize = Math.min(Number(body.limit ?? DIRECTORY_PAGE_MAX), DIRECTORY_PAGE_MAX)
      let start = 0
      if (body.cursor !== undefined) {
        const decoded = Number(Buffer.from(String(body.cursor), 'base64url').toString('utf8'))
        if (!Number.isSafeInteger(decoded) || decoded < 0)
          throw devError('not_found', 'unknown listing cursor')
        start = decoded
      }
      const observedAt = nowIso(now)
      const items: FileEntry[] = []
      let scanned = 0
      let nextCursor: string | undefined
      for (const name of names) {
        if (scanned < start) {
          scanned += 1
          continue
        }
        if (items.length >= pageSize) {
          nextCursor = Buffer.from(String(scanned)).toString('base64url')
          break
        }
        try {
          const childRelative = relativePath.length === 0 ? name : `${relativePath}/${name}`
          items.push(
            toFileEntry(worktreeId, rootIdentity, childRelative, join(absolute, name), observedAt)
          )
        } catch {
          // The entry vanished between listing and classification; skip it.
        }
        scanned += 1
      }
      const page: DevRuntimePage<FileEntry> = {
        items,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
        observedAt,
      }
      return page
    },

    'dev.files.read': (command) => {
      const body = devOperationDecoders['dev.files.read'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const relativePath = workspaceRelativePath(worktreeId, body.path, rootIdentity)
      const absolute = resolveTargetPath(canonicalRoot, relativePath)
      proveContainment(canonicalRoot, absolute)
      const stats = lstatSync(absolute, { throwIfNoEntry: false })
      if (!stats) throw devError('not_found', 'file does not exist inside the worktree')
      if (stats.isSymbolicLink())
        throw devError('symlink_rejected', 'refusing to read through a symlink')
      if (!stats.isFile())
        throw devError('special_file_rejected', 'only regular files accept reads')
      if (stats.size > EDITABLE_TEXT_MAX && body.length === undefined)
        throw devError(
          'limit_exceeded',
          'file exceeds the editable text budget; read it through explicit windows'
        )
      const offset = body.offset !== undefined ? BigInt(String(body.offset)) : 0n
      const length = Math.min(Number(body.length ?? READ_WINDOW_MAX), READ_WINDOW_MAX)
      const { bytes, fileSize } = readWindow(absolute, offset, length)
      const analysis = analyzeBytes(bytes)
      const result: FileReadResult = {
        entry: toFileEntry(worktreeId, rootIdentity, relativePath, absolute, nowIso(now)),
        offset: offset.toString(),
        bytes,
        eof: offset + BigInt(bytes.length) >= fileSize,
        eol: analysis.eol,
        encoding: analysis.encoding,
      }
      return result
    },

    'dev.files.write': (command) => {
      const body = devOperationDecoders['dev.files.write'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const relativePath = workspaceRelativePath(worktreeId, body.path, rootIdentity)
      const absolute = resolveTargetPath(canonicalRoot, relativePath)
      proveContainment(canonicalRoot, absolute)
      requireRegularFileTarget(absolute, true)
      // CAS first: a mismatch throws file_changed and performs no write.
      assertExpectedIdentity(absolute, body.expectedIdentity as FileIdentity)
      const content = body.content as Uint8Array
      const analysis = analyzeBytes(content)
      if (analysis.encoding === 'binary')
        throw devError(
          'invalid_state',
          'binary content is refused on the control path; use the bulk stream'
        )
      const normalized = applyEolPolicy(
        content,
        (body.eolPolicy as 'preserve' | 'lf' | 'crlf') ?? 'preserve'
      )
      const existing = bigintLstat(absolute)
      const previousIdentity = existing ? fileIdentityOf(existing) : { ...ABSENT_IDENTITY }
      const mode = existing ? Number(existing.mode & 0o777n) || 0o644 : 0o644
      atomicWrite(absolute, normalized, mode)
      const entry = toFileEntry(worktreeId, rootIdentity, relativePath, absolute, nowIso(now))
      const result: FileWriteResult = {
        entry: {
          ...entry,
          identity: {
            ...entry.identity,
            contentSha256: createHash('sha256').update(normalized).digest('hex'),
          },
        },
        previousIdentity,
        atomic: true,
      }
      return result
    },

    // Bulk byte streaming (#399 residue): the command halves mint single-use
    // file-bytes-v1 stream grants (caller-identity-bound, resource- and
    // generation-fenced, expiring); the byte halves live in the registered
    // stream provider below.
    'dev.files.readStream': (command, identity) => {
      const body = devOperationDecoders['dev.files.readStream'].request(command.body)
      if (body.direction !== 'read')
        throw devError('identity_mismatch', 'readStream requests the read direction')
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const relativePath = workspaceRelativePath(worktreeId, body.path, rootIdentity)
      const absolute = resolveTargetPath(canonicalRoot, relativePath)
      proveContainment(canonicalRoot, absolute)
      const stats = lstatSync(absolute, { throwIfNoEntry: false })
      if (!stats) throw devError('not_found', 'file does not exist inside the worktree')
      if (stats.isSymbolicLink())
        throw devError('symlink_rejected', 'refusing to read through a symlink')
      if (!stats.isFile())
        throw devError('special_file_rejected', 'only regular files accept reads')
      assertExpectedIdentity(absolute, body.expectedIdentity as FileIdentity)
      const fileSize = BigInt(stats.size)
      const offset = body.offset !== undefined ? BigInt(String(body.offset)) : 0n
      if (offset > fileSize)
        throw devError('invalid_state', 'read offset is past the end of the file')
      const declaredLength = body.length !== undefined ? BigInt(String(body.length)) : undefined
      const readableBytes = fileSize - offset
      if (readableBytes > BigInt(BULK_STREAM_MAX))
        throw devError(
          'limit_exceeded',
          'file exceeds the bulk stream budget (64 MiB); the bounded read window remains available'
        )
      if (declaredLength !== undefined && declaredLength > readableBytes)
        throw devError('invalid_state', 'declared read length is longer than the file')
      const grant = input.authority.mintStreamGrant({
        identity: identity!,
        protocol: 'file-bytes-v1',
        scope: command.scope,
        resource: {
          kind: 'workspace_root',
          id: worktreeId,
          generation: command.resource!.generation,
        },
        direction: 'read',
        fromSequence: offset.toString(),
        maxFrameBytes: STREAM_FRAME_BYTES,
      })
      sweepPendingStreams()
      pendingReads.set(grant.grantId, {
        worktreeId,
        canonicalRoot,
        rootIdentity,
        relativePath,
        absolute,
        expectedIdentity: body.expectedIdentity as FileIdentity,
        offset,
        ...(declaredLength !== undefined ? { declaredLength } : {}),
        expiresAt: Date.parse(grant.expiresAt),
      })
      return grant
    },

    'dev.files.writeStream': (command, identity) => {
      const body = devOperationDecoders['dev.files.writeStream'].request(command.body)
      if (body.direction !== 'write')
        throw devError('identity_mismatch', 'writeStream requests the write direction')
      if (body.eolPolicy !== 'preserve')
        throw devError(
          'invalid_state',
          'bulk stream writes are byte-exact; explicit eol policies apply on the control path'
        )
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const relativePath = workspaceRelativePath(worktreeId, body.path, rootIdentity)
      const absolute = resolveTargetPath(canonicalRoot, relativePath)
      proveContainment(canonicalRoot, absolute)
      requireRegularFileTarget(absolute, true)
      assertExpectedIdentity(absolute, body.expectedIdentity as FileIdentity)
      const declaredByteLength = BigInt(String(body.byteLength))
      if (declaredByteLength > BigInt(BULK_STREAM_MAX))
        throw devError(
          'limit_exceeded',
          'declared write exceeds the bulk stream budget (64 MiB); the control path accepts <= 256 KiB'
        )
      const grant = input.authority.mintStreamGrant({
        identity: identity!,
        protocol: 'file-bytes-v1',
        scope: command.scope,
        resource: {
          kind: 'workspace_root',
          id: worktreeId,
          generation: command.resource!.generation,
        },
        direction: 'write',
        fromSequence: '0',
        maxFrameBytes: STREAM_FRAME_BYTES,
      })
      sweepPendingStreams()
      pendingWrites.set(grant.grantId, {
        worktreeId,
        canonicalRoot,
        rootIdentity,
        relativePath,
        absolute,
        expectedIdentity: body.expectedIdentity as FileIdentity,
        declaredByteLength,
        declaredSha256: String(body.contentSha256),
        expiresAt: Date.parse(grant.expiresAt),
      })
      return grant
    },

    'dev.files.create': (command) => {
      const body = devOperationDecoders['dev.files.create'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const relativePath = workspaceRelativePath(worktreeId, body.path, rootIdentity)
      const absolute = resolveTargetPath(canonicalRoot, relativePath)
      proveContainment(canonicalRoot, absolute)
      if (body.kind === 'directory') {
        try {
          mkdirSync(absolute, { recursive: false, mode: 0o755 })
        } catch {
          throw devError('path_collision', 'directory exists or creation lost a create race')
        }
        fsyncDirectory(dirname(absolute))
      } else {
        const content = (body.content ?? new Uint8Array()) as Uint8Array
        if (analyzeBytes(content).encoding === 'binary')
          throw devError('invalid_state', 'binary creation is refused on the control path')
        atomicCreateNew(absolute, content, 0o644)
      }
      return toFileEntry(worktreeId, rootIdentity, relativePath, absolute, nowIso(now))
    },

    'dev.files.rename': (command) => {
      const body = devOperationDecoders['dev.files.rename'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const fromRelative = workspaceRelativePath(worktreeId, body.from, rootIdentity)
      const fromAbsolute = resolveTargetPath(canonicalRoot, fromRelative)
      proveContainment(canonicalRoot, fromAbsolute)
      assertExpectedIdentity(fromAbsolute, body.expectedIdentity as FileIdentity)
      const toRelative = workspaceRelativePath(worktreeId, body.to, rootIdentity)
      const toAbsolute = resolveTargetPath(canonicalRoot, toRelative)
      proveContainment(canonicalRoot, toAbsolute)
      if (lstatSync(toAbsolute, { throwIfNoEntry: false }))
        throw devError('path_collision', `destination already exists: ${toRelative}`)
      // link + unlink gives failIfExists semantics atomically (rename would
      // silently overwrite an existing destination).
      try {
        linkSync(fromAbsolute, toAbsolute)
      } catch {
        throw devError('path_collision', `destination already exists: ${toRelative}`)
      }
      try {
        unlinkSync(fromAbsolute)
      } catch (error) {
        try {
          unlinkSync(toAbsolute)
        } catch {
          // Rollback best-effort; the original failure surfaces.
        }
        throw error
      }
      fsyncDirectory(dirname(toAbsolute))
      return toFileEntry(worktreeId, rootIdentity, toRelative, toAbsolute, nowIso(now))
    },

    // Overwrite renames are the one sanctioned clobber, so they ride an
    // explicit plan/commit pair: the plan pins BOTH identities — the moving
    // source and the colliding destination it will replace — and names the
    // collision; the commit re-proves both and only then runs the atomic
    // rename over the destination.
    'dev.files.renameOverwritePlan': (command) => {
      const body = devOperationDecoders['dev.files.renameOverwritePlan'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity, ...gate } =
        requireLiveWorktreeExtended(command)
      const fromRelative = workspaceRelativePath(worktreeId, body.from, rootIdentity)
      const fromAbsolute = resolveTargetPath(canonicalRoot, fromRelative)
      proveContainment(canonicalRoot, fromAbsolute)
      if (!bigintLstat(fromAbsolute))
        throw devError('not_found', 'rename source does not exist inside the worktree')
      assertExpectedIdentity(fromAbsolute, body.expectedFromIdentity as FileIdentity)
      const toRelative = workspaceRelativePath(worktreeId, body.to, rootIdentity)
      if (fromRelative === toRelative)
        throw devError('invalid_state', 'rename source and destination are identical')
      const toAbsolute = resolveTargetPath(canonicalRoot, toRelative)
      proveContainment(canonicalRoot, toAbsolute)
      const toStats = lstatSync(toAbsolute, { throwIfNoEntry: false })
      if (!toStats)
        throw devError(
          'not_found',
          `overwrite plan requires an existing destination; the target ${toRelative} is free — use dev.files.rename`
        )
      // The explicit confirm binding: the caller pins the identity of the
      // exact file the overwrite will destroy, not just its path.
      assertExpectedIdentity(toAbsolute, body.expectedToIdentity as FileIdentity)
      // A directory rename may never swallow its own subtree.
      if (
        containsPath(fromAbsolute, toAbsolute) &&
        fromAbsolute !== toAbsolute &&
        toStats.isDirectory()
      )
        throw devError('invalid_state', 'destination sits inside the source directory')
      const digest = sha256Text(
        JSON.stringify({
          kind: 'rename_overwrite',
          worktreeId,
          generation: gate.generation,
          from: fromRelative,
          to: toRelative,
          fromIdentity: body.expectedFromIdentity,
          toIdentity: body.expectedToIdentity,
        })
      )
      const planId = randomUUID()
      plans.set(planId, {
        kind: 'rename_overwrite',
        worktreeId,
        canonicalRoot,
        generation: gate.generation,
        fromRelative,
        toRelative,
        expectedFromIdentity: body.expectedFromIdentity as FileIdentity,
        expectedToIdentity: body.expectedToIdentity as FileIdentity,
        expiresAt: now() + PLAN_TTL_MS,
        digest,
      })
      return {
        id: planId,
        operation: 'dev.files.renameOverwriteCommit' as DevOperation,
        scope: input.scope,
        resource: { kind: 'workspace_root', id: worktreeId, generation: gate.generation },
        factVersions: {
          generation: String(gate.generation),
          fromIdentity: identityFactLine(body.expectedFromIdentity),
          toIdentity: identityFactLine(body.expectedToIdentity),
        },
        steps: [
          {
            id: 'rename_overwrite',
            kind: 'file_rename_overwrite',
            targetId: toRelative,
            dependsOn: [],
          },
        ],
        blockers: [],
        requiredApprovalIds: [],
        digest,
        expiresAt: new Date(now() + PLAN_TTL_MS).toISOString(),
      } satisfies MutationPlan
    },

    'dev.files.renameOverwriteCommit': (command) => {
      const body = devOperationDecoders['dev.files.renameOverwriteCommit'].request(command.body)
      const planId = String(body.planId)
      // Paired commit: the body names the plan, so the envelope resource is
      // validated against the plan's bound worktree before anything runs.
      const entry = liveFilePlan(planId, 'rename_overwrite', body.planDigest, command.resource)
      if (
        entry.fromRelative === undefined ||
        entry.toRelative === undefined ||
        entry.expectedFromIdentity === undefined ||
        entry.expectedToIdentity === undefined
      )
        throw devError('plan_stale', 'the plan is not an overwrite rename')
      const generation = command.resource?.generation ?? entry.generation
      const { canonicalRoot, rootIdentity } = requireWorktreeContextAt(
        command,
        entry.worktreeId,
        generation
      )
      if (entry.generation !== generation)
        throw devError('stale_generation', 'the plan is bound to another worktree generation')
      if (entry.canonicalRoot !== canonicalRoot)
        throw devError('unauthorized_root', 'the plan is bound to another canonical root')
      const fromAbsolute = resolveTargetPath(canonicalRoot, entry.fromRelative)
      const toAbsolute = resolveTargetPath(canonicalRoot, entry.toRelative)
      proveContainment(canonicalRoot, fromAbsolute)
      proveContainment(canonicalRoot, toAbsolute)
      // Both pins re-proven immediately before the atomic rename.
      assertExpectedIdentity(fromAbsolute, entry.expectedFromIdentity)
      assertExpectedIdentity(toAbsolute, entry.expectedToIdentity)
      renameSync(fromAbsolute, toAbsolute)
      fsyncDirectory(dirname(toAbsolute))
      consumeFilePlan(planId)
      return toFileEntry(entry.worktreeId, rootIdentity, entry.toRelative, toAbsolute, nowIso(now))
    },

    'dev.files.delete': (command) => {
      const body = devOperationDecoders['dev.files.delete'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const relativePath = workspaceRelativePath(worktreeId, body.path, rootIdentity)
      const absolute = resolveTargetPath(canonicalRoot, relativePath)
      proveContainment(canonicalRoot, absolute)
      const stats = bigintLstat(absolute)
      if (!stats) throw devError('not_found', 'path does not exist inside the worktree')
      assertExpectedIdentity(absolute, body.expectedIdentity as FileIdentity)
      if (stats.isDirectory()) {
        rmdirSync(absolute)
      } else {
        unlinkSync(absolute)
      }
      fsyncDirectory(dirname(absolute))
      const result: FileMutationResult = {
        path: { worktreeId, rootIdentity: { ...rootIdentity }, relativePath },
        previousIdentity: fileIdentityOf(stats),
        state: 'deleted',
      }
      return result
    },

    // Recursive deletes ride an explicit bounded plan: the dry run
    // enumerates every item (bounded depth/items, symlinks refused outright)
    // into per-item steps with identity facts, and the confirmed commit
    // re-proves the whole tree before deleting anything.
    'dev.files.deleteTreePlan': (command) => {
      const body = devOperationDecoders['dev.files.deleteTreePlan'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity, ...gate } =
        requireLiveWorktreeExtended(command)
      const relativePath = workspaceRelativePath(worktreeId, body.path, rootIdentity)
      if (relativePath.length === 0 || relativePath === '.')
        throw devError('invalid_state', 'the worktree root itself is not a delete target')
      if (typeof body.confirmationId !== 'string' || body.confirmationId.length < 6)
        throw devError('invalid_state', 'recursive delete requires an explicit confirmation id')
      const { items } = enumerateTree(canonicalRoot, relativePath)
      const digest = sha256Text(
        JSON.stringify({ kind: 'delete_tree', worktreeId, generation: gate.generation, items })
      )
      const planId = randomUUID()
      plans.set(planId, {
        kind: 'delete_tree',
        worktreeId,
        canonicalRoot,
        generation: gate.generation,
        rootRelative: relativePath,
        items,
        expiresAt: now() + PLAN_TTL_MS,
        digest,
      })
      const stepIds = items.map((_, index) => `item-${index}`)
      const steps = items.map((item, index) => ({
        id: stepIds[index] as string,
        kind: item.kind === 'directory' ? 'dir_delete' : 'file_delete',
        targetId: item.relativePath,
        dependsOn:
          item.kind === 'directory' ? directChildStepIds(items, item.relativePath, stepIds) : [],
      }))
      return {
        id: planId,
        operation: 'dev.files.deleteTreeCommit' as DevOperation,
        scope: input.scope,
        resource: { kind: 'workspace_root', id: worktreeId, generation: gate.generation },
        factVersions: {
          generation: String(gate.generation),
          root: identityFactLine(rootIdentity),
          items: String(items.length),
        },
        steps,
        blockers: [],
        requiredApprovalIds: [],
        digest,
        expiresAt: new Date(now() + PLAN_TTL_MS).toISOString(),
      } satisfies MutationPlan
    },

    'dev.files.deleteTreeCommit': (command) => {
      const body = devOperationDecoders['dev.files.deleteTreeCommit'].request(command.body)
      const planId = String(body.planId)
      const entry = liveFilePlan(planId, 'delete_tree', body.planDigest, command.resource)
      if (entry.rootRelative === undefined || entry.items === undefined)
        throw devError('plan_stale', 'the plan is not a recursive delete')
      const generation = command.resource?.generation ?? entry.generation
      const { canonicalRoot, rootIdentity } = requireWorktreeContextAt(
        command,
        entry.worktreeId,
        generation
      )
      if (entry.generation !== generation)
        throw devError('stale_generation', 'the plan is bound to another worktree generation')
      if (entry.canonicalRoot !== canonicalRoot)
        throw devError('unauthorized_root', 'the plan is bound to another canonical root')
      reprovePlannedTree(canonicalRoot, entry)
      // Pre-order enumeration reversed: children always delete before their
      // parent directories.
      for (const item of entry.items.toReversed()) {
        const absolute = join(canonicalRoot, item.relativePath)
        proveContainment(canonicalRoot, absolute)
        if (item.kind === 'directory') rmdirSync(absolute)
        else unlinkSync(absolute)
      }
      fsyncDirectory(dirname(join(canonicalRoot, entry.rootRelative)))
      consumeFilePlan(planId)
      const result: FileTreeMutationResult = {
        path: {
          worktreeId: entry.worktreeId,
          rootIdentity: { ...rootIdentity },
          relativePath: entry.rootRelative,
        },
        state: 'deleted',
        items: entry.items.length,
        totalBytes: '0',
        observedAt: nowIso(now),
      }
      return result
    },

    'dev.files.copy': (command) => {
      const body = devOperationDecoders['dev.files.copy'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const fromRelative = workspaceRelativePath(worktreeId, body.from, rootIdentity)
      const fromAbsolute = resolveTargetPath(canonicalRoot, fromRelative)
      proveContainment(canonicalRoot, fromAbsolute)
      const sourceStats = lstatSync(fromAbsolute, { throwIfNoEntry: false })
      if (!sourceStats) throw devError('not_found', 'source does not exist inside the worktree')
      if (sourceStats.isSymbolicLink())
        throw devError('symlink_rejected', 'refusing to copy through a symlink')
      if (!sourceStats.isFile())
        throw devError('special_file_rejected', 'only regular files copy on the control path')
      assertExpectedIdentity(fromAbsolute, body.expectedIdentity as FileIdentity)
      if (Number(sourceStats.size) > COPY_BUDGET_MAX)
        throw devError('limit_exceeded', 'source exceeds the copy budget')
      const toRelative = workspaceRelativePath(worktreeId, body.to, rootIdentity)
      const toAbsolute = resolveTargetPath(canonicalRoot, toRelative)
      proveContainment(canonicalRoot, toAbsolute)
      if (lstatSync(toAbsolute, { throwIfNoEntry: false }))
        throw devError('path_collision', 'destination exists and failIfExists is true')
      atomicCreateNew(toAbsolute, readFileSync(fromAbsolute), sourceStats.mode & 0o777)
      return toFileEntry(worktreeId, rootIdentity, toRelative, toAbsolute, nowIso(now))
    },

    // Recursive copies: the plan enumerates and validates every
    // source/destination pair under the item/depth/volume budgets (spec:
    // no recursive copy without an explicit plan); the commit re-proves the
    // source tree and the free destination before copying anything.
    'dev.files.copyTreePlan': (command) => {
      const body = devOperationDecoders['dev.files.copyTreePlan'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity, ...gate } =
        requireLiveWorktreeExtended(command)
      const fromRelative = workspaceRelativePath(worktreeId, body.from, rootIdentity)
      const fromAbsolute = resolveTargetPath(canonicalRoot, fromRelative)
      proveContainment(canonicalRoot, fromAbsolute)
      if (!bigintLstat(fromAbsolute))
        throw devError('not_found', 'source does not exist inside the worktree')
      assertExpectedIdentity(fromAbsolute, body.expectedIdentity as FileIdentity)
      const toRelative = workspaceRelativePath(worktreeId, body.to, rootIdentity)
      if (fromRelative === toRelative)
        throw devError('invalid_state', 'copy source and destination are identical')
      const toAbsolute = resolveTargetPath(canonicalRoot, toRelative)
      proveContainment(canonicalRoot, toAbsolute)
      if (lstatSync(toAbsolute, { throwIfNoEntry: false }))
        throw devError('path_collision', `destination already exists: ${toRelative}`)
      if (containsPath(fromAbsolute, toAbsolute))
        throw devError('invalid_state', 'destination sits inside the source directory')
      const { items, totalBytes } = enumerateTree(canonicalRoot, fromRelative)
      if (totalBytes > BigInt(TREE_COPY_TOTAL_MAX))
        throw devError(
          'limit_exceeded',
          'tree exceeds the copy volume budget (256 MiB); copy smaller batches'
        )
      const digest = sha256Text(
        JSON.stringify({
          kind: 'copy_tree',
          worktreeId,
          generation: gate.generation,
          from: fromRelative,
          to: toRelative,
          items,
          totalBytes: totalBytes.toString(),
        })
      )
      const planId = randomUUID()
      plans.set(planId, {
        kind: 'copy_tree',
        worktreeId,
        canonicalRoot,
        generation: gate.generation,
        rootRelative: fromRelative,
        destinationRelative: toRelative,
        items,
        totalBytes,
        expiresAt: now() + PLAN_TTL_MS,
        digest,
      })
      const stepIdByPath = new Map(items.map((item, index) => [item.relativePath, `item-${index}`]))
      const steps = items.map((item) => {
        const lastSlash = item.relativePath.lastIndexOf('/')
        const parentRelative = lastSlash === -1 ? undefined : item.relativePath.slice(0, lastSlash)
        const parentStepId =
          parentRelative === undefined ? undefined : stepIdByPath.get(parentRelative)
        return {
          id: stepIdByPath.get(item.relativePath) as string,
          kind: item.kind === 'directory' ? 'copy_dir' : 'copy_file',
          targetId: `${toRelative}${item.relativePath.slice(fromRelative.length)}`,
          dependsOn: parentStepId === undefined ? [] : [parentStepId],
        }
      })
      return {
        id: planId,
        operation: 'dev.files.copyTreeCommit' as DevOperation,
        scope: input.scope,
        resource: { kind: 'workspace_root', id: worktreeId, generation: gate.generation },
        factVersions: {
          generation: String(gate.generation),
          source: identityFactLine(body.expectedIdentity),
          items: String(items.length),
          totalBytes: totalBytes.toString(),
        },
        steps,
        blockers: [],
        requiredApprovalIds: [],
        digest,
        expiresAt: new Date(now() + PLAN_TTL_MS).toISOString(),
      } satisfies MutationPlan
    },

    'dev.files.copyTreeCommit': (command) => {
      const body = devOperationDecoders['dev.files.copyTreeCommit'].request(command.body)
      const planId = String(body.planId)
      const entry = liveFilePlan(planId, 'copy_tree', body.planDigest, command.resource)
      if (
        entry.rootRelative === undefined ||
        entry.destinationRelative === undefined ||
        entry.items === undefined ||
        entry.totalBytes === undefined
      )
        throw devError('plan_stale', 'the plan is not a recursive copy')
      const generation = command.resource?.generation ?? entry.generation
      const { canonicalRoot, rootIdentity } = requireWorktreeContextAt(
        command,
        entry.worktreeId,
        generation
      )
      if (entry.generation !== generation)
        throw devError('stale_generation', 'the plan is bound to another worktree generation')
      if (entry.canonicalRoot !== canonicalRoot)
        throw devError('unauthorized_root', 'the plan is bound to another canonical root')
      // The source tree must be exactly what the plan enumerated and the
      // destination must still be free before anything is written.
      reprovePlannedTree(canonicalRoot, entry)
      const destinationRoot = join(canonicalRoot, entry.destinationRelative)
      if (lstatSync(destinationRoot, { throwIfNoEntry: false }))
        throw devError('path_collision', `destination already exists: ${entry.destinationRelative}`)
      const sourcePrefixLength = entry.rootRelative.length
      for (const item of entry.items) {
        const destinationRelative = `${entry.destinationRelative}${item.relativePath.slice(sourcePrefixLength)}`
        const destinationAbsolute = join(canonicalRoot, destinationRelative)
        proveContainment(canonicalRoot, destinationAbsolute)
        if (item.kind === 'directory') {
          try {
            mkdirSync(destinationAbsolute, { recursive: false, mode: 0o755 })
          } catch {
            throw devError('path_collision', `destination already exists: ${destinationRelative}`)
          }
        } else {
          if (BigInt(item.size) > BigInt(COPY_BUDGET_MAX))
            throw devError('limit_exceeded', `source exceeds the copy budget: ${item.relativePath}`)
          atomicCreateNew(
            destinationAbsolute,
            readFileSync(join(canonicalRoot, item.relativePath)),
            item.mode || 0o644
          )
        }
      }
      fsyncDirectory(dirname(destinationRoot))
      consumeFilePlan(planId)
      const result: FileTreeMutationResult = {
        path: {
          worktreeId: entry.worktreeId,
          rootIdentity: { ...rootIdentity },
          relativePath: entry.destinationRelative,
        },
        state: 'copied',
        items: entry.items.length,
        totalBytes: entry.totalBytes.toString(),
        observedAt: nowIso(now),
      }
      return result
    },

    'dev.files.openExternal': async (command) => {
      const body = devOperationDecoders['dev.files.openExternal'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const relativePath = workspaceRelativePath(worktreeId, body.path, rootIdentity)
      const absolute = resolveTargetPath(canonicalRoot, relativePath)
      proveContainment(canonicalRoot, absolute)
      assertExpectedIdentity(absolute, body.expectedIdentity as FileIdentity)
      const open = input.openPath ?? defaultOpenPath
      const applicationLabel = await open(absolute)
      const result: ExternalOpenResult = {
        accepted: true,
        path: { worktreeId, rootIdentity: { ...rootIdentity }, relativePath },
        ...(applicationLabel !== undefined ? { applicationLabel } : {}),
      }
      return result
    },

    'dev.files.search': async (command) => {
      const body = devOperationDecoders['dev.files.search'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const rgPath = input.rgPath?.() ?? 'rg'
      if (!probeRipgrep(rgPath))
        throw devError(
          'capability_unavailable',
          'no ripgrep binary is available on this runtime node; install rg for project search',
          true
        )
      const limit = Math.min(Number(body.limit ?? SEARCH_MATCH_CAP), SEARCH_MATCH_CAP)
      const start = searchOffset(body.cursor)
      // Collect one look-ahead match so the bounded page can advertise a
      // cursor. The cap remains global; hitting it is an intentional partial
      // result rather than an unbounded search.
      const matchCap = Math.min(start + limit + 1, SEARCH_MATCH_CAP)
      const matches = await runRipgrep({
        rgPath,
        canonicalRoot,
        rootIdentity,
        worktreeId,
        query: String(body.query),
        globs: (body.globs as readonly string[] | undefined) ?? [],
        matchCap,
        observedAt: nowIso(now),
      })
      // Attach the live file identity where the file still exists; a match
      // whose file vanished between match and identity fill is dropped.
      const resolved: SearchMatch[] = []
      for (const match of matches) {
        try {
          const absolute = resolveTargetPath(canonicalRoot, match.path.relativePath)
          const stats = bigintLstat(absolute)
          resolved.push({
            ...match,
            identity: stats ? fileIdentityOf(stats) : { ...ABSENT_IDENTITY },
          })
        } catch {
          // Vanished; drop.
        }
      }
      const hasMore = resolved.length > start + limit
      const page: DevRuntimePage<SearchMatch> = {
        items: resolved.slice(start, start + limit),
        ...(hasMore ? { nextCursor: searchCursor(start + limit) } : {}),
        observedAt: nowIso(now),
      }
      return page
    },
  }

  // ── file-bytes-v1 stream provider (bulk byte halves) ─────────────────────

  /** Serves one attached read stream: re-proves the worktree and file
   *  identity at attach, then pumps bounded frames under client ack credit
   *  (at most one mebibyte in flight). Sequence numbers are byte offsets, so
   *  a client can always position what it received. */
  function attachReadSession(session: FileBytesSession, grant: DevStreamGrant): void {
    const pending = pendingReads.get(grant.grantId)
    pendingReads.delete(grant.grantId)
    if (!pending) {
      session.close('incompatible', 'no pending bulk read is bound to this grant')
      return
    }
    const record: PendingReadRecord = pending
    const refuse = (error: DevError): void => {
      try {
        session.send({ type: 'error', error })
      } catch {
        /* socket already gone */
      }
      session.close('incompatible', error.message)
    }
    try {
      requireAttachableWorktree(record, grant.resource.generation)
      assertExpectedIdentity(record.absolute, record.expectedIdentity)
    } catch (error) {
      refuse(mapFilesError(error) as DevError)
      return
    }
    let nextOffset = record.offset
    const endOffset =
      record.declaredLength !== undefined ? record.offset + record.declaredLength : undefined
    let fd: number | undefined
    let outstanding = 0
    let finished = false
    const release = (): void => {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* already closed */
        }
        fd = undefined
      }
    }
    session.onClose = release
    session.onFrame = (frame) => {
      if (frame.type !== 'ack') {
        session.close('incompatible', 'read streams accept only ack frames')
        return
      }
      outstanding = Math.max(0, outstanding - frame.availableCreditBytes)
      pump()
    }
    function pump(): void {
      if (finished) return
      try {
        // Re-prove identity between credit windows: a file rewritten mid-read
        // ends the stream instead of serving torn bytes.
        assertExpectedIdentity(record.absolute, record.expectedIdentity)
        if (fd === undefined) fd = openSync(record.absolute, 'r')
        while (outstanding < STREAM_CREDIT_HIGH_WATER) {
          if (endOffset !== undefined && nextOffset >= endOffset) break
          const budget =
            endOffset !== undefined ? Number(endOffset - nextOffset) : STREAM_FRAME_BYTES
          const chunkLength = Math.min(STREAM_FRAME_BYTES, budget)
          if (chunkLength <= 0) break
          const window = Buffer.alloc(chunkLength)
          const read = readSync(fd, window, 0, chunkLength, Number(nextOffset))
          if (read === 0) break
          const bytes = window.subarray(0, read)
          session.send({ type: 'data', sequence: nextOffset.toString(), bytes })
          outstanding += read
          nextOffset += BigInt(read)
          if (read < chunkLength) break // fstat EOF
        }
        const fileSize = BigInt(fstatSync(fd).size)
        const drained =
          nextOffset >= fileSize || (endOffset !== undefined && nextOffset >= endOffset)
        if (drained && outstanding === 0) {
          finished = true
          release()
          session.close('normal', 'bulk read complete')
        }
      } catch (error) {
        finished = true
        release()
        refuse(mapFilesError(error) as DevError)
      }
    }
    pump()
  }

  /** Serves one attached write stream: chunks land in an owner-only
   *  same-directory temp file, are digest-tracked as they arrive, and only a
   *  byte-exact, digest-exact, identity-clean transfer is renamed into
   *  place. Anything else discards the temp and reports `file_changed`. */
  function attachWriteSession(session: FileBytesSession, grant: DevStreamGrant): void {
    const pending = pendingWrites.get(grant.grantId)
    pendingWrites.delete(grant.grantId)
    if (!pending) {
      session.close('incompatible', 'no pending bulk write is bound to this grant')
      return
    }
    const record: PendingWriteRecord = pending
    const refuse = (error: DevError): void => {
      try {
        session.send({ type: 'error', error })
      } catch {
        /* socket already gone */
      }
      session.close('normal', error.message)
    }
    try {
      requireAttachableWorktree(record, grant.resource.generation)
      assertExpectedIdentity(record.absolute, record.expectedIdentity)
    } catch (error) {
      refuse(mapFilesError(error) as DevError)
      return
    }
    const temp = join(dirname(record.absolute), `.adea-tmp-${randomUUID()}`)
    const digest = createHash('sha256')
    let received = 0n
    let settled = false
    let fd: number | undefined
    const discard = (): void => {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* already closed */
        }
        fd = undefined
      }
      try {
        unlinkSync(temp)
      } catch {
        /* nothing to clean */
      }
    }
    session.onClose = () => {
      if (!settled) discard()
    }
    session.onFrame = (frame) => {
      if (settled) {
        session.close('incompatible', 'the write already settled')
        return
      }
      if (frame.type !== 'input') {
        session.close('incompatible', 'write streams accept only input frames')
        return
      }
      if (frame.generation !== grant.resource.generation) {
        session.close('stale_generation', 'input frame generation is stale')
        return
      }
      if (BigInt(frame.sequence) !== received || frame.bytes.byteLength === 0) {
        settled = true
        discard()
        refuse(devError('file_changed', 'write chunks must be contiguous; the write was discarded'))
        return
      }
      if (received + BigInt(frame.bytes.byteLength) > record.declaredByteLength) {
        settled = true
        discard()
        refuse(
          devError(
            'file_changed',
            'received bytes exceed the declared length; the write was discarded'
          )
        )
        return
      }
      try {
        if (fd === undefined) fd = openSync(temp, 'wx', 0o600)
        writeSync(fd, frame.bytes)
        digest.update(frame.bytes)
        received += BigInt(frame.bytes.byteLength)
        if (received === record.declaredByteLength) {
          settled = true
          finalize()
        }
      } catch (error) {
        settled = true
        discard()
        refuse(mapFilesError(error) as DevError)
      }
    }
    /** The transfer is byte-complete: fsync, verify the declared digest,
     *  re-prove the pinned identity, preserve the reviewed permissions, and
     *  rename atomically into place. */
    function finalize(): void {
      try {
        if (fd !== undefined) {
          fsyncSync(fd)
          closeSync(fd)
          fd = undefined
        }
        if (digest.digest('hex') !== record.declaredSha256)
          throw devError(
            'file_changed',
            'received bytes do not match the declared sha256; the write was discarded'
          )
        assertExpectedIdentity(record.absolute, record.expectedIdentity)
        const existing = bigintLstat(record.absolute)
        const mode = existing ? Number(existing.mode & 0o777n) || 0o644 : 0o644
        chmodSync(temp, mode)
        renameSync(temp, record.absolute)
        fsyncDirectory(dirname(record.absolute))
        session.close('normal', 'bulk write complete')
      } catch (error) {
        discard()
        refuse(mapFilesError(error) as DevError)
      }
    }
    // A declared-empty write never receives a chunk; finalize immediately.
    if (record.declaredByteLength === 0n) {
      settled = true
      finalize()
    }
  }

  function registerStreamProvider(): void {
    if (!input.gateway) return
    input.gateway.registerStreamHandler('file-bytes-v1', (session) => {
      const grant = session.grant
      if (grant.resource.kind !== 'workspace_root') {
        session.close('incompatible', 'file streams bind workspace_root resources')
        return
      }
      if (grant.direction === 'read') attachReadSession(session, grant)
      else attachWriteSession(session, grant)
    })
  }

  let registeredCommands = 0
  const registeredOperations: DevOperation[] = []
  for (const [operation, handler] of Object.entries(handlers)) {
    if (!handler) continue
    // Without a full-duplex gateway there is no attach path for a minted
    // file-bytes-v1 grant, so the stream command halves stay unregistered
    // and the composition fallback reports them typed-unavailable.
    if (
      !input.gateway &&
      (operation === 'dev.files.readStream' || operation === 'dev.files.writeStream')
    )
      continue
    input.authority.registerCommandProvider(
      operation as DevOperation,
      async (command, identity) => {
        try {
          return await handler(command, identity)
        } catch (error) {
          throw mapFilesError(error)
        }
      }
    )
    registeredCommands += 1
    registeredOperations.push(operation as DevOperation)
  }
  registerStreamProvider()
  return { commands: registeredOperations, registeredCommands }
}

/** macOS handoff: fixed argv `open <path>` — no shell, no interpolation. */
function defaultOpenPath(absolutePath: string): Promise<string | undefined> {
  if (process.platform !== 'darwin')
    return Promise.reject(
      devError('unavailable', 'no external-open handoff is wired for this platform')
    )
  try {
    const proc = Bun.spawnSync(['open', absolutePath], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 10_000,
    })
    if (proc.exitCode !== 0)
      return Promise.reject(devError('unavailable', 'the external-open handoff failed'))
    return Promise.resolve(undefined)
  } catch {
    return Promise.reject(devError('unavailable', 'the external-open handoff failed'))
  }
}

function mapFilesError(error: unknown): unknown {
  const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown }
  if (
    candidate &&
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    (candidate.retryable === undefined || typeof candidate.retryable === 'boolean')
  ) {
    if (candidate.retryable === undefined)
      return devError(candidate.code as DevError['code'], candidate.message)
    return candidate
  }
  return error instanceof Error
    ? devError('invalid_state', error.message)
    : devError('invalid_state', 'files operation failed')
}
