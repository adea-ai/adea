/*
 * Source control app state: the provider accounts, the runtime catalog (projects,
 * repositories, worktrees, sessions), each repository's open pull requests
 * and default-branch CI, and the selection/route. Sync polls on an interval
 * and on window focus; webhooks are a later improvement. Every pull request
 * read through here is linked to its Adea session before the UI sees it.
 */
import type {
  GitHubAccount,
  GitHubPullRequestSummary,
  GitHubRepository,
} from '@adea-ai/types/dev-runtime'
import { batch, createMemo, createSignal, onCleanup } from 'solid-js'
import { devProjectDisplayName, type DevProjectNames } from '../platform'

import { errorText, type ScmClient } from './client'
import { classifyPullRequest, needsViewer } from './model/inbox'
import type { AppPreferences, AppStorage, PrTab, Selection } from './model/persistence'
import { indexSessions, linkPullRequest } from './model/sessions'
import { buildTree, type RepoStats, type TreeProject } from './model/tree'
import {
  providerOf,
  type LinkedSession,
  type PullRequestView,
  type ScmProvider,
} from './model/types'

export const SYNC_INTERVAL_MS = 60_000
const CONCURRENCY = 3

export type AccountState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'connected'; account: GitHubAccount }>
  | Readonly<{ status: 'disconnected'; reason: string; code: string }>

export type RepoPulls = Readonly<{
  items: readonly GitHubPullRequestSummary[]
  more: boolean
  error?: string
  loadedAt?: number
}>

export type Route =
  | Readonly<{ view: 'inbox' }>
  | Readonly<{ view: 'pr'; pullRequestId: string; repoId: string; tab: PrTab }>

