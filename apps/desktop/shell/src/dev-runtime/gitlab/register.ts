// GitLab provider for the source control app.
//
// Serves the `dev.gitlab.*` mirror of the GitHub collaboration contract:
// identical request bodies and the shared review DTOs, so the app's screens
// work unchanged against a GitLab project. Merge requests map to pull
// requests, pipelines and their jobs to checks, discussions to threads.
//
// Auth is the user's `glab` CLI context (its per-host credential store):
// Adea stores no GitLab token. Request bodies with user text ride glab's
// stdin (`glab api --input -`), never argv; GitLab responses are untrusted
// input decoded through narrow guards. Merge, auto-merge, branch rebase and
// PR updates are plan/commit pairs that bind the head SHA (or the read
// model's version) and re-prove it at commit time. What GitLab cannot do in
// this contract — updating a branch with a merge commit, requesting changes
// as a review verdict, or team reviewers — is refused with a typed
// `unsupported_capability`, and the app hides those actions.
import { createHash, randomUUID } from 'node:crypto'

import type {
  DevCommand,
  DevError,
  DevOperation,
  DevRuntimePage,
  GitHubAccount,
  GitHubActor,
  GitHubBranch,
  GitHubChangedFile,
  GitHubCheck,
  GitHubCheckLog,
  GitHubCheckRollup,
  GitHubCheckRollupState,
  GitHubCommitSummary,
  GitHubCompare,
  GitHubLabel,
  GitHubLatestReview,
  GitHubMergeMethod,
  GitHubPullRequest,
  GitHubPullRequestSummary,
  GitHubRepository,
  GitHubRerunResult,
  GitHubTimelineItem,
  MutationPlan,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import type { ChannelAuthority } from '../channel/authority'
import type { ConnectionsRuntime } from '../connections/register'
import { glabTokenEnv, hostnameArg } from '../connections/transport-env'
import { gitChildEnv, resolveCliExecutable, runGit } from '../worktrees/git-run'
import { BODY_MAX, PATCH_MAX, cleanText, graphqlData } from '../github/graphql'
import {
  arr,
  gitSha,
  isoTimestamp,
  num,
  obj,
  optStr,
  requiredIsoTimestamp,
  str,
} from '../github/untrusted'

const DEFAULT_HOST = 'gitlab.com'
const PLAN_TTL_MS = 10 * 60_000
const CACHE_TTL_MS = 30_000
const READ_BUDGET = 4 * 1024 * 1024
const LOG_READ_BUDGET = 32 * 1024 * 1024
const LOG_TAIL_MAX = 524_288
const TITLE_MAX = 256
const MR_ID_PATTERN = /^gl:((?:[A-Za-z0-9._-]{1,100})(?:\/[A-Za-z0-9._-]{1,100}){1,19})!(\d{1,9})$/
const PATH_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
const LOGIN_PATTERN = /^[A-Za-z0-9_.-]{1,255}$/
const DRAFT_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s-|draft\s)\s*/i

export function devError(code: DevError['code'], message: string, retryable = false): DevError {
  return { code, retryable, message }
}

function iso(at: number): string {
  return new Date(at).toISOString()
}

function digestOf(facts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(facts), 'utf8').digest('hex')
}

function encodeCursor(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

/** GitLab global ids (`gid://gitlab/Ci::Build/123`) to their trailing id. */
function gidTail(value: unknown, path: string): string {
  const text = str(value, path, 256)
  return text.slice(text.lastIndexOf('/') + 1)
}

function redact(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, '$1<redacted>@')
    .replace(/glpat-[A-Za-z0-9_-]+/g, '<redacted>')
}

// ─── glab transport ─────────────────────────────────────────────────────────

export type GlabRunResult = Readonly<{
  stdout: string
  stderr: string
  exitCode: number
  spawnCode?: 'capability_unavailable'
}>

export type GlabRunner = (
  args: readonly string[],
  options?: {
    timeoutMs?: number
    maxOutputBytes?: number
    stdin?: string
    /** Workspace-connection token env for this one child (ADR 0012). */
    env?: Readonly<Record<string, string>>
  }
) => Promise<GlabRunResult>

/** Bounded, argv-only glab runner; glab resolves credentials from its own
 *  host-scoped configuration, so no token passes through argv or env. The
 *  executable goes through the shared CLI resolver: launchd's PATH hides
 *  Homebrew installs from a Dock-launched app. */
export const defaultRunGlab: GlabRunner = async (args, options) => {
  let proc: Bun.Subprocess<'ignore' | Uint8Array, 'pipe', 'pipe'>
  try {
    proc = Bun.spawn([resolveCliExecutable('glab') ?? 'glab', ...args], {
      env: { ...gitChildEnv(), GLAB_NO_PROMPT: '1', NO_COLOR: '1', ...options?.env },
      stdin: options?.stdin !== undefined ? new TextEncoder().encode(options.stdin) : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    return {
      stdout: '',
      stderr: 'the glab CLI is not installed on this machine',
      exitCode: 127,
      spawnCode: 'capability_unavailable',
    }
  }
  const timer = setTimeout(() => proc.kill(), options?.timeoutMs ?? 60_000)
  const budget = options?.maxOutputBytes ?? READ_BUDGET
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const decoder = new TextDecoder('utf-8', { fatal: false })
    let total = 0
    let text = ''
    for await (const chunk of stream) {
      total += chunk.byteLength
      if (total > budget) {
        proc.kill()
        throw devError('limit_exceeded', 'glab output exceeded its budget')
      }
      text += decoder.decode(chunk, { stream: true })
    }
    return text + decoder.decode()
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    read(proc.stdout),
    read(proc.stderr),
    proc.exited,
  ])
  clearTimeout(timer)
  return { stdout, stderr, exitCode }
}

// ─── Remote parsing ─────────────────────────────────────────────────────────

export type ParsedGitLabRemote = Readonly<{ host: string; fullPath: string }>

/** Parse a GitLab remote (https, ssh, or scp-like) into its host and full
 *  project path (nested groups kept). Hosts outside the trust list refuse. */
export function parseGitLabRemote(
  rawUrl: string,
  trustedHosts: readonly string[]
): ParsedGitLabRemote {
  const trimmed = rawUrl.trim()
  // oxlint-disable-next-line no-control-regex -- refusing control characters in a remote is intentional
  if (trimmed.length === 0 || trimmed.length > 1024 || /[\s\u0000-\u001f]/.test(trimmed))
    throw devError('identity_mismatch', 'the remote URL is not a GitLab project URL')
  let host: string
  let path: string
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(.+)$/.exec(trimmed)
  if (scp) {
    host = scp[1]!.toLowerCase()
    path = scp[2]!
  } else {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      throw devError('identity_mismatch', 'the remote URL is not a GitLab project URL')
    }
    if (!['https:', 'ssh:', 'git:', 'http:'].includes(url.protocol))
      throw devError('identity_mismatch', 'the remote URL scheme is not supported')
    host = url.hostname.toLowerCase()
    path = url.pathname.replace(/^\/+/, '')
  }
  const segments = path
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .split('/')
  if (
    segments.length < 2 ||
    segments.length > 20 ||
    segments.some((segment) => !PATH_SEGMENT.test(segment) || segment === '.' || segment === '..')
  )
    throw devError('identity_mismatch', 'the remote URL does not name a GitLab project')
  if (!trustedHosts.includes(host))
    throw devError(
      'remote_host_untrusted',
      `host ${host} is not trusted for GitLab operations; trust it explicitly before use`
    )
  return { host, fullPath: segments.join('/') }
}

// ─── GraphQL documents ──────────────────────────────────────────────────────

const ACTOR = 'username name bot'

const MR_FIELDS = `
  id iid title webUrl state draft
  author { ${ACTOR} }
  sourceBranch targetBranch diffHeadSha sourceProjectId targetProjectId
  diffRefs { startSha }
  labels { nodes { title } }
  assignees { nodes { ${ACTOR} } }
  reviewers { nodes { ${ACTOR} mergeRequestInteraction { reviewState approved } } }
  approvedBy { nodes { ${ACTOR} } }
  approved approvalsLeft approvalsRequired
  detailedMergeStatus conflicts shouldBeRebased
  autoMergeEnabled squashOnMerge mergeUser { username }
  diffStatsSummary { additions deletions fileCount }
  commitCount
  headPipeline { status jobs(first: 100) { nodes { status allowFailure } } }
  userPermissions { pushToSourceBranch }
  createdAt updatedAt mergedAt closedAt`

const MR_LIST_QUERY = `query($path: ID!, $state: MergeRequestState, $first: Int!, $after: String) {
  project(fullPath: $path) {
    mergeRequests(state: $state, first: $first, after: $after, sort: UPDATED_DESC) {
      pageInfo { hasNextPage endCursor }
      nodes { ${MR_FIELDS} }
    }
  }
}`

const MR_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) { mergeRequest(iid: $iid) { ${MR_FIELDS} description } }
}`

const DISCUSSIONS_QUERY = `query($path: ID!, $iid: String!, $after: String) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      discussions(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id resolved resolvable
          notes(first: 100) { nodes { id body system createdAt author { ${ACTOR} } position { newPath oldPath newLine oldLine } } }
        }
      }
    }
  }
}`

const COMMITS_QUERY = `query($path: ID!, $iid: String!, $first: Int!, $after: String) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      diffHeadSha
      headPipeline { status }
      commits(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { sha title authoredDate author { username } authorName }
      }
    }
  }
}`

const JOBS = `jobs(first: 100) { nodes { id name status allowFailure startedAt finishedAt webPath failureMessage stage { name } } }`

const HEAD_JOBS_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) { mergeRequest(iid: $iid) { diffHeadSha headPipeline { ${JOBS} } } }
}`

const SHA_JOBS_QUERY = `query($path: ID!, $sha: String!) {
  project(fullPath: $path) { pipelines(sha: $sha, first: 1) { nodes { ${JOBS} } } }
}`

const REF_PIPELINE_QUERY = `query($path: ID!, $ref: String!) {
  project(fullPath: $path) { pipelines(ref: $ref, first: 1) { nodes { status } } }
}`

const LABELS_QUERY = `query($path: ID!, $after: String) {
  project(fullPath: $path) { labels(first: 100, after: $after, includeAncestorGroups: true) {
    pageInfo { hasNextPage endCursor } nodes { title color description } } }
}`

const MEMBERS_QUERY = `query($path: ID!, $search: String, $first: Int!) {
  project(fullPath: $path) { projectMembers(first: $first, search: $search) { nodes { user { ${ACTOR} } } } }
}`

// ─── Mapping ────────────────────────────────────────────────────────────────

function actorOf(value: unknown, path: string): GitHubActor | undefined {
  if (value === null || value === undefined) return undefined
  const item = obj(value, path)
  const login = str(item.username, `${path}.username`, 255)
  if (!login) return undefined
  const name = optStr(item.name, `${path}.name`, 256)
  return { login, kind: item.bot === true ? 'bot' : 'user', ...(name ? { name } : {}) }
}

