/*
 * Strict validators for the source control app's GitHub collaboration DTOs:
 * inbox summaries, the conversation timeline, commits, changed files, check
 * logs, and the picker read models. Every field is untrusted provider data
 * that the host already decoded once; these shapes re-prove it at the client
 * boundary so an unexpected key or out-of-range value fails closed.
 */
import {
  exactKeys,
  fail,
  gitShaPattern,
  integerValue,
  literal,
  record,
  stringValue,
  timestamp,
} from './dev-runtime-validation-internal'

const pullRequestIdPattern =
  /^(?:gh:[A-Za-z0-9-]{1,100}\/[A-Za-z0-9._-]{1,100}#\d{1,9}|gl:[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100}){1,19}!\d{1,9})$/
const colorPattern = /^[0-9a-f]{6}$/
const reviewStates = ['approved', 'changes_requested', 'commented', 'dismissed', 'pending'] as const
const rollupStates = ['success', 'failure', 'pending', 'none'] as const
const mergeMethods = ['merge', 'squash', 'rebase'] as const
const timelineEvents = [
  'merged',
  'closed',
  'reopened',
  'ready_for_review',
  'converted_to_draft',
  'review_requested',
  'head_ref_force_pushed',
  'base_ref_changed',
] as const

/** Names this module owns; `namedType` routes them here. */
export const githubCollaborationDtoNames: ReadonlySet<string> = new Set([
  'GitHubActor',
  'GitHubCheckRollup',
  'GitHubPullRequestSummary',
  'GitHubTimelineItem',
  'GitHubCommitSummary',
  'GitHubChangedFile',
  'GitHubCheckLog',
  'GitHubLabel',
  'GitHubBranch',
  'GitHubCompare',
  'GitHubReviewCommentInput',
  'GitHubRerunResult',
])

function sha(value: unknown, path: string): void {
  if (!gitShaPattern.test(stringValue(value, path))) fail(path, 'expected git sha')
}

function bool(value: unknown, path: string): void {
  if (typeof value !== 'boolean') fail(path, 'expected boolean')
}

function list(value: unknown, path: string, max: number): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected array')
  if (value.length > max) fail(path, `array exceeds ${max}`)
  return value
}

function actor(value: unknown, path: string): void {
  const item = record(value, path)
  exactKeys(item, ['login', 'kind'], ['name'], path)
  stringValue(item.login, `${path}.login`, 1, 201)
  literal(item.kind, ['user', 'bot', 'team'], `${path}.kind`)
  if (item.name !== undefined) stringValue(item.name, `${path}.name`, 0, 256)
}

function optionalActor(value: unknown, path: string): void {
  if (value !== undefined) actor(value, path)
}

function rollup(value: unknown, path: string): void {
  const item = record(value, path)
  exactKeys(item, ['state', 'passing', 'failing', 'running', 'skipped', 'total'], [], path)
  literal(item.state, rollupStates, `${path}.state`)
  for (const key of ['passing', 'failing', 'running', 'skipped', 'total'] as const)
    integerValue(item[key], `${path}.${key}`, 0)
}

function threadComment(value: unknown, path: string): void {
  const item = record(value, path)
  exactKeys(item, ['id', 'body', 'createdAt'], ['author'], path)
  stringValue(item.id, `${path}.id`, 1, 128)
  optionalActor(item.author, `${path}.author`)
  stringValue(item.body, `${path}.body`, 0, 65_536)
  timestamp(item.createdAt, `${path}.createdAt`)
}

