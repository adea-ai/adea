/*
 * The source control app view: take an agent's branch from push to merged
 * without leaving Adea. The workspace frame supplies the rail and top bar;
 * this view fills the frame with the contextual sidebar (accounts and
 * projects), the main area (inbox or pull request), the optional details
 * panel, and a status bar. Everything reaches GitHub through the Dev Runtime
 * channel; the UI never talks to a provider directly.
 */
import { workspaceStore, useWorkspaceState } from '@adea-ai/state'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { StatusBar, StatusBarItem, StatusBarSpacer } from '@adea-ai/ui/components/layout/status-bar'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@adea-ai/ui/components/ui/alert-dialog'
import { Button } from '@adea-ai/ui/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@adea-ai/ui/components/ui/input-group'
import {
  Kbd,
  KbdGroup,
  platformModifierKey,
  searchShortcutKeyshortcuts,
} from '@adea-ai/ui/components/ui/kbd'
import { Popover, PopoverAnchor, PopoverContent } from '@adea-ai/ui/components/ui/popover'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import { Switch as Toggle } from '@adea-ai/ui/components/ui/switch'
import { Toaster, toast } from '@adea-ai/ui/components/ui/toast'
import { RefreshCw, Search } from 'lucide-solid'
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onMount,
  type JSX,
} from 'solid-js'
import { Portal } from 'solid-js/web'

import type { DevProjectNames, DevRuntimeService } from '../platform'
import { createScmClient, errorText } from './client'
import type { AppActions } from './components/actions'
import { StateMessage } from './components/bits'
import { NewPullRequestDialog, ProvidersDialog } from './components/dialogs'
import { ProjectInbox, ShortcutInbox } from './components/inbox'
import { PullRequestDetail } from './components/pr-detail'
import { SourceControlSidebar } from './components/sidebar'
import { prRef, relativeTime, shortSha } from './model/format'
import { mergeMethodLabel, preferredMethod } from './model/merge-dock'
import { createAppStorage, type KeyValueStorage } from './model/persistence'
import {
  hostNameOf,
  providerLabel,
  type LinkedSession,
  type PullRequestView,
  type ScmProvider,
} from './model/types'
import { createSourceControlState, type SourceControlState } from './state'
import './source-control-app.css'

export type SourceControlAppProps = Readonly<{
  runtime: DevRuntimeService
  /** Top bar mount for the search, sync state, and sync control. */
  toolbarMount?: HTMLElement
  /** Defaults to the browser's local storage when available. */
  storage?: KeyValueStorage
  /** Switch the workspace to the Dev view (after selecting a session). */
  onOpenDev?: () => void
  now?: () => number
  /** Cloud project names keyed by project id; the register stores none. */
  projectNames?: DevProjectNames
}>

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined
  } catch {
    return undefined
  }
}

const TOAST_REGION = 'source-control'

/**
 * Error toasts leave on their own: a failed "check again" is one of a stream
 * of retries, so the toast takes a timer above the region's 5 s default —
 * long enough to read, short enough that it does not sit on screen until it
 * is dismissed. Published `toast.error` defaults to persistent (an error the
 * user missed is a failure unreported) and takes the override since
 * @adea-ai/ui 0.113.1, so the funnel states its timer right on the call.
 */
const ERROR_TOAST_DURATION_MS = 7000

function notifyOf(message: string, tone: 'success' | 'error', region: string): number {
  if (tone === 'error')
    return toast.error(message, {
      region,
      persistent: false,
      duration: ERROR_TOAST_DURATION_MS,
    })
  return toast.success(message, { region })
}

/** The pull-request search: the field plus its results popover. The host
 *  decides where it lives — centered in the top bar's title slot in the
 *  workspace shell, or leading the toolbar group in bare integrations. */
