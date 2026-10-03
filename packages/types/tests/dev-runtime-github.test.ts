// Source control app GitHub collaboration DTOs. The request DSL bodies and
// strict reply decoders for the inbox, timeline, commits, files, check logs,
// pickers and the collaboration mutations: valid shapes decode, and unknown
// keys, malformed ids and out-of-range values fail closed.
import { describe, expect, test } from 'bun:test'

import { decodeDevCommand, decodeDevReply, devOperationDefinitions } from '../src/dev-runtime'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const now = '2026-10-03T12:00:00.000Z'
const sha = 'a'.repeat(40)
const prId = 'gh:acme/widgets#7'

function command(operation: keyof typeof devOperationDefinitions, body: Record<string, unknown>) {
  const definition = devOperationDefinitions[operation]
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000004',
    nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
    issuedAt: '2026-10-03T12:00:00.000Z',
    expiresAt: '2026-10-03T12:01:00.000Z',
    scope,
    capabilities: definition.capabilities,
    ...(definition.resource
      ? {
          resource: {
            kind: definition.resource.kind,
            id: String(body[definition.resource.idField]),
            generation: 0,
          },
        }
      : {}),
    body,
  }
}

function reply(operation: keyof typeof devOperationDefinitions, value: unknown) {
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000004',
    ok: true,
    value,
    observedAt: now,
  }
}

const page = (items: readonly unknown[]) => ({ items, observedAt: now })

const summary = {
  id: prId,
  repoId: '00000000-0000-4000-8000-00000000repo',
  number: 7,
  title: 'Add widget support',
  url: 'https://github.com/acme/widgets/pull/7',
  state: 'open',
  draft: false,
  author: { login: 'juno[bot]', kind: 'bot' },
  headRef: 'agent/juno/widgets',
  headSha: sha,
  baseRef: 'main',
  crossRepository: false,
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  commitCount: 1,
  labels: ['area:frontend'],
  assignees: [],
  requestedReviewers: [{ login: 'octocat', kind: 'user' }],
  reviews: [{ actor: { login: 'dana', kind: 'user' }, state: 'approved', commitSha: sha }],
  reviewDecision: 'review_required',
  mergeable: 'mergeable',
  mergeState: 'blocked',
  checks: { state: 'pending', passing: 3, failing: 0, running: 1, skipped: 0, total: 4 },
  mergeMethods: ['merge', 'squash'],
  autoMergeAllowed: true,
  viewerCanUpdateBranch: true,
  linkedIssues: [
    { number: 3, title: 'Widgets', state: 'open', url: 'https://github.com/acme/widgets/issues/3' },
  ],
  createdAt: now,
  updatedAt: now,
  observedAt: now,
}

describe('GitHub collaboration request bodies', () => {
  test('decode the new read and write operations', () => {
    const bodies: [keyof typeof devOperationDefinitions, Record<string, unknown>][] = [
      ['dev.github.pullRequestSummaries', { repoId: 'repo-1', state: 'open', limit: 50 }],
      ['dev.github.pullRequestSummary', { pullRequestId: prId, refresh: true }],
      ['dev.github.timeline', { pullRequestId: prId, limit: 100 }],
      ['dev.github.commits', { pullRequestId: prId }],
      ['dev.github.files', { pullRequestId: prId, cursor: 'MTAw' }],
      ['dev.github.checks', { pullRequestId: prId, sha }],
      ['dev.github.checkLog', { pullRequestId: prId, checkId: '42' }],
      ['dev.github.labels', { repoId: 'repo-1' }],
      ['dev.github.assignableUsers', { repoId: 'repo-1', query: 'oct' }],
      ['dev.github.branches', { repoId: 'repo-1', limit: 100 }],
      ['dev.github.compare', { repoId: 'repo-1', baseRef: 'main', headRef: 'feat/x' }],
      ['dev.github.comment', { pullRequestId: prId, body: 'Looks good' }],
      ['dev.github.threadReply', { pullRequestId: prId, threadId: 'PRRT_1', body: 'Fixed' }],
      ['dev.github.threadResolve', { pullRequestId: prId, threadId: 'PRRT_1', resolved: true }],
      ['dev.github.metadataUpdate', { pullRequestId: prId, labels: { add: ['bug'], remove: [] } }],
      [
        'dev.github.submitReview',
        {
          pullRequestId: prId,
          expectedHeadSha: sha,
          verdict: 'approve',
          body: '',
          comments: [{ path: 'src/a.ts', line: 4, side: 'right', startLine: 2, body: 'nit' }],
        },
      ],
      [
        'dev.github.autoMergePlan',
        { pullRequestId: prId, expectedHeadSha: sha, enabled: true, method: 'squash' },
      ],
      [
        'dev.github.syncBranchPlan',
        { pullRequestId: prId, expectedHeadSha: sha, method: 'rebase' },
      ],
      ['dev.github.rerunFailedJobs', { pullRequestId: prId, checkId: '42' }],
      [
        'dev.github.mergePlan',
        { pullRequestId: prId, expectedHeadSha: sha, method: 'squash', deleteBranch: true },
      ],
      [
        'dev.github.updatePlan',
        { pullRequestId: prId, expectedVersion: 2, patch: { state: 'closed' } },
      ],
    ]
    for (const [operation, body] of bodies) {
      const value = command(operation, body)
      expect(decodeDevCommand(value)).toEqual(value)
    }
  })

  test('reject unknown keys, empty comments and inverted review ranges', () => {
    expect(() =>
      decodeDevCommand(command('dev.github.comment', { pullRequestId: prId, body: '' }))
    ).toThrow()
    expect(() =>
      decodeDevCommand(
        command('dev.github.timeline', { pullRequestId: prId, includeEverything: true })
      )
    ).toThrow('unknown key')
    expect(() =>
      decodeDevCommand(
        command('dev.github.submitReview', {
          pullRequestId: prId,
          expectedHeadSha: sha,
          verdict: 'approve',
          body: '',
          comments: [{ path: 'a.ts', line: 2, side: 'right', startLine: 5, body: 'x' }],
        })
      )
    ).toThrow('must not follow line')
    expect(() =>
      decodeDevCommand(
        command('dev.github.updatePlan', {
          pullRequestId: prId,
          expectedVersion: 2,
          patch: { state: 'merged' },
        })
      )
    ).toThrow()
  })
})

