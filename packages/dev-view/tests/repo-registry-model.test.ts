import { describe, expect, test } from 'bun:test'

import type {
  CredentialRef,
  Project,
  Repo,
  RepoInspection,
  RootBookmark,
  Scope,
} from '../../../packages/types/src/dev-runtime'
import { decodeRepo, decodeRepoInspection } from '../../../packages/types/src/dev-runtime'

import {
  archiveNoticeForError,
  beginRegistryLoad,
  cancelPendingArchive,
  confirmPendingArchive,
  credentialRefsForHost,
  defaultAdoptBookmarkId,
  expectedRepoVersion,
  inspectionLine,
  lifecycleBadge,
  projectBindings,
  registryError,
  registryReady,
  registryUnavailable,
  registryUnavailableNotice,
  repoBaseName,
  repoCommandNotice,
  repoRows,
  requestArchive,
  type RepoRegistryState,
} from '../src/sidebar/repo-registry-model'

const scope: Scope = { accountId: 'a1', workspaceId: 'w1', runtimeNodeId: 'n1' }
const identity = { mtimeNs: '1', size: '2' }

const project = (over: Partial<Project> & Pick<Project, 'id' | 'name'>): Project => ({
  scope,
  groupIds: [],
  repoIds: [],
  lifecycle: 'ready',
  version: 1,
  ...over,
})

const repo = (over: Partial<Repo> & Pick<Repo, 'id'>): Repo => ({
  scope,
  kind: 'git',
  lifecycle: 'ready',
  canonicalRoot: `/repo/${over.id}`,
  projectIds: [],
  version: 1,
  ...over,
})

const refusal = (code: string, message: string) =>
  ({ code, retryable: false, message }) as unknown as Parameters<typeof repoCommandNotice>[1]

const uuid = (seed: string) => `${seed}-1111-4111-8111-111111111111`

describe('project bindings', () => {
  test('flattens the import-time binding triples across projects', () => {
    const bindings = projectBindings([
      project({
        id: 'p1',
        name: 'Alpha',
        repoIds: ['r1'],
        repos: [{ repoId: 'r1', rootBookmarkId: 'b1', canonicalRoot: '/repo/alpha' }],
      }),
      project({
        id: 'p2',
        name: 'Beta',
        repoIds: ['r1', 'r2'],
        repos: [
          { repoId: 'r1', rootBookmarkId: 'b1', canonicalRoot: '/repo/alpha' },
          { repoId: 'r2', rootBookmarkId: 'b2', canonicalRoot: '/repo/beta' },
        ],
      }),
    ])
    expect(bindings.map((binding) => binding.repoId).toSorted()).toEqual(['r1', 'r2'])
    const shared = bindings.find((binding) => binding.repoId === 'r1')
    expect(shared?.rootBookmarkId).toBe('b1')
    expect(shared?.projects.map((entry) => entry.id)).toEqual(['p1', 'p2'])
  })

  test('projects without import bindings contribute nothing', () => {
    expect(projectBindings([project({ id: 'p1', name: 'Solo' })])).toEqual([])
  })
})

describe('repo rows', () => {
  test('a binding without a durable record renders as binding-only', () => {
    const rows = repoRows(
      [
        {
          repoId: 'r1',
          canonicalRoot: '/repo/alpha',
          rootBookmarkId: 'b1',
          projects: [{ id: 'p1', name: 'Alpha', archived: false, version: 1 }],
        },
      ],
      []
    )
    expect(rows.length).toBe(1)
    expect(rows[0]?.lifecycle).toBe('binding-only')
    expect(rows[0]?.record).toBeUndefined()
    expect(expectedRepoVersion(rows[0]!)).toBe(1)
  })

  test('a durable record wins: lifecycle, canonical root, and version', () => {
    const rows = repoRows(
      [
        {
          repoId: 'r1',
          canonicalRoot: '/repo/binding',
          rootBookmarkId: 'b1',
          projects: [{ id: 'p1', name: 'Alpha', archived: false, version: 1 }],
        },
      ],
      [
        repo({
          id: 'r1',
          lifecycle: 'stale',
          canonicalRoot: '/repo/proven',
          version: 4,
          remote: {
            provider: 'github',
            host: 'github.com',
            ownerPath: 'adea/alpha',
            displayUrl: 'https://github.com/adea/alpha',
          },
        }),
      ]
    )
    expect(rows[0]?.lifecycle).toBe('stale')
    expect(rows[0]?.canonicalRoot).toBe('/repo/proven')
    expect(expectedRepoVersion(rows[0]!)).toBe(4)
  })

  test('a record without a live binding still renders, projects empty', () => {
    const rows = repoRows([], [repo({ id: 'r9' })])
    expect(rows.length).toBe(1)
    expect(rows[0]?.repoId).toBe('r9')
    expect(rows[0]?.projects).toEqual([])
    expect(rows[0]?.lifecycle).toBe('ready')
  })

  test('rows sort by first project name, then canonical root', () => {
    const rows = repoRows(
      [
        {
          repoId: 'rB',
          canonicalRoot: '/z',
          rootBookmarkId: '',
          projects: [{ id: 'p2', name: 'Beta', archived: false, version: 1 }],
        },
        {
          repoId: 'rA',
          canonicalRoot: '/m',
          rootBookmarkId: '',
          projects: [{ id: 'p1', name: 'Alpha', archived: false, version: 1 }],
        },
      ],
      []
    )
    expect(rows.map((row) => row.repoId)).toEqual(['rA', 'rB'])
  })
})

