// Browser harness for the source control app. A deterministic runtime that
// answers the Dev Runtime catalog and dev.github.* operations from fixtures
// (dev.gitlab.* answers from the same fixtures for the GitLab project)
// shaped like the design's artboards, records every command, and applies
// mutations to its in-memory state so the UI's re-reads observe them.
import '../../src/start/globals.css'
import type {
  DevCommand,
  DevReply,
  GitHubChangedFile,
  GitHubCheck,
  GitHubCommitSummary,
  GitHubPullRequestSummary,
  GitHubTimelineItem,
  Scope,
} from '@adea-ai/types/dev-runtime'
import {
  applyAppearanceFontSettings,
  DEFAULT_APPEARANCE_EDITOR_FONT_SETTINGS,
  type AppearanceEditorFontSettings,
} from '@adea-ai/ui/lib/appearance-font-settings'
import { render } from 'solid-js/web'

import { SourceControlApp } from '../../../../packages/dev-view/src/source-control-app/app'
import type { DevRuntimeService } from '../../../../packages/dev-view/src/platform'

const params = new URLSearchParams(location.search)
const scenario = params.get('scenario') ?? 'default'
if (params.get('theme') === 'light') document.documentElement.classList.remove('dark')
else document.documentElement.classList.add('dark')

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const now = Date.parse('2026-10-03T12:00:00.000Z')
/** How many `dev.repo.list` reads have run (the `auto-adopt` scenario). */
let repoListReads = 0
/** Advanceable offset so a focus event crosses the app's 10 s re-sync gate. */
let clockSkewMs = 0
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
const sha = (seed: string) => seed.repeat(40).slice(0, 40)

// Worktree records validate their repo and project ids as UUIDs (ADR 0011
// strict DTO), and a pull request links to an Adea session only when its
// repoId equals the checked-out worktree's repoId — so the catalog uses one
// deterministic UUID family instead of slugs (dev-runtime ADR 0011).
const repoId = {
  adea: '00000000-0000-4000-8000-000000000101',
  ui: '00000000-0000-4000-8000-000000000102',
  control: '00000000-0000-4000-8000-000000000103',
  dotfiles: '00000000-0000-4000-8000-000000000104',
  runner: '00000000-0000-4000-8000-000000000105',
  old: '00000000-0000-4000-8000-000000000106',
} as const
const projectId = {
  adea: '00000000-0000-4000-8000-000000000201',
  ui: '00000000-0000-4000-8000-000000000202',
  control: '00000000-0000-4000-8000-000000000203',
  dotfiles: '00000000-0000-4000-8000-000000000204',
  runner: '00000000-0000-4000-8000-000000000205',
  old: '00000000-0000-4000-8000-000000000206',
} as const
const worktreeId = '00000000-0000-4000-8000-000000000301'
const sessionId = '00000000-0000-4000-8000-000000000401'

const repos = [
  { id: repoId.adea, owner: 'adea-ai', name: 'adea', project: projectId.adea, projectName: 'Adea' },
  { id: repoId.ui, owner: 'adea-ai', name: 'ui', project: projectId.ui, projectName: 'Adea UI' },
  {
    id: repoId.control,
    owner: 'adea-ai',
    name: 'control-plane',
    project: projectId.control,
    projectName: 'Control plane',
  },
  {
    id: repoId.dotfiles,
    owner: 'octocat',
    name: 'dotfiles',
    project: projectId.dotfiles,
    projectName: 'Dotfiles',
  },
  {
    id: repoId.runner,
    owner: 'platform/infra',
    name: 'runner',
    project: projectId.runner,
    projectName: 'Runner',
    provider: 'gitlab' as const,
  },
  {
    id: repoId.old,
    owner: 'adea-ai',
    name: 'legacy-site',
    project: projectId.old,
    projectName: 'Legacy site',
    archived: true,
  },
]

const rollup = (
  state: GitHubPullRequestSummary['checks']['state'],
  passing: number,
  failing = 0,
  running = 0,
  skipped = 0
) => ({
  state,
  passing,
  failing,
  running,
  skipped,
  total: passing + failing + running + skipped,
})

