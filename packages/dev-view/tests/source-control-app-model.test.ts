import { describe, expect, test } from 'bun:test'
import type { GitHubPullRequestSummary } from '@adea-ai/types/dev-runtime'

import {
  anchorOf,
  groupByDirectory,
  parsePatch,
  splitRows,
} from '../src/source-control-app/model/diff'
import { duration, relativeTime } from '../src/source-control-app/model/format'
import {
  classifyPullRequest,
  filterOptions,
  filterPullRequests,
  groupInbox,
} from '../src/source-control-app/model/inbox'
import { failureLines, logLines } from '../src/source-control-app/model/log'
import { mergeDock, preferredMethod } from '../src/source-control-app/model/merge-dock'
import {
  createAppStorage,
  decodeDraft,
  decodePreferences,
  defaultPreferences,
} from '../src/source-control-app/model/persistence'
import { indexSessions, linkPullRequest } from '../src/source-control-app/model/sessions'
import { buildTree, monogram, repositoryName } from '../src/source-control-app/model/tree'
import { githubCapabilities, type PullRequestView } from '../src/source-control-app/model/types'

const NOW = '2026-10-03T12:00:00.000Z'
const HEAD = 'a'.repeat(40)
const VIEWER = 'octocat'

function summary(overrides: Partial<GitHubPullRequestSummary> = {}): GitHubPullRequestSummary {
  return {
    id: 'gh:acme/widgets#7',
    repoId: 'repo-1',
    number: 7,
    title: 'Add widget support',
    url: 'https://github.com/acme/widgets/pull/7',
    state: 'open',
    draft: false,
    author: { login: 'dana', kind: 'user' },
    headRef: 'dana/widgets',
    headSha: HEAD,
    baseRef: 'main',
    crossRepository: false,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    commitCount: 1,
    labels: [],
    assignees: [],
    requestedReviewers: [],
    reviews: [],
    mergeable: 'mergeable',
    mergeState: 'clean',
    checks: { state: 'success', passing: 3, failing: 0, running: 0, skipped: 0, total: 3 },
    mergeMethods: ['merge', 'squash'],
    autoMergeAllowed: true,
    viewerCanUpdateBranch: true,
    linkedIssues: [],
    createdAt: NOW,
    updatedAt: NOW,
    observedAt: NOW,
    ...overrides,
  }
}

function view(
  overrides: Partial<GitHubPullRequestSummary> = {},
  extra: Partial<PullRequestView> = {}
): PullRequestView {
  return { ...summary(overrides), authorIsAgent: false, ...extra }
}

const session = {
  runtimeSessionId: 's-1',
  projectId: 'p-1',
  worktreeId: 'w-1',
  title: 'Widgets',
  lifecycle: 'active',
}