export function createSourceControlState(options: {
  client: ScmClient
  storage: AppStorage
  now: () => number
  /** Cloud project names keyed by project id; absent names show the short id. */
  projectNames?: () => DevProjectNames | undefined
}) {
  const { client, storage } = options
  const [accounts, setAccounts] = createSignal<ReadonlyMap<ScmProvider, AccountState>>(new Map())
  const [projects, setProjects] = createSignal<Awaited<ReturnType<ScmClient['projects']>>>([])
  const [repos, setRepos] = createSignal<Awaited<ReturnType<ScmClient['repos']>>>([])
  const [sessionIndex, setSessionIndex] = createSignal<ReadonlyMap<string, LinkedSession>>(
    new Map()
  )
  const [pulls, setPulls] = createSignal<ReadonlyMap<string, RepoPulls>>(new Map())
  const [repoMeta, setRepoMeta] = createSignal<ReadonlyMap<string, GitHubRepository>>(new Map())
  const [catalogError, setCatalogError] = createSignal<string>()
  const [catalogLoaded, setCatalogLoaded] = createSignal(false)
  const [syncing, setSyncing] = createSignal(false)
  const [syncedAt, setSyncedAt] = createSignal<number>()
  const [preferences, setPreferencesSignal] = createSignal<AppPreferences>(
    storage.loadPreferences()
  )
  const [route, setRoute] = createSignal<Route>({ view: 'inbox' })
  const [tick, setTick] = createSignal(options.now())

  const setPreferences = (update: (current: AppPreferences) => AppPreferences) => {
    const next = update(preferences())
    setPreferencesSignal(next)
    storage.savePreferences(next)
  }

  /** A provider's account; GitHub unless asked. */
  const account = (provider: ScmProvider = 'github'): AccountState =>
    accounts().get(provider) ?? { status: 'loading' }

  /** The signed-in login on a provider. */
  const viewer = (provider: ScmProvider = 'github') => {
    const state = account(provider)
    return state.status === 'connected' ? state.account.login : undefined
  }

  /** The provider of each repository with a supported remote. */
  const repoProvider = (repoId: string): ScmProvider | undefined => {
    const remote = repos().find((repo) => repo.id === repoId)?.remote
    return remote?.provider === 'github' || remote?.provider === 'gitlab'
      ? remote.provider
      : undefined
  }

  /** Providers the catalog's repositories use; GitHub when there are none. */
  const providers = createMemo((): readonly ScmProvider[] => {
    const used = new Set<ScmProvider>()
    for (const repo of repos())
      if (repo.remote?.provider === 'github' || repo.remote?.provider === 'gitlab')
        used.add(repo.remote.provider)
    return used.size === 0 ? ['github'] : (['github', 'gitlab'] as const).filter((p) => used.has(p))
  })

  /** Disconnected only when no provider in use is connected; the first such
   *  provider's state explains why. */
  const disconnected = createMemo(() => {
    const states = providers().map((provider) => ({ provider, state: account(provider) }))
    if (states.some((entry) => entry.state.status !== 'disconnected')) return undefined
    const first = states[0]!
    return first.state.status === 'disconnected'
      ? { provider: first.provider, ...first.state }
      : undefined
  })

  /** The viewer for a pull request, on its own provider. */
  const viewerFor = (pullRequestId: string) => viewer(providerOf(pullRequestId))

  const tree = createMemo(() => {
    const stats = new Map<string, RepoStats>()
    for (const [repoId, entry] of pulls())
      stats.set(repoId, {
        openCount: entry.error ? undefined : entry.items.length,
        openCountMore: entry.more,
        ...(repoMeta().get(repoId)?.defaultBranchHead
          ? { ci: repoMeta().get(repoId)!.defaultBranchHead!.checks }
          : {}),
      })
    for (const [repoId, meta] of repoMeta())
      if (!stats.has(repoId) && meta.defaultBranchHead)
        stats.set(repoId, { ci: meta.defaultBranchHead.checks })
    return buildTree(
      projects().map((project) => ({
        id: project.id,
        name: devProjectDisplayName(project.id, options.projectNames?.()),
        repoIds: project.repoIds,
        archived: project.lifecycle === 'archived',
      })),
      repos().flatMap((repo) =>
        repo.remote
          ? [
              {
                id: repo.id,
                provider: repo.remote.provider,
                host: repo.remote.host,
                ownerPath: repo.remote.ownerPath,
                displayUrl: repo.remote.displayUrl,
              },
            ]
          : []
      ),
      stats,
      {
        ...(viewer('github') ? { github: viewer('github')! } : {}),
        ...(viewer('gitlab') ? { gitlab: viewer('gitlab')! } : {}),
      }
    )
  })

  const activeProjects = createMemo(() => tree().owners.flatMap((owner) => owner.projects))

  const projectFor = (repoId: string): TreeProject | undefined =>
    activeProjects().find((row) => row.repoId === repoId) ??
    tree().archived.find((row) => row.repoId === repoId)

  /** Linked views of a repository's open pull requests. */
  const openPulls = (repoId: string): readonly PullRequestView[] =>
    (pulls().get(repoId)?.items ?? []).map((pr) => linkPullRequest(pr, sessionIndex()))

  const link = (pr: GitHubPullRequestSummary): PullRequestView =>
    linkPullRequest(pr, sessionIndex())

  /** Every open pull request across active projects, for the shortcuts. */
  const everyOpen = createMemo(() =>
    activeProjects().flatMap((row) => openPulls(row.repoId).map((pr) => ({ pr, project: row })))
  )

  const shortcutCounts = createMemo(() => {
    let needsYou = 0
    let ready = 0
    for (const { pr } of everyOpen()) {
      if (classifyPullRequest(pr, viewerFor(pr.id)).group === 'ready') ready += 1
      if (needsViewer(pr, viewerFor(pr.id))) needsYou += 1
    }
    return { needsYou, ready }
  })

  const selection = createMemo((): Selection | undefined => {
    const stored = preferences().selection
    if (stored?.kind === 'shortcut') return stored
    if (stored?.kind === 'project' && projectFor(stored.repoId)) return stored
    const first = activeProjects()[0]
    return first ? { kind: 'project', repoId: first.repoId, projectId: first.projectId } : stored
  })

  const select = (next: Selection) => {
    batch(() => {
      setPreferences((current) => ({ ...current, selection: next }))
      setRoute({ view: 'inbox' })
    })
  }

  async function loadRepo(repoId: string): Promise<void> {
    const [summaries, meta] = await Promise.allSettled([
      client.summaries(repoId, 'open'),
      client.repository(repoId),
    ])
    setPulls((current) => {
      const next = new Map(current)
      if (summaries.status === 'fulfilled')
        next.set(repoId, {
          items: summaries.value.items,
          more: Boolean(summaries.value.nextCursor),
          loadedAt: options.now(),
        })
      else
        next.set(repoId, {
          items: current.get(repoId)?.items ?? [],
          more: false,
          error: errorText(summaries.reason),
        })
      return next
    })
    if (meta.status === 'fulfilled')
      setRepoMeta((current) => new Map(current).set(repoId, meta.value))
  }

  async function loadCatalog(): Promise<void> {
    const [projectList, repoList, worktrees, sessions] = await Promise.all([
      client.projects(),
      client.repos(),
      client.worktrees().catch(() => []),
      client.sessions().catch(() => []),
    ])
    client.setRepoProviders(
      repoList.flatMap((repo) =>
        repo.remote?.provider === 'github' || repo.remote?.provider === 'gitlab'
          ? [[repo.id, repo.remote.provider] as const]
          : []
      )
    )
    batch(() => {
      setProjects(projectList)
      setRepos(repoList)
      setSessionIndex(
        indexSessions(
          worktrees.map((worktree) => ({
            id: worktree.id,
            ...(worktree.repoId ? { repoId: worktree.repoId } : {}),
            ...(worktree.headRef ? { headRef: worktree.headRef } : {}),
            archived: worktree.archived,
          })),
          sessions.map((session) => ({
            id: session.id,
            projectId: session.projectId,
            worktreeId: session.worktreeId,
            ...(session.displayName ? { displayName: session.displayName } : {}),
            lifecycle: session.lifecycle,
            archived: session.archived,
          }))
        )
      )
      setCatalogError(undefined)
      setCatalogLoaded(true)
    })
  }

  let inFlight: Promise<void> | undefined
  async function loadAccount(provider: ScmProvider): Promise<void> {
    // Flip to an explicit checking state first: the providers dialog's rows
    // and chips read this, and "checking" must never render as "not checked".
    setAccounts((current) => new Map(current).set(provider, { status: 'loading' }))
    let next: AccountState
    try {
      next = { status: 'connected', account: await client.account(provider) }
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'unavailable'
      next = { status: 'disconnected', reason: errorText(error), code }
    }
    setAccounts((current) => new Map(current).set(provider, next))
  }

  /** Re-check one provider right now and report the resulting state, so the
   *  Check-again action can explain what happened instead of silently
   *  flickering. The check always settles, so the result is connected or
   *  disconnected — never the pre-check loading state. */
  async function checkProvider(
    provider: ScmProvider
  ): Promise<Extract<AccountState, { status: 'connected' | 'disconnected' }>> {
    await loadAccount(provider)
    const settled = account(provider)
    if (settled.status === 'loading') throw new Error('account check did not settle')
    return settled
  }

  /** Re-read the accounts, catalog, and every active repository. */
  function sync(): Promise<void> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      setSyncing(true)
      try {
        const github = loadAccount('github')
        try {
          await loadCatalog()
        } catch (error) {
          setCatalogError(errorText(error))
          setCatalogLoaded(true)
          await github
          return
        }
        await Promise.all([
          github,
          ...(providers().includes('gitlab') ? [loadAccount('gitlab')] : []),
        ])
        // A provider that is not signed in explains itself on its projects.
        setPulls((current) => {
          const next = new Map(current)
          for (const row of activeProjects()) {
            const state = account(row.provider)
            if (state.status === 'disconnected')
              next.set(row.repoId, { items: [], more: false, error: state.reason })
          }
          return next
        })
        const queue = activeProjects()
          .filter((row) => account(row.provider).status === 'connected')
          .map((row) => row.repoId)
        const unique = [...new Set(queue)]
        const workers = Array.from({ length: Math.min(CONCURRENCY, unique.length) }, async () => {
          for (let next = unique.shift(); next !== undefined; next = unique.shift())
            await loadRepo(next)
        })
        await Promise.all(workers)
        setSyncedAt(options.now())
      } finally {
        setSyncing(false)
        inFlight = undefined
      }
    })()
    return inFlight
  }

  /** Re-read one pull request after a mutation and fold it into its list. */
  function absorb(summary: GitHubPullRequestSummary): void {
    setPulls((current) => {
      const entry = current.get(summary.repoId)
      if (!entry) return current
      const exists = entry.items.some((item) => item.id === summary.id)
      const items =
        summary.state === 'open'
          ? exists
            ? entry.items.map((item) =>
                item.id === summary.id ? { ...summary, body: undefined } : item
              )
            : [summary, ...entry.items]
          : entry.items.filter((item) => item.id !== summary.id)
      return new Map(current).set(summary.repoId, {
        ...entry,
        items: items as GitHubPullRequestSummary[],
      })
    })
  }

  /** Re-sync on focus unless the last sync is recent. */
  const onFocus = () => {
    const last = syncedAt()
    if (last === undefined || options.now() - last > 10_000) void sync()
  }

  function startPolling(): void {
    const timer = setInterval(() => void sync(), SYNC_INTERVAL_MS)
    const clock = setInterval(() => setTick(options.now()), 15_000)
    window.addEventListener('focus', onFocus)
    onCleanup(() => {
      clearInterval(timer)
      clearInterval(clock)
      window.removeEventListener('focus', onFocus)
    })
  }

  return {
    client,
    storage,
    account,
    viewer,
    viewerFor,
    repoProvider,
    providers,
    disconnected,
    tree,
    activeProjects,
    projectFor,
    openPulls,
    everyOpen,
    link,
    shortcutCounts,
    selection,
    select,
    route,
    setRoute,
    preferences,
    setPreferences,
    repoMeta,
    pulls,
    catalogError,
    catalogLoaded,
    syncing,
    syncedAt,
    tick,
    sync,
    checkProvider,
    loadRepo,
    absorb,
    startPolling,
  }
}

export type SourceControlState = ReturnType<typeof createSourceControlState>