function pullRequestSummary(value: unknown, path: string): void {
  const item = record(value, path)
  exactKeys(
    item,
    [
      'id',
      'repoId',
      'number',
      'title',
      'url',
      'state',
      'draft',
      'headRef',
      'headSha',
      'baseRef',
      'crossRepository',
      'additions',
      'deletions',
      'changedFiles',
      'commitCount',
      'labels',
      'assignees',
      'requestedReviewers',
      'reviews',
      'mergeable',
      'mergeState',
      'checks',
      'mergeMethods',
      'autoMergeAllowed',
      'viewerCanUpdateBranch',
      'linkedIssues',
      'createdAt',
      'updatedAt',
      'observedAt',
    ],
    [
      'author',
      'reviewDecision',
      'autoMerge',
      'behindBy',
      'requiredApprovals',
      'baseSha',
      'body',
      'mergedAt',
      'closedAt',
    ],
    path
  )
  if (!pullRequestIdPattern.test(stringValue(item.id, `${path}.id`)))
    fail(`${path}.id`, 'expected gh:<owner>/<repo>#<number> or gl:<project>!<iid>')
  stringValue(item.repoId, `${path}.repoId`, 1, 128)
  integerValue(item.number, `${path}.number`, 1)
  stringValue(item.title, `${path}.title`, 0, 1024)
  stringValue(item.url, `${path}.url`, 1, 512)
  literal(item.state, ['open', 'closed', 'merged'], `${path}.state`)
  bool(item.draft, `${path}.draft`)
  optionalActor(item.author, `${path}.author`)
  stringValue(item.headRef, `${path}.headRef`, 1, 512)
  sha(item.headSha, `${path}.headSha`)
  stringValue(item.baseRef, `${path}.baseRef`, 1, 512)
  if (item.baseSha !== undefined) sha(item.baseSha, `${path}.baseSha`)
  bool(item.crossRepository, `${path}.crossRepository`)
  for (const key of ['additions', 'deletions', 'changedFiles', 'commitCount'] as const)
    integerValue(item[key], `${path}.${key}`, 0)
  list(item.labels, `${path}.labels`, 100).forEach((label, index) =>
    stringValue(label, `${path}.labels[${index}]`, 0, 256)
  )
  list(item.assignees, `${path}.assignees`, 100).forEach((entry, index) =>
    actor(entry, `${path}.assignees[${index}]`)
  )
  list(item.requestedReviewers, `${path}.requestedReviewers`, 100).forEach((entry, index) =>
    actor(entry, `${path}.requestedReviewers[${index}]`)
  )
  list(item.reviews, `${path}.reviews`, 100).forEach((entry, index) => {
    const at = `${path}.reviews[${index}]`
    const review = record(entry, at)
    exactKeys(review, ['actor', 'state'], ['commitSha', 'submittedAt'], at)
    actor(review.actor, `${at}.actor`)
    literal(review.state, reviewStates, `${at}.state`)
    if (review.commitSha !== undefined) sha(review.commitSha, `${at}.commitSha`)
    if (review.submittedAt !== undefined) timestamp(review.submittedAt, `${at}.submittedAt`)
  })
  if (item.reviewDecision !== undefined)
    literal(
      item.reviewDecision,
      ['approved', 'changes_requested', 'review_required'],
      `${path}.reviewDecision`
    )
  literal(item.mergeable, ['mergeable', 'conflicting', 'unknown'], `${path}.mergeable`)
  literal(
    item.mergeState,
    ['behind', 'blocked', 'clean', 'dirty', 'draft', 'has_hooks', 'unknown', 'unstable'],
    `${path}.mergeState`
  )
  rollup(item.checks, `${path}.checks`)
  if (item.autoMerge !== undefined) {
    const auto = record(item.autoMerge, `${path}.autoMerge`)
    exactKeys(auto, ['method'], ['enabledBy'], `${path}.autoMerge`)
    literal(auto.method, mergeMethods, `${path}.autoMerge.method`)
    if (auto.enabledBy !== undefined)
      stringValue(auto.enabledBy, `${path}.autoMerge.enabledBy`, 1, 100)
  }
  if (item.behindBy !== undefined) integerValue(item.behindBy, `${path}.behindBy`, 0)
  if (item.requiredApprovals !== undefined)
    integerValue(item.requiredApprovals, `${path}.requiredApprovals`, 0, 100)
  list(item.mergeMethods, `${path}.mergeMethods`, 3).forEach((method, index) =>
    literal(method, mergeMethods, `${path}.mergeMethods[${index}]`)
  )
  bool(item.autoMergeAllowed, `${path}.autoMergeAllowed`)
  bool(item.viewerCanUpdateBranch, `${path}.viewerCanUpdateBranch`)
  list(item.linkedIssues, `${path}.linkedIssues`, 20).forEach((entry, index) => {
    const at = `${path}.linkedIssues[${index}]`
    const issue = record(entry, at)
    exactKeys(issue, ['number', 'title', 'state', 'url'], [], at)
    integerValue(issue.number, `${at}.number`, 1)
    stringValue(issue.title, `${at}.title`, 0, 1024)
    literal(issue.state, ['open', 'closed'], `${at}.state`)
    stringValue(issue.url, `${at}.url`, 1, 512)
  })
  if (item.body !== undefined) stringValue(item.body, `${path}.body`, 0, 65_536)
  timestamp(item.createdAt, `${path}.createdAt`)
  timestamp(item.updatedAt, `${path}.updatedAt`)
  if (item.mergedAt !== undefined) timestamp(item.mergedAt, `${path}.mergedAt`)
  if (item.closedAt !== undefined) timestamp(item.closedAt, `${path}.closedAt`)
  timestamp(item.observedAt, `${path}.observedAt`)
}