function nodes(value: unknown, path: string): readonly unknown[] {
  if (value === null || value === undefined) return []
  return arr(obj(value, path).nodes ?? [], `${path}.nodes`).filter((entry) => entry !== null)
}

function bounded(value: unknown, path: string, max: number): string {
  if (value === null || value === undefined) return ''
  return cleanText(str(value, path, 16 * 1024 * 1024), max).text
}

const PIPELINE_STATE: Record<string, GitHubCheckRollupState> = {
  SUCCESS: 'success',
  FAILED: 'failure',
  CANCELED: 'failure',
  CANCELING: 'failure',
  RUNNING: 'pending',
  PENDING: 'pending',
  CREATED: 'pending',
  WAITING_FOR_RESOURCE: 'pending',
  WAITING_FOR_CALLBACK: 'pending',
  PREPARING: 'pending',
  SCHEDULED: 'pending',
  MANUAL: 'pending',
  SKIPPED: 'none',
}

export function pipelineState(value: unknown): GitHubCheckRollupState {
  if (typeof value !== 'string') return 'none'
  return PIPELINE_STATE[value.toUpperCase()] ?? 'none'
}

function jobBucket(
  status: string,
  allowFailure: boolean
): keyof Omit<GitHubCheckRollup, 'state' | 'total'> {
  switch (status.toUpperCase()) {
    case 'SUCCESS':
      return 'passing'
    case 'FAILED':
      return allowFailure ? 'passing' : 'failing'
    case 'CANCELED':
    case 'CANCELING':
      return 'failing'
    case 'SKIPPED':
    case 'MANUAL':
      return 'skipped'
    default:
      return 'running'
  }
}

function rollupOf(pipeline: unknown, path: string): GitHubCheckRollup {
  const counts = { passing: 0, failing: 0, running: 0, skipped: 0 }
  if (pipeline === null || pipeline === undefined) return { state: 'none', ...counts, total: 0 }
  const item = obj(pipeline, path)
  for (const [index, entry] of nodes(item.jobs, `${path}.jobs`).entries()) {
    const job = obj(entry, `${path}.jobs[${index}]`)
    counts[
      jobBucket(str(job.status, `${path}.jobs[${index}].status`, 64), job.allowFailure === true)
    ] += 1
  }
  const total = counts.passing + counts.failing + counts.running + counts.skipped
  return { state: pipelineState(item.status), ...counts, total }
}

const MERGE_STATE: Record<string, GitHubPullRequestSummary['mergeState']> = {
  MERGEABLE: 'clean',
  NEED_REBASE: 'behind',
  CONFLICT: 'dirty',
  BROKEN_STATUS: 'dirty',
  DRAFT_STATUS: 'draft',
  CI_MUST_PASS: 'blocked',
  CI_STILL_RUNNING: 'blocked',
  NOT_APPROVED: 'blocked',
  DISCUSSIONS_NOT_RESOLVED: 'blocked',
  BLOCKED_STATUS: 'blocked',
  NOT_OPEN: 'unknown',
  CHECKING: 'unknown',
  UNCHECKED: 'unknown',
  PREPARING: 'unknown',
}

export type ProjectSettings = Readonly<{
  mergeMethods: readonly GitHubMergeMethod[]
  defaultBranch: string
}>

/** The target branch commit the merge request's diff starts from, as
 *  decoration: a missing or malformed sha is omitted. */
function baseShaOf(refs: unknown): { baseSha?: string } {
  if (typeof refs !== 'object' || refs === null) return {}
  const start = (refs as Record<string, unknown>).startSha
  return typeof start === 'string' && /^[0-9a-f]{40}$/.test(start) ? { baseSha: start } : {}
}

export function settingsFromProject(payload: unknown): ProjectSettings {
  const item = obj(payload, 'project')
  const method = optStr(item.merge_method, 'project.merge_method', 32) ?? 'merge'
  const squash = optStr(item.squash_option, 'project.squash_option', 32) ?? 'default_off'
  const base: GitHubMergeMethod = method === 'merge' ? 'merge' : 'rebase'
  const methods: GitHubMergeMethod[] =
    squash === 'always' ? ['squash'] : squash === 'never' ? [base] : [base, 'squash']
  return {
    mergeMethods: methods,
    defaultBranch: optStr(item.default_branch, 'project.default_branch', 256) ?? 'main',
  }
}

/** A merge request's title without GitLab's draft prefix; the flag says it. */
export function displayTitle(title: string): string {
  return title.replace(DRAFT_PREFIX, '')
}

export function mapMergeRequest(
  value: unknown,
  path: string,
  context: Readonly<{
    fullPath: string
    repoId: string
    settings: ProjectSettings
    observedAt: string
    withBody: boolean
  }>
): GitHubPullRequestSummary | undefined {
  const item = obj(value, path)
  if (item.diffHeadSha === null || item.diffHeadSha === undefined) return undefined
  const iid = Number(str(item.iid, `${path}.iid`, 12))
  if (!Number.isSafeInteger(iid) || iid < 1) return undefined
  const stateText = str(item.state, `${path}.state`, 32)
  const state = stateText === 'merged' ? 'merged' : stateText === 'opened' ? 'open' : 'closed'
  const author = actorOf(item.author, `${path}.author`)
  const approvedBy = nodes(item.approvedBy, `${path}.approvedBy`).flatMap((entry, index) => {
    const actor = actorOf(entry, `${path}.approvedBy[${index}]`)
    return actor ? [actor] : []
  })
  const reviews: GitHubLatestReview[] = approvedBy.map((actor) => ({ actor, state: 'approved' }))
  const requested: GitHubActor[] = []
  for (const [index, entry] of nodes(item.reviewers, `${path}.reviewers`).entries()) {
    const actor = actorOf(entry, `${path}.reviewers[${index}]`)
    if (!actor) continue
    const interaction = obj(entry, `${path}.reviewers[${index}]`).mergeRequestInteraction
    const reviewState =
      interaction && typeof obj(interaction, 'interaction').reviewState === 'string'
        ? String(obj(interaction, 'interaction').reviewState)
        : 'UNREVIEWED'
    if (approvedBy.some((approver) => approver.login === actor.login)) continue
    if (reviewState === 'REQUESTED_CHANGES') reviews.push({ actor, state: 'changes_requested' })
    else if (reviewState === 'REVIEWED') reviews.push({ actor, state: 'commented' })
    else requested.push(actor)
  }
  const approvalsLeft = typeof item.approvalsLeft === 'number' ? item.approvalsLeft : 0
  const approvalsRequired = typeof item.approvalsRequired === 'number' ? item.approvalsRequired : 0
  const reviewDecision = reviews.some((review) => review.state === 'changes_requested')
    ? 'changes_requested'
    : approvalsRequired > 0 && approvalsLeft === 0
      ? 'approved'
      : approvalsRequired > 0
        ? 'review_required'
        : undefined
  const detailed =
    optStr(item.detailedMergeStatus, `${path}.detailedMergeStatus`, 64) ?? 'UNCHECKED'
  const conflicts = item.conflicts === true
  const stats = item.diffStatsSummary ? obj(item.diffStatsSummary, `${path}.diffStatsSummary`) : {}
  const pushable = item.userPermissions
    ? obj(item.userPermissions, `${path}.userPermissions`).pushToSourceBranch === true
    : false
  const mergeUser = item.mergeUser
    ? optStr(obj(item.mergeUser, `${path}.mergeUser`).username, 'mergeUser.username', 255)
    : undefined
  const mergedAt = isoTimestamp(item.mergedAt, `${path}.mergedAt`)
  const closedAt = isoTimestamp(item.closedAt, `${path}.closedAt`)
  let mergeState = MERGE_STATE[detailed] ?? 'unknown'
  if (item.shouldBeRebased === true && mergeState !== 'dirty') mergeState = 'behind'
  return {
    id: `gl:${context.fullPath}!${iid}`,
    repoId: context.repoId,
    number: iid,
    title: displayTitle(bounded(item.title, `${path}.title`, 1024)),
    url: str(item.webUrl, `${path}.webUrl`, 512),
    state,
    draft: item.draft === true,
    ...(author ? { author } : {}),
    headRef: str(item.sourceBranch, `${path}.sourceBranch`, 512),
    headSha: gitSha(item.diffHeadSha, `${path}.diffHeadSha`),
    baseRef: str(item.targetBranch, `${path}.targetBranch`, 512),
    ...baseShaOf(item.diffRefs),
    crossRepository: String(item.sourceProjectId) !== String(item.targetProjectId),
    additions: typeof stats.additions === 'number' ? stats.additions : 0,
    deletions: typeof stats.deletions === 'number' ? stats.deletions : 0,
    changedFiles: typeof stats.fileCount === 'number' ? stats.fileCount : 0,
    commitCount: typeof item.commitCount === 'number' ? item.commitCount : 0,
    labels: nodes(item.labels, `${path}.labels`).map((entry, index) =>
      bounded(obj(entry, `${path}.labels[${index}]`).title, `${path}.labels[${index}].title`, 256)
    ),
    assignees: nodes(item.assignees, `${path}.assignees`).flatMap((entry, index) => {
      const actor = actorOf(entry, `${path}.assignees[${index}]`)
      return actor ? [actor] : []
    }),
    requestedReviewers: requested,
    reviews,
    ...(reviewDecision ? { reviewDecision } : {}),
    ...(Number.isSafeInteger(item.approvalsRequired) && approvalsRequired >= 0
      ? { requiredApprovals: Math.min(approvalsRequired, 100) }
      : {}),
    mergeable: conflicts ? 'conflicting' : detailed === 'MERGEABLE' ? 'mergeable' : 'unknown',
    mergeState,
    checks: rollupOf(item.headPipeline, `${path}.headPipeline`),
    ...(item.autoMergeEnabled === true
      ? {
          autoMerge: {
            method:
              item.squashOnMerge === true
                ? 'squash'
                : (context.settings.mergeMethods[0] ?? 'merge'),
            ...(mergeUser ? { enabledBy: mergeUser } : {}),
          },
        }
      : {}),
    mergeMethods: context.settings.mergeMethods,
    autoMergeAllowed: true,
    viewerCanUpdateBranch: pushable,
    linkedIssues: [],
    ...(context.withBody
      ? { body: bounded(item.description, `${path}.description`, BODY_MAX) }
      : {}),
    createdAt: requiredIsoTimestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: requiredIsoTimestamp(item.updatedAt, `${path}.updatedAt`),
    ...(mergedAt ? { mergedAt } : {}),
    ...(closedAt ? { closedAt } : {}),
    observedAt: context.observedAt,
  }
}