function pr(
  number: number,
  title: string,
  author: { login: string; kind: 'user' | 'bot' },
  headRef: string,
  minutes: number,
  overrides: Partial<GitHubPullRequestSummary> = {}
): GitHubPullRequestSummary {
  return {
    id: `gh:adea-ai/adea#${number}`,
    repoId: repoId.adea,
    number,
    title,
    url: `https://github.com/adea-ai/adea/pull/${number}`,
    state: 'open',
    draft: false,
    author,
    headRef,
    headSha: sha(String(number % 10)),
    baseRef: 'main',
    crossRepository: false,
    additions: 120,
    deletions: 30,
    changedFiles: 4,
    commitCount: 3,
    labels: [],
    assignees: [],
    requestedReviewers: [],
    reviews: [],
    reviewDecision: 'review_required',
    mergeable: 'mergeable',
    mergeState: 'blocked',
    checks: rollup('success', 7),
    mergeMethods: ['merge', 'squash', 'rebase'],
    autoMergeAllowed: true,
    viewerCanUpdateBranch: true,
    linkedIssues: [],
    createdAt: ago(minutes + 180),
    updatedAt: ago(minutes),
    observedAt: new Date(now).toISOString(),
    ...overrides,
  }
}

const juno = { login: 'juno', kind: 'bot' as const }
const pico = { login: 'pico', kind: 'bot' as const }
const atlas = { login: 'atlas', kind: 'bot' as const }
const viewer = 'octocat'

const providerOfRepo = (wanted: unknown) =>
  repos.find((repo) => repo.id === wanted)?.provider ?? 'github'
const hostOf = (provider: 'github' | 'gitlab') => `${provider}.com`

const state = {
  commands: [] as { operation: string; body: Record<string, unknown> }[],
  pulls: [
    pr(12, 'Cache Go modules between jobs', pico, 'agent/pico/go-cache', 20, {
      id: 'gl:platform/infra/runner!12',
      repoId: repoId.runner,
      url: 'https://gitlab.com/platform/infra/runner/-/merge_requests/12',
      mergeMethods: ['merge', 'squash'],
      reviewDecision: 'approved',
      reviews: [{ actor: { login: 'dana', kind: 'user' }, state: 'approved' }],
      mergeState: 'behind',
      behindBy: 3,
    }),
    pr(
      912,
      'Add source control shell and provider adapters',
      juno,
      'agent/juno/source-control-shell',
      8,
      {
        reviewDecision: 'approved',
        reviews: [
          { actor: { login: 'dana', kind: 'user' }, state: 'approved', commitSha: sha('2') },
          { actor: { login: 'mika', kind: 'user' }, state: 'approved', commitSha: sha('2') },
        ],
        mergeState: 'clean',
        additions: 1204,
        deletions: 86,
      }
    ),
    pr(
      904,
      'Migrate workspace store to Solid signals',
      juno,
      'agent/juno/solid-store-signals',
      21,
      {
        requestedReviewers: [{ login: viewer, kind: 'user' }],
        reviews: [
          { actor: { login: 'dana', kind: 'user' }, state: 'approved', commitSha: sha('4') },
          { actor: { login: 'mika', kind: 'user' }, state: 'commented', commitSha: sha('4') },
        ],
        checks: rollup('pending', 6, 0, 1),
        behindBy: 5,
        mergeState: 'behind',
        labels: ['migration', 'solid', 'performance'],
        assignees: [{ login: 'juno', kind: 'bot' }],
        linkedIssues: [
          {
            number: 871,
            title: 'React to Solid: workspace store',
            state: 'open',
            url: 'https://github.com/adea-ai/adea/issues/871',
          },
        ],
        additions: 418,
        deletions: 173,
        changedFiles: 3,
        commitCount: 4,
        body: 'Replaces the reducer in the workspace store with fine-grained Solid signals, so a renamed channel no longer re-renders every room row.\n\n- Splits workspace.ts into a store and derived selectors\n- Moves room ordering into a memo',
      }
    ),
    pr(
      911,
      'Persist split layout sizes per room',
      { login: 'mika', kind: 'user' },
      'mika/split-layout-persist',
      120,
      {
        requestedReviewers: [{ login: viewer, kind: 'user' }],
        additions: 96,
        deletions: 12,
      }
    ),
    pr(909, 'Add GitLab provider adapter', pico, 'agent/pico/gitlab-adapter', 34, {
      checks: rollup('failure', 4, 2, 0, 1),
      reviewDecision: 'approved',
      reviews: [{ actor: { login: 'dana', kind: 'user' }, state: 'approved', commitSha: sha('9') }],
      additions: 687,
      deletions: 9,
    }),
    pr(901, 'Collapse rail labels into tooltips', atlas, 'agent/atlas/rail-tooltips', 180, {
      reviewDecision: 'approved',
      reviews: [{ actor: { login: 'dana', kind: 'user' }, state: 'approved', commitSha: sha('1') }],
      behindBy: 5,
      mergeState: 'behind',
    }),
    pr(
      897,
      'Rework session handoff between harnesses',
      { login: 'dana', kind: 'user' },
      'dana/session-handoff',
      2880,
      {
        reviewDecision: 'changes_requested',
        reviews: [
          {
            actor: { login: viewer, kind: 'user' },
            state: 'changes_requested',
            commitSha: sha('7'),
          },
        ],
      }
    ),
    pr(
      913,
      'Inline review threads in the files view',
      juno,
      'agent/juno/inline-review-threads',
      2,
      {
        draft: true,
        checks: rollup('pending', 0, 0, 3),
        reviewDecision: undefined,
        mergeState: 'draft',
      }
    ),
  ] as GitHubPullRequestSummary[],
  autoMerged: new Set<string>(),
}