function timelineItem(value: unknown, path: string): void {
  const item = record(value, path)
  const kind = literal(
    item.kind,
    ['comment', 'review', 'commit', 'thread', 'event'],
    `${path}.kind`
  )
  stringValue(item.id, `${path}.id`, 1, 128)
  timestamp(item.createdAt, `${path}.createdAt`)
  switch (kind) {
    case 'comment':
      exactKeys(item, ['kind', 'id', 'body', 'createdAt'], ['author'], path)
      optionalActor(item.author, `${path}.author`)
      stringValue(item.body, `${path}.body`, 0, 65_536)
      return
    case 'review':
      exactKeys(item, ['kind', 'id', 'state', 'body', 'createdAt'], ['author', 'commitSha'], path)
      optionalActor(item.author, `${path}.author`)
      literal(item.state, reviewStates, `${path}.state`)
      stringValue(item.body, `${path}.body`, 0, 65_536)
      if (item.commitSha !== undefined) sha(item.commitSha, `${path}.commitSha`)
      return
    case 'commit':
      exactKeys(
        item,
        ['kind', 'id', 'sha', 'headline', 'checks', 'createdAt'],
        ['authorLogin', 'authorName'],
        path
      )
      sha(item.sha, `${path}.sha`)
      stringValue(item.headline, `${path}.headline`, 0, 1024)
      if (item.authorLogin !== undefined)
        stringValue(item.authorLogin, `${path}.authorLogin`, 1, 100)
      if (item.authorName !== undefined) stringValue(item.authorName, `${path}.authorName`, 0, 256)
      literal(item.checks, rollupStates, `${path}.checks`)
      return
    case 'thread':
      exactKeys(
        item,
        ['kind', 'id', 'path', 'side', 'resolved', 'outdated', 'comments', 'createdAt'],
        ['line', 'startLine', 'diffHunk'],
        path
      )
      stringValue(item.path, `${path}.path`, 1, 1024)
      if (item.line !== undefined) integerValue(item.line, `${path}.line`, 1)
      if (item.startLine !== undefined) integerValue(item.startLine, `${path}.startLine`, 1)
      literal(item.side, ['left', 'right'], `${path}.side`)
      if (item.diffHunk !== undefined) stringValue(item.diffHunk, `${path}.diffHunk`, 0, 16_384)
      bool(item.resolved, `${path}.resolved`)
      bool(item.outdated, `${path}.outdated`)
      list(item.comments, `${path}.comments`, 100).forEach((entry, index) =>
        threadComment(entry, `${path}.comments[${index}]`)
      )
      return
    case 'event':
      exactKeys(item, ['kind', 'id', 'event', 'createdAt'], ['actor', 'detail'], path)
      literal(item.event, timelineEvents, `${path}.event`)
      optionalActor(item.actor, `${path}.actor`)
      if (item.detail !== undefined) stringValue(item.detail, `${path}.detail`, 0, 512)
      return
  }
}

/**
 * Validate one of this module's named DTOs. Returns `true` when the name is
 * owned here (and the value passed), `false` when another validator owns it.
 */