describe('inbox grouping', () => {
  test('drafts come first and open their session when one exists', () => {
    expect(classifyPullRequest(view({ draft: true }), VIEWER)).toEqual({
      group: 'drafts',
      action: 'open',
    })
    expect(classifyPullRequest(view({ draft: true }, { session }), VIEWER)).toEqual({
      group: 'drafts',
      action: 'open_session',
    })
  })

  test('a requested viewer who has not reviewed the head needs to review', () => {
    const requested = view({ requestedReviewers: [{ login: 'OctoCat', kind: 'user' }] })
    expect(classifyPullRequest(requested, VIEWER)).toEqual({
      group: 'needs_review',
      action: 'review',
    })
    const reviewed = view({
      requestedReviewers: [{ login: VIEWER, kind: 'user' }],
      reviews: [{ actor: { login: VIEWER, kind: 'user' }, state: 'commented', commitSha: HEAD }],
    })
    expect(classifyPullRequest(reviewed, VIEWER).group).not.toBe('needs_review')
    const team = view({ requestedReviewers: [{ login: 'acme/octocat', kind: 'team' }] })
    expect(classifyPullRequest(team, VIEWER).group).not.toBe('needs_review')
    expect(classifyPullRequest(requested, undefined).group).not.toBe('needs_review')
  })

  test('ready to merge needs approvals, passing checks, no lag and no conflicts', () => {
    expect(classifyPullRequest(view({ reviewDecision: 'approved' }), VIEWER)).toEqual({
      group: 'ready',
      action: 'merge',
    })
    // No review required by the repository counts as met.
    expect(classifyPullRequest(view(), VIEWER).group).toBe('ready')
    expect(
      classifyPullRequest(
        view({
          checks: { state: 'none', passing: 0, failing: 0, running: 0, skipped: 0, total: 0 },
        }),
        VIEWER
      ).group
    ).toBe('ready')
  })

  test('blocked rows pick their action by first match', () => {
    const failing = {
      state: 'failure' as const,
      passing: 2,
      failing: 1,
      running: 0,
      skipped: 0,
      total: 3,
    }
    expect(
      classifyPullRequest(view({ checks: failing }, { authorIsAgent: true, session }), VIEWER)
    ).toEqual({
      group: 'blocked',
      action: 'open_session',
    })
    expect(classifyPullRequest(view({ checks: failing }), VIEWER)).toEqual({
      group: 'blocked',
      action: 'open',
    })
    expect(classifyPullRequest(view({ reviewDecision: 'changes_requested' }), VIEWER)).toEqual({
      group: 'blocked',
      action: 'open',
    })
    expect(
      classifyPullRequest(view({ mergeable: 'conflicting', mergeState: 'dirty' }), VIEWER)
    ).toEqual({
      group: 'blocked',
      action: 'open',
    })
    expect(classifyPullRequest(view({ mergeState: 'behind', behindBy: 5 }), VIEWER)).toEqual({
      group: 'blocked',
      action: 'update_branch',
    })
    expect(
      classifyPullRequest(view({ mergeState: 'behind', viewerCanUpdateBranch: false }), VIEWER)
        .action
    ).toBe('open')
  })

  test('anything else waits on others', () => {
    expect(
      classifyPullRequest(
        view({
          reviewDecision: 'review_required',
          checks: { state: 'pending', passing: 1, failing: 0, running: 2, skipped: 0, total: 3 },
        }),
        VIEWER
      )
    ).toEqual({ group: 'waiting', action: 'open' })
  })

  test('groups keep the display order and drop empty or closed groups', () => {
    const groups = groupInbox(
      [
        view({ number: 1, draft: true }),
        view({ number: 2, reviewDecision: 'approved' }),
        view({ number: 3, state: 'merged' }),
        view({ number: 4, requestedReviewers: [{ login: VIEWER, kind: 'user' }] }),
      ],
      VIEWER
    )
    expect(groups.map((group) => group.id)).toEqual(['ready', 'needs_review', 'drafts'])
    expect(groups.flatMap((group) => group.items.map((item) => item.pr.number))).toEqual([2, 4, 1])
  })

  test('filters by text, number, branch, author, label and agent authorship', () => {
    const prs = [
      view({ number: 7, title: 'Add widget support', labels: ['ui'] }),
      view(
        {
          number: 8,
          title: 'Fix login',
          headRef: 'agent/juno/login',
          author: { login: 'juno', kind: 'bot' },
        },
        { authorIsAgent: true }
      ),
    ]
    expect(
      filterPullRequests(prs, { text: '#8', agentsOnly: false }).map((pr) => pr.number)
    ).toEqual([8])
    expect(filterPullRequests(prs, { text: 'juno/login', agentsOnly: false })).toHaveLength(1)
    expect(filterPullRequests(prs, { text: '', agentsOnly: true }).map((pr) => pr.number)).toEqual([
      8,
    ])
    expect(filterPullRequests(prs, { text: '', label: 'ui', agentsOnly: false })).toHaveLength(1)
    expect(filterPullRequests(prs, { text: '', author: 'dana', agentsOnly: false })).toHaveLength(1)
    expect(filterOptions(prs)).toEqual({ authors: ['dana', 'juno'], reviewers: [], labels: ['ui'] })
  })
})

describe('merge dock', () => {
  const dock = (pr: PullRequestView, method = preferredMethod(pr.mergeMethods, undefined)) =>
    mergeDock(pr, VIEWER, method, githubCapabilities)

  test('all green merges now with the preferred method', () => {
    const result = dock(view({ reviewDecision: 'approved' }))
    expect(result.merge).toMatchObject({ kind: 'merge_now', label: 'Squash and merge' })
    expect(result.reviews.tone).toBe('success')
    expect(result.checks.label).toBe('3 of 3 passing')
    expect(result.branch.label).toBe('Up to date with main')
  })

  test('pending requirements offer merge when ready if the repository allows it', () => {
    const pending = view({
      reviewDecision: 'review_required',
      checks: { state: 'pending', passing: 6, failing: 0, running: 1, skipped: 0, total: 7 },
    })
    expect(dock(pending).merge).toMatchObject({
      kind: 'merge_when_ready',
      label: 'Squash and merge when ready',
    })
    expect(
      dock(view({ ...summary({ reviewDecision: 'review_required' }), autoMergeAllowed: false }))
        .merge.kind
    ).toBe('disabled')
  })

  test('auto-merge already on shows as enabled', () => {
    const enabled = view({ autoMerge: { method: 'rebase', enabledBy: 'dana' } })
    expect(dock(enabled).merge).toMatchObject({
      kind: 'auto_enabled',
      label: 'Rebase and merge when ready',
    })
  })

  test('conflicts, requested changes and drafts disable merging with a reason', () => {
    expect(dock(view({ mergeable: 'conflicting' })).merge).toMatchObject({
      kind: 'disabled',
      helper: 'Resolve the conflicts with the base first.',
    })
    expect(dock(view({ reviewDecision: 'changes_requested' })).merge.helper).toBe(
      'A reviewer requested changes.'
    )
    expect(dock(view({ draft: true })).merge.helper).toContain('ready for review')
  })

  test('behind branches can update and the review row knows the author', () => {
    const behind = dock(view({ mergeState: 'behind', behindBy: 5, reviewDecision: 'approved' }))
    expect(behind.branch).toMatchObject({ label: '5 commits behind main', canUpdate: true })
    expect(behind.merge.kind).toBe('merge_when_ready')
    const own = mergeDock(
      view({ author: { login: VIEWER, kind: 'user' } }),
      VIEWER,
      'squash',
      githubCapabilities
    )
    expect(own.reviews.canReview).toBe(false)
  })

  test('the remembered method wins only while the repository allows it', () => {
    expect(preferredMethod(['merge', 'squash'], 'merge')).toBe('merge')
    expect(preferredMethod(['merge', 'squash'], 'rebase')).toBe('squash')
    expect(preferredMethod(['rebase'], undefined)).toBe('rebase')
    expect(preferredMethod([], undefined)).toBeUndefined()
  })
})