const commits: GitHubCommitSummary[] = [
  {
    sha: sha('a'),
    headline: 'Split workspace store into signals and selectors',
    authorLogin: 'juno',
    committedAt: ago(120),
    checks: 'success',
  },
  {
    sha: sha('b'),
    headline: 'Move room ordering into a memo',
    authorLogin: 'juno',
    committedAt: ago(110),
    checks: 'failure',
  },
  {
    sha: sha('c'),
    headline: 'Guard selector against rooms that are still loading',
    authorLogin: 'juno',
    committedAt: ago(40),
    checks: 'pending',
  },
  {
    sha: sha('4'),
    headline: 'Add store tests',
    authorLogin: 'juno',
    committedAt: ago(21),
    checks: 'pending',
  },
]

const timeline: GitHubTimelineItem[] = [
  ...commits.slice(0, 3).map((commit, index): GitHubTimelineItem => ({
    kind: 'commit',
    id: `PRC_${index}`,
    sha: commit.sha,
    headline: commit.headline,
    authorLogin: 'juno',
    checks: commit.checks,
    createdAt: commit.committedAt,
  })),
  {
    kind: 'thread',
    id: 'PRRT_1',
    path: 'src/stores/selectors.ts',
    line: 42,
    side: 'right',
    diffHunk:
      '@@ -40,3 +40,3 @@\n   const ordered = createMemo(() => {\n-    return rooms().sort(byActivity)\n+    return rooms().toSorted(byActivity)',
    resolved: false,
    outdated: false,
    comments: [
      {
        id: 'C1',
        author: { login: 'mika', kind: 'user' },
        body: 'Does rooms() ever return undefined while the workspace is loading?',
        createdAt: ago(60),
      },
      {
        id: 'C2',
        author: { login: 'juno', kind: 'bot' },
        body: 'It could during hydration. Guarded in the next commit and added a test.',
        createdAt: ago(40),
      },
    ],
    createdAt: ago(60),
  },
  {
    kind: 'review',
    id: 'PRR_1',
    author: { login: 'dana', kind: 'user' },
    state: 'approved',
    body: '',
    commitSha: sha('4'),
    createdAt: ago(55),
  },
  {
    kind: 'review',
    id: 'PRR_2',
    author: { login: 'dana', kind: 'user' },
    state: 'approved',
    body: 'Store split looks good.',
    commitSha: sha('4'),
    createdAt: ago(50),
  },
]

