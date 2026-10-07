/*
 * GitHub GraphQL documents and untrusted-payload mappers for the source
 * control app's collaboration read models. Pure: no transport, no state.
 * Every payload is untrusted gh output, re-proven field by field; provider
 * text is bounded here and rendered by the client as text nodes only.
 */
import type {
  GitHubActor,
  GitHubChangedFile,
  GitHubCheckRollup,
  GitHubCheckRollupState,
  GitHubCommitSummary,
  GitHubLatestReview,
  GitHubLinkedIssue,
  GitHubMergeMethod,
  GitHubPullRequestSummary,
  GitHubReviewState,
  GitHubThreadComment,
  GitHubTimelineItem,
} from '../../../../../../packages/types/src/dev-runtime'
import {
  arr,
  bool,
  gitSha,
  isoTimestamp,
  literal,
  num,
  obj,
  optStr,
  requiredIsoTimestamp,
  str,
  untrusted,
} from './untrusted'

/** GraphQL's type discriminator field. */
export const TYPENAME = '__typename'
export const BODY_MAX = 65_536
export const PATCH_MAX = 262_144
export const DIFF_HUNK_MAX = 16_384

const ACTOR_FIELDS = `__typename login ... on User { name }`

const SUMMARY_FIELDS = `
  id number title url state isDraft
  author { ${ACTOR_FIELDS} }
  headRefName headRefOid baseRefName baseRefOid isCrossRepository
  additions deletions changedFiles
  commits { totalCount }
  labels(first: 50) { nodes { name } }
  assignees(first: 20) { nodes { login name } }
  reviewRequests(first: 20) {
    nodes {
      requestedReviewer {
        __typename
        ... on User { login name }
        ... on Bot { login }
        ... on Mannequin { login }
        ... on Team { combinedSlug name }
      }
    }
  }
  latestReviews(first: 50) {
    nodes { author { ${ACTOR_FIELDS} } state commit { oid } submittedAt }
  }
  reviewDecision mergeable mergeStateStatus
  autoMergeRequest { mergeMethod enabledBy { login } }
  viewerCanUpdateBranch
  closingIssuesReferences(first: 20) { nodes { number title state url } }
  createdAt updatedAt mergedAt closedAt
  rollup: commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 1) {
            checkRunCountsByState { state count }
            statusContextCountsByState { state count }
          }
        }
      }
    }
  }`

const REPOSITORY_SETTINGS = `mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed`

export const SUMMARIES_QUERY = `query($owner: String!, $name: String!, $states: [PullRequestState!], $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    ${REPOSITORY_SETTINGS}
    pullRequests(states: $states, first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${SUMMARY_FIELDS} }
    }
  }
}`

export const SUMMARY_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    ${REPOSITORY_SETTINGS}
    pullRequest(number: $number) { ${SUMMARY_FIELDS} body }
  }
}`

const THREAD_FIELDS = `
  id isResolved isOutdated path line originalLine startLine originalStartLine diffSide
  comments(first: 50) { nodes { id author { ${ACTOR_FIELDS} } body createdAt diffHunk } }
  pullRequest { number repository { owner { login } name } }`

export const TIMELINE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String, $withThreads: Boolean!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(first: $first, after: $after, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, REVIEW_REQUESTED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, BASE_REF_CHANGED_EVENT]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on IssueComment { id author { ${ACTOR_FIELDS} } body createdAt }
          ... on PullRequestReview { id author { ${ACTOR_FIELDS} } state body createdAt submittedAt commit { oid } }
          ... on PullRequestCommit {
            id
            commit { oid messageHeadline committedDate author { name user { login } } statusCheckRollup { state } }
          }
          ... on MergedEvent { id actor { ${ACTOR_FIELDS} } createdAt commit { oid } }
          ... on ClosedEvent { id actor { ${ACTOR_FIELDS} } createdAt }
          ... on ReopenedEvent { id actor { ${ACTOR_FIELDS} } createdAt }
          ... on ReadyForReviewEvent { id actor { ${ACTOR_FIELDS} } createdAt }
          ... on ConvertToDraftEvent { id actor { ${ACTOR_FIELDS} } createdAt }
          ... on ReviewRequestedEvent {
            id actor { ${ACTOR_FIELDS} } createdAt
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Bot { login }
              ... on Mannequin { login }
              ... on Team { combinedSlug }
            }
          }
          ... on HeadRefForcePushedEvent { id actor { ${ACTOR_FIELDS} } createdAt afterCommit { oid } }
          ... on BaseRefChangedEvent { id actor { ${ACTOR_FIELDS} } createdAt currentRefName }
        }
      }
      reviewThreads(first: 100) @include(if: $withThreads) { nodes { ${THREAD_FIELDS} } }
    }
  }
}`

