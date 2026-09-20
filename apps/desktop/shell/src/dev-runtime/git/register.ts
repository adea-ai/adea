// Production local-git registrar for the #399 Files/Source Control slice.
//
// Every operation is scope-bound through the M10 channel gate and re-proven
// here against the worktree service's canonical roots: the envelope resource
// (kind `worktree`, id, live worktree generation) must match a registered
// ready worktree, and every WorkspacePath must pin that same root (cross-
// worktree substitution is refused).
//
// Git runs through the bounded, argv-only runner the worktree service uses
// (`LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, fixed time and
// output budgets) with `--` before pathspecs and NUL-delimited machine formats
// so newline/control-containing filenames stay representable. Remote URLs are
// credential-redacted before any error message, log, or DTO. Checkpoints are
// namespaced refs under `refs/adea/checkpoints/<worktreeId>/` built through a
// temporary index — they never dirty the branch or the real index — and
// restore is an explicit plan/commit pair, never automatic.
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  DevCommand,
  DevError,
  DevOperation,
  DevRuntimePage,
  DiffHunk,
  GitCheckpoint,
  GitCommit,
  GitFetchResult,
  GitStatus,
  MutationPlan,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import type { ChannelAuthority } from '../channel/authority'
import { gitChildEnv, GIT_CHILD_TIMEOUT_MS, runGit, runGitChecked } from '../worktrees/git-run'
import type { FileIdentityValue } from '../worktrees/identity'

const NUL = '\u0000'
const RECORD = '\u001e'
const CHECKPOINT_REF_PREFIX = 'refs/adea/checkpoints/'
const PLAN_TTL_MS = 10 * 60_000
const STATUS_PAGE_MAX = 500
const HISTORY_PAGE_MAX = 500
const DIFF_PAGE_MAX = 10_000
const DIFF_OUTPUT_BUDGET = 8 * 1024 * 1024
const PATHSPEC_MAX = 1000
const COMMIT_MESSAGE_MAX = 10_000

/** The narrow worktree-service seam the composition root populates from
 *  `service.getWorktree(scope, id)`. */
export type GitWorktreeContext = Readonly<{
  canonicalRoot: string
  rootIdentity: FileIdentityValue
  generation: number
  lifecycle: string
}>

export type GitRegistrarInput = {
  authority: ChannelAuthority
  scope: Scope
  /** Fail-closed resolution of the live worktree record. */
  resolveWorktree(worktreeId: string): GitWorktreeContext | undefined
  now?: () => number
}

function devError(code: DevError['code'], message: string, retryable = false): DevError {
  return { code, retryable, message }
}

/** Remote URLs are redacted before any error message enters a DTO or log;
 *  embedded user-info is removed, namespace paths are preserved. */
function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, '$1<redacted>@')
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function cursorOf(offset: number): string {
  return Buffer.from(String(offset)).toString('base64url')
}

function offsetOf(cursor: unknown): number {
  const decoded = Number(Buffer.from(String(cursor), 'base64url').toString('utf8'))
  if (!Number.isSafeInteger(decoded) || decoded < 0)
    throw devError('not_found', 'unknown listing cursor')
  return decoded
}

/** Fixed leading config: porcelain output keeps non-ASCII and
 *  control-character filenames as raw UTF-8 (never C-quoted). */
const PATHSAFE_CONFIG = ['-c', 'core.quotepath=off'] as const

// ─── Bounded git with extra environment (temporary index) ───────────────────

async function runGitEnv(
  args: readonly string[],
  options: {
    cwd: string
    env?: Record<string, string>
    timeoutMs?: number
    maxOutputBytes?: number
  }
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: options.cwd,
    env: { ...gitChildEnv(), ...options.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // Already exited.
    }
  }, options.timeoutMs ?? GIT_CHILD_TIMEOUT_MS)
  timer.unref?.()
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const decoder = new TextDecoder('utf-8', { fatal: false })
    let total = 0
    let text = ''
    for await (const chunk of stream) {
      total += chunk.byteLength
      if (total > (options.maxOutputBytes ?? 1024 * 1024)) {
        try {
          proc.kill()
        } catch {
          // Already exiting.
        }
        throw devError('limit_exceeded', `git ${String(args[0])} exceeded its output budget`)
      }
      text += decoder.decode(chunk, { stream: true })
    }
    text += decoder.decode()
    return text
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    read(proc.stdout),
    read(proc.stderr),
    proc.exited,
  ])
  clearTimeout(timer)
  return { stdout, stderr, exitCode }
}

// ─── Porcelain parsing ──────────────────────────────────────────────────────

type StatusRecord = { x: string; y: string; path: string; origPath?: string }

/** `git status --porcelain=v1 -z` records: `XY <path>` NUL, plus a trailing
 *  NUL field carrying the ORIGINAL path for renames/copies. */