const files: GitHubChangedFile[] = [
  {
    path: 'src/stores/workspace.ts',
    status: 'modified',
    additions: 4,
    deletions: 3,
    patch:
      '@@ -12,7 +12,8 @@ export function createWorkspaceStore()\n   const client = useClient()\n-  const [state, dispatch] = createReducer(reduce, initial)\n-  const rooms = () => state.rooms\n+  const [rooms, setRooms] = createSignal<Room[]>([])\n+  const [activeId, setActiveId] = createSignal<string>()\n \n-  createEffect(() => dispatch(order(state.rooms)))\n+  const ordered = createMemo(() => rooms().toSorted(byActivity))\n+\n   return { rooms: ordered, activeId, setActiveId, rename }',
    patchTruncated: false,
  },
  {
    path: 'src/stores/selectors.ts',
    status: 'added',
    additions: 3,
    deletions: 0,
    patch:
      '@@ -0,0 +40,3 @@\n+  const ordered = createMemo(() => {\n+    return rooms().toSorted(byActivity)\n+  })',
    patchTruncated: false,
  },
  { path: 'assets/logo.png', status: 'added', additions: 0, deletions: 0, patchTruncated: false },
]

const checks: GitHubCheck[] = [
  {
    id: '101',
    detailsUrl: 'https://github.com/adea-ai/adea/actions/runs/9001/job/101',
    name: 'unit-tests',
    status: 'completed',
    conclusion: 'failure',
    title: '3 of 412 tests failed in packages/providers',
    startedAt: ago(40),
    completedAt: ago(37),
  },
  {
    id: '102',
    detailsUrl: 'https://github.com/adea-ai/adea/actions/runs/9001/job/102',
    name: 'typecheck',
    status: 'completed',
    conclusion: 'failure',
    title: '2 errors in gitlab/review-state.ts',
    startedAt: ago(40),
    completedAt: ago(39),
  },
  {
    id: '103',
    detailsUrl: 'https://github.com/adea-ai/adea/actions/runs/9001/job/103',
    name: 'lint',
    status: 'completed',
    conclusion: 'success',
    title: 'No problems',
    startedAt: ago(40),
    completedAt: ago(39),
  },
  {
    id: '104',
    name: 'e2e-desktop',
    status: 'completed',
    conclusion: 'skipped',
    title: 'Waits for unit-tests',
  },
  { id: '105', name: 'build-desktop', status: 'in_progress', startedAt: ago(4) },
]

const log =
  '2026-10-03T11:20:00.0000000Z ##[group]Run bun test packages/providers\n2026-10-03T11:20:01.0000000Z bun test v1.4.2\n' +
  Array.from({ length: 40 }, (_, index) => `2026-10-03T11:20:02.0000000Z ✓ case ${index + 1}`).join(
    '\n'
  ) +
  '\n2026-10-03T11:20:03.0000000Z ✗ maps "unapproved" after approval to changes requested\n2026-10-03T11:20:03.0000000Z     Expected: "changes_requested"\n2026-10-03T11:20:03.0000000Z     Received: "pending"\n2026-10-03T11:20:04.0000000Z  409 pass, 3 fail\n'

function ok(command: DevCommand, value: unknown): DevReply {
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: true,
    value,
    observedAt: new Date(now).toISOString(),
  } as DevReply
}

function fail(command: DevCommand, code: string, message: string): DevReply {
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: false,
    error: { code, retryable: false, message },
  } as DevReply
}

const page = (items: readonly unknown[]) => ({ items, observedAt: new Date(now).toISOString() })
const plan = (command: DevCommand, id: string) => ({
  id,
  operation: command.operation.replace('Plan', 'Commit'),
  scope,
  resource: command.resource,
  factVersions: {},
  steps: [],
  blockers: [],
  requiredApprovalIds: [],
  digest: 'd'.repeat(64),
  expiresAt: new Date(now + 600_000).toISOString(),
})
const find = (id: unknown) => state.pulls.find((entry) => entry.id === id)
const restPr = (summary: GitHubPullRequestSummary) => ({
  id: summary.id,
  repoId: summary.repoId,
  number: summary.number,
  host: 'github.com',
  owner: 'adea-ai',
  repo: 'adea',
  title: summary.title,
  state: summary.state,
  draft: summary.draft,
  headRef: summary.headRef,
  headSha: summary.headSha,
  baseRef: summary.baseRef,
  baseSha: sha('0'),
  url: summary.url,
  mergeable: 'mergeable',
  labels: summary.labels,
  version: 1,
  updatedAt: summary.updatedAt,
  observedAt: summary.observedAt,
})
let pendingPlan: { operation: string; body: Record<string, unknown> } | undefined

