// Production GitHub remote source-control registrar for the #423 slice.
//
// Layered on the #399 local-git lane: push, pull-request creation/management,
// CI checks, and update-branch. Every operation is scope-bound through the M10
// channel gate, and every `repository`/`pull_request` resource binding is
// re-proven against the worktree service's records before anything runs —
// pushes execute only from canonical worktree roots whose live record still
// binds the same repository at the planned generation.
//
// Credentials are never stored, passed, or logged by this slice: GitHub auth
// comes from the user's existing `gh` CLI context (its per-host credential
// configuration), reached through a fixed-argv, bounded runner with a minimal
// environment. Token values can therefore enter neither argv, env, logs, nor
// errors — every error surface is credential-redacted, and `gh` JSON is
// treated as untrusted input decoded through strict shape guards.
//
// Reads cache by repository/PR with a short TTL, refresh visible rows on
// demand, and degrade to the last known read model (marked stale) only on
// rate limits and network loss. All mutations (push, PR create/update/merge,
// update branch) re-read server truth before reporting success, and the
// destructive ones are plan/commit pairs like the local lane's discard/
// restore: a reviewed plan binds exact facts (SHAs, generations, digests),
// and the paired commit re-proves every fact at execution time. There is no
// raw `--force` in this universe: the only force path is the explicit
// `--force-with-lease=<ref>:<expectedSha>` flow, which refuses protected and
// default branches outright.
import { createHash, randomUUID } from 'node:crypto'

import type {
  DevCommand,
  DevError,
  DevOperation,
  DevRuntimePage,
  GitHubAccount,
  GitHubAheadBehind,
  GitHubCheck,
  GitHubIssue,
  GitHubMilestone,
  GitHubPullRequest,
  GitHubRepository,
  GitPushResult,
  GitUpdateBranchResult,
  MutationPlan,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import type { ChannelAuthority } from '../channel/authority'
import { GIT_CHILD_TIMEOUT_MS, gitChildEnv, runGit } from '../worktrees/git-run'
import type { FileIdentityValue } from '../worktrees/identity'

const PLAN_TTL_MS = 10 * 60_000
const CACHE_TTL_MS = 30_000
const PAGE_MAX = 100
const GH_READ_BUDGET = 2 * 1024 * 1024
const TITLE_MAX = 256
const BODY_MAX = 65_536
const DEFAULT_HOST = 'github.com'
const GH_EXIT_AUTH = 4
const NUL = '\u0000'

export function devError(code: DevError['code'], message: string, retryable = false): DevError {
  return { code, retryable, message }
}

/** Remote URLs and any embedded user-info are redacted before an error
 *  message, log, or DTO ever sees them (shared convention with the git lane). */
export function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, '$1<redacted>@')
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function iso(at: number): string {
  return new Date(at).toISOString()
}

// ─── gh transport ───────────────────────────────────────────────────────────

export type GhRunResult = Readonly<{
  stdout: string
  stderr: string
  exitCode: number
  /** Spawn-level failure (gh binary absent) — typed before any command runs. */
  spawnCode?: 'capability_unavailable'
}>

export type GhRunner = (
  args: readonly string[],
  options?: { timeoutMs?: number; maxOutputBytes?: number }
) => Promise<GhRunResult>

/** Default bounded, argv-only gh runner. The environment is the worktree
 *  service's minimal git child env plus `GH_PROMPT_DISABLED`: gh resolves its
 *  credentials from its own host-scoped configuration under HOME, so token
 *  values never pass through this process's argv or env. stdin is ignored, so
 *  an interactive gh prompt fails typed instead of hanging the pipeline. */
export const defaultRunGh: GhRunner = async (args, options) => {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn(['gh', ...args], {
      env: { ...gitChildEnv(), GH_PROMPT_DISABLED: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      stdout: '',
      stderr: /ENOENT|not found/i.test(message)
        ? 'the gh CLI is not installed on this machine'
        : message,
      exitCode: 127,
      spawnCode: 'capability_unavailable',
    }
  }
  const timeoutMs = options?.timeoutMs ?? GIT_CHILD_TIMEOUT_MS
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // Already exited.
    }
  }, timeoutMs)
  timer.unref?.()
  const read = async (stream: ReadableStream<Uint8Array>, what: string): Promise<string> => {
    const decoder = new TextDecoder('utf-8', { fatal: false })
    let total = 0
    let text = ''
    for await (const chunk of stream) {
      total += chunk.byteLength
      if (total > (options?.maxOutputBytes ?? GH_READ_BUDGET)) {
        try {
          proc.kill()
        } catch {
          // Already exiting.
        }
        throw devError('limit_exceeded', `gh ${String(args[0])} ${what} exceeded its output budget`)
      }
      text += decoder.decode(chunk, { stream: true })
    }
    return text + decoder.decode()
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    read(proc.stdout, 'stdout'),
    read(proc.stderr, 'stderr'),
    proc.exited,
  ])
  clearTimeout(timer)
  return { stdout, stderr, exitCode }
}

// ─── Untrusted gh JSON decoding ─────────────────────────────────────────────
//
// gh output is untrusted input: every field is re-proven through narrow
// guards, and unknown extra keys are ignored (GitHub adds fields freely).

class UntrustedError extends Error {}

function untrusted(path: string, expected: string): never {
  throw new UntrustedError(`${path}: expected ${expected}`)
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) untrusted(path, 'object')
  return value as Record<string, unknown>
}

function arr(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) untrusted(path, 'array')
  return value
}

function str(value: unknown, path: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max) untrusted(path, `string<=${max}`)
  return value
}

function optStr(value: unknown, path: string, max = 4096): string | undefined {
  if (value === undefined || value === null) return undefined
  return str(value, path, max)
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    untrusted(path, 'non-negative integer')
  return value
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') untrusted(path, 'boolean')
  return value
}

function literal<T extends string>(value: unknown, choices: readonly T[], path: string): T {
  if (typeof value !== 'string') untrusted(path, 'string')
  const found = choices.find((choice) => choice === value)
  if (found === undefined) untrusted(path, `one of ${choices.join('|')}`)
  return found
}

function gitSha(value: unknown, path: string): string {
  const text = str(value, path, 64)
  if (!/^[0-9a-f]{40}$/.test(text)) untrusted(path, 'git sha')
  return text
}

function isoTimestamp(value: unknown, path: string): string | undefined {
  const text = optStr(value, path, 64)
  if (text === undefined) return undefined
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) untrusted(path, 'timestamp')
  return new Date(parsed).toISOString()
}

function requiredIsoTimestamp(value: unknown, path: string): string {
  const parsed = isoTimestamp(value, path)
  if (parsed === undefined) untrusted(path, 'timestamp')
  return parsed
}

// ─── Remote URL parsing ─────────────────────────────────────────────────────

export type ParsedRemote = Readonly<{
  host: string
  owner: string
  repo: string
}>

/** Parse a git remote URL into a GitHub host/owner/repo triple. Accepts
 *  https, ssh, and scp-like syntaxes; rejects anything with whitespace,
 *  control characters, dot segments, or absurd lengths. Hosts outside the
 *  explicit trust list are refused, so github.com credentials (handled by gh
 *  per host) are never sent elsewhere. */
export function parseGitHubRemote(rawUrl: string, trustedHosts: readonly string[]): ParsedRemote {
  const url = rawUrl.trim()
  if (url.length === 0 || url.length > 2048)
    throw devError('invalid_state', 'remote URL is malformed')
  if (/[\s\u0000-\u001f]/.test(url))
    throw devError('invalid_state', 'remote URL contains whitespace or control characters')
  let host: string | undefined
  let path: string | undefined
  const https = url.match(/^https?:\/\/(?:[^/@]+@)?([^/?#]+)\/([^?#]*?)(?:\.git)?\/?$/i)
  const ssh = url.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)[/:]\/?(.+?)(?:\.git)?\/?$/i)
  const scp = url.match(/^[^@/]+@([^:]+):(.+?)(?:\.git)?$/)
  if (https) {
    host = (https[1] ?? '').toLowerCase()
    path = https[2]
  } else if (ssh) {
    host = (ssh[1] ?? '').toLowerCase()
    path = ssh[2]
  } else if (scp) {
    host = (scp[1] ?? '').toLowerCase()
    path = scp[2]
  }
  if (!host || !path)
    throw devError('unsupported_capability', 'remote is not a recognized GitHub URL')
  const segments = path.split('/').filter((segment) => segment.length > 0)
  if (segments.length !== 2 || segments.some((segment) => segment === '.' || segment === '..'))
    throw devError('invalid_state', 'remote path is not an owner/repository pair')
  const [owner, repo] = segments as [string, string]
  if (!/^[A-Za-z0-9-]{1,100}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo))
    throw devError('invalid_state', 'remote owner/repository is malformed')
  if (!trustedHosts.includes(host))
    throw devError(
      'remote_host_untrusted',
      `host ${host} is not trusted for GitHub operations; trust it explicitly before use`
    )
  return { host, owner, repo }
}