export const THREAD_QUERY = `query($id: ID!) { node(id: $id) { __typename ... on PullRequestReviewThread { ${THREAD_FIELDS} } } }`

export const COMMITS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { commit { oid messageHeadline committedDate author { name user { login } } statusCheckRollup { state } } }
      }
    }
  }
}`

export const ASSIGNABLE_USERS_QUERY = `query($owner: String!, $name: String!, $query: String, $first: Int!) {
  repository(owner: $owner, name: $name) {
    assignableUsers(first: $first, query: $query) { nodes { login name } }
  }
}`

export const DEFAULT_BRANCH_HEAD_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit { oid statusCheckRollup { state } } } }
  }
}`

export const PULL_REQUEST_NODE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id headRefOid state isDraft } }
}`

export const REPLY_THREAD_MUTATION = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } }
}`

export const RESOLVE_THREAD_MUTATION = `mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { id } } }`
export const UNRESOLVE_THREAD_MUTATION = `mutation($thread: ID!) { unresolveReviewThread(input: { threadId: $thread }) { thread { id } } }`

export const ENABLE_AUTO_MERGE_MUTATION = `mutation($pr: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pr, mergeMethod: $method, expectedHeadOid: $head }) { clientMutationId }
}`
export const DISABLE_AUTO_MERGE_MUTATION = `mutation($pr: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pr }) { clientMutationId }
}`
export const UPDATE_BRANCH_MUTATION = `mutation($pr: ID!, $head: GitObjectID!, $method: PullRequestBranchUpdateMethod!) {
  updatePullRequestBranch(input: { pullRequestId: $pr, expectedHeadOid: $head, updateMethod: $method }) { clientMutationId }
}`
export const CONVERT_TO_DRAFT_MUTATION = `mutation($pr: ID!) { convertPullRequestToDraft(input: { pullRequestId: $pr }) { clientMutationId } }`
export const READY_FOR_REVIEW_MUTATION = `mutation($pr: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pr }) { clientMutationId } }`

// ─── Mapping ────────────────────────────────────────────────────────────────

/** GraphQL `data`, failing closed on an `errors` array or a missing body. */
export function graphqlData(payload: unknown): Record<string, unknown> {
  const item = obj(payload, 'graphql')
  if (Array.isArray(item.errors) && item.errors.length > 0) {
    const first = obj(item.errors[0], 'graphql.errors[0]')
    untrusted('graphql.errors', `no errors (${str(first.message ?? 'error', 'message', 512)})`)
  }
  return obj(item.data, 'graphql.data')
}

/** Strip terminal escapes and control characters from untrusted text,
 *  keeping newlines and tabs, then bound it. */
export function cleanText(text: string, max: number): { text: string; truncated: boolean } {
  const cleaned = text
    // oxlint-disable-next-line no-control-regex -- stripping provider escape sequences is intentional
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // oxlint-disable-next-line no-control-regex -- stripping provider control characters is intentional
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  return cleaned.length > max
    ? { text: cleaned.slice(0, max), truncated: true }
    : { text: cleaned, truncated: false }
}

function bounded(value: unknown, path: string, max: number): string {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') untrusted(path, 'string')
  return cleanText(value, max).text
}

export function mapActor(value: unknown, path: string): GitHubActor | undefined {
  if (value === null || value === undefined) return undefined
  const item = obj(value, path)
  const typename = optStr(item[TYPENAME], `${path}.__typename`, 64)
  if (typename === 'Team') {
    const slug = str(item.combinedSlug, `${path}.combinedSlug`, 201)
    const name = optStr(item.name, `${path}.name`, 256)
    return { login: slug, kind: 'team', ...(name ? { name } : {}) }
  }
  const login = str(item.login, `${path}.login`, 100)
  if (login.length === 0) return undefined
  const name = optStr(item.name, `${path}.name`, 256)
  const kind = typename === 'Bot' || login.endsWith('[bot]') ? 'bot' : 'user'
  return { login, kind, ...(name ? { name } : {}) }
}