async function execute(command: DevCommand): Promise<DevReply> {
  const body = command.body as Record<string, unknown>
  state.commands.push({ operation: command.operation, body })
  await new Promise((resolve) => setTimeout(resolve, 20))
  if (command.operation === 'dev.gitlab.account')
    return scenario === 'gitlab-disconnected' || scenario === 'disconnected'
      ? fail(command, 'unauthenticated', 'glab is not authenticated for this operation')
      : ok(command, {
          provider: 'gitlab',
          host: 'gitlab.com',
          login: 'dana',
          observedAt: new Date(now).toISOString(),
        })
  // The GitLab mirror shares the GitHub bodies and DTOs.
  const operation = command.operation.replace('dev.gitlab.', 'dev.github.')
  switch (operation) {
    case 'dev.github.account':
      return scenario === 'disconnected'
        ? fail(
            command,
            'unauthenticated',
            'gh is not authenticated for this operation: run gh auth login'
          )
        : ok(command, {
            provider: 'github',
            host: 'github.com',
            login: viewer,
            observedAt: new Date(now).toISOString(),
          })
    case 'dev.project.list':
      return ok(
        command,
        page(
          repos.map((repo) => ({
            id: repo.project,
            scope,
            repoIds: [repo.id],
            lifecycle: repo.archived ? 'archived' : 'ready',
            version: 1,
          }))
        )
      )
    case 'dev.repo.list':
      // `unregistered`: gh is connected and projects exist, but no registry
      // record was ever proven (import mints bindings; adoption proves
      // records) — the sidebar's honest empty state for the owner report.
      if (scenario === 'unregistered') return ok(command, page([]))
      // `auto-adopt`: the host's import-time adoption is a background side
      // effect. The first read sees nothing registered; every later read
      // sees the proof, mirroring a completed auto-adopt without any
      // dev.repo.adopt command the client could have issued.
      if (scenario === 'auto-adopt') {
        repoListReads += 1
        if (repoListReads === 1) return ok(command, page([]))
      }
      return ok(
        command,
        page(
          repos.map((repo) => ({
            id: repo.id,
            scope,
            kind: 'git',
            lifecycle: 'ready',
            canonicalRoot: `/work/${repo.name}`,
            remote: {
              provider: repo.provider ?? 'github',
              host: hostOf(repo.provider ?? 'github'),
              ownerPath: repo.owner,
              displayUrl: `https://${hostOf(repo.provider ?? 'github')}/${repo.owner}/${repo.name}`,
            },
            projectIds: [repo.project],
            version: 1,
          }))
        )
      )
    case 'dev.worktree.list':
      // ADR 0011 strict Worktree record: the client decodes it fail-closed, so
      // the fixture must satisfy the exact DTO for the pull request's session
      // link (repoId + head branch) to resolve at all.
      return ok(
        command,
        page([
          {
            id: worktreeId,
            scope,
            kind: 'managed',
            repoId: repoId.adea,
            projectId: projectId.adea,
            canonicalRoot: '/work/adea',
            rootIdentity: { mtimeNs: '0', size: '0' },
            provenance: 'adea',
            lifecycle: 'ready',
            bootstrap: 'completed',
            archived: false,
            generation: 1,
            version: 1,
            headRef: 'agent/juno/solid-store-signals',
          },
        ])
      )
    case 'dev.session.list':
      return ok(
        command,
        page([
          {
            id: sessionId,
            projectId: projectId.adea,
            worktreeId,
            displayName: 'Store migration',
            lifecycle: 'ready',
            archived: false,
          },
        ])
      )
    case 'dev.github.repository':
      return ok(command, {
        repoId: body.repoId,
        provider: providerOfRepo(body.repoId),
        host: hostOf(providerOfRepo(body.repoId)),
        owner: 'adea-ai',
        name: repos.find((repo) => repo.id === body.repoId)?.name ?? 'adea',
        fullName: 'adea-ai/adea',
        defaultBranch: 'main',
        url: 'https://github.com/adea-ai/adea',
        visibility: 'private',
        fork: false,
        freshness: 'fresh',
        observedAt: new Date(now).toISOString(),
        defaultBranchHead: {
          sha: sha('a41f9c2'),
          checks: body.repoId === repoId.control ? 'failure' : 'success',
        },
      })
    case 'dev.github.pullRequestSummaries': {
      const wanted = body.state ?? 'open'
      if (wanted === 'merged' && body.repoId === repoId.adea)
        return ok(
          command,
          page([
            {
              ...pr(880, 'Ship the conversation transcript', juno, 'agent/juno/transcript', 4000),
              state: 'merged',
              mergedAt: ago(3900),
            },
          ])
        )
      return ok(
        command,
        page(
          state.pulls
            .filter((entry) => entry.repoId === body.repoId && entry.state === wanted)
            .map(({ body: _body, behindBy: _behind, ...rest }) => rest)
        )
      )
    }
    case 'dev.github.pullRequestSummary': {
      const found = find(body.pullRequestId)
      return found
        ? ok(command, { ...found, body: found.body ?? '' })
        : fail(command, 'not_found', 'not found')
    }
    case 'dev.github.pullRequest': {
      const found = find(body.pullRequestId)
      return found ? ok(command, restPr(found)) : fail(command, 'not_found', 'not found')
    }
    case 'dev.github.timeline':
      return ok(command, page(body.pullRequestId === 'gh:adea-ai/adea#904' ? timeline : []))
    case 'dev.github.commits':
      return ok(command, page(commits))
    case 'dev.github.files':
      return ok(command, page(files))
    case 'dev.github.checks':
      return ok(command, page(checks))
    case 'dev.github.checkLog':
      return ok(command, {
        checkId: body.checkId,
        text: log,
        truncated: false,
        observedAt: new Date(now).toISOString(),
      })
    case 'dev.github.labels':
      return ok(
        command,
        page([
          { name: 'migration' },
          { name: 'solid' },
          { name: 'performance' },
          { name: 'bug', color: 'd73a4a' },
        ])
      )
    case 'dev.github.assignableUsers':
      return ok(
        command,
        page([
          { login: 'dana', kind: 'user', name: 'Dana' },
          { login: 'mika', kind: 'user' },
          { login: viewer, kind: 'user' },
        ])
      )
    case 'dev.github.branches':
      return ok(
        command,
        page([
          { name: 'main', sha: sha('0'), protected: true },
          { name: 'agent/juno/new-feature', sha: sha('5'), protected: false },
        ])
      )
    case 'dev.github.compare':
      return ok(command, {
        baseRef: body.baseRef,
        headRef: body.headRef,
        status: 'ahead',
        aheadBy: 6,
        behindBy: 0,
        commitCount: 6,
        changedFiles: 9,
        additions: 140,
        deletions: 6,
        observedAt: new Date(now).toISOString(),
      })
    case 'dev.github.comment': {
      const item: GitHubTimelineItem = {
        kind: 'comment',
        id: `IC_${state.commands.length}`,
        author: { login: viewer, kind: 'user' },
        body: String(body.body),
        createdAt: new Date(now).toISOString(),
      }
      timeline.push(item)
      return ok(command, item)
    }
    case 'dev.github.threadResolve': {
      const thread = timeline.find((entry) => entry.id === body.threadId) as Extract<
        GitHubTimelineItem,
        { kind: 'thread' }
      >
      const updated = { ...thread, resolved: body.resolved === true }
      timeline.splice(timeline.indexOf(thread), 1, updated)
      return ok(command, updated)
    }
    case 'dev.github.submitReview':
      return ok(command, {
        kind: 'review',
        id: `PRR_${state.commands.length}`,
        author: { login: viewer, kind: 'user' },
        state:
          body.verdict === 'approve'
            ? 'approved'
            : body.verdict === 'request_changes'
              ? 'changes_requested'
              : 'commented',
        body: String(body.body),
        commitSha: body.expectedHeadSha,
        createdAt: new Date(now).toISOString(),
      })
    case 'dev.github.metadataUpdate': {
      const found = find(body.pullRequestId)!
      const labels = body.labels as { add: string[]; remove: string[] } | undefined
      if (labels)
        found.labels = [
          ...found.labels.filter((label) => !labels.remove.includes(label)),
          ...labels.add,
        ]
      return ok(command, found)
    }
    case 'dev.github.mergePlan':
    case 'dev.github.autoMergePlan':
    case 'dev.github.syncBranchPlan':
    case 'dev.github.updatePlan':
      pendingPlan = { operation: command.operation, body }
      return ok(command, plan(command, `plan-${state.commands.length}`))
    case 'dev.github.mergeCommit': {
      const found = find(pendingPlan?.body.pullRequestId)!
      found.state = 'merged'
      return ok(command, {
        ...restPr(found),
        state: 'merged',
        headBranchDeleted: pendingPlan?.body.deleteBranch === true,
      })
    }
    case 'dev.github.autoMergeCommit': {
      const found = find(pendingPlan?.body.pullRequestId)!
      found.autoMerge = pendingPlan?.body.enabled
        ? { method: (pendingPlan.body.method as 'squash') ?? 'squash', enabledBy: viewer }
        : undefined
      if (!found.autoMerge) delete found.autoMerge
      return ok(command, found)
    }
    case 'dev.github.syncBranchCommit': {
      const found = find(pendingPlan?.body.pullRequestId)!
      found.behindBy = 0
      found.mergeState = 'blocked'
      return ok(command, found)
    }
    case 'dev.github.updateCommit': {
      const found = find(pendingPlan?.body.pullRequestId)!
      const patch = pendingPlan?.body.patch as { draft?: boolean; state?: 'open' | 'closed' }
      if (patch.draft !== undefined) found.draft = patch.draft
      if (patch.state) found.state = patch.state
      return ok(command, restPr(found))
    }
    case 'dev.github.createPullRequest': {
      const created = pr(
        914,
        String(body.title),
        { login: viewer, kind: 'user' },
        String(body.headRef),
        0,
        { draft: true, mergeState: 'draft' }
      )
      state.pulls.unshift(created)
      return ok(command, { ...restPr(created), reconciled: false })
    }
    case 'dev.github.rerunFailedJobs':
      return ok(command, {
        checkId: body.checkId,
        runId: '9001',
        observedAt: new Date(now).toISOString(),
      })
    default:
      return fail(
        command,
        'unsupported_capability',
        `The harness has no handler for ${command.operation}.`
      )
  }
}