describe('adopt defaults', () => {
  const bookmarks: readonly RootBookmark[] = [
    {
      id: 'b-revoked',
      scope,
      label: 'revoked root',
      kind: 'repository',
      canonicalRoot: '/repo/x',
      rootIdentity: identity,
      state: 'revoked',
      generation: 1,
      version: 1,
    },
    {
      id: 'b-dir',
      scope,
      label: 'folder root',
      kind: 'directory',
      canonicalRoot: '/dir',
      rootIdentity: identity,
      state: 'active',
      generation: 1,
      version: 1,
    },
    {
      id: 'b-2',
      scope,
      label: 'second repo root',
      kind: 'repository',
      canonicalRoot: '/repo/two',
      rootIdentity: identity,
      state: 'active',
      generation: 1,
      version: 1,
    },
    {
      id: 'b-1',
      scope,
      label: 'first repo root',
      kind: 'repository',
      canonicalRoot: '/repo/one',
      rootIdentity: identity,
      state: 'active',
      generation: 1,
      version: 1,
    },
  ]

  test('the binding bookmark is the default when still an active repository root', () => {
    expect(defaultAdoptBookmarkId({ rootBookmarkId: 'b-2' }, bookmarks)).toBe('b-2')
  })

  test('a revoked binding bookmark is never a default; first active repository wins', () => {
    expect(defaultAdoptBookmarkId({ rootBookmarkId: 'b-revoked' }, bookmarks)).toBe('b-2')
    expect(defaultAdoptBookmarkId({ rootBookmarkId: '' }, bookmarks)).toBe('b-2')
  })

  test('directory bookmarks and empty bookmark lists adopt nothing by default', () => {
    expect(defaultAdoptBookmarkId({ rootBookmarkId: 'b-dir' }, bookmarks)).toBe('b-2')
    expect(defaultAdoptBookmarkId({ rootBookmarkId: 'b-1' }, [bookmarks[1]!])).toBe('')
  })
})

describe('credential refs', () => {
  const refs: readonly CredentialRef[] = [
    {
      id: 'c1',
      scope,
      label: 'github token',
      host: 'github.com',
      kind: 'github_token',
      state: 'ready',
      version: 1,
    },
    {
      id: 'c2',
      scope,
      label: 'expired gitlab',
      host: 'gitlab.com',
      kind: 'git_https',
      state: 'expired',
      version: 1,
    },
  ]

  test('only ready refs on the matching host (case-insensitive) are offered', () => {
    expect(credentialRefsForHost(refs, 'GitHub.com').map((ref) => ref.id)).toEqual(['c1'])
    expect(credentialRefsForHost(refs, 'github.com').map((ref) => ref.id)).toEqual(['c1'])
    expect(credentialRefsForHost(refs, 'example.org')).toEqual([])
  })
})

describe('inspection and lifecycle rendering', () => {
  const base = {
    rootIdentity: identity,
    dirty: false,
    observedAt: '2026-09-20T00:00:00.000Z',
  }

  const inspection = (over: Partial<RepoInspection>): RepoInspection => ({
    ...base,
    repo: repo({ id: 'r1' }),
    ...over,
  })

  test('inspection line carries ref, short sha, and dirty marker', () => {
    const value = inspection({ headRef: 'refs/heads/main', headSha: 'a'.repeat(40), dirty: true })
    expect(inspectionLine(value)).toBe('refs/heads/main @ aaaaaaa · dirty')
    expect(
      inspectionLine(inspection({ headRef: 'refs/heads/main', headSha: 'b'.repeat(40) }))
    ).toBe('refs/heads/main @ bbbbbbb · clean')
  })

  test('a detached or unavailable checkout degrades the line, never crashes', () => {
    expect(inspectionLine(inspection({}))).toContain('detached HEAD')
    expect(inspectionLine(inspection({ repo: repo({ id: 'r1', lifecycle: 'unavailable' }) }))).toBe(
      'Checkout unavailable'
    )
  })

  test('lifecycle badges map to truthful tones', () => {
    expect(lifecycleBadge('ready')).toEqual({ label: 'ready', tone: 'success' })
    expect(lifecycleBadge('stale')?.tone).toBe('failure')
    expect(lifecycleBadge('unavailable')?.tone).toBe('failure')
    expect(lifecycleBadge('refreshing')?.tone).toBe('progress')
    expect(lifecycleBadge('binding-only')).toEqual({ label: 'not adopted', tone: undefined })
  })

  test('row titles use the canonical root basename', () => {
    expect(repoBaseName('/Users/dev/work/alpha')).toBe('alpha')
    expect(repoBaseName('/repo/trailing/')).toBe('trailing')
  })
})