function nodes(value: unknown, path: string): readonly unknown[] {
  if (value === null || value === undefined) return []
  return arr(obj(value, path).nodes ?? [], `${path}.nodes`).filter(
    (entry) => entry !== null && entry !== undefined
  )
}

const ROLLUP_STATES: Record<string, GitHubCheckRollupState> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'failure',
  PENDING: 'pending',
  EXPECTED: 'pending',
}

export function mapRollupState(value: unknown, path: string): GitHubCheckRollupState {
  if (value === null || value === undefined) return 'none'
  const item = obj(value, path)
  if (item.state === null || item.state === undefined) return 'none'
  return ROLLUP_STATES[str(item.state, `${path}.state`, 32)] ?? 'none'
}

const RUN_BUCKETS: Record<string, keyof Omit<GitHubCheckRollup, 'state' | 'total'>> = {
  SUCCESS: 'passing',
  NEUTRAL: 'passing',
  FAILURE: 'failing',
  TIMED_OUT: 'failing',
  CANCELLED: 'failing',
  ACTION_REQUIRED: 'failing',
  STARTUP_FAILURE: 'failing',
  STALE: 'failing',
  ERROR: 'failing',
  IN_PROGRESS: 'running',
  QUEUED: 'running',
  PENDING: 'running',
  WAITING: 'running',
  REQUESTED: 'running',
  EXPECTED: 'running',
  SKIPPED: 'skipped',
}

export function mapRollup(value: unknown, path: string): GitHubCheckRollup {
  const counts = { passing: 0, failing: 0, running: 0, skipped: 0 }
  if (value === null || value === undefined) return { state: 'none', ...counts, total: 0 }
  const item = obj(value, path)
  const contexts =
    item.contexts === null || item.contexts === undefined
      ? {}
      : obj(item.contexts, `${path}.contexts`)
  for (const key of ['checkRunCountsByState', 'statusContextCountsByState'] as const) {
    const rows =
      contexts[key] === null || contexts[key] === undefined ? [] : arr(contexts[key], key)
    rows.forEach((row, index) => {
      const entry = obj(row, `${path}.${key}[${index}]`)
      const bucket = RUN_BUCKETS[str(entry.state, `${path}.${key}[${index}].state`, 32)]
      if (bucket) counts[bucket] += num(entry.count, `${path}.${key}[${index}].count`)
    })
  }
  const total = counts.passing + counts.failing + counts.running + counts.skipped
  return { state: mapRollupState(item, path), ...counts, total }
}

const REVIEW_STATES: Record<string, GitHubReviewState> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
}

function reviewState(value: unknown, path: string): GitHubReviewState {
  const state = REVIEW_STATES[str(value, path, 32)]
  if (state === undefined) untrusted(path, 'review state')
  return state
}

const MERGE_METHODS: Record<string, GitHubMergeMethod> = {
  MERGE: 'merge',
  SQUASH: 'squash',
  REBASE: 'rebase',
}

export function graphqlMergeMethod(method: GitHubMergeMethod): string {
  return method.toUpperCase()
}

export type RepositorySettings = Readonly<{
  mergeMethods: readonly GitHubMergeMethod[]
  autoMergeAllowed: boolean
}>

export function mapRepositorySettings(value: unknown, path: string): RepositorySettings {
  const item = obj(value, path)
  const mergeMethods: GitHubMergeMethod[] = []
  if (bool(item.mergeCommitAllowed, `${path}.mergeCommitAllowed`)) mergeMethods.push('merge')
  if (bool(item.squashMergeAllowed, `${path}.squashMergeAllowed`)) mergeMethods.push('squash')
  if (bool(item.rebaseMergeAllowed, `${path}.rebaseMergeAllowed`)) mergeMethods.push('rebase')
  return {
    mergeMethods,
    autoMergeAllowed: bool(item.autoMergeAllowed, `${path}.autoMergeAllowed`),
  }
}