const runtime: DevRuntimeService = {
  state: () => ({ status: 'ready' }),
  ready: Promise.resolve(),
  preferenceScope: () => scope,
  projection: async () => ({ projects: [] }),
  capabilitySnapshot: async (requestScope) => ({
    scope: requestScope,
    granted: [],
    unavailable: [],
    channelGeneration: 1,
    observedAt: new Date(now).toISOString(),
  }),
  execute,
} as unknown as DevRuntimeService

declare global {
  interface Window {
    sourceControlHarness: {
      commands(): { operation: string; body: Record<string, unknown> }[]
      setFonts(settings: AppearanceEditorFontSettings): void
      resetFonts(): void
      /** Moves the app's clock past its 10 s focus re-sync gate. */
      advanceClock(ms: number): void
    }
  }
}
window.sourceControlHarness = {
  commands: () => state.commands,
  setFonts: (settings) => applyAppearanceFontSettings(document.documentElement, settings),
  resetFonts: () =>
    applyAppearanceFontSettings(document.documentElement, DEFAULT_APPEARANCE_EDITOR_FONT_SETTINGS),
  advanceClock: (ms) => {
    clockSkewMs += ms
  },
}

if (params.get('reset') !== 'keep') {
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith('adea:source-control')) localStorage.removeItem(key)
  } catch {
    // Storage is optional.
  }
}

const root = document.getElementById('harness-root')!
const toolbar = document.getElementById('harness-toolbar') ?? undefined
// The register stores no names; the host supplies them from the cloud list.
const projectNames = new Map(repos.map((repo) => [repo.project, repo.projectName]))
render(
  () => (
    <SourceControlApp
      runtime={runtime}
      now={() => now + clockSkewMs}
      toolbarMount={toolbar}
      projectNames={projectNames}
    />
  ),
  root
)