describe('sidebar tree', () => {
  test('groups GitHub projects by owner, viewer last, archived collapsed', () => {
    const tree = buildTree(
      [
        { id: 'p1', name: 'Adea', repoIds: ['r1'], archived: false },
        { id: 'p2', name: 'Dotfiles', repoIds: ['r2'], archived: false },
        { id: 'p3', name: 'Old', repoIds: ['r3'], archived: true },
        { id: 'p4', name: 'Local', repoIds: ['r4'], archived: false },
      ],
      [
        {
          id: 'r1',
          provider: 'github',
          host: 'github.com',
          ownerPath: 'adea-ai',
          displayUrl: 'https://github.com/adea-ai/adea',
        },
        {
          id: 'r2',
          provider: 'github',
          host: 'github.com',
          ownerPath: 'octocat',
          displayUrl: 'https://github.com/octocat/dotfiles.git',
        },
        {
          id: 'r3',
          provider: 'github',
          host: 'github.com',
          ownerPath: 'adea-ai',
          displayUrl: 'https://github.com/adea-ai/old',
        },
        {
          id: 'r4',
          provider: 'other',
          host: 'example.com',
          ownerPath: 'me',
          displayUrl: 'https://example.com/me/local',
        },
      ],
      new Map([['r1', { openCount: 10, ci: 'success' as const }]]),
      VIEWER
    )
    expect(tree.owners.map((owner) => [owner.owner, owner.isViewer])).toEqual([
      ['adea-ai', false],
      ['octocat', true],
    ])
    expect(tree.owners[0]!.projects[0]).toMatchObject({
      name: 'adea',
      openCount: 10,
      ci: 'success',
    })
    expect(tree.owners[1]!.projects[0]!.name).toBe('dotfiles')
    expect(tree.archived.map((row) => row.name)).toEqual(['old'])
    expect(tree.skipped).toBe(1)
    expect(repositoryName('git@github.com:acme/widgets.git')).toBe('widgets')
    expect(monogram('adea-ai')).toBe('AA')
    expect(monogram('labs')).toBe('LA')
  })
})

describe('session links', () => {
  test('a worktree on the head branch links its live session and marks an agent', () => {
    const index = indexSessions(
      [
        { id: 'w-1', repoId: 'repo-1', headRef: 'refs/heads/agent/juno/widgets', archived: false },
        { id: 'w-2', repoId: 'repo-1', headRef: 'other', archived: true },
      ],
      [
        {
          id: 's-old',
          projectId: 'p-1',
          worktreeId: 'w-1',
          lifecycle: 'completed',
          archived: false,
        },
        {
          id: 's-1',
          projectId: 'p-1',
          worktreeId: 'w-1',
          displayName: 'Widgets',
          lifecycle: 'active',
          archived: false,
        },
      ]
    )
    const linked = linkPullRequest(summary({ headRef: 'agent/juno/widgets' }), index)
    expect(linked.session?.runtimeSessionId).toBe('s-1')
    expect(linked.authorIsAgent).toBe(true)
    const fork = linkPullRequest(
      summary({ headRef: 'agent/juno/widgets', crossRepository: true }),
      index
    )
    expect(fork.session).toBeUndefined()
    const bot = linkPullRequest(summary({ author: { login: 'renovate[bot]', kind: 'bot' } }), index)
    expect(bot.authorIsAgent).toBe(true)
  })
})