// ─── Registrar ──────────────────────────────────────────────────────────────

export type GithubRepoContext = Readonly<{
  repoId: string
  canonicalRoot: string
  remote?: string
  defaultBranch?: string
}>

export type GithubWorktreeContext = Readonly<{
  canonicalRoot: string
  rootIdentity: FileIdentityValue
  generation: number
  lifecycle: string
  repoId: string
}>

export type GithubRegistrarInput = {
  authority: ChannelAuthority
  scope: Scope
  /** Fail-closed resolution of the registered repository record. */
  resolveRepo(repoId: string): GithubRepoContext | undefined
  /** Registered repository records, for binding a remote PR to a local repo. */
  listRepos(): readonly GithubRepoContext[]
  /** Fail-closed resolution of the live worktree record (with its repoId). */
  resolveWorktree(worktreeId: string): GithubWorktreeContext | undefined
  /** Test seam: inject a scripted gh transport (no network in tests). */
  runGh?: GhRunner
  now?: () => number
  cacheTtlMs?: number
  /** Hosts trusted for GitHub operations; github.com is always implied. */
  trustedHosts?: readonly string[]
  /** Extra refs the force-with-lease flow must always refuse. */
  protectedRefs?: readonly string[]
}

type PlanEntry =
  | {
      kind: 'push'
      kindOfPush: 'normal' | 'force'
      repoId: string
      worktreeId: string
      generation: number
      ref: string
      localSha: string
      remoteSha?: string
      host: string
      owner: string
      repo: string
      expiresAt: number
      digest: string
    }
  | {
      kind: 'pr-update'
      pullRequestId: string
      expectedUpdatedAt: string
      patch: Record<string, unknown>
      expiresAt: number
      digest: string
    }
  | {
      kind: 'pr-merge'
      pullRequestId: string
      headSha: string
      method: 'merge' | 'squash' | 'rebase'
      expiresAt: number
      digest: string
    }
  | {
      kind: 'update-branch'
      pullRequestId: string
      worktreeId: string
      generation: number
      strategy: 'merge'
      headSha: string
      baseSha: string
      expiresAt: number
      digest: string
    }

type CacheEntry = Readonly<{ value: unknown; observedAt: number }>

const PR_ID_PATTERN = /^gh:([A-Za-z0-9-]{1,100})\/([A-Za-z0-9._-]{1,100})#(\d{1,9})$/
const SHA_PATTERN = /^[0-9a-f]{40}$/
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/

function pullRequestIdOf(owner: string, repo: string, number: number): string {
  return `gh:${owner}/${repo}#${number}`
}