function parsePorcelainZ(stdout: string): { branchLine?: string; records: StatusRecord[] } {
  const fields = stdout.split(NUL)
  const records: StatusRecord[] = []
  let branchLine: string | undefined
  let index = 0
  if (fields[0]?.startsWith('## ')) {
    branchLine = fields[0]
    index = 1
  }
  for (; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === undefined || field.length === 0) continue
    if (field.startsWith('## ')) {
      branchLine = field
      continue
    }
    if (field.length < 4) continue
    const x = field[0] as string
    const y = field[1] as string
    const path = field.slice(3)
    if (x === 'R' || x === 'C') {
      const orig = fields[index + 1]
      index += 1
      records.push({ x, y, path, ...(orig !== undefined ? { origPath: orig } : {}) })
    } else {
      records.push({ x, y, path })
    }
  }
  return { branchLine, records }
}

function parseBranchLine(branchLine: string | undefined): {
  headRef?: string
  detached: boolean
  unborn: boolean
} {
  if (!branchLine) return { detached: true, unborn: false }
  const body = branchLine.slice(3).trim()
  if (body.startsWith('No commits yet on ')) {
    return { headRef: body.slice('No commits yet on '.length), detached: false, unborn: true }
  }
  if (body === 'HEAD (no branch)') return { detached: true, unborn: false }
  const dotIndex = body.indexOf('...')
  const ref = dotIndex === -1 ? (body.split(' ')[0] ?? body) : body.slice(0, dotIndex)
  return { headRef: ref, detached: false, unborn: false }
}

// ─── Unified diff parsing ───────────────────────────────────────────────────

type DiffLine = { kind: 'context' | 'add' | 'delete'; text: string }

type RawHunk = {
  oldPath?: string
  newPath: string
  binary: boolean
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

function stripAB(text: string): string | undefined {
  if (text === '/dev/null') return undefined
  return text.replace(/^[ab]\//, '')
}

function parseUnifiedDiff(stdout: string): RawHunk[] {
  const hunks: RawHunk[] = []
  const lines = stdout.split('\n')
  let current: RawHunk | undefined
  let oldPath: string | undefined
  let newPath: string | undefined
  let binary = false
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = undefined
      oldPath = undefined
      newPath = undefined
      binary = false
      continue
    }
    if (line.startsWith('--- ')) {
      oldPath = stripAB(line.slice(4).replace(/\t.*$/, ''))
      continue
    }
    if (line.startsWith('+++ ')) {
      newPath = stripAB(line.slice(4).replace(/\t.*$/, ''))
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      binary = true
      continue
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) {
      current = {
        ...(oldPath !== undefined ? { oldPath } : {}),
        newPath: newPath ?? oldPath ?? '',
        binary,
        header: line,
        oldStart: Number(hunk[1]),
        oldLines: hunk[2] === undefined ? 1 : Number(hunk[2]),
        newStart: Number(hunk[3]),
        newLines: hunk[4] === undefined ? 1 : Number(hunk[4]),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('@@')) continue
    if (line.startsWith('\\ No newline')) continue
    if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: line.slice(1) })
    } else if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', text: line.slice(1) })
    } else if (line.startsWith('-')) {
      current.lines.push({ kind: 'delete', text: line.slice(1) })
    }
    if (current.lines.length >= 20_000) {
      // Renderer budget guard: absurd hunks truncate, they never hang the UI.
      current.lines.push({ kind: 'context', text: '… hunk truncated (line budget)' })
      current = undefined
    }
  }
  return hunks.filter((hunk) => hunk.newPath.length > 0)
}

// ─── Registrar ──────────────────────────────────────────────────────────────

async function headOf(canonicalRoot: string): Promise<{
  headRef?: string
  headSha?: string
  unborn: boolean
}> {
  const symbolic = await runGit(['rev-parse', '--symbolic-full-name', 'HEAD'], {
    cwd: canonicalRoot,
  }).catch(() => ({ stdout: '', exitCode: 128, stderr: '' }))
  const head = await runGit(['rev-parse', 'HEAD'], { cwd: canonicalRoot }).catch(() => ({
    stdout: '',
    exitCode: 128,
    stderr: '',
  }))
  const headSha = head.exitCode === 0 ? head.stdout.trim() : undefined
  if (headSha === undefined) {
    const branch = await runGit(['symbolic-ref', '--short', 'HEAD'], {
      cwd: canonicalRoot,
    }).catch(() => ({ stdout: '', exitCode: 128, stderr: '' }))
    return {
      ...(branch.exitCode === 0 ? { headRef: branch.stdout.trim() } : {}),
      unborn: true,
    }
  }
  const ref = symbolic.exitCode === 0 ? symbolic.stdout.trim() : undefined
  return {
    ...(ref !== undefined && ref.startsWith('refs/heads/')
      ? { headRef: ref.slice('refs/heads/'.length) }
      : {}),
    ...(headSha !== undefined ? { headSha } : {}),
    unborn: false,
  }
}

type PlanEntry = {
  kind: 'discard' | 'restore'
  worktreeId: string
  paths: string[]
  checkpointId?: string
  boundGeneration: number
  boundIndexSha: string
  expiresAt: number
}