const SYSTEM_EVENTS: readonly [RegExp, Extract<GitHubTimelineItem, { kind: 'event' }>['event']][] =
  [
    [/^merged\b/i, 'merged'],
    [/^closed\b/i, 'closed'],
    [/^reopened\b/i, 'reopened'],
    [/marked this merge request as \**ready\**/i, 'ready_for_review'],
    [/marked this merge request as \**draft\**/i, 'converted_to_draft'],
    [/^requested review from/i, 'review_requested'],
    [/^changed target branch from/i, 'base_ref_changed'],
    [/^force-pushed\b/i, 'head_ref_force_pushed'],
  ]

/** Map GitLab discussions to timeline items: diff-anchored discussions are
 *  threads, other notes are comments, and recognised system notes become
 *  lifecycle events or approval reviews. Other system notes are skipped. */
export function mapDiscussions(value: readonly unknown[]): GitHubTimelineItem[] {
  const items: GitHubTimelineItem[] = []
  for (const [index, entry] of value.entries()) {
    const at = `discussions[${index}]`
    const discussion = obj(entry, at)
    const id = gidTail(discussion.id, `${at}.id`)
    const notes = nodes(discussion.notes, `${at}.notes`).map((note, noteIndex) =>
      obj(note, `${at}.notes[${noteIndex}]`)
    )
    if (notes.length === 0) continue
    const first = notes[0]!
    const position = first.position ? obj(first.position, `${at}.position`) : undefined
    if (position && discussion.resolvable === true) {
      const newLine = typeof position.newLine === 'number' ? position.newLine : undefined
      const oldLine = typeof position.oldLine === 'number' ? position.oldLine : undefined
      const filePath = str(position.newPath ?? position.oldPath, `${at}.position.path`, 1024)
      const comments = notes
        .filter((note) => note.system !== true)
        .map((note, noteIndex) => {
          const author = actorOf(note.author, `${at}.notes[${noteIndex}].author`)
          return {
            id: gidTail(note.id, `${at}.notes[${noteIndex}].id`),
            ...(author ? { author } : {}),
            body: bounded(note.body, `${at}.notes[${noteIndex}].body`, BODY_MAX),
            createdAt: requiredIsoTimestamp(note.createdAt, `${at}.notes[${noteIndex}].createdAt`),
          }
        })
      if (comments.length === 0) continue
      const line = newLine ?? oldLine
      items.push({
        kind: 'thread',
        id,
        path: filePath,
        ...(line !== undefined && line > 0 ? { line } : {}),
        side: newLine !== undefined ? 'right' : 'left',
        resolved: discussion.resolved === true,
        outdated: false,
        comments,
        createdAt: comments[0]!.createdAt,
      })
      continue
    }
    for (const [noteIndex, note] of notes.entries()) {
      const nat = `${at}.notes[${noteIndex}]`
      const author = actorOf(note.author, `${nat}.author`)
      const createdAt = requiredIsoTimestamp(note.createdAt, `${nat}.createdAt`)
      const noteId = gidTail(note.id, `${nat}.id`)
      const body = bounded(note.body, `${nat}.body`, BODY_MAX)
      if (note.system === true) {
        if (/^approved this merge request/i.test(body)) {
          items.push({
            kind: 'review',
            id: noteId,
            ...(author ? { author } : {}),
            state: 'approved',
            body: '',
            createdAt,
          })
          continue
        }
        const match = SYSTEM_EVENTS.find(([pattern]) => pattern.test(body))
        if (match) {
          const detail =
            match[1] === 'review_requested' ? /@([A-Za-z0-9_.-]+)/.exec(body)?.[1] : undefined
          items.push({
            kind: 'event',
            id: noteId,
            event: match[1],
            ...(author ? { actor: author } : {}),
            ...(detail ? { detail } : {}),
            createdAt,
          })
        }
        continue
      }
      items.push({ kind: 'comment', id: noteId, ...(author ? { author } : {}), body, createdAt })
    }
  }
  return items
}