describe('typed notices', () => {
  test('typed-unavailable names the missing registry provider', () => {
    expect(registryUnavailableNotice('capability_unavailable')).toContain('capability_unavailable')
    expect(registryUnavailableNotice('capability_denied')).toContain('capability_denied')
    expect(registryUnavailableNotice('weird_code')).toContain('weird_code')
  })

  test('repo command notices explain retries and host mismatches', () => {
    expect(repoCommandNotice('Adopt', refusal('stale_version', 'moved on'))).toContain('try again')
    expect(repoCommandNotice('Adopt', refusal('unauthorized_root', 'nope'))).toContain(
      'authorized root'
    )
    expect(repoCommandNotice('Authorize', refusal('identity_mismatch', 'host'))).toContain(
      'host does not match'
    )
    expect(repoCommandNotice('Refresh', refusal('not_found', 'gone'))).toContain('gone')
  })

  test('archive notices surface live-session refusals verbatim', () => {
    const live = refusal(
      'invalid_state',
      'project p1 still has 2 live session(s); archive them first'
    )
    expect(archiveNoticeForError(live)).toContain('2 live session(s)')
    expect(archiveNoticeForError(refusal('stale_version', 'moved'))).toContain('try again')
  })
})

describe('registry state machine', () => {
  test('loading/unavailable states never fabricate rows', () => {
    expect(beginRegistryLoad()).toEqual({ status: 'loading', rows: [], projects: [] })
    expect(registryUnavailable('capability_unavailable').rows).toEqual([])
  })

  test('an error keeps recoverable rows mounted and names the reason', () => {
    const ready = registryReady([], [])
    const failed = registryError('registry data failed strict decode', ready)
    expect(failed.status).toBe('error')
    expect(failed.reason).toContain('strict decode')
  })

  test('archive passes an explicit confirmation gate', () => {
    let state: RepoRegistryState = registryReady([], [project({ id: 'p1', name: 'Alpha' })])
    state = requestArchive(state, 'p1')
    expect(state.pendingArchiveProjectId).toBe('p1')
    state = cancelPendingArchive(state)
    expect(state.pendingArchiveProjectId).toBeUndefined()
    state = requestArchive(state, 'p1')
    const commit = confirmPendingArchive(state)
    expect(commit.projectId).toBe('p1')
    expect(commit.state.pendingArchiveProjectId).toBeUndefined()
  })

  test('cancel and confirm without a pending request are no-ops', () => {
    const ready = registryReady([], [])
    expect(cancelPendingArchive(ready)).toBe(ready)
    const again = confirmPendingArchive(ready)
    expect(again.projectId).toBeUndefined()
    expect(again.state).toBe(ready)
  })
})

describe('strict decoder composition', () => {
  test('repoRows composes with the provider-owned Repo decoder', () => {
    const decoded = decodeRepo({
      id: uuid('44444444'),
      scope: {
        accountId: uuid('11111111'),
        workspaceId: uuid('22222222'),
        runtimeNodeId: uuid('33333333'),
      },
      kind: 'git',
      lifecycle: 'ready',
      canonicalRoot: '/repo/alpha',
      remote: {
        provider: 'github',
        host: 'github.com',
        ownerPath: 'adea/alpha',
        displayUrl: 'https://github.com/adea/alpha',
      },
      defaultRef: 'refs/heads/main',
      projectIds: [uuid('55555555')],
      version: 2,
    })
    const rows = repoRows([], [decoded])
    expect(rows[0]?.record?.remote?.host).toBe('github.com')
    expect(rows[0]?.record?.defaultRef).toBe('refs/heads/main')
    expect(expectedRepoVersion(rows[0]!)).toBe(2)
  })

  test('the inspection decoder refuses a bogus sha before any rendering', () => {
    expect(() =>
      decodeRepoInspection({
        repo: repo({ id: 'r1' }),
        rootIdentity: identity,
        headSha: 'not-a-sha',
        dirty: false,
        observedAt: '2026-09-20T00:00:00.000Z',
      })
    ).toThrow()
  })
})