function TopBarSearch(props: { state: SourceControlState; actions: AppActions }): JSX.Element {
  const [query, setQuery] = createSignal('')
  const matches = createMemo(() => {
    const needle = query().trim().toLowerCase().replace(/^#/, '')
    if (needle.length < 2) return []
    return props.state
      .everyOpen()
      .filter(
        ({ pr }) =>
          pr.title.toLowerCase().includes(needle) ||
          pr.headRef.toLowerCase().includes(needle) ||
          String(pr.number) === needle ||
          pr.headSha.startsWith(needle)
      )
      .slice(0, 8)
  })
  return (
    <Popover open={matches().length > 0} placement="bottom-start" gutter={4}>
      <PopoverAnchor>
        <InputGroup class="w-full min-w-0" data-scm-search="">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            placeholder="Search pull requests"
            aria-label="Search pull requests and branches"
            aria-keyshortcuts={searchShortcutKeyshortcuts}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('')
              if (event.key === 'Enter' && matches()[0]) {
                props.actions.openPullRequest(matches()[0]!.pr)
                setQuery('')
              }
            }}
          />
          <InputGroupAddon align="end">
            {/* The chord binds Meta and Ctrl alike (the rail owns the global
                handler), so the caps draw the modifier the running OS renders.
                A spelled-out Ctrl cannot ride KbdChord's one-cap-per-character
                split — the shared group draws one cap per entry. */}
            <KbdGroup size="compact" aria-hidden="true">
              <Kbd size="compact">{platformModifierKey()}</Kbd>
              <Kbd size="compact">K</Kbd>
            </KbdGroup>
          </InputGroupAddon>
        </InputGroup>
      </PopoverAnchor>
      <PopoverContent hideArrow aria-label="Search results">
        <div class="dev-scm-picker">
          <For each={matches()}>
            {({ pr, project }) => (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                class="w-full justify-start"
                onClick={() => {
                  props.actions.openPullRequest(pr)
                  setQuery('')
                }}
              >
                <span class="dev-scm-truncate">{pr.title}</span>
                <span class="dev-scm-caption">
                  {project.name} {prRef(pr)}
                </span>
              </Button>
            )}
          </For>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function TopBarControls(props: { state: SourceControlState; actions: AppActions }): JSX.Element {
  const synced = () => {
    const at = props.state.syncedAt()
    return at === undefined
      ? 'Not synced yet'
      : `Synced ${relativeTime(new Date(at).toISOString(), props.state.tick())}`
  }
  return (
    <div class="dev-scm-topbar">
      {/* The search leads the group so it reads left of the sync status,
          lined up after the leading section's divider exactly like the Dev
          view's pane actions; the stylesheet lets the field shrink with the
          leading track instead of overflowing it. */}
      <TopBarSearch state={props.state} actions={props.actions} />
      <span class="dev-scm-topbar__synced">
        <StatusChip
          tone={
            props.state.syncing()
              ? 'info'
              : props.state.syncedAt() === undefined
                ? 'unknown'
                : 'success'
          }
          label={props.state.syncing() ? 'Syncing' : synced()}
        />
      </span>
      <ActionButton
        type="button"
        variant="ghost"
        size="icon-sm"
        tooltip="Sync pull requests now"
        aria-label="Sync now"
        busy={props.state.syncing()}
        busyLabel="Syncing"
        onClick={() => void props.state.sync()}
      >
        <RefreshCw aria-hidden="true" />
      </ActionButton>
    </div>
  )
}

export function SourceControlApp(props: SourceControlAppProps): JSX.Element {
  const scope = () => props.runtime.preferenceScope?.()
  return (
    <Show
      when={props.runtime.state().status === 'ready' && scope()}
      fallback={
        <main class="dev-scm" aria-label="Source control">
          <StateMessage
            title="Source control needs the Adea desktop runtime"
            description={
              props.runtime.state().status === 'unavailable'
                ? 'Open Adea on your desktop to review and merge pull requests here.'
                : 'Connecting to the runtime…'
            }
          />
        </main>
      }
    >
      {(activeScope) => <ConnectedApp {...props} scope={activeScope()} />}
    </Show>
  )
}

function ConnectedApp(
  props: SourceControlAppProps & {
    scope: NonNullable<ReturnType<NonNullable<DevRuntimeService['preferenceScope']>>>
  }
) {
  const now = props.now ?? Date.now
  const client = createScmClient(props.runtime, props.scope)
  const storage = createAppStorage(props.storage ?? defaultStorage(), props.scope)
  const state = createSourceControlState({
    client,
    storage,
    now,
    projectNames: () => props.projectNames,
  })
  const sidebarOpen = useWorkspaceState((store) => store.mobileSidebarOpen)
  const [revision, setRevision] = createSignal(0)
  const [providersOpen, setProvidersOpen] = createSignal(false)
  const [newPr, setNewPr] = createSignal<{ repoId: string; headRef?: string }>()
  const [mergeTarget, setMergeTarget] = createSignal<PullRequestView>()
  const [updateTarget, setUpdateTarget] = createSignal<{
    pr: PullRequestView
    method: 'merge' | 'rebase'
  }>()

  const notify = (message: string, tone: 'success' | 'error' = 'success'): number =>
    notifyOf(message, tone, TOAST_REGION)

  /** Re-check one provider from the Git providers dialog and say what
   *  happened: the row chip flips with the state, and a toast carries the
   *  signed-in identity or the typed refusal — a bare loading flicker left
   *  "Check again" looking like a no-op. */
  const checkProviderWithFeedback = async (provider: ScmProvider) => {
    const result = await state.checkProvider(provider)
    if (result.status === 'connected')
      notify(`Connected to ${providerLabel[provider]} as ${result.account.login}`)
    else notify(`${providerLabel[provider]}: ${result.reason}`, 'error')
  }

  // Opening the dialog answers "which is it?" for every listed provider:
  // both are checked immediately, so a row reads Connected/Not connected with
  // a reason instead of an indefinite "not checked".
  createEffect(() => {
    if (!providersOpen()) return
    void state.checkProvider('github')
    void state.checkProvider('gitlab')
  })

  const actions: AppActions = {
    openPullRequest: (pr, tab = 'conversation') =>
      state.setRoute({ view: 'pr', pullRequestId: pr.id, repoId: pr.repoId, tab }),
    openSession: (session: LinkedSession) => {
      const store = workspaceStore.getState()
      store.setSelectedDevProjectId(session.projectId)
      store.setSelectedRuntimeSessionId(session.runtimeSessionId)
      props.onOpenDev?.()
    },
    requestMerge: (pr) => setMergeTarget(pr),
    requestUpdateBranch: (pr, method) => setUpdateTarget({ pr, method }),
    newPullRequest: (repoId, headRef) => setNewPr({ repoId, ...(headRef ? { headRef } : {}) }),
    notify,
  }

  onMount(() => {
    void state.sync()
    state.startPolling()
  })

  const disconnected = () => state.disconnected()
  /** The status bar's summary across the providers in use. */
  const connection = () => {
    const states = state
      .providers()
      .map((provider) => ({ provider, account: state.account(provider) }))
    const names = (filter: (entry: (typeof states)[number]) => boolean) =>
      states
        .filter(filter)
        .map((entry) => providerLabel[entry.provider])
        .join(' and ')
    if (states.some((entry) => entry.account.status === 'loading'))
      return { tone: 'default' as const, text: `Checking ${names(() => true)}` }
    const off = names((entry) => entry.account.status !== 'connected')
    return off
      ? { tone: 'warning' as const, text: `${off} not connected` }
      : { tone: 'success' as const, text: `${names(() => true)} connected` }
  }
  const route = () => state.route()
  const selectedProject = () => {
    const current = state.selection()
    return current?.kind === 'project' ? state.projectFor(current.repoId) : undefined
  }
  const statusProject = () => {
    const current = route()
    if (current.view === 'pr') return state.projectFor(current.repoId)
    return selectedProject()
  }
  const statusPr = () => {
    const current = route()
    return current.view === 'pr'
      ? state.openPulls(current.repoId).find((pr) => pr.id === current.pullRequestId)
      : undefined
  }

  const [merging, setMerging] = createSignal(false)
  const mergeMethod = () => {
    const pr = mergeTarget()
    return pr ? preferredMethod(pr.mergeMethods, state.preferences().mergeMethod) : undefined
  }
  const confirmMerge = async () => {
    const pr = mergeTarget()
    const method = mergeMethod()
    if (!pr || !method) return
    setMerging(true)
    try {
      const result = await client.merge(
        pr.id,
        pr.headSha,
        method,
        state.preferences().deleteBranch && !pr.crossRepository
      )
      notify(
        result.headBranchDeleted
          ? `Merged ${prRef(pr)} and deleted ${pr.headRef}.`
          : `Merged ${prRef(pr)}.`
      )
      setMergeTarget(undefined)
      void state.loadRepo(pr.repoId)
      setRevision((value) => value + 1)
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setMerging(false)
    }
  }

  const [updating, setUpdating] = createSignal(false)
  const confirmUpdate = async () => {
    const target = updateTarget()
    if (!target) return
    setUpdating(true)
    try {
      const summary = await client.syncBranch(target.pr.id, target.pr.headSha, target.method)
      state.absorb(summary)
      notify(
        `Updated ${target.pr.headRef} from ${target.pr.baseRef}. Checks re-run on the new head.`
      )
      setUpdateTarget(undefined)
      setRevision((value) => value + 1)
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setUpdating(false)
    }
  }

  const newPrProject = () => {
    const target = newPr()
    return target ? state.projectFor(target.repoId) : undefined
  }

  return (
    <main class="dev-scm" aria-label="Source control">
      <Show when={props.toolbarMount}>
        {(mount) => (
          <Portal mount={mount()}>
            <TopBarControls state={state} actions={actions} />
          </Portal>
        )}
      </Show>
      <div class="dev-scm__body">
        <SourceControlSidebar
          state={state}
          open={sidebarOpen()}
          onConnect={() => setProvidersOpen(true)}
        />
        <div class="dev-scm__main">
          <Switch>
            <Match when={disconnected()}>
              {(account) => (
                <StateMessage
                  title={
                    account().code === 'capability_unavailable'
                      ? `Install the ${providerLabel[account().provider]} CLI to connect ${providerLabel[account().provider]}`
                      : `Connect ${providerLabel[account().provider]}`
                  }
                  description={account().reason}
                >
                  <Button type="button" onClick={() => setProvidersOpen(true)}>
                    Connect account
                  </Button>
                </StateMessage>
              )}
            </Match>
            <Match when={state.catalogError()}>
              {(message) => (
                <StateMessage title="Projects could not be loaded" description={message()}>
                  <Button type="button" variant="outline" onClick={() => void state.sync()}>
                    Try again
                  </Button>
                </StateMessage>
              )}
            </Match>
            <Match
              when={
                route().view === 'pr' &&
                (route() as Extract<ReturnType<typeof route>, { view: 'pr' }>)
              }
            >
              {(current) => (
                <PullRequestDetail
                  pullRequestId={current().pullRequestId}
                  repoId={current().repoId}
                  tab={current().tab}
                  revision={revision()}
                  state={state}
                  actions={actions}
                  onTab={(tab) => state.setRoute({ ...current(), tab })}
                />
              )}
            </Match>
            <Match when={state.selection()?.kind === 'shortcut' && state.selection()}>
              {(selection) => (
                <ShortcutInbox
                  id={(selection() as { id: 'needs_you' | 'ready' }).id}
                  state={state}
                  actions={actions}
                />
              )}
            </Match>
            <Match when={selectedProject()}>
              {(project) => <ProjectInbox project={project()} state={state} actions={actions} />}
            </Match>
            <Match when={state.catalogLoaded()}>
              <StateMessage
                title="No GitHub or GitLab projects yet"
                description="Add a project whose repository is on GitHub or GitLab in the Dev view, and its pull requests appear here."
              />
            </Match>
          </Switch>
        </div>
      </div>
      <StatusBar>
        <StatusBarItem dot tone={connection().tone}>
          {connection().text}
        </StatusBarItem>
        <Show when={statusProject()}>
          {(project) => (
            <StatusBarItem>
              {project().owner}/{project().name}
            </StatusBarItem>
          )}
        </Show>
        <Show when={statusPr()}>{(pr) => <StatusBarItem>{prRef(pr())}</StatusBarItem>}</Show>
        <StatusBarSpacer />
        <Show when={statusPr()}>
          {(pr) => (
            <>
              <StatusBarItem>Head {shortSha(pr().headSha)}</StatusBarItem>
              <StatusBarItem>
                Base {pr().baseRef}
                {pr().baseSha ? ` ${shortSha(pr().baseSha!)}` : ''}
              </StatusBarItem>
            </>
          )}
        </Show>
        <Show when={!statusPr() && statusProject()}>
          {(project) => (
            <StatusBarItem>
              {project().openCount === undefined
                ? 'Loading pull requests'
                : `${project().openCount}${project().openCountMore ? '+' : ''} open pull requests`}
            </StatusBarItem>
          )}
        </Show>
      </StatusBar>

      <ProvidersDialog
        open={providersOpen()}
        accounts={{ github: state.account('github'), gitlab: state.account('gitlab') }}
        settledAccounts={{
          github: state.settledAccount('github'),
          gitlab: state.settledAccount('gitlab'),
        }}
        projectCounts={{
          github: state.activeProjects().filter((row) => row.provider === 'github').length,
          gitlab: state.activeProjects().filter((row) => row.provider === 'gitlab').length,
        }}
        onCheck={(provider) => void checkProviderWithFeedback(provider)}
        onClose={() => setProvidersOpen(false)}
      />
      <Show when={newPr()}>
        {(target) => (
          <NewPullRequestDialog
            open
            repoId={target().repoId}
            repoLabel={newPrProject() ? `${newPrProject()!.owner} / ${newPrProject()!.name}` : ''}
            {...(state.repoMeta().get(target().repoId)?.defaultBranch
              ? { defaultBranch: state.repoMeta().get(target().repoId)!.defaultBranch }
              : {})}
            {...(target().headRef ? { headRef: target().headRef! } : {})}
            {...(state.preferences().mergeMethod
              ? { mergeMethod: state.preferences().mergeMethod! }
              : {})}
            {...(state.viewer(state.repoProvider(target().repoId))
              ? { viewer: state.viewer(state.repoProvider(target().repoId))! }
              : {})}
            providerName={providerLabel[state.repoProvider(target().repoId) ?? 'github']}
            client={client}
            onClose={() => setNewPr(undefined)}
            onCreated={(pullRequestId) => {
              const repoId = target().repoId
              setNewPr(undefined)
              void state.loadRepo(repoId)
              actions.openPullRequest({ id: pullRequestId, repoId })
            }}
            notify={notify}
          />
        )}
      </Show>

      <AlertDialog
        open={mergeTarget() !== undefined}
        onOpenChange={(open) => !open && !merging() && setMergeTarget(undefined)}
      >
        <AlertDialogContent>
          <Show when={mergeTarget()}>
            {(pr) => (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {mergeMethod() ? mergeMethodLabel[mergeMethod()!] : 'Merge'} {prRef(pr())}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    “{pr().title}” merges {pr().headRef} into {pr().baseRef} at{' '}
                    {shortSha(pr().headSha)}. {hostNameOf(pr().id)} re-checks every requirement
                    first.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <Show when={!pr().crossRepository}>
                  <Toggle
                    checked={state.preferences().deleteBranch}
                    onChange={(deleteBranch: boolean) =>
                      state.setPreferences((prefs) => ({ ...prefs, deleteBranch }))
                    }
                    label={`Delete ${pr().headRef} on ${hostNameOf(pr().id)} after merging`}
                  />
                </Show>
                <AlertDialogFooter>
                  <AlertDialogCancel
                    as={Button}
                    type="button"
                    variant="outline"
                    disabled={merging()}
                  >
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    as={ActionButton}
                    type="button"
                    busy={merging()}
                    busyLabel="Merging"
                    disabled={merging() || !mergeMethod()}
                    closeOnClick={false}
                    onClick={(event: MouseEvent) => {
                      event.preventDefault()
                      void confirmMerge()
                    }}
                  >
                    {mergeMethod() ? mergeMethodLabel[mergeMethod()!] : 'Merge'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </>
            )}
          </Show>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={updateTarget() !== undefined}
        onOpenChange={(open) => !open && !updating() && setUpdateTarget(undefined)}
      >
        <AlertDialogContent>
          <Show when={updateTarget()}>
            {(target) => (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Update {target().pr.headRef} with{' '}
                    {target().method === 'rebase' ? 'a rebase' : 'a merge'}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {target().method === 'rebase'
                      ? `${hostNameOf(target().pr.id)} rebases the branch onto ${target().pr.baseRef} and rewrites its history. Anyone with the branch checked out, including an agent's worktree, must reset to the new head.`
                      : `${hostNameOf(target().pr.id)} merges ${target().pr.baseRef} into the branch with a new commit.`}{' '}
                    Checks re-run on the new head.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel
                    as={Button}
                    type="button"
                    variant="outline"
                    disabled={updating()}
                  >
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    as={ActionButton}
                    type="button"
                    busy={updating()}
                    busyLabel="Updating"
                    disabled={updating()}
                    onClick={(event: MouseEvent) => {
                      event.preventDefault()
                      void confirmUpdate()
                    }}
                  >
                    Update branch
                  </AlertDialogAction>
                </AlertDialogFooter>
              </>
            )}
          </Show>
        </AlertDialogContent>
      </AlertDialog>
      {/* The toast stack portals to the document root: the published Toaster
          rides the top rung of the named overlay scale (--z-toast, above
          menus and tooltips), and rendering it at the root keeps that rung
          meaningful no matter which stacking context the view that owns the
          notification happens to sit in. An open dialog must never bury an
          error toast — the Git providers dialog is exactly where one fires. */}
      <Portal>
        <Toaster region={TOAST_REGION} position="bottom-right" />
      </Portal>
    </main>
  )
}