describe('GitHub collaboration replies', () => {
  test('decode summaries, timeline items, commits, files and pickers', () => {
    const replies: [keyof typeof devOperationDefinitions, unknown][] = [
      ['dev.github.pullRequestSummaries', page([summary])],
      ['dev.github.pullRequestSummary', { ...summary, body: 'Implements widgets', behindBy: 2 }],
      [
        'dev.github.timeline',
        page([
          {
            kind: 'comment',
            id: 'IC_1',
            author: { login: 'mika', kind: 'user' },
            body: 'Hi',
            createdAt: now,
          },
          {
            kind: 'review',
            id: 'PRR_1',
            state: 'approved',
            body: '',
            commitSha: sha,
            createdAt: now,
          },
          {
            kind: 'commit',
            id: sha,
            sha,
            headline: 'Add widgets',
            checks: 'failure',
            createdAt: now,
          },
          {
            kind: 'thread',
            id: 'PRRT_1',
            path: 'src/a.ts',
            line: 4,
            side: 'right',
            diffHunk: '@@ -1 +1 @@',
            resolved: false,
            outdated: false,
            comments: [{ id: 'PRRC_1', body: 'Does this throw?', createdAt: now }],
            createdAt: now,
          },
          { kind: 'event', id: 'ME_1', event: 'merged', detail: sha, createdAt: now },
        ]),
      ],
      [
        'dev.github.commits',
        page([
          {
            sha,
            headline: 'Add widgets',
            authorLogin: 'juno',
            committedAt: now,
            checks: 'success',
          },
        ]),
      ],
      [
        'dev.github.files',
        page([
          {
            path: 'src/a.ts',
            status: 'modified',
            additions: 2,
            deletions: 1,
            patch: '@@ -1 +1 @@\n-a\n+b',
            patchTruncated: false,
          },
          { path: 'img.png', status: 'added', additions: 0, deletions: 0, patchTruncated: false },
        ]),
      ],
      [
        'dev.github.checkLog',
        { checkId: '42', text: 'FAIL a.test.ts', truncated: false, observedAt: now },
      ],
      ['dev.github.labels', page([{ name: 'bug', color: 'd73a4a', description: 'Broken' }])],
      [
        'dev.github.assignableUsers',
        page([{ login: 'octocat', kind: 'user', name: 'The Octocat' }]),
      ],
      ['dev.github.branches', page([{ name: 'main', sha, protected: true }])],
      [
        'dev.github.compare',
        {
          baseRef: 'main',
          headRef: 'feat/x',
          status: 'ahead',
          aheadBy: 2,
          behindBy: 0,
          commitCount: 2,
          changedFiles: 3,
          additions: 10,
          deletions: 1,
          observedAt: now,
        },
      ],
      ['dev.github.rerunFailedJobs', { checkId: '42', runId: '9001', observedAt: now }],
      [
        'dev.github.autoMergeCommit',
        { ...summary, autoMerge: { method: 'squash', enabledBy: 'octocat' } },
      ],
    ]
    for (const [operation, value] of replies) {
      const envelope = reply(operation, value)
      expect(decodeDevReply(envelope)).toEqual(envelope)
    }
  })

  test('fail closed on unknown keys and malformed provider facts', () => {
    expect(() =>
      decodeDevReply(reply('dev.github.pullRequestSummary', { ...summary, extra: true }))
    ).toThrow('unknown key')
    expect(() =>
      decodeDevReply(reply('dev.github.pullRequestSummary', { ...summary, id: 'acme/widgets#7' }))
    ).toThrow('expected gh:')
    expect(() =>
      decodeDevReply(
        reply(
          'dev.github.timeline',
          page([{ kind: 'event', id: 'E', event: 'deleted', createdAt: now }])
        )
      )
    ).toThrow()
    expect(() =>
      decodeDevReply(
        reply(
          'dev.github.timeline',
          page([{ kind: 'comment', id: 'IC', body: 'x', createdAt: now, sha }])
        )
      )
    ).toThrow('unknown key')
    expect(() =>
      decodeDevReply(reply('dev.github.labels', page([{ name: 'bug', color: '#d73a4a' }])))
    ).toThrow('hex')
  })
})