export function registerGitRuntime(input: GitRegistrarInput): {
  commands: readonly DevOperation[]
  registeredCommands: number
} {
  const now = input.now ?? Date.now
  const plans = new Map<string, PlanEntry>()

  /** Scope admission, then resolution of a live, ready worktree context at
   *  the pinned generation. */
  function requireWorktreeContext(
    command: DevCommand,
    worktreeId: string,
    generation: number
  ): { canonicalRoot: string; rootIdentity: FileIdentityValue } {
    if (
      command.scope.accountId !== input.scope.accountId ||
      command.scope.workspaceId !== input.scope.workspaceId ||
      command.scope.runtimeNodeId !== input.scope.runtimeNodeId
    )
      throw devError('unauthorized', 'git scope is not authorized on this runtime node')
    const record = input.resolveWorktree(worktreeId)
    if (!record)
      throw devError('not_found', 'no worktree context exists for this operation on this node')
    if (generation !== record.generation)
      throw devError('stale_generation', 'resource generation does not match the worktree record')
    if (record.lifecycle !== 'ready')
      throw devError('invalid_state', 'git operations require a ready worktree')
    return { canonicalRoot: record.canonicalRoot, rootIdentity: record.rootIdentity }
  }

  /** Gate re-check shared by every body-addressed operation: scope, resource
   *  binding, live generation, ready lifecycle. */
  function requireLiveWorktree(command: DevCommand): {
    worktreeId: string
    canonicalRoot: string
    rootIdentity: FileIdentityValue
  } {
    const body = command.body as { worktreeId?: unknown }
    const worktreeId = typeof body.worktreeId === 'string' ? body.worktreeId : ''
    const resource = command.resource
    if (resource === undefined)
      throw devError('identity_mismatch', 'git operations require a worktree resource')
    if (resource.kind !== 'worktree')
      throw devError('identity_mismatch', 'resource kind must be worktree')
    if (resource.id !== worktreeId)
      throw devError('identity_mismatch', 'resource id does not match the request body')
    const context = requireWorktreeContext(command, worktreeId, resource.generation)
    return { worktreeId, ...context }
  }

  /** Pathspec re-proof: every path must pin the live worktree root and obey
   *  the canonical grammar; returns the relative strings for argv use. */
  function pathspecsOf(
    worktreeId: string,
    paths: unknown,
    rootIdentity: FileIdentityValue
  ): string[] {
    if (!Array.isArray(paths) || paths.length === 0)
      throw devError('identity_mismatch', 'paths must be a non-empty WorkspacePath array')
    if (paths.length > PATHSPEC_MAX) throw devError('limit_exceeded', 'too many pathspecs')
    return paths.map((path) => {
      const candidate = path as
        | { worktreeId?: unknown; rootIdentity?: unknown; relativePath?: unknown }
        | undefined
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        typeof candidate.relativePath !== 'string' ||
        candidate.relativePath.length === 0 ||
        candidate.worktreeId !== worktreeId
      )
        throw devError('identity_mismatch', 'pathspec is not bound to this worktree')
      const pinned = candidate.rootIdentity as FileIdentityValue | undefined
      if (!pinMatches(pinned, rootIdentity))
        throw devError('unauthorized_root', 'pathspec root identity does not match this worktree')
      return safeGitPathspec(candidate.relativePath)
    })
  }

  /** Git pathspecs and revisions are argv values, but Git still interprets
   *  pathspec magic and leading-dash revisions. Keep the provider's canonical
   *  relative-path/ref grammar stricter than Git's parser. */
  function safeGitPathspec(value: string): string {
    if (
      value !== '.' &&
      (value.includes('\0') ||
        value.includes('\\') ||
        value.startsWith('/') ||
        value.split('/').some((part) => part.length === 0 || part === '.' || part === '..'))
    )
      throw devError('invalid_state', 'git pathspec must be a normalized worktree-relative path')
    if (value.startsWith(':')) throw devError('invalid_state', 'git pathspec magic is not allowed')
    return value
  }

  function safeGitRef(value: string): string {
    if (
      value.length === 0 ||
      value.length > 512 ||
      value.startsWith('-') ||
      value.startsWith('/') ||
      value.endsWith('/') ||
      value.endsWith('.') ||
      /[\s\0]/.test(value) ||
      value.includes('..') ||
      value.includes('@{') ||
      value.includes('//')
    )
      throw devError('invalid_state', 'git ref is not safe')
    return value
  }

  function safeGitRemote(value: string): string {
    if (
      value.length === 0 ||
      value.length > 256 ||
      value.startsWith('-') ||
      value.startsWith('/') ||
      value.endsWith('/') ||
      /[\s\0]/.test(value) ||
      value.includes('..') ||
      value.includes('@{') ||
      value.includes('//')
    )
      throw devError('invalid_state', 'git remote name is not safe')
    return value
  }

  function safeGitRefspec(value: string): string {
    if (value.length === 0 || value.length > 512 || value.startsWith('-') || /[\s\0]/.test(value))
      throw devError('invalid_state', 'git refspec is not safe')
    return value
  }

  /** Deterministic staged-state fingerprint for compare-and-swap commits:
   *  the sha256 of `git ls-files --stage -z` (locks nothing, represents
   *  conflicts through their stage entries). */
  async function indexShaOf(canonicalRoot: string): Promise<string> {
    const listing = await runGit([...PATHSAFE_CONFIG, 'ls-files', '--stage', '-z'], {
      cwd: canonicalRoot,
    })
    return sha256Text(listing.stdout)
  }

  function statusFromPorcelain(
    worktreeId: string,
    canonicalRoot: string,
    rootIdentity: FileIdentityValue,
    limit: number,
    cursor: unknown
  ): Promise<GitStatus> {
    return (async () => {
      const result = await runGitChecked(
        [...PATHSAFE_CONFIG, 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'],
        { cwd: canonicalRoot, maxOutputBytes: 8 * 1024 * 1024 }
      )
      const { branchLine, records } = parsePorcelainZ(result.stdout)
      const branch = parseBranchLine(branchLine)
      const head = await headOf(canonicalRoot)
      const indexSha = await indexShaOf(canonicalRoot)
      const start = cursor !== undefined ? offsetOf(cursor) : 0
      const entries = records.slice(start, start + limit).map((record) => ({
        path: workspacePath(worktreeId, rootIdentity, record.path),
        staged: record.x === ' ' ? '.' : record.x,
        unstaged: record.y === ' ' ? '.' : record.y,
        untracked: record.x === '?',
      }))
      return {
        worktreeId,
        ...(branch.headRef !== undefined
          ? { headRef: branch.headRef }
          : head.headRef !== undefined
            ? { headRef: head.headRef }
            : {}),
        ...(head.headSha !== undefined ? { headSha: head.headSha } : {}),
        indexSha,
        entries,
        observedAt: new Date(now()).toISOString(),
      } satisfies GitStatus
    })()
  }

  async function diffArgs(
    mode: 'worktree' | 'staged' | 'commit',
    ref: string | undefined
  ): Promise<string[]> {
    if (mode === 'worktree')
      return [...PATHSAFE_CONFIG, 'diff', '--no-color', '--no-ext-diff', '--unified=3']
    if (mode === 'staged')
      return [...PATHSAFE_CONFIG, 'diff', '--cached', '--no-color', '--no-ext-diff', '--unified=3']
    if (ref === undefined || ref.length === 0)
      throw devError('invalid_state', 'commit diff requires a ref')
    return [
      ...PATHSAFE_CONFIG,
      'diff-tree',
      '--no-color',
      '-p',
      '--root',
      '--unified=3',
      safeGitRef(ref),
    ]
  }

  const handlers: Partial<Record<DevOperation, (command: DevCommand) => unknown>> = {
    'dev.git.status': (command) => {
      const body = devOperationDecoders['dev.git.status'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const limit = Math.min(Number(body.limit ?? STATUS_PAGE_MAX), STATUS_PAGE_MAX)
      return statusFromPorcelain(worktreeId, canonicalRoot, rootIdentity, limit, body.cursor)
    },

    'dev.git.history': async (command) => {
      const body = devOperationDecoders['dev.git.history'].request(command.body)
      const { canonicalRoot } = requireLiveWorktree(command)
      const limit = Math.min(Number(body.limit ?? HISTORY_PAGE_MAX), HISTORY_PAGE_MAX)
      const skip = body.cursor !== undefined ? offsetOf(body.cursor) : 0
      // NUL-delimited fields with a record separator between commits: a
      // subject/body can never confuse the field boundaries.
      const format = `${['%H', '%P', '%an', '%aI', '%s', '%b'].join('%x00')}%x1e`
      const args = [
        ...PATHSAFE_CONFIG,
        'log',
        `--max-count=${limit + 1}`,
        `--skip=${skip}`,
        `--format=${format}`,
        ...(body.ref !== undefined ? [safeGitRef(String(body.ref))] : []),
      ]
      const result = await runGit(args, {
        cwd: canonicalRoot,
        maxOutputBytes: 16 * 1024 * 1024,
      })
      if (result.exitCode !== 0)
        throw devError('base_not_found', redactCredentials(result.stderr.trim().slice(0, 512)))
      const records = result.stdout.split(RECORD).filter((record) => record.trim().length > 0)
      const hasMore = records.length > limit
      const commits: GitCommit[] = records.slice(0, limit).map((record) => {
        const fields = record.split(NUL)
        const parents = (fields[1] ?? '').length > 0 ? (fields[1] as string).split(' ') : []
        return {
          sha: (fields[0] as string) ?? '',
          parents,
          authorName: (fields[2] as string) ?? '',
          authoredAt: (fields[3] as string) ?? '',
          subject: (fields[4] as string) ?? '',
          ...((fields[5] ?? '').length > 0 ? { body: fields[5]?.trim() } : {}),
        }
      })
      const nextCursor = hasMore ? cursorOf(skip + limit) : undefined
      const page: DevRuntimePage<GitCommit> = {
        items: commits,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
        observedAt: new Date(now()).toISOString(),
      }
      return page
    },

    'dev.git.diff': async (command) => {
      const body = devOperationDecoders['dev.git.diff'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const limit = Math.min(Number(body.limit ?? DIFF_PAGE_MAX), DIFF_PAGE_MAX)
      const start = body.cursor !== undefined ? offsetOf(body.cursor) : 0
      const args = await diffArgs(
        body.mode as 'worktree' | 'staged' | 'commit',
        body.ref !== undefined ? String(body.ref) : undefined
      )
      if (body.path !== undefined) {
        args.push('--', workspaceRelativeSpec(worktreeId, body.path, rootIdentity))
      }
      const result = await runGit(args, {
        cwd: canonicalRoot,
        maxOutputBytes: DIFF_OUTPUT_BUDGET,
      })
      if (result.exitCode !== 0)
        throw devError('invalid_state', redactCredentials(result.stderr.trim().slice(0, 512)))
      const hunks = parseUnifiedDiff(result.stdout)
      const slice = hunks.slice(start, start + limit).map((hunk): DiffHunk => {
        const path = workspacePath(worktreeId, rootIdentity, hunk.newPath)
        return {
          path,
          ...(hunk.oldPath !== undefined && hunk.oldPath !== hunk.newPath
            ? { oldPath: workspacePath(worktreeId, rootIdentity, hunk.oldPath) }
            : {}),
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
          lines: hunk.lines,
        }
      })
      const nextCursor = start + limit < hunks.length ? cursorOf(start + limit) : undefined
      const page: DevRuntimePage<DiffHunk> = {
        items: slice,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
        observedAt: new Date(now()).toISOString(),
      }
      return page
    },

    'dev.git.stage': async (command) => {
      const body = devOperationDecoders['dev.git.stage'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const specs = pathspecsOf(worktreeId, body.paths, rootIdentity)
      await runGitChecked(['add', '-A', '--', ...specs], { cwd: canonicalRoot })
      return statusFromPorcelain(
        worktreeId,
        canonicalRoot,
        rootIdentity,
        STATUS_PAGE_MAX,
        undefined
      )
    },

    'dev.git.unstage': async (command) => {
      const body = devOperationDecoders['dev.git.unstage'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity } = requireLiveWorktree(command)
      const specs = pathspecsOf(worktreeId, body.paths, rootIdentity)
      const reset = await runGit(['reset', '-q', 'HEAD', '--', ...specs], {
        cwd: canonicalRoot,
      })
      if (reset.exitCode !== 0) {
        // Unborn HEAD: `git reset HEAD` fails; `git rm --cached` unstages.
        const removed = await runGit(['rm', '--cached', '-q', '--', ...specs], {
          cwd: canonicalRoot,
        })
        if (removed.exitCode !== 0)
          throw devError('invalid_state', redactCredentials(reset.stderr.trim().slice(0, 512)))
      }
      return statusFromPorcelain(
        worktreeId,
        canonicalRoot,
        rootIdentity,
        STATUS_PAGE_MAX,
        undefined
      )
    },

    'dev.git.commit': async (command) => {
      const body = devOperationDecoders['dev.git.commit'].request(command.body)
      const { canonicalRoot } = requireLiveWorktree(command)
      const message = String(body.message)
      if (message.length === 0 || message.length > COMMIT_MESSAGE_MAX)
        throw devError('invalid_state', 'commit message must be 1..10000 characters')
      // CAS: the caller pins the staged-state fingerprint they saw.
      const liveIndexSha = await indexShaOf(canonicalRoot)
      if (liveIndexSha !== String(body.expectedIndexSha))
        throw devError(
          'stale_version',
          'the index moved on since the caller observed it; re-status before committing'
        )
      const args = ['commit', '-q', '-m', message]
      if (body.sign === true) args.push('-S')
      const committed = await runGit(args, { cwd: canonicalRoot })
      if (committed.exitCode !== 0)
        throw devError('invalid_state', redactCredentials(committed.stderr.trim().slice(0, 512)))
      const log = await runGit(['log', '-1', '--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%b'], {
        cwd: canonicalRoot,
      })
      const fields = log.stdout.replace(/\n$/, '').split(NUL)
      if (fields.length < 5) throw devError('corrupt_state', 'commit output did not parse')
      return {
        sha: fields[0] as string,
        parents: (fields[1] ?? '').length > 0 ? (fields[1] as string).split(' ') : [],
        authorName: (fields[2] as string) ?? '',
        authoredAt: (fields[3] as string) ?? '',
        subject: (fields[4] as string) ?? '',
      } satisfies GitCommit
    },

    'dev.git.fetch': async (command) => {
      const body = devOperationDecoders['dev.git.fetch'].request(command.body)
      const { canonicalRoot } = requireLiveWorktree(command)
      const remoteName = safeGitRemote(String(body.remoteName))
      const refsBefore = await remoteRefShas(canonicalRoot, remoteName)
      const args = ['fetch', ...(body.prune === true ? ['--prune'] : []), remoteName]
      if (Array.isArray(body.refspecs) && body.refspecs.length > 0)
        args.push(...(body.refspecs as string[]).slice(0, 64).map(safeGitRefspec))
      const fetched = await runGit(args, {
        cwd: canonicalRoot,
        timeoutMs: GIT_CHILD_TIMEOUT_MS,
        maxOutputBytes: 1024 * 1024,
      })
      if (fetched.exitCode !== 0)
        throw devError('remote_unavailable', redactCredentials(fetched.stderr.trim().slice(0, 512)))
      const refsAfter = await remoteRefShas(canonicalRoot, remoteName)
      return {
        remoteName,
        before: refsBefore,
        after: refsAfter,
        observedAt: new Date(now()).toISOString(),
      } satisfies GitFetchResult
    },

    'dev.git.checkpoint': async (command) => {
      const body = devOperationDecoders['dev.git.checkpoint'].request(command.body)
      const { worktreeId, canonicalRoot } = requireLiveWorktree(command)
      const checkpointId = randomUUID()
      const ref = `${CHECKPOINT_REF_PREFIX}${worktreeId}/${checkpointId}`
      const treeSha = await writeSnapshotTree(canonicalRoot)
      const head = await headOf(canonicalRoot)
      // commit-tree always creates the commit; a root commit simply has no -p.
      const parents = head.headSha !== undefined ? ['-p', head.headSha] : []
      const commitArgs = [
        'commit-tree',
        treeSha,
        ...parents,
        '-m',
        `adea checkpoint ${checkpointId}`,
      ]
      const committed = await runGitEnv(commitArgs, {
        cwd: canonicalRoot,
        env: checkpointIdentityEnv(),
      })
      if (committed.exitCode !== 0)
        throw devError('invalid_state', redactCredentials(committed.stderr.trim().slice(0, 512)))
      const commitSha = committed.stdout.trim()
      const updated = await runGitEnv(['update-ref', ref, commitSha], { cwd: canonicalRoot })
      if (updated.exitCode !== 0)
        throw devError('invalid_state', redactCredentials(updated.stderr.trim().slice(0, 512)))
      return {
        id: checkpointId,
        worktreeId,
        ...(head.headSha !== undefined ? { baseSha: head.headSha } : {}),
        treeSha,
        createdAt: new Date(now()).toISOString(),
        ...(body.label !== undefined && String(body.label).length > 0
          ? { label: String(body.label).slice(0, 128) }
          : {}),
      } satisfies GitCheckpoint
    },

    'dev.git.discardPlan': async (command) => {
      const body = devOperationDecoders['dev.git.discardPlan'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity, ...gate } =
        requireLiveWorktreeExtended(command)
      const specs = pathspecsOf(worktreeId, body.paths, rootIdentity)
      const blockers: Array<{ code: DevError['code']; message: string }> = []
      const tracked = await trackedPaths(canonicalRoot, specs)
      for (const spec of specs) {
        if (!tracked.has(spec))
          blockers.push({
            code: 'invalid_state',
            message: `${spec} is untracked; discarding untracked files is not part of this plan`,
          })
      }
      const head = await headOf(canonicalRoot)
      const indexSha = await indexShaOf(canonicalRoot)
      const planId = randomUUID()
      const digest = sha256Text(
        JSON.stringify({
          kind: 'discard',
          worktreeId,
          generation: gate.generation,
          indexSha,
          headSha: head.headSha ?? null,
          paths: [...specs].toSorted(),
        })
      )
      plans.set(planId, {
        kind: 'discard',
        worktreeId,
        paths: specs,
        boundGeneration: gate.generation,
        boundIndexSha: indexSha,
        expiresAt: now() + PLAN_TTL_MS,
      })
      return {
        id: planId,
        operation: 'dev.git.discardCommit' as DevOperation,
        scope: input.scope,
        resource: { kind: 'worktree', id: worktreeId, generation: gate.generation },
        factVersions: {
          indexSha,
          ...(head.headSha !== undefined ? { headSha: head.headSha } : {}),
        },
        steps: [{ id: 'discard', kind: 'git_discard', targetId: worktreeId, dependsOn: [] }],
        blockers,
        requiredApprovalIds: [],
        digest,
        expiresAt: new Date(now() + PLAN_TTL_MS).toISOString(),
      } satisfies MutationPlan
    },

    'dev.git.discardCommit': async (command) => {
      const body = devOperationDecoders['dev.git.discardCommit'].request(command.body)
      // Paired commit: the body names the plan, so the envelope resource is
      // validated against the plan's bound target before anything runs.
      const entry = livePlan(plans, String(body.planId), 'dev.git.discardCommit')
      const resource = command.resource
      if (
        resource === undefined ||
        resource.kind !== 'worktree' ||
        resource.id !== entry.worktreeId
      )
        throw devError('identity_mismatch', 'the plan is bound to another worktree resource')
      const { canonicalRoot, rootIdentity } = requireWorktreeContext(
        command,
        entry.worktreeId,
        resource.generation
      )
      const worktreeId = entry.worktreeId
      if (entry.boundGeneration !== resource.generation)
        throw devError('stale_generation', 'the plan is bound to another worktree generation')
      const liveIndexSha = await indexShaOf(canonicalRoot)
      if (liveIndexSha !== entry.boundIndexSha)
        throw devError('stale_version', 'the index moved on since the discard plan was made')
      const restored = await runGit(
        ['restore', '-q', '--source=HEAD', '--worktree', '--staged', '--', ...entry.paths],
        { cwd: canonicalRoot }
      )
      if (restored.exitCode !== 0)
        throw devError('invalid_state', redactCredentials(restored.stderr.trim().slice(0, 512)))
      plans.delete(String(body.planId))
      return statusFromPorcelain(
        worktreeId,
        canonicalRoot,
        rootIdentity,
        STATUS_PAGE_MAX,
        undefined
      )
    },

    'dev.git.restorePlan': async (command) => {
      const body = devOperationDecoders['dev.git.restorePlan'].request(command.body)
      const { worktreeId, canonicalRoot, rootIdentity, ...gate } =
        requireLiveWorktreeExtended(command)
      const checkpointId = String(body.checkpointId)
      const ref = checkpointRef(worktreeId, checkpointId)
      const resolved = await runGit(['rev-parse', '--verify', '-q', `${ref}^{commit}`], {
        cwd: canonicalRoot,
      })
      if (resolved.exitCode !== 0)
        throw devError('checkpoint_corrupt', 'checkpoint ref is unknown to this worktree')
      const specs =
        body.paths !== undefined && Array.isArray(body.paths)
          ? pathspecsOf(worktreeId, body.paths, rootIdentity)
          : undefined
      const head = await headOf(canonicalRoot)
      const indexSha = await indexShaOf(canonicalRoot)
      const planId = randomUUID()
      const digest = sha256Text(
        JSON.stringify({
          kind: 'restore',
          worktreeId,
          generation: gate.generation,
          indexSha,
          headSha: head.headSha ?? null,
          checkpointId,
          paths: specs ? [...specs].toSorted() : null,
        })
      )
      plans.set(planId, {
        kind: 'restore',
        worktreeId,
        paths: specs ?? [],
        checkpointId,
        boundGeneration: gate.generation,
        boundIndexSha: indexSha,
        expiresAt: now() + PLAN_TTL_MS,
      })
      return {
        id: planId,
        operation: 'dev.git.restoreCommit' as DevOperation,
        scope: input.scope,
        resource: { kind: 'worktree', id: worktreeId, generation: gate.generation },
        factVersions: {
          indexSha,
          checkpointId,
          checkpointSha: resolved.stdout.trim(),
          ...(head.headSha !== undefined ? { headSha: head.headSha } : {}),
        },
        steps: [{ id: 'restore', kind: 'git_restore', targetId: worktreeId, dependsOn: [] }],
        blockers: [],
        requiredApprovalIds: [],
        digest,
        expiresAt: new Date(now() + PLAN_TTL_MS).toISOString(),
      } satisfies MutationPlan
    },

    'dev.git.restoreCommit': async (command) => {
      const body = devOperationDecoders['dev.git.restoreCommit'].request(command.body)
      // Paired commit: the body names the plan, so the envelope resource is
      // validated against the plan's bound target before anything runs.
      const entry = livePlan(plans, String(body.planId), 'dev.git.restoreCommit')
      if (entry.kind !== 'restore' || entry.checkpointId === undefined)
        throw devError('plan_stale', 'the plan is not a checkpoint restore')
      const resource = command.resource
      if (
        resource === undefined ||
        resource.kind !== 'worktree' ||
        resource.id !== entry.worktreeId
      )
        throw devError('identity_mismatch', 'the plan is bound to another worktree resource')
      const { canonicalRoot, rootIdentity } = requireWorktreeContext(
        command,
        entry.worktreeId,
        resource.generation
      )
      const worktreeId = entry.worktreeId
      if (entry.boundGeneration !== resource.generation)
        throw devError('stale_generation', 'the plan is bound to another worktree generation')
      const liveIndexSha = await indexShaOf(canonicalRoot)
      if (liveIndexSha !== entry.boundIndexSha)
        throw devError('stale_version', 'the index moved on since the restore plan was made')
      const ref = checkpointRef(worktreeId, entry.checkpointId)
      const args = [
        'restore',
        '-q',
        `--source=${ref}`,
        '--worktree',
        '--staged',
        '--',
        ...(entry.paths.length > 0 ? entry.paths : [':/']),
      ]
      const restored = await runGit(args, { cwd: canonicalRoot })
      if (restored.exitCode !== 0)
        throw devError('invalid_state', redactCredentials(restored.stderr.trim().slice(0, 512)))
      plans.delete(String(body.planId))
      return statusFromPorcelain(
        worktreeId,
        canonicalRoot,
        rootIdentity,
        STATUS_PAGE_MAX,
        undefined
      )
    },
  }

  function checkpointRef(worktreeId: string, checkpointId: string): string {
    if (!/^[0-9a-fA-F-]{8,64}$/.test(checkpointId))
      throw devError('checkpoint_corrupt', 'checkpoint id is malformed')
    return `${CHECKPOINT_REF_PREFIX}${worktreeId}/${checkpointId}`
  }

  function livePlan(
    store: Map<string, PlanEntry>,
    planId: string,
    operation: 'dev.git.discardCommit' | 'dev.git.restoreCommit'
  ): PlanEntry {
    const entry = store.get(planId)
    if (!entry || entry.expiresAt <= now())
      throw devError('plan_stale', 'the plan is unknown, expired, or already consumed')
    if (
      (operation === 'dev.git.discardCommit' && entry.kind !== 'discard') ||
      (operation === 'dev.git.restoreCommit' && entry.kind !== 'restore')
    )
      throw devError('plan_stale', 'the plan does not match this operation')
    return entry
  }

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

  /** Snapshot the worktree state through a temporary index: read-tree the
   *  current HEAD into a throwaway index file, `add -A` the worktree, then
   *  `write-tree`. The real index and the branch are never touched. */
  async function writeSnapshotTree(canonicalRoot: string): Promise<string> {
    const tempIndexDir = mkdtempSync(join(realpathSync(tmpdir()), 'adea-git-index-'))
    const tempIndex = join(tempIndexDir, 'index')
    try {
      const head = await headOf(canonicalRoot)
      if (head.headSha !== undefined) {
        const read = await runGitEnv(['read-tree', 'HEAD'], {
          cwd: canonicalRoot,
          env: { GIT_INDEX_FILE: tempIndex },
        })
        if (read.exitCode !== 0)
          throw devError('invalid_state', redactCredentials(read.stderr.trim().slice(0, 512)))
      }
      const add = await runGitEnv(['add', '-A', '--', '.'], {
        cwd: canonicalRoot,
        env: { GIT_INDEX_FILE: tempIndex },
        maxOutputBytes: 1024 * 1024,
      })
      if (add.exitCode !== 0)
        throw devError('invalid_state', redactCredentials(add.stderr.trim().slice(0, 512)))
      const write = await runGitEnv(['write-tree'], {
        cwd: canonicalRoot,
        env: { GIT_INDEX_FILE: tempIndex },
      })
      if (write.exitCode !== 0)
        throw devError('invalid_state', redactCredentials(write.stderr.trim().slice(0, 512)))
      return write.stdout.trim()
    } finally {
      rmSync(tempIndexDir, { recursive: true, force: true })
    }
  }

  async function remoteRefShas(
    canonicalRoot: string,
    remoteName: string
  ): Promise<Record<string, string>> {
    const refs = await runGit(
      [
        ...PATHSAFE_CONFIG,
        'for-each-ref',
        '--format=%(refname)%00%(objectname)',
        `refs/remotes/${remoteName}`,
      ],
      { cwd: canonicalRoot }
    )
    const map: Record<string, string> = {}
    for (const line of refs.stdout.split('\n')) {
      if (line.trim().length === 0) continue
      const [name, sha] = line.split(NUL)
      if (name !== undefined && sha !== undefined) map[name] = sha
    }
    return map
  }

  async function trackedPaths(
    canonicalRoot: string,
    specs: readonly string[]
  ): Promise<Set<string>> {
    const listing = await runGit([...PATHSAFE_CONFIG, 'ls-files', '-z', '--', ...specs], {
      cwd: canonicalRoot,
    })
    return new Set(listing.stdout.split(NUL).filter((entry) => entry.length > 0))
  }

  let registeredCommands = 0
  for (const [operation, handler] of Object.entries(handlers)) {
    if (!handler) continue
    input.authority.registerCommandProvider(operation as DevOperation, async (command) => {
      try {
        return await handler(command)
      } catch (error) {
        throw mapGitError(error)
      }
    })
    registeredCommands += 1
  }
  return { commands: Object.keys(handlers) as DevOperation[], registeredCommands }
}

function workspacePath(
  worktreeId: string,
  rootIdentity: FileIdentityValue,
  relativePath: string
): { worktreeId: string; rootIdentity: FileIdentityValue; relativePath: string } {
  return { worktreeId, rootIdentity: { ...rootIdentity }, relativePath }
}

function pinMatches(pinned: unknown, rootIdentity: FileIdentityValue): boolean {
  const candidate = pinned as FileIdentityValue | undefined
  return (
    !!candidate &&
    typeof candidate === 'object' &&
    candidate.device === rootIdentity.device &&
    candidate.inode === rootIdentity.inode &&
    candidate.mtimeNs === rootIdentity.mtimeNs &&
    candidate.size === rootIdentity.size
  )
}

function workspaceRelativeSpec(
  worktreeId: string,
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
    candidate.relativePath.length === 0 ||
    candidate.worktreeId !== worktreeId ||
    !pinMatches(candidate.rootIdentity, rootIdentity)
  )
    throw devError('identity_mismatch', 'diff path is not bound to this worktree')
  if (candidate.relativePath.startsWith(':'))
    throw devError('invalid_state', 'git pathspec magic is not allowed')
  if (
    candidate.relativePath !== '.' &&
    (candidate.relativePath.includes('\0') ||
      candidate.relativePath.includes('\\') ||
      candidate.relativePath.startsWith('/') ||
      candidate.relativePath
        .split('/')
        .some((part) => part.length === 0 || part === '.' || part === '..'))
  )
    throw devError('invalid_state', 'git pathspec must be a normalized worktree-relative path')
  return candidate.relativePath
}

function checkpointIdentityEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: 'adea-checkpoint',
    GIT_AUTHOR_EMAIL: 'checkpoint@adea.local',
    GIT_COMMITTER_NAME: 'adea-checkpoint',
    GIT_COMMITTER_EMAIL: 'checkpoint@adea.local',
  }
}

function mapGitError(error: unknown): unknown {
  const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown }
  if (
    candidate &&
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    (candidate.retryable === undefined || typeof candidate.retryable === 'boolean')
  ) {
    if (candidate.retryable === undefined)
      return devError(candidate.code as DevError['code'], redactCredentials(candidate.message))
    return {
      ...candidate,
      message: redactCredentials(candidate.message),
    }
  }
  return error instanceof Error
    ? devError('invalid_state', redactCredentials(error.message))
    : devError('invalid_state', 'git operation failed')
}