/** The PR summary plus its GraphQL node id, which mutations address. */
export type MappedSummary = Readonly<{ nodeId: string; summary: GitHubPullRequestSummary }>

export function mapSummary(
  value: unknown,
  path: string,
  context: Readonly<{
    owner: string
    repo: string
    repoId: string
    settings: RepositorySettings
    observedAt: string
    withBody: boolean
  }>
): MappedSummary {
  const item = obj(value, path)
  const number = num(item.number, `${path}.number`)
  const state = literal(item.state, ['OPEN', 'CLOSED', 'MERGED'] as const, `${path}.state`)
  const author = mapActor(item.author, `${path}.author`)
  const reviewers = nodes(item.reviewRequests, `${path}.reviewRequests`).flatMap((entry, index) => {
    const actor = mapActor(
      obj(entry, `${path}.reviewRequests[${index}]`).requestedReviewer,
      `${path}.reviewRequests[${index}].requestedReviewer`
    )
    return actor ? [actor] : []
  })
  const reviews = nodes(item.latestReviews, `${path}.latestReviews`).flatMap(
    (entry, index): GitHubLatestReview[] => {
      const at = `${path}.latestReviews[${index}]`
      const review = obj(entry, at)
      const actor = mapActor(review.author, `${at}.author`)
      if (!actor) return []
      const commit =
        review.commit === null || review.commit === undefined
          ? undefined
          : gitSha(obj(review.commit, `${at}.commit`).oid, `${at}.commit.oid`)
      const submittedAt = isoTimestamp(review.submittedAt, `${at}.submittedAt`)
      return [
        {
          actor,
          state: reviewState(review.state, `${at}.state`),
          ...(commit ? { commitSha: commit } : {}),
          ...(submittedAt ? { submittedAt } : {}),
        },
      ]
    }
  )
  const linkedIssues = nodes(item.closingIssuesReferences, `${path}.closingIssues`).map(
    (entry, index): GitHubLinkedIssue => {
      const at = `${path}.closingIssues[${index}]`
      const issue = obj(entry, at)
      return {
        number: num(issue.number, `${at}.number`),
        title: bounded(issue.title, `${at}.title`, 1024),
        state:
          literal(issue.state, ['OPEN', 'CLOSED'] as const, `${at}.state`) === 'OPEN'
            ? 'open'
            : 'closed',
        url: str(issue.url, `${at}.url`, 512),
      }
    }
  )
  const rollupCommit = nodes(item.rollup, `${path}.rollup`)[0]
  const checks = mapRollup(
    rollupCommit === undefined
      ? undefined
      : obj(obj(rollupCommit, `${path}.rollup[0]`).commit, `${path}.rollup[0].commit`)
          .statusCheckRollup,
    `${path}.rollup`
  )
  const decision =
    item.reviewDecision === null || item.reviewDecision === undefined
      ? undefined
      : literal(
          item.reviewDecision,
          ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] as const,
          `${path}.reviewDecision`
        ).toLowerCase()
  const autoMergeRequest =
    item.autoMergeRequest === null || item.autoMergeRequest === undefined
      ? undefined
      : obj(item.autoMergeRequest, `${path}.autoMergeRequest`)
  const autoMethod = autoMergeRequest
    ? MERGE_METHODS[str(autoMergeRequest.mergeMethod, `${path}.autoMergeRequest.mergeMethod`, 16)]
    : undefined
  const enabledBy =
    autoMergeRequest && autoMergeRequest.enabledBy
      ? optStr(
          obj(autoMergeRequest.enabledBy, `${path}.autoMergeRequest.enabledBy`).login,
          'enabledBy',
          100
        )
      : undefined
  const mergedAt = isoTimestamp(item.mergedAt, `${path}.mergedAt`)
  const closedAt = isoTimestamp(item.closedAt, `${path}.closedAt`)
  const summary: GitHubPullRequestSummary = {
    id: `gh:${context.owner}/${context.repo}#${number}`,
    repoId: context.repoId,
    number,
    title: bounded(item.title, `${path}.title`, 1024),
    url: str(item.url, `${path}.url`, 512),
    state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
    draft: bool(item.isDraft, `${path}.isDraft`),
    ...(author ? { author } : {}),
    headRef: str(item.headRefName, `${path}.headRefName`, 512),
    headSha: gitSha(item.headRefOid, `${path}.headRefOid`),
    baseRef: str(item.baseRefName, `${path}.baseRefName`, 512),
    // Decoration for the status bar: a missing or malformed oid is omitted.
    ...(typeof item.baseRefOid === 'string' && /^[0-9a-f]{40}$/.test(item.baseRefOid)
      ? { baseSha: item.baseRefOid }
      : {}),
    crossRepository: bool(item.isCrossRepository, `${path}.isCrossRepository`),
    additions: num(item.additions, `${path}.additions`),
    deletions: num(item.deletions, `${path}.deletions`),
    changedFiles: num(item.changedFiles, `${path}.changedFiles`),
    commitCount: num(obj(item.commits, `${path}.commits`).totalCount, `${path}.commits.totalCount`),
    labels: nodes(item.labels, `${path}.labels`).map((entry, index) =>
      bounded(obj(entry, `${path}.labels[${index}]`).name, `${path}.labels[${index}].name`, 256)
    ),
    assignees: nodes(item.assignees, `${path}.assignees`).flatMap((entry, index) => {
      const actor = mapActor(
        { [TYPENAME]: 'User', ...obj(entry, `${path}.assignees[${index}]`) },
        `${path}.assignees[${index}]`
      )
      return actor ? [actor] : []
    }),
    requestedReviewers: reviewers,
    reviews,
    ...(decision ? { reviewDecision: decision as GitHubPullRequestSummary['reviewDecision'] } : {}),
    mergeable:
      item.mergeable === 'MERGEABLE'
        ? 'mergeable'
        : item.mergeable === 'CONFLICTING'
          ? 'conflicting'
          : 'unknown',
    mergeState: literal(
      item.mergeStateStatus ?? 'UNKNOWN',
      ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE'] as const,
      `${path}.mergeStateStatus`
    ).toLowerCase() as GitHubPullRequestSummary['mergeState'],
    checks,
    ...(autoMethod
      ? { autoMerge: { method: autoMethod, ...(enabledBy ? { enabledBy } : {}) } }
      : {}),
    mergeMethods: context.settings.mergeMethods,
    autoMergeAllowed: context.settings.autoMergeAllowed,
    viewerCanUpdateBranch: item.viewerCanUpdateBranch === true,
    linkedIssues,
    ...(context.withBody ? { body: bounded(item.body, `${path}.body`, BODY_MAX) } : {}),
    createdAt: requiredIsoTimestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: requiredIsoTimestamp(item.updatedAt, `${path}.updatedAt`),
    ...(mergedAt ? { mergedAt } : {}),
    ...(closedAt ? { closedAt } : {}),
    observedAt: context.observedAt,
  }
  return { nodeId: str(item.id, `${path}.id`, 128), summary }
}