export function decodeGithubCollaborationDto(name: string, value: unknown, path: string): boolean {
  if (!githubCollaborationDtoNames.has(name)) return false
  switch (name) {
    case 'GitHubActor':
      actor(value, path)
      return true
    case 'GitHubCheckRollup':
      rollup(value, path)
      return true
    case 'GitHubPullRequestSummary':
      pullRequestSummary(value, path)
      return true
    case 'GitHubTimelineItem':
      timelineItem(value, path)
      return true
    case 'GitHubCommitSummary': {
      const item = record(value, path)
      exactKeys(
        item,
        ['sha', 'headline', 'committedAt', 'checks'],
        ['authorLogin', 'authorName'],
        path
      )
      sha(item.sha, `${path}.sha`)
      stringValue(item.headline, `${path}.headline`, 0, 1024)
      if (item.authorLogin !== undefined)
        stringValue(item.authorLogin, `${path}.authorLogin`, 1, 100)
      if (item.authorName !== undefined) stringValue(item.authorName, `${path}.authorName`, 0, 256)
      timestamp(item.committedAt, `${path}.committedAt`)
      literal(item.checks, rollupStates, `${path}.checks`)
      return true
    }
    case 'GitHubChangedFile': {
      const item = record(value, path)
      exactKeys(
        item,
        ['path', 'status', 'additions', 'deletions', 'patchTruncated'],
        ['previousPath', 'patch'],
        path
      )
      stringValue(item.path, `${path}.path`, 1, 1024)
      if (item.previousPath !== undefined)
        stringValue(item.previousPath, `${path}.previousPath`, 1, 1024)
      literal(
        item.status,
        ['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged'],
        `${path}.status`
      )
      integerValue(item.additions, `${path}.additions`, 0)
      integerValue(item.deletions, `${path}.deletions`, 0)
      if (item.patch !== undefined) stringValue(item.patch, `${path}.patch`, 0, 262_144)
      bool(item.patchTruncated, `${path}.patchTruncated`)
      return true
    }
    case 'GitHubCheckLog': {
      const item = record(value, path)
      exactKeys(item, ['checkId', 'text', 'truncated', 'observedAt'], [], path)
      stringValue(item.checkId, `${path}.checkId`, 1, 64)
      stringValue(item.text, `${path}.text`, 0, 524_288)
      bool(item.truncated, `${path}.truncated`)
      timestamp(item.observedAt, `${path}.observedAt`)
      return true
    }
    case 'GitHubLabel': {
      const item = record(value, path)
      exactKeys(item, ['name'], ['color', 'description'], path)
      stringValue(item.name, `${path}.name`, 1, 256)
      if (item.color !== undefined && !colorPattern.test(stringValue(item.color, `${path}.color`)))
        fail(`${path}.color`, 'expected six lowercase hex digits')
      if (item.description !== undefined)
        stringValue(item.description, `${path}.description`, 0, 1024)
      return true
    }
    case 'GitHubBranch': {
      const item = record(value, path)
      exactKeys(item, ['name', 'sha', 'protected'], [], path)
      stringValue(item.name, `${path}.name`, 1, 255)
      sha(item.sha, `${path}.sha`)
      bool(item.protected, `${path}.protected`)
      return true
    }
    case 'GitHubCompare': {
      const item = record(value, path)
      exactKeys(
        item,
        [
          'baseRef',
          'headRef',
          'status',
          'aheadBy',
          'behindBy',
          'commitCount',
          'changedFiles',
          'additions',
          'deletions',
          'observedAt',
        ],
        [],
        path
      )
      stringValue(item.baseRef, `${path}.baseRef`, 1, 255)
      stringValue(item.headRef, `${path}.headRef`, 1, 255)
      literal(item.status, ['ahead', 'behind', 'diverged', 'identical'], `${path}.status`)
      for (const key of [
        'aheadBy',
        'behindBy',
        'commitCount',
        'changedFiles',
        'additions',
        'deletions',
      ] as const)
        integerValue(item[key], `${path}.${key}`, 0)
      timestamp(item.observedAt, `${path}.observedAt`)
      return true
    }
    case 'GitHubReviewCommentInput': {
      const item = record(value, path)
      exactKeys(item, ['path', 'line', 'side', 'body'], ['startLine'], path)
      stringValue(item.path, `${path}.path`, 1, 1024)
      const line = integerValue(item.line, `${path}.line`, 1)
      literal(item.side, ['left', 'right'], `${path}.side`)
      if (item.startLine !== undefined) {
        const startLine = integerValue(item.startLine, `${path}.startLine`, 1)
        if (startLine > line) fail(`${path}.startLine`, 'must not follow line')
      }
      stringValue(item.body, `${path}.body`, 1, 65_536)
      return true
    }
    case 'GitHubRerunResult': {
      const item = record(value, path)
      exactKeys(item, ['checkId', 'runId', 'observedAt'], [], path)
      stringValue(item.checkId, `${path}.checkId`, 1, 64)
      stringValue(item.runId, `${path}.runId`, 1, 64)
      timestamp(item.observedAt, `${path}.observedAt`)
      return true
    }
  }
  return false
}
