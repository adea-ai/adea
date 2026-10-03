/*
 * Source control app state: the account, the runtime catalog (projects,
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

import { errorText, type ScmClient } from './client'
import { classifyPullRequest, needsViewer } from './model/inbox'
import type { AppPreferences, AppStorage, PrTab, Selection } from './model/persistence'
import { indexSessions, linkPullRequest } from './model/sessions'
import { buildTree, type RepoStats, type TreeProject } from './model/tree'
import type { LinkedSession, PullRequestView } from './model/types'

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
}) {
  const { client, storage } = options
  const [account, setAccount] = createSignal<AccountState>({ status: 'loading' })
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

  const viewer = () => {
    const state = account()
    return state.status === 'connected' ? state.account.login : undefined
  }

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
        name: project.name,
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
      viewer()
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
      if (classifyPullRequest(pr, viewer()).group === 'ready') ready += 1
      if (needsViewer(pr, viewer())) needsYou += 1
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
  /** Re-read the account, catalog, and every active repository. */
  function sync(): Promise<void> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      setSyncing(true)
      try {
        try {
          const current = await client.account()
          setAccount({ status: 'connected', account: current })
        } catch (error) {
          const code = (error as { code?: string }).code ?? 'unavailable'
          setAccount({ status: 'disconnected', reason: errorText(error), code })
        }
        try {
          await loadCatalog()
        } catch (error) {
          setCatalogError(errorText(error))
          setCatalogLoaded(true)
          return
        }
        if (account().status !== 'connected') return
        const queue = activeProjects().map((row) => row.repoId)
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

  function startPolling(): void {
    const timer = setInterval(() => void sync(), SYNC_INTERVAL_MS)
    const clock = setInterval(() => setTick(options.now()), 15_000)
    const onFocus = () => {
      const last = syncedAt()
      if (last === undefined || options.now() - last > 10_000) void sync()
    }
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
    loadRepo,
    absorb,
    startPolling,
  }
}

export type SourceControlState = ReturnType<typeof createSourceControlState>