function mapThreadComment(value: unknown, path: string): GitHubThreadComment {
  const item = obj(value, path)
  const author = mapActor(item.author, `${path}.author`)
  return {
    id: str(item.id, `${path}.id`, 128),
    ...(author ? { author } : {}),
    body: bounded(item.body, `${path}.body`, BODY_MAX),
    createdAt: requiredIsoTimestamp(item.createdAt, `${path}.createdAt`),
  }
}

export type ThreadOwner = Readonly<{ owner: string; repo: string; number: number }>

/** Map a review thread; `owner` re-proves which pull request it belongs to. */
export function mapThread(
  value: unknown,
  path: string
): { item: Extract<GitHubTimelineItem, { kind: 'thread' }>; owner: ThreadOwner } {
  const thread = obj(value, path)
  const commentNodes = nodes(thread.comments, `${path}.comments`)
  const comments = commentNodes.map((entry, index) =>
    mapThreadComment(entry, `${path}.comments[${index}]`)
  )
  const first =
    commentNodes[0] === undefined ? undefined : obj(commentNodes[0], `${path}.comments[0]`)
  const diffHunk = first
    ? bounded(first.diffHunk, `${path}.comments[0].diffHunk`, DIFF_HUNK_MAX)
    : ''
  const lineValue = thread.line ?? thread.originalLine
  const startValue = thread.startLine ?? thread.originalStartLine
  const line =
    lineValue === null || lineValue === undefined ? undefined : num(lineValue, `${path}.line`)
  const startLine =
    startValue === null || startValue === undefined
      ? undefined
      : num(startValue, `${path}.startLine`)
  const pr = obj(thread.pullRequest, `${path}.pullRequest`)
  const repository = obj(pr.repository, `${path}.pullRequest.repository`)
  return {
    item: {
      kind: 'thread',
      id: str(thread.id, `${path}.id`, 128),
      path: str(thread.path, `${path}.path`, 1024),
      ...(line !== undefined && line > 0 ? { line } : {}),
      ...(startLine !== undefined && startLine > 0 && (line === undefined || startLine <= line)
        ? { startLine }
        : {}),
      side: thread.diffSide === 'LEFT' ? 'left' : 'right',
      ...(diffHunk ? { diffHunk } : {}),
      resolved: bool(thread.isResolved, `${path}.isResolved`),
      outdated: bool(thread.isOutdated, `${path}.isOutdated`),
      comments,
      createdAt: comments[0]?.createdAt ?? new Date(0).toISOString(),
    },
    owner: {
      owner: str(obj(repository.owner, `${path}.owner`).login, `${path}.owner.login`, 100),
      repo: str(repository.name, `${path}.repository.name`, 100),
      number: num(pr.number, `${path}.pullRequest.number`),
    },
  }
}