describe('diff rows', () => {
  const patch =
    '@@ -10,4 +10,4 @@ fn()\n keep\n-old one\n-old two\n+new one\n keep2\n\\ No newline at end of file'

  test('numbers both sides and anchors comments by side', () => {
    const rows = parsePatch(patch)
    expect(rows.map((row) => row.kind)).toEqual([
      'hunk',
      'context',
      'delete',
      'delete',
      'add',
      'context',
      'meta',
    ])
    expect(rows[1]).toMatchObject({ oldLine: 10, newLine: 10 })
    expect(anchorOf(rows[2]!)).toEqual({ side: 'left', line: 11 })
    expect(anchorOf(rows[4]!)).toEqual({ side: 'right', line: 11 })
    expect(anchorOf(rows[0]!)).toBeUndefined()
  })

  test('split view pairs deletions with following additions', () => {
    const split = splitRows(parsePatch(patch))
    expect(
      split.map((row) =>
        row.kind === 'pair' ? `${row.left?.kind ?? '-'}|${row.right?.kind ?? '-'}` : row.kind
      )
    ).toEqual(['hunk', 'context|context', 'delete|add', 'delete|-', 'context|context', 'meta'])
  })

  test('changed files group by directory', () => {
    expect(
      groupByDirectory([{ path: 'src/a.ts' }, { path: 'README.md' }, { path: 'src/b.ts' }])
    ).toEqual([
      { dir: 'src', files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] },
      { dir: '', files: [{ path: 'README.md' }] },
    ])
  })
})

describe('check logs', () => {
  test('strip timestamps and keep failures with context', () => {
    const lines = logLines(
      '2026-10-03T12:00:00.1234567Z setup\n2026-10-03T12:00:01Z ✗ maps state\nExpected: a\nReceived: b\nok\nok\nok\nok\n409 pass, 3 fail\n'
    )
    expect(lines[0]).toEqual({ number: 1, text: 'setup', failure: false })
    expect(failureLines(lines, 2).map((line) => line.number)).toEqual([2, 3, 4, 9])
  })
})

describe('persistence', () => {
  const scope = { accountId: 'a', workspaceId: 'w', runtimeNodeId: 'n' }

  test('decodes preferences strictly and falls back to defaults', () => {
    expect(decodePreferences('nope')).toEqual(defaultPreferences)
    expect(
      decodePreferences({
        selection: { kind: 'project', repoId: 'r', projectId: 'p' },
        details: { files: true, bogus: true },
        mergeMethod: 'yolo',
        diffLayout: 'split',
      })
    ).toEqual({
      selection: { kind: 'project', repoId: 'r', projectId: 'p' },
      details: { conversation: true, commits: false, checks: false, files: true },
      diffLayout: 'split',
      deleteBranch: true,
    })
  })

  test('drafts drop malformed comments and survive a reload', () => {
    expect(
      decodeDraft({
        headSha: HEAD,
        body: 'x',
        comments: [{ id: '1', path: 'a', line: 0, side: 'right', body: '' }],
      })?.comments
    ).toEqual([])
    const memory = new Map<string, string>()
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
    }
    const app = createAppStorage(storage, scope)
    const draft = {
      headSha: HEAD,
      body: 'Looks good',
      verdict: 'approve' as const,
      comments: [
        { id: 'c1', path: 'src/a.ts', line: 4, side: 'right' as const, startLine: 2, body: 'nit' },
      ],
    }
    app.saveDraft('gh:acme/widgets#7', draft)
    expect(app.loadDraft('gh:acme/widgets#7')).toEqual(draft)
    app.saveDraft('gh:acme/widgets#7', { ...draft, body: '', comments: [] })
    expect(app.loadDraft('gh:acme/widgets#7')).toBeUndefined()
    app.saveViewed('gh:acme/widgets#7', HEAD, new Set(['src/a.ts']))
    expect([...app.loadViewed('gh:acme/widgets#7', HEAD)]).toEqual(['src/a.ts'])
    expect(app.loadViewed('gh:acme/widgets#7', 'b'.repeat(40)).size).toBe(0)
  })

  test('a throwing store never breaks the app', () => {
    const app = createAppStorage(
      {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('quota')
        },
        removeItem: () => {},
      },
      scope
    )
    expect(app.loadPreferences()).toEqual(defaultPreferences)
    expect(() => app.savePreferences(defaultPreferences)).not.toThrow()
  })
})

describe('format', () => {
  test('relative times and durations', () => {
    const now = Date.parse(NOW)
    expect(relativeTime('2026-10-03T11:52:00.000Z', now)).toBe('8 minutes ago')
    expect(relativeTime('2026-10-03T11:00:00.000Z', now)).toBe('1 hour ago')
    expect(relativeTime('2026-10-02T10:00:00.000Z', now)).toBe('yesterday')
    expect(duration('2026-10-03T12:00:00Z', '2026-10-03T12:06:12Z')).toBe('6 min 12 s')
    expect(duration('2026-10-03T12:00:00Z', '2026-10-03T12:00:58Z')).toBe('58 s')
  })
})
