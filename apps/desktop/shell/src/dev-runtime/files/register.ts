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

import type {
  DevCommand,
  DevError,
  DevOperation,
  DevRuntimePage,
  ExternalOpenResult,
  FileEntry,
  FileIdentity,
  FileMutationResult,
  FileReadResult,
  FileWriteResult,
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
  /** External-editor/OS handoff seam (fixed argv, no shell); defaults to the
   *  macOS `open` handoff and refuses elsewhere. */
  openPath?: (absolutePath: string) => Promise<string | undefined>
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
const SEARCH_PREVIEW_MAX = 2000

const ABSENT_IDENTITY: FileIdentity = { mtimeNs: '0', size: '0' }

function devError(code: DevError['code'], message: string, retryable = false): DevError {
  return { code, retryable, message }
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString()
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

function containsPath(parentPath: string, childPath: string): boolean {
  const rel = relative(parentPath, childPath)
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'))
}

/** Re-prove containment immediately before a system call: realpath the
 *  deepest existing ancestor of the target and require it to stay inside the
 *  canonical root. Catches symlink swaps that happened after listing. */
function proveContainment(canonicalRoot: string, target: string): void {
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

export function registerFilesRuntime(input: FilesRegistrarInput): {
  commands: readonly DevOperation[]
  registeredCommands: number
} {
  const now = input.now ?? Date.now

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

  const handlers: Partial<Record<DevOperation, (command: DevCommand) => unknown>> = {
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
        throw devError('path_collision', 'destination exists and failIfExists is true')
      // link + unlink gives failIfExists semantics atomically (rename would
      // silently overwrite an existing destination).
      try {
        linkSync(fromAbsolute, toAbsolute)
      } catch {
        throw devError('path_collision', 'destination exists and failIfExists is true')
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
      const matchCap = Math.min(Number(body.limit ?? SEARCH_MATCH_CAP), SEARCH_MATCH_CAP)
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
      const page: DevRuntimePage<SearchMatch> = {
        items: resolved.slice(0, matchCap),
        observedAt: nowIso(now),
      }
      return page
    },
  }

  let registeredCommands = 0
  for (const [operation, handler] of Object.entries(handlers)) {
    if (!handler) continue
    input.authority.registerCommandProvider(operation as DevOperation, async (command) => {
      try {
        return await handler(command)
      } catch (error) {
        throw mapFilesError(error)
      }
    })
    registeredCommands += 1
  }
  return { commands: Object.keys(handlers) as DevOperation[], registeredCommands }
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