function commitFields(value: unknown, path: string) {
  const commit = obj(value, path)
  const author =
    commit.author === null || commit.author === undefined
      ? undefined
      : obj(commit.author, `${path}.author`)
  const user =
    author && author.user !== null && author.user !== undefined
      ? obj(author.user, `${path}.author.user`)
      : undefined
  const authorLogin = user ? optStr(user.login, `${path}.author.user.login`, 100) : undefined
  const authorName = author ? optStr(author.name, `${path}.author.name`, 256) : undefined
  return {
    sha: gitSha(commit.oid, `${path}.oid`),
    headline: bounded(commit.messageHeadline, `${path}.messageHeadline`, 1024),
    ...(authorLogin ? { authorLogin } : {}),
    ...(authorName !== undefined ? { authorName: cleanText(authorName, 256).text } : {}),
    committedAt: requiredIsoTimestamp(commit.committedDate, `${path}.committedDate`),
    checks: mapRollupState(commit.statusCheckRollup, `${path}.statusCheckRollup`),
  }
}

export function mapCommitSummary(value: unknown, path: string): GitHubCommitSummary {
  return commitFields(obj(value, path).commit, `${path}.commit`)
}

const EVENT_KINDS: Record<string, Extract<GitHubTimelineItem, { kind: 'event' }>['event']> = {
  MergedEvent: 'merged',
  ClosedEvent: 'closed',
  ReopenedEvent: 'reopened',
  ReadyForReviewEvent: 'ready_for_review',
  ConvertToDraftEvent: 'converted_to_draft',
  ReviewRequestedEvent: 'review_requested',
  HeadRefForcePushedEvent: 'head_ref_force_pushed',
  BaseRefChangedEvent: 'base_ref_changed',
}