export function registerGithubRuntime(input: GithubRegistrarInput): {
  commands: readonly DevOperation[]
  registeredCommands: number
} {
  const now = input.now ?? Date.now
  const runGh = input.runGh ?? defaultRunGh
  const cacheTtlMs = input.cacheTtlMs ?? CACHE_TTL_MS
  const trustedHosts = [...new Set([...(input.trustedHosts ?? []), DEFAULT_HOST])]
  const protectedRefs = input.protectedRefs ?? []
  const plans = new Map<string, PlanEntry>()
  const cache = new Map<string, CacheEntry>()
  /** Local optimistic-concurrency tokens for PR read models: the version
   *  bumps only when the server-side updatedAt moved. */
  const prVersions = new Map<string, { updatedAt: string; version: number }>()

  function requireScope(command: DevCommand): void {
    if (
      command.scope.accountId !== input.scope.accountId ||
      command.scope.workspaceId !== input.scope.workspaceId ||
      command.scope.runtimeNodeId !== input.scope.runtimeNodeId
    )
      throw devError('unauthorized', 'github scope is not authorized on this runtime node')
  }

  function resourceOf(command: DevCommand, kind: string, bodyId: unknown): string {
    const resource = command.resource
    if (resource === undefined)
      throw devError('identity_mismatch', `this operation requires a ${kind} resource`)
    if (resource.kind !== kind) throw devError('identity_mismatch', `resource kind must be ${kind}`)
    if (typeof bodyId === 'string' && bodyId.length > 0 && resource.id !== bodyId)
      throw devError('identity_mismatch', 'resource id does not match the request body')
    return resource.id
  }

  /** Classify a gh failure as a typed DevError; the message is credential-
   *  redacted and bounded, and never echoes raw transport text unredacted. */
  function classifyGh(result: GhRunResult, operation: string): DevError {
    const stderr = redactCredentials(result.stderr.trim().slice(0, 512))
    if (result.spawnCode === 'capability_unavailable')
      return devError(
        'capability_unavailable',
        'the gh CLI is not available; install and authenticate it to use GitHub operations',
        true
      )
    if (result.exitCode === GH_EXIT_AUTH || /gh auth|authentication required/i.test(stderr))
      return devError('unauthenticated', `gh is not authenticated for this operation: ${stderr}`)
    if (/rate limit/i.test(stderr)) return devError('rate_limited', `GitHub rate limit was hit: ${stderr}`, true)
    if (/HTTP 404|not found/i.test(stderr))
      return devError('not_found', `${operation} target was not found on the remote: ${stderr}`)
    if (/HTTP 403|resource not accessible/i.test(stderr))
      return devError('unauthorized', `GitHub refused the operation: ${stderr}`)
    if (/HTTP 422|already_exists|validation/i.test(stderr))
      return devError('invalid_state', `GitHub rejected the request: ${stderr}`)
    if (/could not resolve|dial tcp|connection refused|context deadline|network/i.test(stderr))
      return devError('remote_unavailable', `GitHub was unreachable: ${stderr}`, true)
    return devError(
      'invalid_state',
      `${operation} failed: ${stderr || `gh exited ${result.exitCode}`}`
    )
  }

  type GhJsonOptions = Readonly<{
    cacheKey?: string
    /** Serve a fresh cached payload instead of running gh (read models). */
    allowCached?: boolean
    /** Serve the last cached payload when the read fails with a staleable
     *  error (rate limit / network loss) — staleness is reported in the DTO. */
    staleFallback?: boolean
  }>

  async function ghJson(args: readonly string[], options: GhJsonOptions = {}): Promise<unknown> {
    const { cacheKey, allowCached = false, staleFallback = true } = options
    if (allowCached && cacheKey !== undefined) {
      const entry = cache.get(cacheKey)
      if (entry && now() - entry.observedAt < cacheTtlMs) return entry.value
    }
    let result: GhRunResult
    try {
      result = await runGh(args)
    } catch (error) {
      const stale = staleFallback && cacheKey !== undefined ? cache.get(cacheKey)?.value : undefined
      if (stale !== undefined) return stale
      throw error
    }
    if (result.exitCode !== 0) {
      const failure = classifyGh(result, 'github read')
      const stale = staleFallback && cacheKey !== undefined ? cache.get(cacheKey)?.value : undefined
      if (stale !== undefined && STALEABLE_CODES.has(failure.code)) return stale
      throw failure
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      throw devError('corrupt_state', 'gh returned output that is not valid JSON')
    }
    if (cacheKey !== undefined) cache.set(cacheKey, { value: parsed, observedAt: now() })
    return parsed
  }

  const STALEABLE_CODES: ReadonlySet<DevError['code']> = new Set([
    'rate_limited',
    'remote_unavailable',
    'unavailable',
    'timeout',
  ])

  /** gh api argument builder: explicit --hostname keeps credentials scoped to
   *  their host; never a token, never shell text. */
  function apiArgs(host: string, path: string, extra: readonly string[] = []): string[] {
    return ['api', path, '--hostname', host, ...extra]
  }

  // ── Repository context ────────────────────────────────────────────────────

  async function remoteOf(canonicalRoot: string, remoteName: string): Promise<ParsedRemote> {
    // The configured URL (not `remote get-url`, which applies insteadOf
    // rewrites) is what names the host; git transport still honors any local
    // rewrite, while host trust and owner/repo parsing see the real origin.
    const result = await runGit(['config', '--get', `remote.${remoteName}.url`], {
      cwd: canonicalRoot,
    }).catch(() => ({ stdout: '', stderr: 'no such remote', exitCode: 128 }))
    if (result.exitCode !== 0)
      throw devError('invalid_state', `the repository has no ${remoteName} remote configured`)
    return parseGitHubRemote(result.stdout.trim(), trustedHosts)
  }

  function repoContext(command: DevCommand): { repoId: string; record: GithubRepoContext } {
    requireScope(command)
    const body = command.body as { repoId?: unknown }
    const repoId = resourceOf(command, 'repository', body.repoId)
    const record = input.resolveRepo(repoId)
    if (record === undefined)
      throw devError('not_found', 'repository is not registered on this runtime node')
    return { repoId, record }
  }

  function prIdParts(pullRequestId: string): {
    owner: string
    repo: string
    number: number
  } {
    const match = pullRequestId.match(PR_ID_PATTERN)
    if (!match) throw devError('identity_mismatch', 'pull request id is malformed')
    return { owner: match[1] as string, repo: match[2] as string, number: Number(match[3]) }
  }

  /** Bind a remote PR back to the local repository registry when one of the
   *  registered repositories carries a remote that parses to the same
   *  host/owner/repo; otherwise a stable remote-derived id keeps the DTO
   *  decodable and honest about being unbound to a local registration. */
  function repoIdForRemote(parts: { owner: string; repo: string }): string {
    for (const record of input.listRepos()) {
      const rawUrl = record.remote
      if (rawUrl === undefined) continue
      try {
        const parsed = parseGitHubRemote(rawUrl, trustedHosts)
        if (parsed.owner === parts.owner && parsed.repo === parts.repo) return record.repoId
      } catch {
        continue
      }
    }
    return `remote:${parts.owner}/${parts.repo}`
  }

  // ── gh DTO mapping (untrusted → typed) ───────────────────────────────────

  function mapAccount(payload: unknown, host: string): GitHubAccount {
    const item = obj(payload, 'account')
    const login = str(item.login, 'account.login', 100)
    const name = optStr(item.name, 'account.name', 256)
    const profileUrl = optStr(item.html_url, 'account.html_url', 512)
    return {
      provider: 'github',
      host,
      login,
      ...(name !== undefined ? { name } : {}),
      ...(profileUrl !== undefined ? { profileUrl } : {}),
      observedAt: iso(now()),
    }
  }

  function mapRepository(
    payload: unknown,
    repoId: string,
    parsed: ParsedRemote,
    stale: boolean
  ): GitHubRepository {
    const item = obj(payload, 'repository')
    const owner = str(obj(item.owner, 'repository.owner').login, 'repository.owner.login', 100)
    const name = str(item.name, 'repository.name', 100)
    const visibility =
      item.visibility !== undefined && item.visibility !== null
        ? literal(String(item.visibility).replace('in', ''), ['public', 'private'], 'repository.visibility')
        : bool(item.private, 'repository.private')
          ? 'private'
          : 'public'
    return {
      repoId,
      provider: 'github',
      host: parsed.host,
      owner,
      name,
      fullName: `${owner}/${name}`,
      defaultBranch: str(item.default_branch, 'repository.default_branch', 256),
      url: str(item.html_url, 'repository.html_url', 512),
      visibility,
      fork: item.fork === undefined ? false : bool(item.fork, 'repository.fork'),
      freshness: stale ? 'stale' : 'fresh',
      observedAt: iso(now()),
    }
  }

  function mapPullRequest(payload: unknown, repoId: string, version: number): GitHubPullRequest {
    const item = obj(payload, 'pullRequest')
    const number = num(item.number, 'pullRequest.number')
    const base = obj(item.base, 'pullRequest.base')
    const baseRepoItem = base.repo
    if (baseRepoItem === undefined || baseRepoItem === null)
      untrusted('pullRequest.base.repo', 'repository')
    const baseRepo = obj(baseRepoItem, 'pullRequest.base.repo')
    const owner = str(obj(baseRepo.owner, 'pullRequest.base.repo.owner').login, 'owner', 100)
    const repo = str(baseRepo.name, 'pullRequest.base.repo.name', 100)
    const head = obj(item.head, 'pullRequest.head')
    const merged = item.merged === undefined ? false : bool(item.merged, 'pullRequest.merged')
    const state = merged ? ('merged' as const) : literal(item.state, ['open', 'closed'] as const, 'pullRequest.state')
    const labels = arr(item.labels ?? [], 'pullRequest.labels').map((label, index) =>
      str(obj(label, `pullRequest.labels[${index}]`).name, `pullRequest.labels[${index}].name`, 256)
    )
    const updatedAt = requiredIsoTimestamp(item.updated_at, 'pullRequest.updated_at')
    const draft = item.draft === undefined ? false : bool(item.draft, 'pullRequest.draft')
    const authorLogin = item.user === undefined || item.user === null ? undefined : optStr(obj(item.user, 'pullRequest.user').login, 'pullRequest.user.login', 100)
    const body = optStr(item.body, 'pullRequest.body', BODY_MAX)
    return {
      id: pullRequestIdOf(owner, repo, number),
      repoId,
      number,
      host: DEFAULT_HOST,
      owner,
      repo,
      title: str(item.title ?? '', 'pullRequest.title', 1024),
      ...(body !== undefined ? { body } : {}),
      state,
      draft,
      headRef: str(head.ref, 'pullRequest.head.ref', 512),
      headSha: gitSha(head.sha, 'pullRequest.head.sha'),
      baseRef: str(base.ref, 'pullRequest.base.ref', 512),
      baseSha: gitSha(base.sha, 'pullRequest.base.sha'),
      ...(authorLogin !== undefined ? { authorLogin } : {}),
      url: str(item.html_url, 'pullRequest.html_url', 512),
      mergeable:
        item.mergeable === true ? 'mergeable' : item.mergeable === false ? 'conflicting' : 'unknown',
      labels,
      version,
      updatedAt,
      observedAt: iso(now()),
    }
  }

  function mapCheck(payload: unknown): GitHubCheck {
    const item = obj(payload, 'check')
    const status = literal(item.status, ['queued', 'in_progress', 'completed'] as const, 'check.status')
    const conclusion =
      item.conclusion === undefined || item.conclusion === null
        ? undefined
        : literal(
            item.conclusion,
            [
              'success',
              'failure',
              'neutral',
              'cancelled',
              'skipped',
              'timed_out',
              'action_required',
              'stale',
            ] as const,
            'check.conclusion'
          )
    const detailsUrl = optStr(item.details_url, 'check.details_url', 512)
    const startedAt = isoTimestamp(item.started_at, 'check.started_at')
    const completedAt = isoTimestamp(item.completed_at, 'check.completed_at')
    return {
      id: String(num(item.id, 'check.id')),
      name: str(item.name, 'check.name', 256),
      status,
      ...(conclusion !== undefined ? { conclusion } : {}),
      ...(detailsUrl !== undefined ? { detailsUrl } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
    }
  }

  function mapIssue(payload: unknown): GitHubIssue | undefined {
    const item = obj(payload, 'issue')
    // The issues endpoint returns PRs too; they are not issues.
    if (item.pull_request !== undefined) return undefined
    const number = num(item.number, 'issue.number')
    const url = str(item.html_url, 'issue.html_url', 512)
    const ownerRepo = url.match(/\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\//)
    const milestone =
      item.milestone === undefined || item.milestone === null
        ? undefined
        : str(obj(item.milestone, 'issue.milestone').title, 'issue.milestone.title', 256)
    return {
      id: pullRequestIdOf(ownerRepo?.[1] ?? 'unknown', ownerRepo?.[2] ?? 'unknown', number),
      number,
      title: str(item.title ?? '', 'issue.title', 1024),
      state: literal(item.state, ['open', 'closed'] as const, 'issue.state'),
      url,
      labels: arr(item.labels ?? [], 'issue.labels').map((label, index) =>
        str(obj(label, `issue.labels[${index}]`).name, `issue.labels[${index}].name`, 256)
      ),
      ...(milestone !== undefined ? { milestone } : {}),
      updatedAt: requiredIsoTimestamp(item.updated_at, 'issue.updated_at'),
    }
  }

  function mapMilestone(payload: unknown, owner: string, repo: string): GitHubMilestone {
    const item = obj(payload, 'milestone')
    const number = num(item.number, 'milestone.number')
    const dueOn = isoTimestamp(item.due_on, 'milestone.due_on')
    return {
      id: `ghm:${owner}/${repo}#${number}`,
      number,
      title: str(item.title ?? '', 'milestone.title', 512),
      state: literal(item.state, ['open', 'closed'] as const, 'milestone.state'),
      ...(dueOn !== undefined ? { dueOn } : {}),
      openIssues: num(item.open_issues, 'milestone.open_issues'),
      closedIssues: num(item.closed_issues, 'milestone.closed_issues'),
      url: str(item.html_url, 'milestone.html_url', 512),
    }
  }

  /** Endpoints either return a bare array or `{ total_count, <key>: [...] }`. */
  function decodeJsonList(payload: unknown, key: string): readonly unknown[] {
    if (Array.isArray(payload)) return payload
    return arr(obj(payload, key)[key], key)
  }

  /** Page over a server-side page: the cursor is the absolute offset; only
   *  our own offset-multiples produce cursors, so the within-page skip is 0
   *  for well-formed clients. */
  function serverPageOf<T>(items: readonly T[], start: number, limit: number): DevRuntimePage<T> {
    const withinPage = start % limit
    const slice = items.slice(withinPage, withinPage + limit)
    const hasMore = items.length > withinPage + slice.length || (items.length === limit && withinPage === 0)
    return {
      items: slice,
      ...(hasMore ? { nextCursor: Buffer.from(String(start + slice.length)).toString('base64url') } : {}),
      observedAt: iso(now()),
    }
  }

  function offsetOf(cursor: unknown): number {
    const decoded = Number(Buffer.from(String(cursor), 'base64url').toString('utf8'))
    if (!Number.isSafeInteger(decoded) || decoded < 0)
      throw devError('not_found', 'unknown listing cursor')
    return decoded
  }

  function prVersionFor(cacheKey: string, updatedAt: string): number {
    const previous = prVersions.get(cacheKey)
    if (previous !== undefined && previous.updatedAt === updatedAt) return previous.version
    const version = (previous?.version ?? 0) + 1
    prVersions.set(cacheKey, { updatedAt, version })
    return version
  }

  function prCacheKey(parts: { owner: string; repo: string; number: number }): string {
    return `pr:${parts.owner}/${parts.repo}#${parts.number}`
  }

  /** Fetch the PR read model: the pull itself is cached; compare (ahead/
   *  behind) and reviews (review decision) decorate the open-state read and
   *  degrade to absent optional fields, never failing the whole read. */
  async function readPullRequest(
    parts: { owner: string; repo: string; number: number },
    refresh: boolean
  ): Promise<GitHubPullRequest> {
    const cacheKey = prCacheKey(parts)
    const payload = await ghJson(apiArgs(DEFAULT_HOST, `repos/${parts.owner}/${parts.repo}/pulls/${parts.number}`), {
      cacheKey,
      allowCached: !refresh,
    })
    const pr = mapPullRequest(
      payload,
      repoIdForRemote(parts),
      prVersionFor(cacheKey, requiredIsoTimestamp(obj(payload, 'pullRequest').updated_at, 'pullRequest.updated_at'))
    )
    if (pr.state !== 'open') return pr
    let aheadBehind: GitHubAheadBehind | undefined
    try {
      const compare = await ghJson(
        apiArgs(DEFAULT_HOST, `repos/${parts.owner}/${parts.repo}/compare/${encodeURIComponent(pr.baseRef)}...${pr.headSha}`)
      )
      const compareItem = obj(compare, 'compare')
      aheadBehind = {
        ahead: num(compareItem.ahead_by, 'compare.ahead_by'),
        behind: num(compareItem.behind_by, 'compare.behind_by'),
      }
    } catch {
      aheadBehind = undefined
    }
    let reviewDecision: GitHubPullRequest['reviewDecision']
    try {
      const reviews = decodeJsonList(
        await ghJson(
          apiArgs(DEFAULT_HOST, `repos/${parts.owner}/${parts.repo}/pulls/${parts.number}/reviews?per_page=100`)
        ),
        'reviews'
      )
      reviewDecision = reviewDecisionOf(reviews)
    } catch {
      reviewDecision = undefined
    }
    return {
      ...pr,
      ...(aheadBehind !== undefined ? { aheadBehind } : {}),
      ...(reviewDecision !== undefined ? { reviewDecision } : {}),
    }
  }

  function reviewDecisionOf(reviews: readonly unknown[]): GitHubPullRequest['reviewDecision'] {
    const latest = new Map<string, string>()
    for (const review of reviews) {
      const item = obj(review, 'review')
      const user = item.user === undefined || item.user === null ? undefined : obj(item.user, 'review.user')
      const login = user !== undefined ? str(user.login, 'review.user.login', 100) : ''
      const state = str(item.state, 'review.state', 32)
      if (login.length > 0) latest.set(login, state)
    }
    const states = [...latest.values()]
    if (states.includes('CHANGES_REQUESTED')) return 'changes_requested'
    if (states.includes('APPROVED')) return 'approved'
    if (states.length > 0) return 'review_required'
    return undefined
  }

  async function checkRunsFor(
    parts: { owner: string; repo: string },
    headSha: string
  ): Promise<readonly GitHubCheck[]> {
    const payload = await ghJson(
      apiArgs(DEFAULT_HOST, `repos/${parts.owner}/${parts.repo}/commits/${headSha}/check-runs?per_page=100`)
    )
    return decodeJsonList(payload, 'check_runs')
      .map((entry) => mapCheck(entry))
      .toSorted((left, right) => left.name.localeCompare(right.name))
  }

  function planEnvelope(
    planId: string,
    operation: DevOperation,
    entry: PlanEntry,
    resource: { kind: string; id: string; generation: number },
    factVersions: Record<string, string>,
    steps: readonly { id: string; kind: string; targetId: string }[],
    blockers: readonly DevError[]
  ): MutationPlan {
    return {
      id: planId,
      operation,
      scope: input.scope,
      resource,
      factVersions,
      steps: steps.map((step) => ({ ...step, dependsOn: [] })),
      blockers: blockers.map((blocker) => ({ code: blocker.code, message: blocker.message })),
      requiredApprovalIds: [],
      digest: entry.digest,
      expiresAt: iso(entry.expiresAt),
    }
  }

  function digestOf(facts: Record<string, unknown>): string {
    return sha256Text(JSON.stringify(facts))
  }

  function livePlan<K extends PlanEntry['kind']>(
    planId: string,
    kind: K
  ): Extract<PlanEntry, { kind: K }> {
    const entry = plans.get(planId)
    if (!entry || entry.expiresAt <= now() || entry.kind !== kind)
      throw devError('plan_stale', 'the plan is unknown, expired, or does not match this operation')
    return entry as Extract<PlanEntry, { kind: K }>
  }

  function requireDigest(entry: PlanEntry, planDigest: unknown): void {
    if (String(planDigest) !== entry.digest)
      throw devError('plan_stale', 'the plan digest does not match the issued plan')
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handlers: Partial<Record<DevOperation, (command: DevCommand) => unknown>> = {
    'dev.github.account': async (command) => {
      requireScope(command)
      devOperationDecoders['dev.github.account'].request(command.body)
      const payload = await ghJson(apiArgs(DEFAULT_HOST, 'user'), { cacheKey: 'account' })
      return mapAccount(payload, DEFAULT_HOST)
    },

    'dev.github.repository': async (command) => {
      const body = devOperationDecoders['dev.github.repository'].request(command.body)
      const { repoId, record } = repoContext(command)
      const parsed = await remoteOf(record.canonicalRoot, 'origin')
      const cacheKey = `repo:${parsed.owner}/${parsed.repo}`
      const entry = cache.get(cacheKey)
      const stale = entry !== undefined && now() - entry.observedAt < cacheTtlMs && body.refresh !== true
      const payload = await ghJson(apiArgs(parsed.host, `repos/${parsed.owner}/${parsed.repo}`), {
        cacheKey,
        allowCached: stale,
      })
      return mapRepository(payload, repoId, parsed, stale)
    },

    'dev.github.pullRequests': async (command) => {
      const body = devOperationDecoders['dev.github.pullRequests'].request(command.body)
      const { record } = repoContext(command)
      const parsed = await remoteOf(record.canonicalRoot, 'origin')
      const state = String(body.state ?? 'open')
      const limit = Math.min(Number(body.limit ?? PAGE_MAX), PAGE_MAX)
      const start = body.cursor !== undefined ? offsetOf(body.cursor) : 0
      const page = Math.floor(start / limit) + 1
      const payload = await ghJson(
        apiArgs(
          parsed.host,
          `repos/${parsed.owner}/${parsed.repo}/pulls?state=${encodeURIComponent(state)}&per_page=${limit}&page=${page}`
        )
      )
      const prs = decodeJsonList(payload, 'pulls').map((entry) =>
        mapPullRequest(entry, record.repoId, 0)
      )
      return serverPageOf(prs, start, limit)
    },

    'dev.github.pullRequest': async (command) => {
      const body = devOperationDecoders['dev.github.pullRequest'].request(command.body)
      requireScope(command)
      const pullRequestId = resourceOf(command, 'pull_request', body.pullRequestId)
      const parts = prIdParts(pullRequestId)
      const pr = await readPullRequest(parts, body.refresh === true)
      return { ...pr, repoId: repoIdForRemote(parts) }
    },

    'dev.github.checks': async (command) => {
      const body = devOperationDecoders['dev.github.checks'].request(command.body)
      requireScope(command)
      const pullRequestId = resourceOf(command, 'pull_request', body.pullRequestId)
      const parts = prIdParts(pullRequestId)
      const pr = await readPullRequest(parts, false)
      const limit = Math.min(Number(body.limit ?? PAGE_MAX), PAGE_MAX)
      const start = body.cursor !== undefined ? offsetOf(body.cursor) : 0
      const checks = await checkRunsFor(parts, pr.headSha)
      return serverPageOf(checks, start, limit)
    },

    'dev.github.issues': async (command) => {
      const body = devOperationDecoders['dev.github.issues'].request(command.body)
      const { record } = repoContext(command)
      const parsed = await remoteOf(record.canonicalRoot, 'origin')
      const state = String(body.state ?? 'open')
      const limit = Math.min(Number(body.limit ?? PAGE_MAX), PAGE_MAX)
      const start = body.cursor !== undefined ? offsetOf(body.cursor) : 0
      const page = Math.floor(start / limit) + 1
      const payload = await ghJson(
        apiArgs(
          parsed.host,
          `repos/${parsed.owner}/${parsed.repo}/issues?state=${encodeURIComponent(state)}&per_page=${limit}&page=${page}`
        )
      )
      const issues = decodeJsonList(payload, 'issues')
        .map((entry) => mapIssue(entry))
        .filter((entry): entry is GitHubIssue => entry !== undefined)
      return serverPageOf(issues, start, limit)
    },

    'dev.github.milestones': async (command) => {
      const body = devOperationDecoders['dev.github.milestones'].request(command.body)
      const { record } = repoContext(command)
      const parsed = await remoteOf(record.canonicalRoot, 'origin')
      const state = String(body.state ?? 'open')
      const limit = Math.min(Number(body.limit ?? PAGE_MAX), PAGE_MAX)
      const start = body.cursor !== undefined ? offsetOf(body.cursor) : 0
      const page = Math.floor(start / limit) + 1
      const payload = await ghJson(
        apiArgs(
          parsed.host,
          `repos/${parsed.owner}/${parsed.repo}/milestones?state=${encodeURIComponent(state)}&per_page=${limit}&page=${page}`
        )
      )
      const milestones = decodeJsonList(payload, 'milestones').map((entry) =>
        mapMilestone(entry, parsed.owner, parsed.repo)
      )
      return serverPageOf(milestones, start, limit)
    },

    // ── Push: plan/commit pair ───────────────────────────────────────────

    'dev.github.pushPlan': async (command) => {
      const body = devOperationDecoders['dev.github.pushPlan'].request(command.body)
      const { record } = repoContext(command)
      const worktreeId = String(body.worktreeId)
      const worktree = input.resolveWorktree(worktreeId)
      if (worktree === undefined || worktree.repoId !== record.repoId)
        throw devError('not_found', 'the worktree does not belong to this repository on this node')
      if (worktree.lifecycle !== 'ready')
        throw devError('invalid_state', 'push requires a ready worktree')
      const ref = String(body.ref)
      if (!REF_PATTERN.test(ref) || ref.includes('..'))
        throw devError('identity_mismatch', 'ref is not a simple branch name')
      const forced = body.forceWithLease !== undefined
      const resolved = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], {
        cwd: worktree.canonicalRoot,
      }).catch(() => ({ stdout: '', stderr: 'unknown revision', exitCode: 128 }))
      if (resolved.exitCode !== 0)
        throw devError('base_not_found', `ref ${ref} is unknown to this worktree`)
      const localSha = resolved.stdout.trim()
      if (localSha !== String(body.expectedLocalSha))
        throw devError('stale_version', 'the ref moved on since the caller observed it; re-read before planning')
      const parsed = await remoteOf(worktree.canonicalRoot, 'origin')
      const leaseSha = forced
        ? String((body.forceWithLease as { expectedRemoteSha: string }).expectedRemoteSha)
        : undefined
      if (forced && (leaseSha === undefined || !SHA_PATTERN.test(leaseSha)))
        throw devError('identity_mismatch', 'force push requires the expected remote sha')
      const defaultBranch = record.defaultBranch ?? 'main'
      if (forced && (ref === defaultBranch || protectedRefs.includes(ref)))
        throw devError('force_push_denied', `${ref} is a protected branch; force push is refused`)
      const blockers: DevError[] = []
      const tracking = await runGit(['rev-parse', '--verify', '-q', `refs/remotes/origin/${ref}`], {
        cwd: worktree.canonicalRoot,
      }).catch(() => ({ stdout: '', exitCode: 128, stderr: '' }))
      let remoteSha: string | undefined
      if (tracking.exitCode === 0 && SHA_PATTERN.test(tracking.stdout.trim())) {
        remoteSha = tracking.stdout.trim()
        if (forced && remoteSha !== leaseSha)
          throw devError('stale_version', 'the remote ref moved on since the expected sha was observed')
        if (!forced && remoteSha !== localSha) {
          const ancestor = await runGit(['merge-base', '--is-ancestor', remoteSha, localSha], {
            cwd: worktree.canonicalRoot,
          }).catch(() => ({ exitCode: 1 }))
          if (ancestor.exitCode !== 0)
            blockers.push({
              code: 'remote_changed',
              retryable: false,
              message: `origin/${ref} is not an ancestor of the local ref; the push would be rejected as non-fast-forward`,
            })
        }
      }
      const planId = randomUUID()
      const digest = digestOf({
        kind: 'push',
        kindOfPush: forced ? 'force' : 'normal',
        repoId: record.repoId,
        worktreeId,
        generation: worktree.generation,
        ref,
        localSha,
        remoteSha: remoteSha ?? null,
        leaseSha: leaseSha ?? null,
        host: parsed.host,
        owner: parsed.owner,
        repo: parsed.repo,
      })
      const entry: PlanEntry = {
        kind: 'push',
        kindOfPush: forced ? 'force' : 'normal',
        repoId: record.repoId,
        worktreeId,
        generation: worktree.generation,
        ref,
        localSha,
        ...(remoteSha !== undefined ? { remoteSha } : {}),
        host: parsed.host,
        owner: parsed.owner,
        repo: parsed.repo,
        expiresAt: now() + PLAN_TTL_MS,
        digest,
      }
      plans.set(planId, entry)
      return planEnvelope(
        planId,
        'dev.github.pushCommit' as DevOperation,
        entry,
        { kind: 'repository', id: record.repoId, generation: worktree.generation },
        { localSha, ...(remoteSha !== undefined ? { remoteSha } : {}), ref, repository: `${parsed.owner}/${parsed.repo}` },
        [{ id: 'push', kind: 'git_push', targetId: worktreeId }],
        blockers
      )
    },

    'dev.github.pushCommit': async (command) => {
      const body = devOperationDecoders['dev.github.pushCommit'].request(command.body)
      requireScope(command)
      const entry = livePlan(String(body.planId), 'push')
      requireDigest(entry, body.planDigest)
      const repoId = resourceOf(command, 'repository', entry.repoId)
      if (repoId !== entry.repoId)
        throw devError('identity_mismatch', 'the plan is bound to another repository')
      const worktree = input.resolveWorktree(entry.worktreeId)
      if (worktree === undefined || worktree.repoId !== entry.repoId)
        throw devError('not_found', 'the planned worktree no longer exists on this node')
      if (worktree.lifecycle !== 'ready')
        throw devError('invalid_state', 'push requires a ready worktree')
      if (worktree.generation !== entry.generation)
        throw devError('stale_generation', 'the worktree moved on since the push plan was made')
      // Re-prove every fact at execution time: the push runs from the
      // canonical worktree root only when the ref still points at the planned
      // commit and the remote still resolves to the planned repository.
      const resolved = await runGit(['rev-parse', '--verify', `${entry.ref}^{commit}`], {
        cwd: worktree.canonicalRoot,
      }).catch(() => ({ stdout: '', exitCode: 128, stderr: '' }))
      if (resolved.exitCode !== 0 || resolved.stdout.trim() !== entry.localSha)
        throw devError('stale_version', 'the ref moved on since the push plan was made')
      const parsed = await remoteOf(worktree.canonicalRoot, 'origin')
      if (parsed.host !== entry.host || parsed.owner !== entry.owner || parsed.repo !== entry.repo)
        throw devError('remote_changed', 'the origin remote changed since the push plan was made')
      const hadUpstream = entry.remoteSha !== undefined
      const args = ['push', '-q']
      if (entry.kindOfPush === 'force') {
        if (entry.remoteSha === undefined)
          throw devError('stale_version', 'force push requires the expected remote sha observed at plan time')
        args.push(`--force-with-lease=${entry.ref}:${entry.remoteSha}`)
      } else if (!hadUpstream) {
        // Upstream selection: a first push binds the tracking ref.
        args.push('-u')
      }
      args.push('origin', `${entry.ref}:${entry.ref}`)
      const pushed = await runGit(args, {
        cwd: worktree.canonicalRoot,
        timeoutMs: GIT_CHILD_TIMEOUT_MS,
        maxOutputBytes: 1024 * 1024,
      }).catch((error: unknown) => ({ stdout: '', exitCode: 128, stderr: String(error) }))
      if (pushed.exitCode !== 0) throw pushFailure(pushed.stderr)
      // Re-read server truth before reporting success. A successful local
      // push is not enough: if verification cannot observe the remote, keep
      // the plan retryable and return a typed failure instead of fabricating
      // the local SHA as server truth.
      const remoteNow = await lsRemoteSha(worktree.canonicalRoot, entry.ref)
      if (remoteNow === undefined)
        throw devError('remote_unavailable', 'push completed but remote verification failed', true)
      plans.delete(String(body.planId))
      return {
        repoId: entry.repoId,
        worktreeId: entry.worktreeId,
        ref: entry.ref,
        remoteName: 'origin',
        headSha: entry.localSha,
        remoteSha: remoteNow,
        forced: entry.kindOfPush === 'force',
        upstreamSet: entry.kindOfPush === 'normal' && !hadUpstream,
        observedAt: iso(now()),
      } satisfies GitPushResult
    },

    // ── PR create: idempotent/reconciled ─────────────────────────────────

    'dev.github.createPullRequest': async (command) => {
      const body = devOperationDecoders['dev.github.createPullRequest'].request(command.body)
      const { record } = repoContext(command)
      const headRef = String(body.headRef)
      const baseRef = String(body.baseRef)
      const title = String(body.title)
      const description = String(body.body)
      if (title.length === 0 || title.length > TITLE_MAX)
        throw devError('invalid_state', `title must be 1..${TITLE_MAX} characters`)
      if (description.length > BODY_MAX)
        throw devError('invalid_state', `body must be at most ${BODY_MAX} characters`)
      if (!REF_PATTERN.test(headRef) || !REF_PATTERN.test(baseRef) || headRef === baseRef)
        throw devError('identity_mismatch', 'head/base refs must be distinct simple branch names')
      if (body.draft !== true)
        throw devError('invalid_state', 'pull requests are created as draft in this slice')
      const parsed = await remoteOf(record.canonicalRoot, 'origin')
      // Reconciliation first: an open PR for the same head/base is returned
      // instead of duplicated, so a retried or timed-out create can never
      // produce an undetected second PR.
      const existing = await searchOpenPullRequest(parsed, headRef, baseRef)
      if (existing !== undefined) {
        const pr = mapPullRequest(existing, record.repoId, 0)
        return { ...pr, reconciled: true }
      }
      let created: unknown
      try {
        created = await ghJson(
          apiArgs(parsed.host, `repos/${parsed.owner}/${parsed.repo}/pulls`, [
            '--method',
            'POST',
            '-f',
            `title=${title}`,
            '-f',
            `body=${description}`,
            '-f',
            `head=${parsed.owner}:${headRef}`,
            '-f',
            `base=${baseRef}`,
            '-F',
            'draft=true',
          ]),
          { staleFallback: false }
        )
      } catch (error) {
        // Ambiguous delivery (timeout / network loss / 5xx): re-search before
        // failing, so a created-but-unreported PR is reconciled, not duplicated.
        const code = (error as { code?: unknown }).code
        if (code !== 'remote_unavailable' && code !== 'timeout' && code !== 'unavailable') throw error
        const recovered = await searchOpenPullRequest(parsed, headRef, baseRef)
        if (recovered === undefined) throw error
        const pr = mapPullRequest(recovered, record.repoId, 0)
        return { ...pr, reconciled: true }
      }
      const pr = mapPullRequest(created, record.repoId, 0)
      return { ...pr, reconciled: false }
    },

    // ── PR metadata update: plan/commit pair ─────────────────────────────

    'dev.github.updatePlan': async (command) => {
      const body = devOperationDecoders['dev.github.updatePlan'].request(command.body)
      requireScope(command)
      const pullRequestId = resourceOf(command, 'pull_request', body.pullRequestId)
      const parts = prIdParts(pullRequestId)
      const pr = await readPullRequest(parts, false)
      if (pr.version !== Number(body.expectedVersion))
        throw devError('stale_version', 'the pull request read model moved on; refresh before planning')
      const patch = body.patch as Record<string, unknown>
      const normalizedPatch: Record<string, unknown> = {}
      for (const key of ['title', 'body', 'draft', 'baseRef'] as const)
        if (patch[key] !== undefined) normalizedPatch[key] = patch[key]
      if (Object.keys(normalizedPatch).length === 0)
        throw devError('invalid_state', 'the patch carries no supported fields')
      const digest = digestOf({
        kind: 'pr-update',
        pullRequestId,
        expectedUpdatedAt: pr.updatedAt,
        patch: normalizedPatch,
      })
      const entry: PlanEntry = {
        kind: 'pr-update',
        pullRequestId,
        expectedUpdatedAt: pr.updatedAt,
        patch: normalizedPatch,
        expiresAt: now() + PLAN_TTL_MS,
        digest,
      }
      const planId = randomUUID()
      plans.set(planId, entry)
      return planEnvelope(
        planId,
        'dev.github.updateCommit' as DevOperation,
        entry,
        { kind: 'pull_request', id: pullRequestId, generation: 0 },
        { updatedAt: pr.updatedAt, headSha: pr.headSha },
        [{ id: 'pr-update', kind: 'github_pr_update', targetId: pullRequestId }],
        []
      )
    },

    'dev.github.updateCommit': async (command) => {
      const body = devOperationDecoders['dev.github.updateCommit'].request(command.body)
      requireScope(command)
      const entry = livePlan(String(body.planId), 'pr-update')
      requireDigest(entry, body.planDigest)
      const pullRequestId = resourceOf(command, 'pull_request', entry.pullRequestId)
      if (pullRequestId !== entry.pullRequestId)
        throw devError('identity_mismatch', 'the plan is bound to another pull request')
      const parts = prIdParts(entry.pullRequestId)
      // Re-read server truth: refuse when the PR moved on since the plan.
      const current = await readPullRequest(parts, true)
      if (current.updatedAt !== entry.expectedUpdatedAt)
        throw devError('stale_version', 'the pull request moved on since the plan was made')
      const patch = entry.patch
      if (patch.draft === true && !current.draft)
        throw devError(
          'invalid_state',
          'converting an opened pull request back to draft is not supported by this provider'
        )
      const extra: string[] = ['--method', 'PATCH']
      if (patch.title !== undefined) extra.push('-f', `title=${String(patch.title).slice(0, TITLE_MAX)}`)
      if (patch.body !== undefined) extra.push('-f', `body=${String(patch.body).slice(0, BODY_MAX)}`)
      if (patch.baseRef !== undefined) {
        const baseRef = String(patch.baseRef)
        if (!REF_PATTERN.test(baseRef))
          throw devError('identity_mismatch', 'baseRef is not a simple branch name')
        extra.push('-f', `base=${baseRef}`)
      }
      if (patch.draft === false && current.draft) extra.push('-F', 'draft=false')
      const updated = await ghJson(
        apiArgs(DEFAULT_HOST, `repos/${parts.owner}/${parts.repo}/pulls/${parts.number}`, extra),
        { staleFallback: false }
      )
      const cacheKey = prCacheKey(parts)
      cache.delete(cacheKey)
      const pr = mapPullRequest(
        updated,
        repoIdForRemote(parts),
        prVersionFor(cacheKey, requiredIsoTimestamp(obj(updated, 'pullRequest').updated_at, 'pullRequest.updated_at'))
      )
      plans.delete(String(body.planId))
      return pr
    },

    // ── PR merge: plan/commit pair ───────────────────────────────────────

    'dev.github.mergePlan': async (command) => {
      const body = devOperationDecoders['dev.github.mergePlan'].request(command.body)
      requireScope(command)
      const pullRequestId = resourceOf(command, 'pull_request', body.pullRequestId)
      const parts = prIdParts(pullRequestId)
      // Merge planning reads server truth fresh: draft/mergeable state is a
      // safety input, not a display model.
      const pr = await readPullRequest(parts, true)
      if (pr.state !== 'open')
        throw devError('invalid_state', `the pull request is ${pr.state}, not open`)
      if (pr.draft) throw devError('invalid_state', 'draft pull requests cannot be merged')
      if (pr.headSha !== String(body.expectedHeadSha))
        throw devError('stale_version', 'the pull request head moved on since the caller observed it')
      const method = body.method as 'merge' | 'squash' | 'rebase'
      const blockers: DevError[] = []
      if (pr.mergeable === 'conflicting')
        blockers.push({
          code: 'conflicted',
          retryable: false,
          message: 'the pull request has merge conflicts with its base',
        })
      if (pr.reviewDecision === 'changes_requested')
        blockers.push({
          code: 'invalid_state',
          retryable: false,
          message: 'a review requests changes; resolve it before merging',
        })
      let checks: readonly GitHubCheck[] = []
      try {
        checks = await checkRunsFor(parts, pr.headSha)
      } catch {
        checks = []
      }
      for (const check of checks) {
        if (check.status !== 'completed' || check.conclusion === 'failure' || check.conclusion === 'timed_out')
          blockers.push({
            code: 'invalid_state',
            retryable: false,
            message: `check ${check.name} is ${check.conclusion ?? check.status}`,
          })
      }
      const digest = digestOf({ kind: 'pr-merge', pullRequestId, headSha: pr.headSha, method })
      const entry: PlanEntry = {
        kind: 'pr-merge',
        pullRequestId,
        headSha: pr.headSha,
        method,
        expiresAt: now() + PLAN_TTL_MS,
        digest,
      }
      const planId = randomUUID()
      plans.set(planId, entry)
      return planEnvelope(
        planId,
        'dev.github.mergeCommit' as DevOperation,
        entry,
        { kind: 'pull_request', id: pullRequestId, generation: 0 },
        { headSha: pr.headSha, method },
        [{ id: 'pr-merge', kind: 'github_pr_merge', targetId: pullRequestId }],
        blockers
      )
    },

    'dev.github.mergeCommit': async (command) => {
      const body = devOperationDecoders['dev.github.mergeCommit'].request(command.body)
      requireScope(command)
      const entry = livePlan(String(body.planId), 'pr-merge')
      requireDigest(entry, body.planDigest)
      const pullRequestId = resourceOf(command, 'pull_request', entry.pullRequestId)
      if (pullRequestId !== entry.pullRequestId)
        throw devError('identity_mismatch', 'the plan is bound to another pull request')
      const parts = prIdParts(entry.pullRequestId)
      const current = await readPullRequest(parts, true)
      if (current.state !== 'open')
        throw devError('invalid_state', `the pull request is ${current.state}, not open`)
      if (current.headSha !== entry.headSha)
        throw devError('stale_version', 'the pull request head moved on since the merge plan was made')
      const merged = await ghJson(
        apiArgs(DEFAULT_HOST, `repos/${parts.owner}/${parts.repo}/pulls/${parts.number}/merge`, [
          '--method',
          'PUT',
          '-f',
          `merge_method=${entry.method}`,
          '-f',
          `sha=${entry.headSha}`,
        ]),
        { staleFallback: false }
      )
      obj(merged, 'mergeResult')
      const cacheKey = prCacheKey(parts)
      cache.delete(cacheKey)
      const pr = await readPullRequest(parts, true)
      plans.delete(String(body.planId))
      return pr
    },

    // ── Update branch (merge base into the PR branch): plan/commit pair ──

    'dev.github.updateBranchPlan': async (command) => {
      const body = devOperationDecoders['dev.github.updateBranchPlan'].request(command.body)
      requireScope(command)
      const pullRequestId = resourceOf(command, 'pull_request', body.pullRequestId)
      const parts = prIdParts(pullRequestId)
      const worktreeId = String(body.worktreeId)
      const worktree = input.resolveWorktree(worktreeId)
      if (worktree === undefined)
        throw devError('not_found', 'the worktree does not exist on this runtime node')
      if (worktree.generation !== Number(body.expectedGeneration))
        throw devError('stale_generation', 'the worktree generation does not match the request')
      if (worktree.lifecycle !== 'ready')
        throw devError('invalid_state', 'update branch requires a ready worktree')
      if (String(body.strategy) !== 'merge')
        throw devError(
          'unsupported_capability',
          'only the merge strategy exists in this slice; rebase requires the explicit force flow'
        )
      const pr = await readPullRequest(parts, false)
      if (pr.headSha !== String(body.expectedHeadSha))
        throw devError('stale_version', 'the pull request head moved on since the caller observed it')
      // The caller's stated base is the working base. A mismatch with the
      // GitHub-reported base is expected whenever the base is only known
      // remotely (it is re-verified at commit time, and the local existence
      // check below reports `base_not_found` until a fetch brings it in).
      const baseSha = String(body.expectedBaseSha)
      const parsed = await remoteOf(worktree.canonicalRoot, 'origin')
      if (parsed.owner !== parts.owner || parsed.repo !== parts.repo)
        throw devError('identity_mismatch', 'the worktree is not a checkout of the pull request repository')
      const headNow = await runGit(['rev-parse', 'HEAD'], { cwd: worktree.canonicalRoot }).catch(() => ({
        stdout: '',
        exitCode: 128,
        stderr: '',
      }))
      if (headNow.exitCode !== 0 || headNow.stdout.trim() !== pr.headSha)
        throw devError('invalid_state', 'the worktree HEAD is not the pull request head')
      const blockers: DevError[] = []
      const dirty = await runGit(['status', '--porcelain=v1', '-z'], { cwd: worktree.canonicalRoot })
      if (dirty.exitCode !== 0 || dirty.stdout.length > 0)
        blockers.push({
          code: 'dirty',
          retryable: false,
          message: 'the worktree has uncommitted changes; commit or discard them first',
        })
      const baseObject = await runGit(['rev-parse', '--verify', '-q', `${baseSha}^{commit}`], {
        cwd: worktree.canonicalRoot,
      }).catch(() => ({ stdout: '', exitCode: 128, stderr: '' }))
      if (baseObject.exitCode === 0) {
        const behind = await runGit(['rev-list', '--count', `${pr.headSha}..${baseSha}`], {
          cwd: worktree.canonicalRoot,
        }).catch(() => ({ stdout: '', exitCode: 128 }))
        if (behind.exitCode === 0 && Number(behind.stdout.trim()) === 0)
          blockers.push({
            code: 'already_completed',
            retryable: false,
            message: 'the branch already contains the base; nothing to update',
          })
      } else {
        blockers.push({
          code: 'base_not_found',
          retryable: false,
          message: 'the base commit is unknown locally; fetch before updating',
        })
      }
      const digest = digestOf({
        kind: 'update-branch',
        pullRequestId,
        worktreeId,
        generation: worktree.generation,
        strategy: 'merge',
        headSha: pr.headSha,
        baseSha: baseSha,
      })
      const entry: PlanEntry = {
        kind: 'update-branch',
        pullRequestId,
        worktreeId,
        generation: worktree.generation,
        strategy: 'merge',
        headSha: pr.headSha,
        baseSha: baseSha,
        expiresAt: now() + PLAN_TTL_MS,
        digest,
      }
      const planId = randomUUID()
      plans.set(planId, entry)
      return planEnvelope(
        planId,
        'dev.github.updateBranchCommit' as DevOperation,
        entry,
        { kind: 'pull_request', id: pullRequestId, generation: worktree.generation },
        { headSha: pr.headSha, baseSha: baseSha, worktreeId },
        [{ id: 'update-branch', kind: 'git_merge', targetId: worktreeId }],
        blockers
      )
    },

    'dev.github.updateBranchCommit': async (command) => {
      const body = devOperationDecoders['dev.github.updateBranchCommit'].request(command.body)
      requireScope(command)
      const entry = livePlan(String(body.planId), 'update-branch')
      requireDigest(entry, body.planDigest)
      const pullRequestId = resourceOf(command, 'pull_request', entry.pullRequestId)
      if (pullRequestId !== entry.pullRequestId)
        throw devError('identity_mismatch', 'the plan is bound to another pull request')
      const worktree = input.resolveWorktree(entry.worktreeId)
      if (worktree === undefined)
        throw devError('not_found', 'the planned worktree no longer exists on this node')
      if (worktree.lifecycle !== 'ready')
        throw devError('invalid_state', 'update branch requires a ready worktree')
      if (worktree.generation !== entry.generation)
        throw devError('stale_generation', 'the worktree moved on since the plan was made')
      const headNow = await runGit(['rev-parse', 'HEAD'], { cwd: worktree.canonicalRoot }).catch(() => ({
        stdout: '',
        exitCode: 128,
        stderr: '',
      }))
      if (headNow.exitCode !== 0 || headNow.stdout.trim() !== entry.headSha)
        throw devError('stale_version', 'the worktree HEAD moved on since the plan was made')
      const dirty = await runGit(['status', '--porcelain=v1', '-z'], { cwd: worktree.canonicalRoot })
      if (dirty.exitCode !== 0 || dirty.stdout.length > 0)
        throw devError('dirty', 'the worktree has uncommitted changes; the plan expected a clean tree')
      const merge = await runGit(['merge', '--no-edit', entry.baseSha], {
        cwd: worktree.canonicalRoot,
        maxOutputBytes: 1024 * 1024,
      })
      if (merge.exitCode !== 0) {
        // Conflict: leave the state exactly as git produced it (recoverable,
        // never silently aborted or reset) and report the exact paths plus the
        // explicit abort/continue actions.
        const status = await runGit(['status', '--porcelain=v1', '-z'], { cwd: worktree.canonicalRoot })
        const conflicted = status.stdout
          .split(NUL)
          .filter((field) => field.length > 3 && /^(?:U|AA|DD)/.test(field.slice(0, 2)))
          .map((field) => field.slice(3))
        if (conflicted.length > 0) {
          plans.delete(String(body.planId))
          return {
            pullRequestId: entry.pullRequestId,
            worktreeId: entry.worktreeId,
            strategy: 'merge',
            state: 'conflicted',
            previousHeadSha: entry.headSha,
            conflictedPaths: conflicted,
            recovery: {
              abort: 'git merge --abort restores the pre-merge branch state',
              continue: 'resolve the conflicted paths, stage them, and commit the merge',
            },
            observedAt: iso(now()),
          } satisfies GitUpdateBranchResult
        }
        throw devError(
          'invalid_state',
          redactCredentials(merge.stderr.trim().slice(0, 512) || 'merge failed')
        )
      }
      const mergedHead = await runGit(['rev-parse', 'HEAD'], { cwd: worktree.canonicalRoot })
      plans.delete(String(body.planId))
      return {
        pullRequestId: entry.pullRequestId,
        worktreeId: entry.worktreeId,
        strategy: 'merge',
        state: 'merged',
        previousHeadSha: entry.headSha,
        headSha: mergedHead.stdout.trim(),
        observedAt: iso(now()),
      } satisfies GitUpdateBranchResult
    },
  }

  function pushFailure(stderr: string): DevError {
    const message = redactCredentials(stderr.trim().slice(0, 512) || 'push failed')
    const text = message.toLowerCase()
    if (text.includes('protected branch') || text.includes('branch is protected'))
      return devError('branch_protected', message)
    if (text.includes('auth') || text.includes('403')) return devError('auth_required', message)
    if (
      text.includes('fetch first') ||
      text.includes('stale info') ||
      text.includes('rejected') ||
      text.includes('non-fast-forward')
    )
      return devError('remote_changed', message)
    return devError('remote_unavailable', message, true)
  }

  async function lsRemoteSha(canonicalRoot: string, ref: string): Promise<string | undefined> {
    const listing = await runGit(['ls-remote', 'origin', `refs/heads/${ref}`], {
      cwd: canonicalRoot,
      timeoutMs: GIT_CHILD_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024,
    }).catch(() => ({ stdout: '', exitCode: 128, stderr: '' }))
    const entry = listing.stdout.trim().split('\t')[0]?.trim()
    return listing.exitCode === 0 && entry !== undefined && SHA_PATTERN.test(entry) ? entry : undefined
  }

  async function searchOpenPullRequest(
    parsed: { host: string; owner: string; repo: string },
    headRef: string,
    baseRef: string
  ): Promise<unknown> {
    const query = `head=${encodeURIComponent(`${parsed.owner}:${headRef}`)}&base=${encodeURIComponent(baseRef)}&state=open`
    const payload = await ghJson(
      apiArgs(parsed.host, `repos/${parsed.owner}/${parsed.repo}/pulls?${query}`),
      { staleFallback: false }
    )
    return decodeJsonList(payload, 'pulls')[0]
  }

  let registeredCommands = 0
  for (const [operation, handler] of Object.entries(handlers)) {
    if (!handler) continue
    input.authority.registerCommandProvider(operation as DevOperation, async (command) => {
      try {
        return await handler(command)
      } catch (error) {
        throw mapGithubError(error)
      }
    })
    registeredCommands += 1
  }
  return { commands: Object.keys(handlers) as DevOperation[], registeredCommands }
}

function mapGithubError(error: unknown): unknown {
  const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown }
  if (
    candidate &&
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    (candidate.retryable === undefined || typeof candidate.retryable === 'boolean')
  ) {
    if (candidate.retryable === undefined)
      return devError(candidate.code as DevError['code'], redactCredentials(candidate.message))
    return { ...candidate, message: redactCredentials(candidate.message) }
  }
  if (error instanceof UntrustedError)
    return devError(
      'corrupt_state',
      `provider output did not decode: ${redactCredentials(error.message)}`
    )
  return error instanceof Error
    ? devError('invalid_state', redactCredentials(error.message))
    : devError('invalid_state', 'github operation failed')
}