export function mapJob(value: unknown, path: string): GitHubCheck {
  const item = obj(value, path)
  const status = str(item.status, `${path}.status`, 64).toUpperCase()
  const stage = item.stage
    ? optStr(obj(item.stage, `${path}.stage`).name, `${path}.stage.name`, 128)
    : undefined
  const name = str(item.name, `${path}.name`, 256)
  const conclusion: GitHubCheck['conclusion'] | undefined =
    status === 'SUCCESS'
      ? 'success'
      : status === 'FAILED'
        ? item.allowFailure === true
          ? 'neutral'
          : 'failure'
        : status === 'CANCELED'
          ? 'cancelled'
          : status === 'SKIPPED' || status === 'MANUAL'
            ? 'skipped'
            : undefined
  const startedAt = isoTimestamp(item.startedAt, `${path}.startedAt`)
  const completedAt = isoTimestamp(item.finishedAt, `${path}.finishedAt`)
  const failure = optStr(item.failureMessage, `${path}.failureMessage`, 4096)
  return {
    id: gidTail(item.id, `${path}.id`),
    name: `${stage ? `${stage} / ` : ''}${name}`.slice(0, 256),
    status:
      conclusion !== undefined
        ? 'completed'
        : status === 'RUNNING' || status === 'CANCELING'
          ? 'in_progress'
          : 'queued',
    ...(conclusion !== undefined ? { conclusion } : {}),
    ...(failure ? { title: cleanText(failure, 256).text.replace(/\n/g, ' ') } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
  }
}

/** Count added and removed lines of a bare `@@` hunk patch. */
export function patchCounts(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

export function mapDiff(value: unknown, path: string): GitHubChangedFile {
  const item = obj(value, path)
  const newPath = str(item.new_path, `${path}.new_path`, 1024)
  const oldPath = str(item.old_path, `${path}.old_path`, 1024)
  const raw = optStr(item.diff, `${path}.diff`, 16 * 1024 * 1024) ?? ''
  const patch = raw ? cleanText(raw, PATCH_MAX) : undefined
  const counts = patchCounts(raw)
  const status: GitHubChangedFile['status'] =
    item.new_file === true
      ? 'added'
      : item.deleted_file === true
        ? 'removed'
        : item.renamed_file === true
          ? 'renamed'
          : 'modified'
  return {
    path: newPath,
    ...(status === 'renamed' && oldPath !== newPath ? { previousPath: oldPath } : {}),
    status,
    additions: counts.additions,
    deletions: counts.deletions,
    ...(patch && patch.text ? { patch: patch.text } : {}),
    patchTruncated: patch?.truncated ?? (item.too_large === true || item.collapsed === true),
  }
}

const projectId = (fullPath: string) => `projects/${encodeURIComponent(fullPath)}`

const blocker = (code: DevError['code'], message: string): DevError => ({
  code,
  retryable: false,
  message,
})

function idsOf(list: unknown, path: string): number[] {
  return arr(list ?? [], path).map((entry, index) =>
    num(obj(entry, `${path}[${index}]`).id, `${path}[${index}].id`)
  )
}

// ─── Registrar ──────────────────────────────────────────────────────────────

export type GitLabRepoContext = Readonly<{ repoId: string; canonicalRoot: string }>

export type GitLabRegistrarInput = {
  authority: ChannelAuthority
  scope: Scope
  resolveRepo(repoId: string): GitLabRepoContext | undefined
  listRepos(): readonly GitLabRepoContext[]
  /** Test seam: a scripted glab transport. */
  runGlab?: GlabRunner
  /** Workspace connections (ADR 0012): the active workspace's git hosting
   *  resolution. Absent keeps glab on the device's own credentials. */
  resolveGitHosting?: ConnectionsRuntime['resolveGitHosting']
  now?: () => number
  cacheTtlMs?: number
  /** Self-managed GitLab hosts trusted explicitly; gitlab.com is implied. */
  trustedHosts?: readonly string[]
}

type Plan =
  | {
      kind: 'update'
      pullRequestId: string
      updatedAt: string
      patch: Record<string, unknown>
      expiresAt: number
      digest: string
    }
  | {
      kind: 'merge'
      pullRequestId: string
      headSha: string
      method: GitHubMergeMethod
      deleteBranch: boolean
      expiresAt: number
      digest: string
    }
  | {
      kind: 'auto-merge'
      pullRequestId: string
      headSha: string
      enabled: boolean
      method: GitHubMergeMethod
      expiresAt: number
      digest: string
    }
  | { kind: 'rebase'; pullRequestId: string; headSha: string; expiresAt: number; digest: string }

type Parts = { fullPath: string; iid: number }

export function registerGitlabRuntime(input: GitLabRegistrarInput): {
  commands: readonly DevOperation[]
  registeredCommands: number
} {
  const now = input.now ?? Date.now
  const baseRunGlab = input.runGlab ?? defaultRunGlab
  // Every glab child resolves its host's workspace connection (token env for
  // this child only); no binding is the device's own `glab auth`.
  const runGlab: GlabRunner = async (args, options) => {
    const resolution = input.resolveGitHosting?.({
      host: hostnameArg(args) ?? DEFAULT_HOST,
      operation: 'gitlab.api',
    })
    const env = resolution ? glabTokenEnv(resolution) : undefined
    return baseRunGlab(args, env ? { ...options, env } : options)
  }
  const cacheTtlMs = input.cacheTtlMs ?? CACHE_TTL_MS
  const trustedHosts = [...new Set([...(input.trustedHosts ?? []), DEFAULT_HOST])]
  const plans = new Map<string, Plan>()
  const cache = new Map<string, { value: unknown; at: number }>()
  const versions = new Map<string, { updatedAt: string; version: number }>()
  /** Host per project path, learned from the registered remotes. */
  const hosts = new Map<string, string>()

  function requireScope(command: DevCommand): void {
    if (
      command.scope.accountId !== input.scope.accountId ||
      command.scope.workspaceId !== input.scope.workspaceId ||
      command.scope.runtimeNodeId !== input.scope.runtimeNodeId
    )
      throw devError('unauthorized', 'gitlab scope is not authorized on this runtime node')
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

  function classify(result: GlabRunResult, operation: string): DevError {
    const stderr = redact(result.stderr.trim().slice(0, 512))
    if (result.spawnCode === 'capability_unavailable')
      return devError(
        'capability_unavailable',
        'the glab CLI is not available; install and authenticate it to use GitLab operations',
        true
      )
    if (/401|unauthorized|not authenticated|glab auth login/i.test(stderr))
      return devError('unauthenticated', `glab is not authenticated for this operation: ${stderr}`)
    if (/429|rate limit/i.test(stderr))
      return devError('rate_limited', `GitLab rate limit was hit: ${stderr}`, true)
    if (/404|not found/i.test(stderr))
      return devError('not_found', `${operation} target was not found: ${stderr}`)
    if (/403|forbidden/i.test(stderr))
      return devError('unauthorized', `GitLab refused the operation: ${stderr}`)
    if (/405|406|409|422|400|conflict|unprocessable/i.test(stderr))
      return devError('invalid_state', `GitLab rejected the request: ${stderr}`)
    if (/could not resolve|dial tcp|connection refused|timeout|network/i.test(stderr))
      return devError('remote_unavailable', `GitLab was unreachable: ${stderr}`, true)
    return devError(
      'invalid_state',
      `${operation} failed: ${stderr || `glab exited ${result.exitCode}`}`
    )
  }

  function hostOf(fullPath: string): string {
    return hosts.get(fullPath) ?? DEFAULT_HOST
  }

  async function rest(
    host: string,
    path: string,
    options: {
      method?: string
      body?: unknown
      operation: string
      cacheKey?: string
      text?: boolean
      maxOutputBytes?: number
    } = {
      operation: 'gitlab read',
    }
  ): Promise<unknown> {
    if (options.cacheKey) {
      const hit = cache.get(options.cacheKey)
      if (hit && now() - hit.at < cacheTtlMs) return hit.value
    }
    const args = ['api', path, '--hostname', host]
    if (options.method) args.push('--method', options.method)
    if (options.body !== undefined)
      args.push('--input', '-', '--header', 'Content-Type: application/json')
    const result = await runGlab(args, {
      ...(options.body !== undefined ? { stdin: JSON.stringify(options.body) } : {}),
      maxOutputBytes: options.maxOutputBytes ?? READ_BUDGET,
    })
    if (result.exitCode !== 0) throw classify(result, options.operation)
    if (options.text) return result.stdout
    let parsed: unknown
    try {
      parsed = result.stdout.trim().length === 0 ? {} : JSON.parse(result.stdout)
    } catch {
      throw devError('corrupt_state', 'glab returned output that is not valid JSON')
    }
    if (options.cacheKey) cache.set(options.cacheKey, { value: parsed, at: now() })
    return parsed
  }

  async function graphql(
    host: string,
    query: string,
    variables: Record<string, unknown>,
    operation: string
  ) {
    return graphqlData(
      await rest(host, 'graphql', { method: 'POST', body: { query, variables }, operation })
    )
  }

  async function repoOf(
    command: DevCommand
  ): Promise<{ repoId: string; fullPath: string; host: string }> {
    requireScope(command)
    const body = command.body as { repoId?: unknown }
    const repoId = resourceOf(command, 'repository', body.repoId)
    const record = input.resolveRepo(repoId)
    if (!record) throw devError('not_found', 'repository is not registered on this runtime node')
    const configured = await runGit(['config', '--get', 'remote.origin.url'], {
      cwd: record.canonicalRoot,
    }).catch(() => ({
      stdout: '',
      exitCode: 128,
      stderr: '',
    }))
    if (configured.exitCode !== 0)
      throw devError('invalid_state', 'the repository has no origin remote configured')
    const parsed = parseGitLabRemote(configured.stdout.trim(), trustedHosts)
    hosts.set(parsed.fullPath, parsed.host)
    return { repoId, fullPath: parsed.fullPath, host: parsed.host }
  }

  /** The registered repository whose origin names this project, if any. */
  async function repoIdFor(fullPath: string): Promise<string> {
    for (const record of input.listRepos()) {
      const configured = await runGit(['config', '--get', 'remote.origin.url'], {
        cwd: record.canonicalRoot,
      }).catch(() => undefined)
      if (!configured || configured.exitCode !== 0) continue
      try {
        const parsed = parseGitLabRemote(configured.stdout.trim(), trustedHosts)
        hosts.set(parsed.fullPath, parsed.host)
        if (parsed.fullPath.toLowerCase() === fullPath.toLowerCase()) return record.repoId
      } catch {
        continue
      }
    }
    return `remote:${fullPath}`.slice(0, 128)
  }

  function prOf(command: DevCommand): { pullRequestId: string; parts: Parts } {
    requireScope(command)
    const body = command.body as { pullRequestId?: unknown }
    const pullRequestId = resourceOf(command, 'pull_request', body.pullRequestId)
    const match = MR_ID_PATTERN.exec(pullRequestId)
    if (!match) throw devError('identity_mismatch', 'merge request id is malformed')
    return { pullRequestId, parts: { fullPath: match[1]!, iid: Number(match[2]) } }
  }

  async function settingsOf(fullPath: string): Promise<ProjectSettings> {
    return settingsFromProject(
      await rest(hostOf(fullPath), projectId(fullPath), {
        operation: 'project read',
        cacheKey: `project:${fullPath}`,
      })
    )
  }

  async function readSummary(
    parts: Parts,
    withBehind: boolean
  ): Promise<{ summary: GitHubPullRequestSummary; gid: string }> {
    const host = hostOf(parts.fullPath)
    const [data, settings, repoId] = await Promise.all([
      graphql(
        host,
        MR_QUERY,
        { path: parts.fullPath, iid: String(parts.iid) },
        'merge request read'
      ),
      settingsOf(parts.fullPath),
      repoIdFor(parts.fullPath),
    ])
    const project = data.project
    const mr = project ? obj(project, 'project').mergeRequest : undefined
    if (!mr) throw devError('not_found', 'the merge request was not found')
    const summary = mapMergeRequest(mr, 'mergeRequest', {
      fullPath: parts.fullPath,
      repoId,
      settings,
      observedAt: iso(now()),
      withBody: true,
    })
    if (!summary) throw devError('invalid_state', 'the merge request has no diff head yet')
    if (!withBehind || summary.state !== 'open')
      return { summary, gid: str(obj(mr, 'mr').id, 'mr.id', 256) }
    try {
      const compare = obj(
        await rest(
          host,
          `${projectId(parts.fullPath)}/repository/compare?from=${summary.headSha}&to=${encodeURIComponent(summary.baseRef)}`,
          { operation: 'compare' }
        ),
        'compare'
      )
      const behindBy = arr(compare.commits ?? [], 'compare.commits').length
      return { summary: { ...summary, behindBy }, gid: str(obj(mr, 'mr').id, 'mr.id', 256) }
    } catch {
      return { summary, gid: str(obj(mr, 'mr').id, 'mr.id', 256) }
    }
  }

  async function readRest(parts: Parts): Promise<Record<string, unknown>> {
    return obj(
      await rest(
        hostOf(parts.fullPath),
        `${projectId(parts.fullPath)}/merge_requests/${parts.iid}`,
        { operation: 'merge request read' }
      ),
      'mergeRequest'
    )
  }

  function versionFor(key: string, updatedAt: string): number {
    const previous = versions.get(key)
    if (previous && previous.updatedAt === updatedAt) return previous.version
    const version = (previous?.version ?? 0) + 1
    versions.set(key, { updatedAt, version })
    return version
  }

  async function restPullRequest(
    parts: Parts,
    item: Record<string, unknown>,
    extra: Partial<GitHubPullRequest> = {}
  ): Promise<GitHubPullRequest> {
    const updatedAt = requiredIsoTimestamp(item.updated_at, 'mergeRequest.updated_at')
    const stateText = str(item.state, 'mergeRequest.state', 32)
    const refs = item.diff_refs ? obj(item.diff_refs, 'mergeRequest.diff_refs') : {}
    const namespace = parts.fullPath.slice(0, parts.fullPath.lastIndexOf('/'))
    const author = item.author
      ? optStr(obj(item.author, 'mergeRequest.author').username, 'author.username', 100)
      : undefined
    const description = optStr(item.description, 'mergeRequest.description', 16 * 1024 * 1024)
    return {
      id: `gl:${parts.fullPath}!${parts.iid}`,
      repoId: await repoIdFor(parts.fullPath),
      number: parts.iid,
      host: hostOf(parts.fullPath),
      owner: namespace,
      repo: parts.fullPath.slice(parts.fullPath.lastIndexOf('/') + 1),
      title: displayTitle(bounded(item.title, 'mergeRequest.title', 1024)),
      ...(description ? { body: cleanText(description, BODY_MAX).text } : {}),
      state: stateText === 'merged' ? 'merged' : stateText === 'opened' ? 'open' : 'closed',
      draft: item.draft === true || item.work_in_progress === true,
      headRef: str(item.source_branch, 'mergeRequest.source_branch', 512),
      headSha: gitSha(item.sha, 'mergeRequest.sha'),
      baseRef: str(item.target_branch, 'mergeRequest.target_branch', 512),
      baseSha:
        typeof refs.base_sha === 'string'
          ? gitSha(refs.base_sha, 'diff_refs.base_sha')
          : gitSha(item.sha, 'mergeRequest.sha'),
      ...(author ? { authorLogin: author } : {}),
      url: str(item.web_url, 'mergeRequest.web_url', 512),
      mergeable:
        item.has_conflicts === true
          ? 'conflicting'
          : item.detailed_merge_status === 'mergeable'
            ? 'mergeable'
            : 'unknown',
      labels: arr(item.labels ?? [], 'mergeRequest.labels').map((label, index) =>
        str(label, `labels[${index}]`, 256)
      ),
      version: versionFor(`mr:${parts.fullPath}!${parts.iid}`, updatedAt),
      updatedAt,
      observedAt: iso(now()),
      ...extra,
    }
  }

  function livePlan<K extends Plan['kind']>(
    planId: unknown,
    kind: K,
    digest: unknown
  ): Extract<Plan, { kind: K }> {
    const entry = plans.get(String(planId))
    if (!entry || entry.expiresAt <= now() || entry.kind !== kind)
      throw devError('plan_stale', 'the plan is unknown, expired, or does not match this operation')
    if (String(digest) !== entry.digest)
      throw devError('plan_stale', 'the plan digest does not match the issued plan')
    return entry as Extract<Plan, { kind: K }>
  }

  function issuePlan(
    entry: Plan,
    operation: DevOperation,
    facts: Record<string, string>,
    stepKind: string,
    blockers: readonly DevError[]
  ): MutationPlan {
    const id = randomUUID()
    plans.set(id, entry)
    return {
      id,
      operation,
      scope: input.scope,
      resource: { kind: 'pull_request', id: entry.pullRequestId, generation: 0 },
      factVersions: facts,
      steps: [{ id: entry.kind, kind: stepKind, targetId: entry.pullRequestId, dependsOn: [] }],
      blockers: blockers.map((item) => ({ code: item.code, message: item.message })),
      requiredApprovalIds: [],
      digest: entry.digest,
      expiresAt: iso(entry.expiresAt),
    }
  }

  function bindCommit(command: DevCommand, entry: Plan): Parts {
    if (resourceOf(command, 'pull_request', entry.pullRequestId) !== entry.pullRequestId)
      throw devError('identity_mismatch', 'the plan is bound to another merge request')
    const match = MR_ID_PATTERN.exec(entry.pullRequestId)!
    return { fullPath: match[1]!, iid: Number(match[2]) }
  }

  async function userIds(host: string, logins: readonly string[]): Promise<number[]> {
    const ids: number[] = []
    for (const login of logins) {
      if (login.includes('/'))
        throw devError(
          'unsupported_capability',
          'GitLab merge requests take people, not teams, as reviewers'
        )
      if (!LOGIN_PATTERN.test(login))
        throw devError('identity_mismatch', `${login.slice(0, 64)} is not a GitLab username`)
      const found = arr(
        await rest(host, `users?username=${encodeURIComponent(login)}`, {
          operation: 'user lookup',
        }),
        'users'
      )
      if (found.length === 0) throw devError('not_found', `no GitLab user ${login}`)
      ids.push(num(obj(found[0], 'users[0]').id, 'users[0].id'))
    }
    return ids
  }

  async function threadOf(
    parts: Parts,
    discussionId: string
  ): Promise<Extract<GitHubTimelineItem, { kind: 'thread' }>> {
    const payload = obj(
      await rest(
        hostOf(parts.fullPath),
        `${projectId(parts.fullPath)}/merge_requests/${parts.iid}/discussions/${discussionId}`,
        {
          operation: 'discussion read',
        }
      ),
      'discussion'
    )
    // REST discussions to the GraphQL shape the mapper reads.
    const notes = arr(payload.notes ?? [], 'discussion.notes').map((entry, index) => {
      const note = obj(entry, `discussion.notes[${index}]`)
      const position = note.position ? obj(note.position, 'position') : undefined
      return {
        id: String(note.id),
        body: note.body,
        system: note.system === true,
        createdAt: note.created_at,
        author: note.author
          ? {
              username: obj(note.author, 'author').username,
              name: obj(note.author, 'author').name,
              bot: obj(note.author, 'author').bot,
            }
          : null,
        position: position
          ? {
              newPath: position.new_path,
              oldPath: position.old_path,
              newLine: position.new_line,
              oldLine: position.old_line,
            }
          : null,
      }
    })
    const resolved =
      notes.length > 0 &&
      arr(payload.notes, 'notes').every((entry) => {
        const note = obj(entry, 'note')
        return note.resolvable !== true || note.resolved === true
      })
    const mapped = mapDiscussions([
      { id: String(payload.id), resolved, resolvable: true, notes: { nodes: notes } },
    ])
    const thread = mapped.find((item) => item.kind === 'thread')
    if (!thread || thread.kind !== 'thread')
      throw devError('not_found', 'the discussion is not a diff thread')
    return thread
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handlers: Partial<Record<DevOperation, (command: DevCommand) => unknown>> = {
    'dev.gitlab.account': async (command) => {
      requireScope(command)
      devOperationDecoders['dev.gitlab.account'].request(command.body)
      const host = input.listRepos().length > 0 ? DEFAULT_HOST : DEFAULT_HOST
      const user = obj(
        await rest(host, 'user', { operation: 'account read', cacheKey: 'account' }),
        'user'
      )
      const name = optStr(user.name, 'user.name', 256)
      const profileUrl = optStr(user.web_url, 'user.web_url', 512)
      return {
        provider: 'gitlab',
        host,
        login: str(user.username, 'user.username', 100),
        ...(name ? { name } : {}),
        ...(profileUrl ? { profileUrl } : {}),
        observedAt: iso(now()),
      } satisfies GitHubAccount
    },

    'dev.gitlab.repository': async (command) => {
      const body = devOperationDecoders['dev.gitlab.repository'].request(command.body)
      const { repoId, fullPath, host } = await repoOf(command)
      if (body.refresh === true) cache.delete(`project:${fullPath}`)
      const project = obj(
        await rest(host, projectId(fullPath), {
          operation: 'project read',
          cacheKey: `project:${fullPath}`,
        }),
        'project'
      )
      const defaultBranch = optStr(project.default_branch, 'project.default_branch', 256) ?? 'main'
      let defaultBranchHead: GitHubRepository['defaultBranchHead']
      try {
        const branch = obj(
          await rest(
            host,
            `${projectId(fullPath)}/repository/branches/${encodeURIComponent(defaultBranch)}`,
            { operation: 'branch read' }
          ),
          'branch'
        )
        const data = await graphql(
          host,
          REF_PIPELINE_QUERY,
          { path: fullPath, ref: defaultBranch },
          'pipeline read'
        )
        const pipeline = nodes(obj(data.project, 'project').pipelines, 'pipelines')[0]
        defaultBranchHead = {
          sha: gitSha(obj(branch.commit, 'branch.commit').id, 'branch.commit.id'),
          checks: pipeline ? pipelineState(obj(pipeline, 'pipeline').status) : 'none',
        }
      } catch {
        defaultBranchHead = undefined
      }
      const pathWithNamespace = str(
        project.path_with_namespace,
        'project.path_with_namespace',
        1024
      )
      return {
        repoId,
        provider: 'gitlab',
        host,
        owner: pathWithNamespace.slice(0, pathWithNamespace.lastIndexOf('/')).slice(0, 100),
        name: str(project.path, 'project.path', 100),
        fullName: pathWithNamespace.slice(0, 201),
        defaultBranch,
        url: str(project.web_url, 'project.web_url', 512),
        visibility: project.visibility === 'public' ? 'public' : 'private',
        fork: project.forked_from_project !== undefined && project.forked_from_project !== null,
        freshness: 'fresh',
        observedAt: iso(now()),
        ...(defaultBranchHead ? { defaultBranchHead } : {}),
      } satisfies GitHubRepository
    },

    'dev.gitlab.pullRequestSummaries': async (command) => {
      const body = devOperationDecoders['dev.gitlab.pullRequestSummaries'].request(command.body)
      const { repoId, fullPath, host } = await repoOf(command)
      const stateMap: Record<string, string> = {
        open: 'opened',
        merged: 'merged',
        closed: 'closed',
      }
      const after =
        body.cursor === undefined
          ? null
          : Buffer.from(String(body.cursor), 'base64url').toString('utf8')
      const [data, settings] = await Promise.all([
        graphql(
          host,
          MR_LIST_QUERY,
          {
            path: fullPath,
            state: stateMap[String(body.state ?? 'open')],
            first: Number(body.limit ?? 25),
            after,
          },
          'merge request listing'
        ),
        settingsOf(fullPath),
      ])
      const connection = obj(obj(data.project, 'project').mergeRequests, 'mergeRequests')
      const observedAt = iso(now())
      const items = nodes(connection, 'mergeRequests').flatMap((node, index) => {
        const mapped = mapMergeRequest(node, `mergeRequests[${index}]`, {
          fullPath,
          repoId,
          settings,
          observedAt,
          withBody: false,
        })
        return mapped ? [mapped] : []
      })
      const pageInfo = obj(connection.pageInfo, 'pageInfo')
      const end = optStr(pageInfo.endCursor, 'endCursor', 512)
      return {
        items,
        ...(pageInfo.hasNextPage === true && end ? { nextCursor: encodeCursor(end) } : {}),
        observedAt,
      } satisfies DevRuntimePage<GitHubPullRequestSummary>
    },

    'dev.gitlab.pullRequestSummary': async (command) => {
      devOperationDecoders['dev.gitlab.pullRequestSummary'].request(command.body)
      const { parts } = prOf(command)
      return (await readSummary(parts, true)).summary
    },

    'dev.gitlab.pullRequest': async (command) => {
      devOperationDecoders['dev.gitlab.pullRequest'].request(command.body)
      const { parts } = prOf(command)
      return restPullRequest(parts, await readRest(parts))
    },

    'dev.gitlab.timeline': async (command) => {
      devOperationDecoders['dev.gitlab.timeline'].request(command.body)
      const { parts } = prOf(command)
      const host = hostOf(parts.fullPath)
      const discussions: unknown[] = []
      let after: string | null = null
      for (let page = 0; page < 10; page += 1) {
        const data = await graphql(
          host,
          DISCUSSIONS_QUERY,
          { path: parts.fullPath, iid: String(parts.iid), after },
          'discussion listing'
        )
        const connection = obj(
          obj(obj(data.project, 'project').mergeRequest, 'mergeRequest').discussions,
          'discussions'
        )
        discussions.push(...nodes(connection, 'discussions'))
        const pageInfo = obj(connection.pageInfo, 'pageInfo')
        if (pageInfo.hasNextPage !== true) break
        after = str(pageInfo.endCursor, 'endCursor', 512)
      }
      const items = mapDiscussions(discussions)
      const commits = await graphql(
        host,
        COMMITS_QUERY,
        { path: parts.fullPath, iid: String(parts.iid), first: 100, after: null },
        'commit listing'
      )
      const mr = obj(obj(commits.project, 'project').mergeRequest, 'mergeRequest')
      const head = optStr(mr.diffHeadSha, 'diffHeadSha', 64)
      const headState = pipelineState(
        mr.headPipeline ? obj(mr.headPipeline, 'headPipeline').status : undefined
      )
      for (const [index, node] of nodes(mr.commits, 'commits').entries()) {
        const commit = obj(node, `commits[${index}]`)
        const sha = gitSha(commit.sha, `commits[${index}].sha`)
        const login = commit.author
          ? optStr(obj(commit.author, 'author').username, 'author.username', 100)
          : undefined
        const authorName = optStr(commit.authorName, 'authorName', 256)
        items.push({
          kind: 'commit',
          id: sha,
          sha,
          headline: bounded(commit.title, `commits[${index}].title`, 1024),
          ...(login ? { authorLogin: login } : {}),
          ...(authorName ? { authorName } : {}),
          checks: sha === head ? headState : 'none',
          createdAt: requiredIsoTimestamp(commit.authoredDate, `commits[${index}].authoredDate`),
        })
      }
      items.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      return {
        items: items.slice(0, 100),
        observedAt: iso(now()),
      } satisfies DevRuntimePage<GitHubTimelineItem>
    },

    'dev.gitlab.commits': async (command) => {
      const body = devOperationDecoders['dev.gitlab.commits'].request(command.body)
      const { parts } = prOf(command)
      const after =
        body.cursor === undefined
          ? null
          : Buffer.from(String(body.cursor), 'base64url').toString('utf8')
      const data = await graphql(
        hostOf(parts.fullPath),
        COMMITS_QUERY,
        { path: parts.fullPath, iid: String(parts.iid), first: Number(body.limit ?? 100), after },
        'commit listing'
      )
      const mr = obj(obj(data.project, 'project').mergeRequest, 'mergeRequest')
      const head = optStr(mr.diffHeadSha, 'diffHeadSha', 64)
      const headState = pipelineState(
        mr.headPipeline ? obj(mr.headPipeline, 'headPipeline').status : undefined
      )
      const connection = obj(mr.commits, 'commits')
      const items = nodes(connection, 'commits').map((node, index): GitHubCommitSummary => {
        const commit = obj(node, `commits[${index}]`)
        const sha = gitSha(commit.sha, `commits[${index}].sha`)
        const login = commit.author
          ? optStr(obj(commit.author, 'author').username, 'author.username', 100)
          : undefined
        const authorName = optStr(commit.authorName, 'authorName', 256)
        return {
          sha,
          headline: bounded(commit.title, `commits[${index}].title`, 1024),
          ...(login ? { authorLogin: login } : {}),
          ...(authorName ? { authorName } : {}),
          committedAt: requiredIsoTimestamp(commit.authoredDate, `commits[${index}].authoredDate`),
          checks: sha === head ? headState : 'none',
        }
      })
      // GitLab lists newest first; the contract is oldest first like GitHub.
      items.reverse()
      const pageInfo = obj(connection.pageInfo, 'pageInfo')
      const end = optStr(pageInfo.endCursor, 'endCursor', 512)
      return {
        items,
        ...(pageInfo.hasNextPage === true && end ? { nextCursor: encodeCursor(end) } : {}),
        observedAt: iso(now()),
      }
    },

    'dev.gitlab.files': async (command) => {
      const body = devOperationDecoders['dev.gitlab.files'].request(command.body)
      const { parts } = prOf(command)
      const limit = Number(body.limit ?? 100)
      const start =
        body.cursor === undefined
          ? 0
          : Number(Buffer.from(String(body.cursor), 'base64url').toString('utf8'))
      if (!Number.isSafeInteger(start) || start < 0 || start % limit !== 0)
        throw devError('not_found', 'unknown listing cursor')
      const payload = await rest(
        hostOf(parts.fullPath),
        `${projectId(parts.fullPath)}/merge_requests/${parts.iid}/diffs?per_page=${limit}&page=${start / limit + 1}`,
        { operation: 'diff listing', maxOutputBytes: LOG_READ_BUDGET }
      )
      const items = arr(payload, 'diffs').map((entry, index) => mapDiff(entry, `diffs[${index}]`))
      return {
        items,
        ...(items.length === limit ? { nextCursor: encodeCursor(String(start + limit)) } : {}),
        observedAt: iso(now()),
      }
    },

    'dev.gitlab.checks': async (command) => {
      const body = devOperationDecoders['dev.gitlab.checks'].request(command.body)
      const { parts } = prOf(command)
      const host = hostOf(parts.fullPath)
      // The merge request's head pipeline is the one GitLab gates merging
      // on; other pipelines for the same commit (branch pipelines, child
      // pipelines) are only the answer for an older commit.
      const head = await graphql(
        host,
        HEAD_JOBS_QUERY,
        { path: parts.fullPath, iid: String(parts.iid) },
        'pipeline read'
      )
      const mr = obj(obj(head.project, 'project').mergeRequest, 'mergeRequest')
      let jobsOwner: unknown = mr.headPipeline
      if (body.sha !== undefined && String(body.sha) !== mr.diffHeadSha) {
        const data = await graphql(
          host,
          SHA_JOBS_QUERY,
          { path: parts.fullPath, sha: String(body.sha) },
          'pipeline read'
        )
        jobsOwner = nodes(obj(data.project, 'project').pipelines, 'pipelines')[0]
      }
      const items = jobsOwner
        ? nodes(obj(jobsOwner, 'pipeline').jobs, 'jobs').map((job, index) =>
            mapJob(job, `jobs[${index}]`)
          )
        : []
      return {
        items: items.slice(0, Number(body.limit ?? 100)),
        observedAt: iso(now()),
      } satisfies DevRuntimePage<GitHubCheck>
    },

    'dev.gitlab.checkLog': async (command) => {
      const body = devOperationDecoders['dev.gitlab.checkLog'].request(command.body)
      const { parts } = prOf(command)
      const checkId = String(body.checkId)
      if (!/^\d{1,20}$/.test(checkId)) throw devError('identity_mismatch', 'check id is malformed')
      const raw = String(
        await rest(hostOf(parts.fullPath), `${projectId(parts.fullPath)}/jobs/${checkId}/trace`, {
          operation: 'job log read',
          text: true,
          maxOutputBytes: LOG_READ_BUDGET,
        })
      )
      const tail = raw.length > LOG_TAIL_MAX ? raw.slice(raw.length - LOG_TAIL_MAX) : raw
      // GitLab section markers (`section_start:…:name\r\x1b[0K`) strip with the escapes.
      const cleaned = cleanText(
        tail.replace(/section_(?:start|end):\d+:[A-Za-z0-9_.-]+(?:\[[^\]]*\])?\r?/g, ''),
        LOG_TAIL_MAX
      )
      return {
        checkId,
        text: cleaned.text,
        truncated: raw.length > LOG_TAIL_MAX || cleaned.truncated,
        observedAt: iso(now()),
      } satisfies GitHubCheckLog
    },

    'dev.gitlab.labels': async (command) => {
      devOperationDecoders['dev.gitlab.labels'].request(command.body)
      const { fullPath, host } = await repoOf(command)
      const data = await graphql(
        host,
        LABELS_QUERY,
        { path: fullPath, after: null },
        'label listing'
      )
      const items = nodes(obj(data.project, 'project').labels, 'labels').map(
        (entry, index): GitHubLabel => {
          const label = obj(entry, `labels[${index}]`)
          const color = optStr(label.color, `labels[${index}].color`, 32)
            ?.replace(/^#/, '')
            .toLowerCase()
          const description = optStr(label.description, `labels[${index}].description`, 4096)
          return {
            name: str(label.title, `labels[${index}].title`, 256),
            ...(color && /^[0-9a-f]{6}$/.test(color) ? { color } : {}),
            ...(description ? { description: cleanText(description, 1024).text } : {}),
          }
        }
      )
      return { items, observedAt: iso(now()) } satisfies DevRuntimePage<GitHubLabel>
    },

    'dev.gitlab.assignableUsers': async (command) => {
      const body = devOperationDecoders['dev.gitlab.assignableUsers'].request(command.body)
      const { fullPath, host } = await repoOf(command)
      const query = String(body.query ?? '')
      const data = await graphql(
        host,
        MEMBERS_QUERY,
        { path: fullPath, search: query || null, first: Number(body.limit ?? 50) },
        'member listing'
      )
      const items = nodes(obj(data.project, 'project').projectMembers, 'projectMembers').flatMap(
        (entry, index) => {
          const member = obj(entry, `projectMembers[${index}]`)
          const actor = member.user
            ? actorOf(member.user, `projectMembers[${index}].user`)
            : undefined
          return actor ? [{ ...actor, kind: 'user' as const }] : []
        }
      )
      return { items, observedAt: iso(now()) } satisfies DevRuntimePage<GitHubActor>
    },

    'dev.gitlab.branches': async (command) => {
      const body = devOperationDecoders['dev.gitlab.branches'].request(command.body)
      const { fullPath, host } = await repoOf(command)
      const limit = Number(body.limit ?? 100)
      const start =
        body.cursor === undefined
          ? 0
          : Number(Buffer.from(String(body.cursor), 'base64url').toString('utf8'))
      if (!Number.isSafeInteger(start) || start < 0 || start % limit !== 0)
        throw devError('not_found', 'unknown listing cursor')
      const payload = await rest(
        host,
        `${projectId(fullPath)}/repository/branches?per_page=${limit}&page=${start / limit + 1}`,
        {
          operation: 'branch listing',
        }
      )
      const items = arr(payload, 'branches').map((entry, index): GitHubBranch => {
        const branch = obj(entry, `branches[${index}]`)
        return {
          name: str(branch.name, `branches[${index}].name`, 255),
          sha: gitSha(
            obj(branch.commit, `branches[${index}].commit`).id,
            `branches[${index}].commit.id`
          ),
          protected: branch.protected === true,
        }
      })
      return {
        items,
        ...(items.length === limit ? { nextCursor: encodeCursor(String(start + limit)) } : {}),
        observedAt: iso(now()),
      }
    },

    'dev.gitlab.compare': async (command) => {
      const body = devOperationDecoders['dev.gitlab.compare'].request(command.body)
      const { fullPath, host } = await repoOf(command)
      const baseRef = String(body.baseRef)
      const headRef = String(body.headRef)
      if (
        !REF_PATTERN.test(baseRef) ||
        !REF_PATTERN.test(headRef) ||
        baseRef.includes('..') ||
        headRef.includes('..')
      )
        throw devError('identity_mismatch', 'base and head must be simple branch names')
      const forward = obj(
        await rest(
          host,
          `${projectId(fullPath)}/repository/compare?from=${encodeURIComponent(baseRef)}&to=${encodeURIComponent(headRef)}&straight=false`,
          {
            operation: 'compare',
            maxOutputBytes: LOG_READ_BUDGET,
          }
        ),
        'compare'
      )
      const backward = obj(
        await rest(
          host,
          `${projectId(fullPath)}/repository/compare?from=${encodeURIComponent(headRef)}&to=${encodeURIComponent(baseRef)}&straight=false`,
          {
            operation: 'compare',
            maxOutputBytes: LOG_READ_BUDGET,
          }
        ),
        'compare'
      )
      const diffs = arr(forward.diffs ?? [], 'compare.diffs')
      let additions = 0
      let deletions = 0
      for (const [index, entry] of diffs.entries()) {
        const counts = patchCounts(
          optStr(obj(entry, `diffs[${index}]`).diff, `diffs[${index}].diff`, 16 * 1024 * 1024) ?? ''
        )
        additions += counts.additions
        deletions += counts.deletions
      }
      const aheadBy = arr(forward.commits ?? [], 'compare.commits').length
      const behindBy = arr(backward.commits ?? [], 'compare.commits').length
      return {
        baseRef,
        headRef,
        status:
          aheadBy === 0 && behindBy === 0
            ? 'identical'
            : behindBy === 0
              ? 'ahead'
              : aheadBy === 0
                ? 'behind'
                : 'diverged',
        aheadBy,
        behindBy,
        commitCount: aheadBy,
        changedFiles: diffs.length,
        additions,
        deletions,
        observedAt: iso(now()),
      } satisfies GitHubCompare
    },

    // ── Writes ──────────────────────────────────────────────────────────────

    'dev.gitlab.comment': async (command) => {
      const body = devOperationDecoders['dev.gitlab.comment'].request(command.body)
      const { parts } = prOf(command)
      const note = obj(
        await rest(
          hostOf(parts.fullPath),
          `${projectId(parts.fullPath)}/merge_requests/${parts.iid}/notes`,
          {
            method: 'POST',
            body: { body: String(body.body).slice(0, BODY_MAX) },
            operation: 'comment',
          }
        ),
        'note'
      )
      const author = note.author ? obj(note.author, 'note.author') : undefined
      return {
        kind: 'comment',
        id: String(num(note.id, 'note.id')),
        ...(author
          ? {
              author: {
                login: str(author.username, 'author.username', 255),
                kind: author.bot === true ? 'bot' : 'user',
              },
            }
          : {}),
        body: bounded(note.body, 'note.body', BODY_MAX),
        createdAt: requiredIsoTimestamp(note.created_at, 'note.created_at'),
      } satisfies GitHubTimelineItem
    },

    'dev.gitlab.threadReply': async (command) => {
      const body = devOperationDecoders['dev.gitlab.threadReply'].request(command.body)
      const { parts } = prOf(command)
      const threadId = String(body.threadId)
      if (!/^[0-9a-f]{8,64}$/.test(threadId))
        throw devError('identity_mismatch', 'discussion id is malformed')
      // The discussion endpoint is scoped to this merge request: a thread
      // from another one answers not_found before anything is written.
      await threadOf(parts, threadId)
      await rest(
        hostOf(parts.fullPath),
        `${projectId(parts.fullPath)}/merge_requests/${parts.iid}/discussions/${threadId}/notes`,
        {
          method: 'POST',
          body: { body: String(body.body).slice(0, BODY_MAX) },
          operation: 'thread reply',
        }
      )
      return threadOf(parts, threadId)
    },

    'dev.gitlab.threadResolve': async (command) => {
      const body = devOperationDecoders['dev.gitlab.threadResolve'].request(command.body)
      const { parts } = prOf(command)
      const threadId = String(body.threadId)
      if (!/^[0-9a-f]{8,64}$/.test(threadId))
        throw devError('identity_mismatch', 'discussion id is malformed')
      await threadOf(parts, threadId)
      await rest(
        hostOf(parts.fullPath),
        `${projectId(parts.fullPath)}/merge_requests/${parts.iid}/discussions/${threadId}?resolved=${body.resolved === true}`,
        { method: 'PUT', operation: 'thread resolve' }
      )
      return threadOf(parts, threadId)
    },

    'dev.gitlab.metadataUpdate': async (command) => {
      const body = devOperationDecoders['dev.gitlab.metadataUpdate'].request(command.body)
      const { parts } = prOf(command)
      const host = hostOf(parts.fullPath)
      type Delta = { add: readonly string[]; remove: readonly string[] }
      const reviewers = body.reviewers as Delta | undefined
      const assignees = body.assignees as Delta | undefined
      const labels = body.labels as Delta | undefined
      if (!reviewers && !assignees && !labels)
        throw devError('invalid_state', 'the update carries no changes')
      const current = await readRest(parts)
      const update: Record<string, unknown> = {}
      if (reviewers) {
        const add = await userIds(host, reviewers.add)
        const remove = new Set(await userIds(host, reviewers.remove))
        update.reviewer_ids = [
          ...new Set([...idsOf(current.reviewers, 'reviewers'), ...add]),
        ].filter((id) => !remove.has(id))
      }
      if (assignees) {
        const add = await userIds(host, assignees.add)
        const remove = new Set(await userIds(host, assignees.remove))
        update.assignee_ids = [
          ...new Set([...idsOf(current.assignees, 'assignees'), ...add]),
        ].filter((id) => !remove.has(id))
      }
      if (labels?.add.length) update.add_labels = labels.add.join(',')
      if (labels?.remove.length) update.remove_labels = labels.remove.join(',')
      await rest(host, `${projectId(parts.fullPath)}/merge_requests/${parts.iid}`, {
        method: 'PUT',
        body: update,
        operation: 'merge request update',
      })
      return (await readSummary(parts, true)).summary
    },

    'dev.gitlab.submitReview': async (command) => {
      const body = devOperationDecoders['dev.gitlab.submitReview'].request(command.body)
      const { parts } = prOf(command)
      const host = hostOf(parts.fullPath)
      const verdict = String(body.verdict)
      const text = String(body.body)
      const comments = (body.comments ?? []) as readonly {
        path: string
        line: number
        side: 'left' | 'right'
        body: string
      }[]
      if (verdict === 'request_changes')
        throw devError(
          'unsupported_capability',
          'GitLab has no request-changes review verdict in this contract; comment instead'
        )
      if (verdict === 'comment' && text.trim().length === 0 && comments.length === 0)
        throw devError('invalid_state', 'a comment review needs a summary or inline comments')
      const current = await readRest(parts)
      if (str(current.state, 'state', 32) !== 'opened')
        throw devError('invalid_state', 'the merge request is not open')
      if (gitSha(current.sha, 'sha') !== String(body.expectedHeadSha))
        throw devError('stale_version', 'the merge request head moved on since you read the diff')
      const refs = obj(current.diff_refs, 'diff_refs')
      const base = `${projectId(parts.fullPath)}/merge_requests/${parts.iid}`
      for (const comment of comments) {
        await rest(host, `${base}/discussions`, {
          method: 'POST',
          body: {
            body: comment.body,
            position: {
              position_type: 'text',
              base_sha: refs.base_sha,
              start_sha: refs.start_sha,
              head_sha: refs.head_sha,
              old_path: comment.path,
              new_path: comment.path,
              ...(comment.side === 'left'
                ? { old_line: comment.line }
                : { new_line: comment.line }),
            },
          },
          operation: 'review comment',
        })
      }
      if (text.trim().length > 0)
        await rest(host, `${base}/notes`, {
          method: 'POST',
          body: { body: text },
          operation: 'review summary',
        })
      if (verdict === 'approve')
        await rest(host, `${base}/approve`, {
          method: 'POST',
          body: { sha: String(body.expectedHeadSha) },
          operation: 'approve',
        })
      const user = obj(
        await rest(host, 'user', { operation: 'account read', cacheKey: 'account' }),
        'user'
      )
      return {
        kind: 'review',
        id: `review:${parts.iid}:${randomUUID()}`.slice(0, 128),
        author: { login: str(user.username, 'user.username', 255), kind: 'user' },
        state: verdict === 'approve' ? 'approved' : 'commented',
        body: cleanText(text, BODY_MAX).text,
        commitSha: String(body.expectedHeadSha),
        createdAt: iso(now()),
      } satisfies GitHubTimelineItem
    },

    'dev.gitlab.rerunFailedJobs': async (command) => {
      const body = devOperationDecoders['dev.gitlab.rerunFailedJobs'].request(command.body)
      const { parts } = prOf(command)
      const host = hostOf(parts.fullPath)
      const checkId = String(body.checkId)
      if (!/^\d{1,20}$/.test(checkId)) throw devError('identity_mismatch', 'check id is malformed')
      const job = obj(
        await rest(host, `${projectId(parts.fullPath)}/jobs/${checkId}`, { operation: 'job read' }),
        'job'
      )
      const current = await readRest(parts)
      if (optStr(job.ref, 'job.ref', 512) !== str(current.source_branch, 'source_branch', 512))
        throw devError('identity_mismatch', 'the job did not run for this merge request branch')
      const pipelineId = String(num(obj(job.pipeline, 'job.pipeline').id, 'job.pipeline.id'))
      await rest(host, `${projectId(parts.fullPath)}/pipelines/${pipelineId}/retry`, {
        method: 'POST',
        operation: 're-run failed jobs',
      })
      return { checkId, runId: pipelineId, observedAt: iso(now()) } satisfies GitHubRerunResult
    },

    'dev.gitlab.createPullRequest': async (command) => {
      const body = devOperationDecoders['dev.gitlab.createPullRequest'].request(command.body)
      const { fullPath, host } = await repoOf(command)
      const headRef = String(body.headRef)
      const baseRef = String(body.baseRef)
      const title = String(body.title)
      if (title.length === 0 || title.length > TITLE_MAX)
        throw devError('invalid_state', `title must be 1..${TITLE_MAX} characters`)
      if (!REF_PATTERN.test(headRef) || !REF_PATTERN.test(baseRef) || headRef === baseRef)
        throw devError('identity_mismatch', 'head/base refs must be distinct simple branch names')
      const parts = (iid: number): Parts => ({ fullPath, iid })
      // GitLab allows one open merge request per source/target pair, so a
      // retry reconciles onto the existing one instead of duplicating.
      const existing = async () =>
        arr(
          await rest(
            host,
            `${projectId(fullPath)}/merge_requests?state=opened&source_branch=${encodeURIComponent(headRef)}&target_branch=${encodeURIComponent(baseRef)}`,
            { operation: 'merge request search' }
          ),
          'mergeRequests'
        )[0]
      const found = await existing()
      if (found) {
        const item = obj(found, 'mergeRequest')
        return restPullRequest(parts(num(item.iid, 'iid')), item, { reconciled: true })
      }
      let created: Record<string, unknown>
      try {
        created = obj(
          await rest(host, `${projectId(fullPath)}/merge_requests`, {
            method: 'POST',
            body: {
              source_branch: headRef,
              target_branch: baseRef,
              title: `Draft: ${title}`,
              description: String(body.body),
            },
            operation: 'merge request create',
          }),
          'mergeRequest'
        )
      } catch (error) {
        const again = await existing().catch(() => undefined)
        if (again) {
          const item = obj(again, 'mergeRequest')
          return restPullRequest(parts(num(item.iid, 'iid')), item, { reconciled: true })
        }
        throw error
      }
      return restPullRequest(parts(num(created.iid, 'iid')), created, { reconciled: false })
    },

    'dev.gitlab.updatePlan': async (command) => {
      const body = devOperationDecoders['dev.gitlab.updatePlan'].request(command.body)
      const { pullRequestId, parts } = prOf(command)
      const current = await readRest(parts)
      const pr = await restPullRequest(parts, current)
      if (pr.version !== Number(body.expectedVersion))
        throw devError(
          'stale_version',
          'the merge request read model moved on; refresh before planning'
        )
      const patch = body.patch as Record<string, unknown>
      const normalized: Record<string, unknown> = {}
      for (const key of ['title', 'body', 'draft', 'baseRef', 'state'] as const)
        if (patch[key] !== undefined) normalized[key] = patch[key]
      if (Object.keys(normalized).length === 0)
        throw devError('invalid_state', 'the patch carries no supported fields')
      const entry: Plan = {
        kind: 'update',
        pullRequestId,
        updatedAt: pr.updatedAt,
        patch: normalized,
        expiresAt: now() + PLAN_TTL_MS,
        digest: digestOf({
          kind: 'update',
          pullRequestId,
          updatedAt: pr.updatedAt,
          patch: normalized,
        }),
      }
      return issuePlan(
        entry,
        'dev.gitlab.updateCommit',
        { updatedAt: pr.updatedAt, headSha: pr.headSha },
        'gitlab_mr_update',
        []
      )
    },

    'dev.gitlab.updateCommit': async (command) => {
      const body = devOperationDecoders['dev.gitlab.updateCommit'].request(command.body)
      requireScope(command)
      const entry = livePlan(body.planId, 'update', body.planDigest)
      const parts = bindCommit(command, entry)
      const current = await readRest(parts)
      if (requiredIsoTimestamp(current.updated_at, 'updated_at') !== entry.updatedAt)
        throw devError('stale_version', 'the merge request moved on since the plan was made')
      const state = str(current.state, 'state', 32)
      const patch = entry.patch
      if (patch.state !== undefined && state === 'merged')
        throw devError('invalid_state', 'a merged merge request cannot be closed or reopened')
      const update: Record<string, unknown> = {}
      const baseTitle =
        typeof patch.title === 'string'
          ? String(patch.title).slice(0, TITLE_MAX)
          : displayTitle(str(current.title, 'title', 1024))
      const draft = typeof patch.draft === 'boolean' ? patch.draft : current.draft === true
      // GitLab marks drafts with a title prefix.
      if (typeof patch.title === 'string' || typeof patch.draft === 'boolean')
        update.title = draft ? `Draft: ${baseTitle}` : baseTitle
      if (typeof patch.body === 'string') update.description = String(patch.body).slice(0, BODY_MAX)
      if (typeof patch.baseRef === 'string') {
        if (!REF_PATTERN.test(String(patch.baseRef)))
          throw devError('identity_mismatch', 'baseRef is not a simple branch name')
        update.target_branch = patch.baseRef
      }
      if (patch.state === 'closed') update.state_event = 'close'
      if (patch.state === 'open') update.state_event = 'reopen'
      const updated = obj(
        await rest(
          hostOf(parts.fullPath),
          `${projectId(parts.fullPath)}/merge_requests/${parts.iid}`,
          {
            method: 'PUT',
            body: update,
            operation: 'merge request update',
          }
        ),
        'mergeRequest'
      )
      plans.delete(String(body.planId))
      return restPullRequest(parts, updated)
    },

    'dev.gitlab.mergePlan': async (command) => {
      const body = devOperationDecoders['dev.gitlab.mergePlan'].request(command.body)
      const { pullRequestId, parts } = prOf(command)
      const { summary } = await readSummary(parts, false)
      if (summary.state !== 'open')
        throw devError('invalid_state', `the merge request is ${summary.state}, not open`)
      if (summary.draft) throw devError('invalid_state', 'draft merge requests cannot be merged')
      if (summary.headSha !== String(body.expectedHeadSha))
        throw devError(
          'stale_version',
          'the merge request head moved on since the caller observed it'
        )
      const method = String(body.method) as GitHubMergeMethod
      const blockers: DevError[] = []
      if (!summary.mergeMethods.includes(method))
        blockers.push(
          blocker('unsupported_capability', `the project does not allow ${method} merges`)
        )
      if (summary.mergeable === 'conflicting')
        blockers.push(blocker('conflicted', 'the merge request has conflicts with its target'))
      if (summary.reviewDecision === 'changes_requested')
        blockers.push(blocker('invalid_state', 'a reviewer requested changes'))
      if (summary.checks.state === 'failure' || summary.checks.failing > 0)
        blockers.push(blocker('invalid_state', 'the pipeline is failing'))
      if (summary.checks.state === 'pending')
        blockers.push(blocker('invalid_state', 'the pipeline is still running'))
      if (summary.mergeState === 'blocked')
        blockers.push(
          blocker('invalid_state', 'GitLab reports the merge request is not ready to merge')
        )
      const deleteBranch = body.deleteBranch === true
      const entry: Plan = {
        kind: 'merge',
        pullRequestId,
        headSha: summary.headSha,
        method,
        deleteBranch,
        expiresAt: now() + PLAN_TTL_MS,
        digest: digestOf({
          kind: 'merge',
          pullRequestId,
          headSha: summary.headSha,
          method,
          deleteBranch,
        }),
      }
      return issuePlan(
        entry,
        'dev.gitlab.mergeCommit',
        { headSha: summary.headSha, method },
        'gitlab_mr_merge',
        blockers
      )
    },

    'dev.gitlab.mergeCommit': async (command) => {
      const body = devOperationDecoders['dev.gitlab.mergeCommit'].request(command.body)
      requireScope(command)
      const entry = livePlan(body.planId, 'merge', body.planDigest)
      const parts = bindCommit(command, entry)
      const host = hostOf(parts.fullPath)
      const current = await readRest(parts)
      if (str(current.state, 'state', 32) !== 'opened')
        throw devError('invalid_state', 'the merge request is not open')
      if (gitSha(current.sha, 'sha') !== entry.headSha)
        throw devError(
          'stale_version',
          'the merge request head moved on since the merge plan was made'
        )
      const cross = String(current.source_project_id) !== String(current.target_project_id)
      await rest(host, `${projectId(parts.fullPath)}/merge_requests/${parts.iid}/merge`, {
        method: 'PUT',
        body: {
          sha: entry.headSha,
          squash: entry.method === 'squash',
          should_remove_source_branch: entry.deleteBranch && !cross,
        },
        operation: 'merge',
      })
      plans.delete(String(body.planId))
      const merged = await readRest(parts)
      let headBranchDeleted: boolean | undefined
      if (entry.deleteBranch) {
        const branch = await runGlab([
          'api',
          `${projectId(parts.fullPath)}/repository/branches/${encodeURIComponent(str(merged.source_branch, 'source_branch', 512))}`,
          '--hostname',
          host,
        ])
        headBranchDeleted = !cross && branch.exitCode !== 0 && /404|not found/i.test(branch.stderr)
      }
      return restPullRequest(
        parts,
        merged,
        headBranchDeleted === undefined ? {} : { headBranchDeleted }
      )
    },

    'dev.gitlab.autoMergePlan': async (command) => {
      const body = devOperationDecoders['dev.gitlab.autoMergePlan'].request(command.body)
      const { pullRequestId, parts } = prOf(command)
      const { summary } = await readSummary(parts, false)
      if (summary.state !== 'open')
        throw devError('invalid_state', `the merge request is ${summary.state}, not open`)
      if (summary.headSha !== String(body.expectedHeadSha))
        throw devError(
          'stale_version',
          'the merge request head moved on since the caller observed it'
        )
      const enabled = body.enabled === true
      const method = (body.method ?? summary.mergeMethods[0] ?? 'merge') as GitHubMergeMethod
      const blockers: DevError[] = []
      if (enabled) {
        if (!summary.mergeMethods.includes(method))
          blockers.push(
            blocker('unsupported_capability', `the project does not allow ${method} merges`)
          )
        if (summary.draft)
          blockers.push(
            blocker('invalid_state', 'mark the merge request ready before enabling auto-merge')
          )
        if (summary.checks.state === 'none')
          blockers.push(
            blocker(
              'invalid_state',
              'auto-merge waits for a pipeline, and this merge request has none'
            )
          )
        if (summary.autoMerge)
          blockers.push(blocker('already_completed', 'auto-merge is already enabled'))
      } else if (!summary.autoMerge)
        blockers.push(blocker('already_completed', 'auto-merge is not enabled'))
      const entry: Plan = {
        kind: 'auto-merge',
        pullRequestId,
        headSha: summary.headSha,
        enabled,
        method,
        expiresAt: now() + PLAN_TTL_MS,
        digest: digestOf({
          kind: 'auto-merge',
          pullRequestId,
          headSha: summary.headSha,
          enabled,
          method,
        }),
      }
      return issuePlan(
        entry,
        'dev.gitlab.autoMergeCommit',
        { headSha: summary.headSha, method, enabled: String(enabled) },
        'gitlab_auto_merge',
        blockers
      )
    },

    'dev.gitlab.autoMergeCommit': async (command) => {
      const body = devOperationDecoders['dev.gitlab.autoMergeCommit'].request(command.body)
      requireScope(command)
      const entry = livePlan(body.planId, 'auto-merge', body.planDigest)
      const parts = bindCommit(command, entry)
      const host = hostOf(parts.fullPath)
      const current = await readRest(parts)
      if (gitSha(current.sha, 'sha') !== entry.headSha)
        throw devError('stale_version', 'the merge request head moved on since the plan was made')
      const base = `${projectId(parts.fullPath)}/merge_requests/${parts.iid}`
      if (entry.enabled)
        await rest(host, `${base}/merge`, {
          method: 'PUT',
          body: {
            sha: entry.headSha,
            merge_when_pipeline_succeeds: true,
            squash: entry.method === 'squash',
          },
          operation: 'enable auto-merge',
        })
      else
        await rest(host, `${base}/cancel_merge_when_pipeline_succeeds`, {
          method: 'POST',
          operation: 'disable auto-merge',
        })
      plans.delete(String(body.planId))
      return (await readSummary(parts, true)).summary
    },

    'dev.gitlab.syncBranchPlan': async (command) => {
      const body = devOperationDecoders['dev.gitlab.syncBranchPlan'].request(command.body)
      const { pullRequestId, parts } = prOf(command)
      const { summary } = await readSummary(parts, true)
      if (summary.state !== 'open')
        throw devError('invalid_state', `the merge request is ${summary.state}, not open`)
      if (summary.headSha !== String(body.expectedHeadSha))
        throw devError(
          'stale_version',
          'the merge request head moved on since the caller observed it'
        )
      const blockers: DevError[] = []
      if (String(body.method) !== 'rebase')
        blockers.push(
          blocker('unsupported_capability', 'GitLab updates a merge request branch by rebasing it')
        )
      if (summary.behindBy === 0)
        blockers.push(blocker('already_completed', 'the branch already contains its target'))
      if (summary.mergeable === 'conflicting')
        blockers.push(
          blocker('conflicted', 'the branch conflicts with its target; resolve it locally')
        )
      const entry: Plan = {
        kind: 'rebase',
        pullRequestId,
        headSha: summary.headSha,
        expiresAt: now() + PLAN_TTL_MS,
        digest: digestOf({ kind: 'rebase', pullRequestId, headSha: summary.headSha }),
      }
      return issuePlan(
        entry,
        'dev.gitlab.syncBranchCommit',
        { headSha: summary.headSha, method: 'rebase' },
        'gitlab_branch_rebase',
        blockers
      )
    },

    'dev.gitlab.syncBranchCommit': async (command) => {
      const body = devOperationDecoders['dev.gitlab.syncBranchCommit'].request(command.body)
      requireScope(command)
      const entry = livePlan(body.planId, 'rebase', body.planDigest)
      const parts = bindCommit(command, entry)
      const current = await readRest(parts)
      if (gitSha(current.sha, 'sha') !== entry.headSha)
        throw devError('stale_version', 'the merge request head moved on since the plan was made')
      await rest(
        hostOf(parts.fullPath),
        `${projectId(parts.fullPath)}/merge_requests/${parts.iid}/rebase`,
        { method: 'PUT', operation: 'rebase' }
      )
      plans.delete(String(body.planId))
      return (await readSummary(parts, true)).summary
    },
  }

  let registeredCommands = 0
  for (const [operation, handler] of Object.entries(handlers)) {
    if (!handler) continue
    input.authority.registerCommandProvider(operation as DevOperation, async (command) => {
      try {
        return await handler(command)
      } catch (error) {
        const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown }
        if (
          candidate &&
          typeof candidate.code === 'string' &&
          typeof candidate.message === 'string'
        )
          throw {
            code: candidate.code,
            retryable: candidate.retryable === true,
            message: redact(candidate.message),
          }
        throw devError(
          error instanceof Error && error.name === 'UntrustedError'
            ? 'corrupt_state'
            : 'invalid_state',
          redact(error instanceof Error ? error.message : 'gitlab operation failed')
        )
      }
    })
    registeredCommands += 1
  }
  return { commands: Object.keys(handlers) as DevOperation[], registeredCommands }
}