/** Map one timeline node; unknown node types are skipped, never guessed. */
export function mapTimelineNode(value: unknown, path: string): GitHubTimelineItem | undefined {
  const item = obj(value, path)
  const typename = str(item[TYPENAME], `${path}.__typename`, 64)
  const id = str(item.id, `${path}.id`, 128)
  if (typename === 'IssueComment') {
    const author = mapActor(item.author, `${path}.author`)
    return {
      kind: 'comment',
      id,
      ...(author ? { author } : {}),
      body: bounded(item.body, `${path}.body`, BODY_MAX),
      createdAt: requiredIsoTimestamp(item.createdAt, `${path}.createdAt`),
    }
  }
  if (typename === 'PullRequestReview') {
    const author = mapActor(item.author, `${path}.author`)
    const commit =
      item.commit === null || item.commit === undefined
        ? undefined
        : gitSha(obj(item.commit, `${path}.commit`).oid, `${path}.commit.oid`)
    return {
      kind: 'review',
      id,
      ...(author ? { author } : {}),
      state: reviewState(item.state, `${path}.state`),
      body: bounded(item.body, `${path}.body`, BODY_MAX),
      ...(commit ? { commitSha: commit } : {}),
      createdAt:
        isoTimestamp(item.submittedAt, `${path}.submittedAt`) ??
        requiredIsoTimestamp(item.createdAt, `${path}.createdAt`),
    }
  }
  if (typename === 'PullRequestCommit') {
    const fields = commitFields(item.commit, `${path}.commit`)
    const { committedAt, ...rest } = fields
    return { kind: 'commit', id, ...rest, createdAt: committedAt }
  }
  const event = EVENT_KINDS[typename]
  if (event === undefined) return undefined
  const actor = mapActor(item.actor, `${path}.actor`)
  let detail: string | undefined
  if (typename === 'MergedEvent' && item.commit)
    detail = gitSha(obj(item.commit, `${path}.commit`).oid, `${path}.commit.oid`)
  if (typename === 'HeadRefForcePushedEvent' && item.afterCommit)
    detail = gitSha(obj(item.afterCommit, `${path}.afterCommit`).oid, `${path}.afterCommit.oid`)
  if (typename === 'BaseRefChangedEvent')
    detail = bounded(item.currentRefName, `${path}.currentRefName`, 512)
  if (typename === 'ReviewRequestedEvent')
    detail = mapActor(item.requestedReviewer, `${path}.requestedReviewer`)?.login
  return {
    kind: 'event',
    id,
    event,
    ...(actor ? { actor } : {}),
    ...(detail ? { detail } : {}),
    createdAt: requiredIsoTimestamp(item.createdAt, `${path}.createdAt`),
  }
}

/** REST issue comment / review payloads, as returned by their create calls. */
export function restActor(value: unknown, path: string): GitHubActor | undefined {
  if (value === null || value === undefined) return undefined
  const item = obj(value, path)
  const login = str(item.login, `${path}.login`, 100)
  return { login, kind: item.type === 'Bot' || login.endsWith('[bot]') ? 'bot' : 'user' }
}

export function mapRestComment(value: unknown): Extract<GitHubTimelineItem, { kind: 'comment' }> {
  const item = obj(value, 'comment')
  const author = restActor(item.user, 'comment.user')
  return {
    kind: 'comment',
    id: str(item.node_id, 'comment.node_id', 128),
    ...(author ? { author } : {}),
    body: bounded(item.body, 'comment.body', BODY_MAX),
    createdAt: requiredIsoTimestamp(item.created_at, 'comment.created_at'),
  }
}

export function mapRestReview(value: unknown): Extract<GitHubTimelineItem, { kind: 'review' }> {
  const item = obj(value, 'review')
  const author = restActor(item.user, 'review.user')
  const commit = item.commit_id ? gitSha(item.commit_id, 'review.commit_id') : undefined
  return {
    kind: 'review',
    id: str(item.node_id, 'review.node_id', 128),
    ...(author ? { author } : {}),
    state: reviewState(item.state, 'review.state'),
    body: bounded(item.body, 'review.body', BODY_MAX),
    ...(commit ? { commitSha: commit } : {}),
    createdAt: isoTimestamp(item.submitted_at, 'review.submitted_at') ?? new Date().toISOString(),
  }
}

const FILE_STATUSES = [
  'added',
  'modified',
  'removed',
  'renamed',
  'copied',
  'changed',
  'unchanged',
] as const

export function mapChangedFile(value: unknown, path: string): GitHubChangedFile {
  const item = obj(value, path)
  const previousPath = optStr(item.previous_filename, `${path}.previous_filename`, 1024)
  const rawPatch = optStr(item.patch, `${path}.patch`, 16 * 1024 * 1024)
  const patch = rawPatch === undefined ? undefined : cleanText(rawPatch, PATCH_MAX)
  return {
    path: str(item.filename, `${path}.filename`, 1024),
    ...(previousPath ? { previousPath } : {}),
    status: literal(item.status, FILE_STATUSES, `${path}.status`),
    additions: num(item.additions, `${path}.additions`),
    deletions: num(item.deletions, `${path}.deletions`),
    ...(patch ? { patch: patch.text } : {}),
    patchTruncated: patch?.truncated ?? false,
  }
}
