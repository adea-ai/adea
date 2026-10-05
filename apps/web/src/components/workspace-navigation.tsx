// The single workspace UI. Both lanes render this exact component: the web
// entry feeds it the cookie bootstrap, the desktop entry feeds it the shell
// session bootstrap. Anything desktop-only is a flag-guarded surface
// (`updates`, account handlers, `platform`), never a forked render tree.
import { createEffect, createSignal, onCleanup, Show, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import { useNavigate, useSearch } from '@tanstack/solid-router'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { settledData, useAgentListQuery } from '@adea-ai/data'
import { useWorkspaceEventStream } from '@adea-ai/data/provider'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { PanelRightClose, PanelRightOpen } from 'lucide-solid'
import type { WorkspaceSummary } from '@adea-ai/types'
import type {
  WorkspacePlatformServices,
  WorkspacePluginsProvider,
} from '@adea-ai/workspace-ui/platform'
import type { RegistryPluginsProviderOptions } from '@adea-ai/workspace-ui/plugins'
import type { RailPreferencesV1 } from '@adea-ai/workspace-ui/rail-preferences'
import {
  defaultRailPreferences,
  railMoveAnnouncement,
  readRailPreferences,
  reorderRailItems,
  reorderRailItemsRelativeTo,
  writeRailPreferences,
} from '@adea-ai/workspace-ui/rail-preferences'
import type { WorkspaceView } from '@adea-ai/workspace-ui/workspace-view-toggle'
import {
  createSharedDevUtilityOwner,
  createUnavailableDevUtilityRuntime,
  type SharedDevUtilityOwner,
} from '@adea-ai/dev-view/utility-owner'
import { GlobalWorkspaceRail } from '@adea-ai/workspace-ui/global-workspace-rail'
import type { WorkspaceDeepLink } from '@adea-ai/workspace-ui/conventional-workspace-shell'
import {
  enabledWorkspaceApps,
  orderedWorkspaceApps,
  reorderWorkspaceAppsRelativeTo,
  resolveWorkspaceApp,
  setWorkspaceAppEnabled,
  workspaceApps,
  type WorkspaceAppId,
} from '@adea-ai/workspace-ui/workspace-apps'
import { WorkspaceTopBar } from './workspace-top-bar'
import { RuntimeResourcesControl } from './runtime-resources-control'
import type { WorkspaceSearch } from '../start/routes/__root'
import { desktopMacPermissionsService } from '../lib/desktop-permissions'
import { bindDesktopChatPresentation } from '../lib/desktop-chat-presentation'
import { isDesktopRuntime, openExternalUrl } from '../lib/desktop-bridge'
import { adeaFeedbackUrl } from '../lib/feedback'
import lazyComponent from './lazy-component'
import type { WorkspaceShellProps } from './workspace-shell'

// The native updater is available in local development and packaged desktop,
// and excluded by the existing lane flag in the production web build.
declare const __ADEA_DESKTOP_COMPONENTS__: boolean
const VersionDialog = __ADEA_DESKTOP_COMPONENTS__
  ? lazyComponent(() => import('./version-dialog').then((module) => module.VersionDialog))
  : () => null

const AppLibraryPage = lazyComponent(
  () => import('@adea-ai/workspace-ui/app-library-page').then((module) => module.AppLibraryPage),
  { loading: () => <WorkspaceEntryLoading /> }
)

const DevWorkspace = lazyComponent(
  () =>
    import('@adea-ai/dev-view').then(
      ({
        DevWorkspaceEntry,
        createUnavailableDevRuntimeService: createUnavailableDevRuntimeServiceFromView,
        devViewFixtureGroups,
      }) => {
        return (entryProps: {
          fixture: boolean
          runtime?: WorkspacePlatformServices['devRuntime']
          toolbarMount?: HTMLElement
          sidebarActionMount?: HTMLElement
          sidebarOpener?: () => HTMLElement | undefined
          utilityOwner?: SharedDevUtilityOwner
          utilityHostOwnedByShell?: boolean
          deepLinkSelection?: () => { projectId?: string; sessionId?: string } | undefined
          onSelectionChange?: (selection: { projectId: string; sessionId: string | null }) => void
        }) => {
          const unavailable =
            entryProps.runtime ??
            createUnavailableDevRuntimeServiceFromView({ reason: 'channel_unauthenticated' })
          const runtime = entryProps.fixture
            ? {
                ...unavailable,
                preferenceScope: () => ({
                  accountId: '00000000-0000-4000-8000-000000000001',
                  workspaceId: '00000000-0000-4000-8000-000000000002',
                  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
                }),
              }
            : unavailable
          return (
            <DevWorkspaceEntry
              groups={entryProps.fixture ? devViewFixtureGroups : undefined}
              storage={typeof window === 'undefined' ? undefined : window.localStorage}
              runtime={runtime}
              toolbarMount={entryProps.toolbarMount}
              sidebarActionMount={entryProps.sidebarActionMount}
              sidebarOpener={entryProps.sidebarOpener}
              utilityOwner={entryProps.utilityOwner}
              utilityHostOwnedByShell={entryProps.utilityHostOwnedByShell}
              deepLinkSelection={entryProps.deepLinkSelection}
              onSelectionChange={entryProps.onSelectionChange}
            />
          )
        }
      }
    ),
  { loading: () => <WorkspaceEntryLoading /> }
)

const SourceControlView = lazyComponent(
  () =>
    Promise.all([
      import('@adea-ai/dev-view/source-control-app'),
      import('@adea-ai/dev-view/platform'),
    ]).then(
      ([
        { SourceControlApp },
        { createUnavailableDevRuntimeService: createSourceControlRuntime },
      ]) => {
        return (entryProps: {
          runtime?: WorkspacePlatformServices['devRuntime']
          toolbarMount?: HTMLElement
          onOpenDev(): void
        }) => (
          <SourceControlApp
            runtime={
              entryProps.runtime ??
              createSourceControlRuntime({ reason: 'channel_unauthenticated' })
            }
            toolbarMount={entryProps.toolbarMount}
            onOpenDev={entryProps.onOpenDev}
          />
        )
      }
    ),
  { loading: () => <WorkspaceEntryLoading /> }
)
const SharedDevUtilityHost = lazyComponent(
  () => import('@adea-ai/dev-view/utility-host').then(({ SharedDevUtilityHost: Host }) => Host),
  { loading: () => null }
)

const SharedUtilityArchiveShelf = lazyComponent(
  () =>
    import('@adea-ai/dev-view/utility-archive-shelf').then(
      ({ SharedUtilityArchiveShelf: Shelf }) => Shelf
    ),
  { loading: () => null }
)

const ConventionalWorkspace = lazyComponent(
  () =>
    import('./conventional-workspace-entry').then(
      ({ ConventionalWorkspaceEntry }) => ConventionalWorkspaceEntry
    ),
  { loading: () => <WorkspaceEntryLoading /> }
)

// Development-only ChatView visual fixture (#536 evidence lane). The import is
// lazy and the mount is `import.meta.env.DEV`-gated, so production bundles
// never contain the fixture route.
const ChatVisualFixture = lazyComponent(
  () => {
    if (import.meta.env.DEV) {
      return import('@adea-ai/dev-view/chat/visual-fixture').then(
        ({ ChatVisualFixture: Fixture }) => Fixture
      )
    }
    return Promise.resolve(() => <WorkspaceEntryLoading />)
  },
  { loading: () => <WorkspaceEntryLoading /> }
)

const SpatialWorkspace = lazyComponent(
  () => import('./workspace-shell').then(({ WorkspaceShell }) => WorkspaceShell),
  { loading: () => <WorkspaceEntryLoading /> }
)

const CharacterDesignerWorkspace = lazyComponent(() =>
  import('./character-designer-entry').then(({ CharacterDesignerEntry }) => CharacterDesignerEntry)
)

const RoomDesignerWorkspace = lazyComponent(
  () => import('./room-designer-entry').then(({ RoomDesignerEntry }) => RoomDesignerEntry),
  { loading: () => <WorkspaceEntryLoading /> }
)

const WorkspaceAboutDialog = lazyComponent(
  () =>
    import('@adea-ai/ui/components/composites/about-dialog').then(({ AboutDialog }) => AboutDialog),
  { ssr: false }
)

const WorkspaceHelpCenter = lazyComponent(
  () =>
    import('@adea-ai/workspace-ui/workspace-help-center').then(
      ({ WorkspaceHelpCenter: HelpCenter }) => HelpCenter
    ),
  { ssr: false }
)

const PluginsDialog = lazyComponent(
  () => import('@adea-ai/workspace-ui/plugins-dialog').then((module) => module.PluginsDialog),
  { ssr: false }
)

// The appearance surface is a dev-view subpath so opening it never pulls the
// Dev workspace chunk into Chat/Virtual.
const AppearancePanel = lazyComponent(
  () => import('@adea-ai/dev-view/appearance').then((module) => module.AppearancePanel),
  { ssr: false }
)

const WorkspaceSettingsDialog = lazyComponent(
  () =>
    import('@adea-ai/workspace-ui/workspace-settings').then(
      ({ WorkspaceSettingsDialog: SettingsDialog }) => SettingsDialog
    ),
  { ssr: false }
)

function WorkspaceEntryLoading() {
  return (
    <main class="conventional-workspace conventional-workspace--loading" aria-busy="true">
      <p>Opening workspace…</p>
    </main>
  )
}

// Fetch a view's chunk on hover/focus so the switch feels instant. The
// specifiers match the lazy boundaries above, so the module map deduplicates
// a preload that races the mount itself.
function preloadView(nextView: WorkspaceView) {
  if (nextView === 'virtual') void import('./workspace-shell')
  else if (nextView === 'dev') void import('@adea-ai/dev-view')
  else void import('./conventional-workspace-entry')
}

// Same trick for the overlay panels: hovering the rail button or the account
// menu trigger downloads the dialog chunk before the click lands.
function preloadPanel(panel: 'about' | 'help' | 'plugins' | 'settings') {
  if (panel === 'plugins') {
    void import('@adea-ai/workspace-ui/plugins-dialog')
    // The dialog's catalog provider resolves through the same deferred import.
    void import('@adea-ai/workspace-ui/plugins')
  } else if (panel === 'settings') {
    void import('@adea-ai/workspace-ui/workspace-settings')
  } else if (panel === 'help') {
    void import('@adea-ai/workspace-ui/workspace-help-center')
  } else {
    void import('@adea-ai/ui/components/composites/about-dialog')
  }
}

function WorkspaceSettingsOverlay(props: {
  accountAuthenticated: boolean
  accountLabel: string
  busy: boolean
  client: AgentHqApiClient
  onClose: () => void
  onOpenAgents: () => void
  onSignIn: () => void
  onSignOut: () => void
  open: boolean
  services: WorkspacePlatformServices
  workspace: WorkspaceSummary
}) {
  const agentsQuery = useAgentListQuery(props.client, () => props.workspace.id)
  return (
    <WorkspaceSettingsDialog
      accountAuthenticated={props.accountAuthenticated}
      appearancePanel={() => <AppearancePanel />}
      accountLabel={props.accountLabel}
      agents={settledData(agentsQuery) ?? []}
      busy={props.busy}
      onClose={props.onClose}
      onOpenAgents={props.onOpenAgents}
      onSignIn={props.onSignIn}
      onSignOut={props.onSignOut}
      open={props.open}
      permissionsService={isDesktopRuntime() ? desktopMacPermissionsService : undefined}
      services={props.services}
      workspace={props.workspace}
    />
  )
}

export function createDeferredPluginsProvider(
  options: RegistryPluginsProviderOptions
): WorkspacePluginsProvider {
  let provider: Promise<WorkspacePluginsProvider> | undefined
  let loaded: WorkspacePluginsProvider | undefined
  const load = () => {
    provider ??= import('@adea-ai/workspace-ui/plugins')
      .then(({ createRegistryPluginsProvider }) => createRegistryPluginsProvider(options))
      .then((value) => {
        loaded = value
        return value
      })
    return provider
  }
  return {
    getState: () => loaded?.getState?.() ?? 'idle',
    list: () => load().then((value) => value.list()),
    requestInstall: (pluginId) => load().then((value) => value.requestInstall(pluginId)),
  }
}

export type WorkspaceNavigationAccount = Readonly<{
  authenticated: boolean
  busy: boolean
  label: string
  onOpenUpdates?(opener: HTMLButtonElement | undefined): void
  onSignIn(): void
  onSignOut(): void | Promise<void>
}>

export type WorkspaceNavigationProps = Readonly<{
  account: WorkspaceNavigationAccount
  activeWorkspace?: WorkspaceSummary
  chatEntry?: (
    fallback: JSX.Element,
    archiveAction: JSX.Element,
    sidebarOpener: () => HTMLElement | undefined
  ) => JSX.Element
  client: AgentHqApiClient
  /** Desktop authorizes local content per workspace before switching. */
  onAuthorizeWorkspace?(workspaceId: string): Promise<void>
  platform: 'desktop' | 'web'
  characterDesigner?: boolean
  roomDesigner?: boolean
  services: WorkspacePlatformServices
  updates?: Readonly<{ open: boolean; onOpenChange(open: boolean): void }>
  virtual: boolean
  virtualProps: WorkspaceShellProps
  utilityOwner?: SharedDevUtilityOwner
  workspaces: readonly WorkspaceSummary[]
}>

/** The rail's live-region announcement for one applied move of `id`. */
function railMoveAnnouncementFor(
  id: WorkspaceAppId,
  previous: RailPreferencesV1,
  next: RailPreferencesV1
): string {
  const position = enabledWorkspaceApps(next).findIndex((app) => app.id === id) + 1
  const moved = position !== enabledWorkspaceApps(previous).findIndex((app) => app.id === id) + 1
  return railMoveAnnouncement(
    workspaceApps.find((app) => app.id === id)?.name ?? id,
    position,
    enabledWorkspaceApps(next).length,
    moved
  )
}

/** The Library announcement follows every built-in tile, including hidden apps. */
function appLibraryMoveAnnouncementFor(
  id: WorkspaceAppId,
  previous: RailPreferencesV1,
  next: RailPreferencesV1
): string {
  const previousPosition = orderedWorkspaceApps(previous).findIndex((app) => app.id === id) + 1
  const ordered = orderedWorkspaceApps(next)
  const position = ordered.findIndex((app) => app.id === id) + 1
  return railMoveAnnouncement(
    workspaceApps.find((app) => app.id === id)?.name ?? id,
    position,
    ordered.length,
    position !== previousPosition
  )
}

// Rail customization applies the versioned order/hidden preference, keeping
// the active view visible even when it is hidden. Unknown ids preserved by
// the preference (contributions from other builds) never reach the rail.

export function WorkspaceNavigation(props: WorkspaceNavigationProps) {
  const unavailableRuntime = createUnavailableDevUtilityRuntime('channel_unauthenticated')
  const utilityRuntime = props.services.devRuntime ?? {
    ...unavailableRuntime,
    preferenceScope: () =>
      import.meta.env.DEV &&
      typeof window !== 'undefined' &&
      new URL(window.location.href).searchParams.get('devE2e') === 'preserved'
        ? {
            accountId: '00000000-0000-4000-8000-000000000001',
            workspaceId: '00000000-0000-4000-8000-000000000002',
            runtimeNodeId: '00000000-0000-4000-8000-000000000003',
          }
        : undefined,
  }
  const utilityOwner =
    props.utilityOwner ??
    createSharedDevUtilityOwner(
      utilityRuntime,
      typeof window === 'undefined' ? undefined : window.localStorage
    )
  if (!props.utilityOwner) onCleanup(() => utilityOwner.dispose())
  const archiveAction = <SharedUtilityArchiveShelf owner={utilityOwner} />
  const [updatesOpener, setUpdatesOpener] = createSignal<HTMLButtonElement>()
  const [feedbackError, setFeedbackError] = createSignal('')
  // Send Feedback opens GitHub's prefilled issue form. The browser gives no
  // success signal (noopener returns null even on success), so only a thrown
  // error surfaces the banner below. On the desktop shell window.open cannot
  // leave the CEF webview, so the link hands off to the system browser
  // through the shell's external-link command.
  const openFeedback = (opener: HTMLButtonElement | undefined) => {
    void opener
    const url = adeaFeedbackUrl(props.services.app?.version, props.platform)
    const opening = isDesktopRuntime()
      ? openExternalUrl(url)
      : Promise.try(() => window.open(url, '_blank', 'noopener,noreferrer'))
    void opening.then(
      () => setFeedbackError(''),
      (caught: unknown) => {
        setFeedbackError(
          caught instanceof Error
            ? `Could not open the Adea feedback form: ${caught.message}. Please try again.`
            : 'Could not open the Adea feedback form. Please try again.'
        )
      }
    )
  }
  // Project links (feedback, About's source, Help Center resources) share the
  // same handoff: undefined on web lets the shared composites use anchors.
  const openExternal = isDesktopRuntime() ? openExternalUrl : undefined
  const [sidebarActionMount, setSidebarActionMount] = createSignal<HTMLDivElement>()
  const [toolbarMount, setToolbarMount] = createSignal<HTMLDivElement>()
  const [sidebarOpener, setSidebarOpener] = createSignal<HTMLButtonElement>()
  const [utilityOpener, setUtilityOpener] = createSignal<HTMLButtonElement>()
  const [characterDesignerEnabled, setCharacterDesignerEnabled] = createSignal(
    props.characterDesigner ?? false
  )
  const [roomDesignerEnabled, setRoomDesignerEnabled] = createSignal(props.roomDesigner ?? false)
  const globalPanel = useWorkspaceState((state) => state.globalPanel)
  const selectedWorkspaceId = useWorkspaceState((state) => state.selectedWorkspaceId)
  // Dev View records its resolved selection in the shared store (it is the
  // field family's single writer); the URL request flows in through the
  // `devDeepLinkSelection` prop and the resolution back through
  // `applyDevSelection`, so nothing here mirrors the store into the URL. The
  // session accessor feeds the desktop chat presentation hint only.
  const devSelectedSessionId = useWorkspaceState((state) => state.selectedRuntimeSessionId)
  const devFocusMode = useWorkspaceState((state) => state.devFocusMode)
  // Rail customization is a device-local versioned preference with unknown-
  // contribution preservation; a corrupt record falls back without deleting
  // the unread value.
  const [librarySearchRequest, setLibrarySearchRequest] = createSignal(0)
  const [librarySearchRequestHandled, setLibrarySearchRequestHandled] = createSignal(0)
  const [railPreferences, setRailPreferences] = createSignal<RailPreferencesV1>(
    defaultRailPreferences,
    { equals: false }
  )
  createEffect(() => {
    setRailPreferences(
      readRailPreferences(typeof window === 'undefined' ? undefined : window.localStorage)
    )
  })
  const persistRailPreferences = (next: RailPreferencesV1) => {
    const requested = requestedAppId()
    const wasLibrary = libraryOpen()
    setRailPreferences(next)
    writeRailPreferences(window.localStorage, next)
    const destination = resolveWorkspaceApp(next, requested)
    if (!destination) openAppLibrary(true)
    else if (!wasLibrary && destination.id !== requested) changeApp(destination.id, true)
  }
  // The stream lives above view switching: chat/virtual/dev share the query
  // cache, so one subscription keeps every lane's lists fresh instead of
  // reconnecting and replaying on each surface change.
  useWorkspaceEventStream({
    headers: () => props.client.eventStreamHeaders(),
    url: () => {
      const id = props.activeWorkspace?.id
      return id ? props.client.workspaceEventStreamUrl(id) : undefined
    },
    workspaceId: () => props.activeWorkspace?.id,
  })
  const search = useSearch({ strict: false })
  const navigate = useNavigate()

  const requestedAppId = () =>
    currentSearch().app ??
    (roomDesignerEnabled() || characterDesignerEnabled() ? 'virtual' : currentSearch().view) ??
    (props.virtual ? 'virtual' : 'chat')
  const activeApp = () => resolveWorkspaceApp(railPreferences(), requestedAppId())
  const activeAppId = (): WorkspaceAppId => activeApp()?.id ?? 'chat'
  const libraryOpen = () => currentSearch().app === 'library' || !activeApp()
  const view = (): WorkspaceView => activeApp()?.view ?? 'chat'
  const designerActive = () =>
    view() === 'virtual' && (roomDesignerEnabled() || characterDesignerEnabled())
  const contextualUtilitiesAvailable = () =>
    ['dev', 'chat', 'virtual'].includes(activeAppId()) && !libraryOpen() && !designerActive()
  const contextualUtilitiesVisible = () =>
    contextualUtilitiesAvailable() &&
    (view() !== 'dev' ||
      (!devFocusMode() &&
        !utilityOwner
          .utilityPreferences()
          .some((item) => item.side === 'left' && item.visible && item.fullWidth)))
  createEffect(() => utilityOwner.setView(contextualUtilitiesAvailable() ? view() : 'workspace'))
  const orderedViews = () => enabledWorkspaceApps(railPreferences()).map((app) => app.id)
  // The selected Dev session is a presentation hint only. Chat reports its
  // visible canonical conversation from DesktopFirstRunChat; the conventional
  // team Chat surface does not imply a RuntimeSession selection.
  const scene = () => {
    const value = currentSearch().scene
    return props.activeWorkspace?.scene ?? (value === 'work' ? 'work' : 'home')
  }
  const currentSearch = () => search() as WorkspaceSearch
  createEffect(() => {
    const query = currentSearch()
    setRoomDesignerEnabled(query.roomDesigner !== undefined && query.roomDesigner !== '0')
    setCharacterDesignerEnabled(
      query.characterDesigner !== undefined && query.characterDesigner !== '0'
    )
  })
  // Dev selection is presentation-only. Chat reports its visible canonical
  // conversation separately; leaving Dev clears only this source.
  bindDesktopChatPresentation('dev', () =>
    view() === 'dev' ? (devSelectedSessionId() ?? undefined) : undefined
  )
  // The ChatView visual fixture selector (#536 evidence lane). Only a DEV
  // build mounts the fixture; the param is inert in production.
  const chatVisualState = (): 'attention' | 'conversation' | 'reconnect' | 'streaming' => {
    const value = currentSearch().chatState
    return value === 'attention' || value === 'reconnect' || value === 'streaming'
      ? value
      : 'conversation'
  }
  // The workspace search contract lives on the root route and the router's
  // custom codec preserves it verbatim, so a patch is written through one
  // typed seam instead of restating the generated search schema.
  const applySearch = (patch: Partial<WorkspaceSearch>) =>
    void navigate({
      search: { ...currentSearch(), ...patch } as never,
      // Carry the hash through: a search update must not drop a deep link such
      // as `#settings/privacy-data` while the dialog it opened is mounting.
      hash: window.location.hash.replace(/^#/, ''),
      replace: true,
    })
  const setViewParam = (nextView: WorkspaceView) => applySearch({ view: nextView })
  const setScene = (nextScene: 'home' | 'work') => applySearch({ scene: nextScene })

  // Dev deep links: the URL request flows into Dev View through one prop and
  // the resolved selection flows back through one callback, so a stale,
  // archived, or cross-project link converges on the recovered selection (Dev
  // View corrects it; the guarded patch below rewrites the URL) instead of
  // pinning an invalid selection. No effect mirrors the store into the URL or
  // the URL into the store: the router owns the deep-linkable fact, Dev View
  // owns the store's presentation record. Unknown query keys survive every
  // patch because `applySearch` spreads the current search.
  const devDeepLinkSelection = () => {
    const query = currentSearch()
    if (query.devProject === undefined && query.devSession === undefined) return undefined
    return { projectId: query.devProject, sessionId: query.devSession }
  }
  const applyDevSelection = (selection: { projectId: string; sessionId: string | null }) => {
    const patch: Partial<WorkspaceSearch> = {}
    if ((currentSearch().devProject ?? undefined) !== (selection.projectId ?? undefined))
      patch.devProject = selection.projectId
    if ((currentSearch().devSession ?? undefined) !== (selection.sessionId ?? undefined))
      patch.devSession = selection.sessionId ?? undefined
    if ('devProject' in patch || 'devSession' in patch) applySearch(patch)
  }

  // Deep-link params are router state the chat surface consumes through
  // accessors — reactive, so notification links apply on SPA navigation too.
  // `onConsumeDeepLink` strips the params once the surface applies them so a
  // stale link can't re-select the destination on later channel changes.
  const deepLink = (): WorkspaceDeepLink => {
    const query = currentSearch()
    return {
      channel: query.channel,
      message: query.message,
      task: query.task,
      thread: query.thread,
      workspace: query.workspace,
    }
  }
  const consumeDeepLink = () => {
    const rest = { ...currentSearch() }
    for (const key of ['channel', 'message', 'task', 'thread', 'workspace'] as const)
      delete rest[key]
    void navigate({
      search: rest as never,
      hash: window.location.hash.replace(/^#/, ''),
      replace: true,
    })
  }
  // `?workspace=` switches the active workspace when the link scopes another
  // one — the surface's deep-link guard keeps channel/task params pending
  // until the switch lands and its lists reload.
  // Both switch paths (rail menu and `?workspace=` links) funnel through one
  // helper so the surface can show the in-flight affordance and an effect
  // re-run can't fire a second authorize for a switch already in progress.
  const [switchingWorkspaceId, setSwitchingWorkspaceId] = createSignal<string>()
  const switchToWorkspace = (workspace: (typeof props.workspaces)[number]) => {
    if (workspace.id === props.activeWorkspace?.id) return Promise.resolve(false)
    if (switchingWorkspaceId()) return Promise.resolve(false)
    setSwitchingWorkspaceId(workspace.id)
    return Promise.resolve(props.onAuthorizeWorkspace?.(workspace.id))
      .then(() => {
        workspaceStore.getState().switchWorkspace(workspace.id)
        // The scene is a router fact: this navigation is the single write.
        void setScene(workspace.scene)
        return true
      })
      .catch(() => false)
      .finally(() =>
        setSwitchingWorkspaceId((current) => (current === workspace.id ? undefined : current))
      )
  }

  createEffect(() => {
    const requestedWorkspace = currentSearch().workspace
    if (!requestedWorkspace) return
    if (requestedWorkspace === props.activeWorkspace?.id) {
      // Already there: drop the param unless channel/task deep links still
      // need it as a scoping guard for the surface.
      const query = currentSearch()
      if (!query.channel && !query.task && !query.thread && !query.message) {
        const rest = { ...query }
        delete rest.workspace
        void navigate({
          search: rest as never,
          hash: window.location.hash.replace(/^#/, ''),
          replace: true,
        })
      }
      return
    }
    const workspace = props.workspaces.find(({ id }) => id === requestedWorkspace)
    if (!workspace || switchingWorkspaceId()) return
    void switchToWorkspace(workspace).then((switched) => {
      if (!switched) return
      const rest = { ...currentSearch() }
      delete rest.workspace
      void navigate({
        search: rest as never,
        hash: window.location.hash.replace(/^#/, ''),
        replace: true,
      })
    })
  })

  const [hashSettingsOpen, setHashSettingsOpen] = createSignal(false)
  const settingsOpen = () => globalPanel() === 'settings' || hashSettingsOpen()

  createEffect(() => {
    const activeWorkspace = props.activeWorkspace
    if (!activeWorkspace) return
    // Reconcile the store with the server-authoritative active workspace. The
    // summary lands asynchronously, so this is a fill-in, not a user switch:
    // `switchWorkspace` resets per-workspace context (drafts, panels, the Dev
    // selection) and would wipe a deep-linked Dev selection seeded and
    // recovered before the summary arrived. User-initiated switches (rail
    // menu, `?workspace=`) go through `switchToWorkspace`, which performs the
    // full reset deliberately.
    if (selectedWorkspaceId() !== activeWorkspace.id)
      workspaceStore.getState().switchWorkspace(activeWorkspace.id, {
        // A summary arrival that lands after a Dev deep link seeded (and
        // Dev View recovered) the selection must reconcile the workspace
        // without wiping that freshly recovered selection.
        preserveDevSelection: true,
      })
    // The scene is a router fact. The workspace summary is the fact's
    // authority; the URL below is its single mirror, and this one navigation
    // (not a store write plus a param write) is what keeps it there.
    const currentScene = (search() as WorkspaceSearch).scene
    if (currentScene !== activeWorkspace.scene) void setScene(activeWorkspace.scene)
  })

  createEffect(() => {
    // Captures the component's settings-open signal and the workspace store setter.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const openDeepLinkedSettings = () => {
      setHashSettingsOpen(window.location.hash.startsWith('#settings'))
      if (window.location.hash.startsWith('#settings'))
        workspaceStore.getState().setGlobalPanel('settings')
    }
    openDeepLinkedSettings()
    window.addEventListener('hashchange', openDeepLinkedSettings)
    return () => window.removeEventListener('hashchange', openDeepLinkedSettings)
  })

  const changeApp = (id: WorkspaceAppId, replace = false) => {
    const destination = resolveWorkspaceApp(railPreferences(), id)
    if (!destination || destination.id !== id) return
    setLibrarySearchRequestHandled(librarySearchRequest())
    workspaceStore.getState().setGlobalPanel(null)
    if (requestedAppId() === id && currentSearch().app !== 'library' && !designerActive()) return
    setRoomDesignerEnabled(false)
    setCharacterDesignerEnabled(false)
    void navigate({
      search: {
        ...currentSearch(),
        view: destination.view,
        roomDesigner: undefined,
        characterDesigner: undefined,
        app: id === 'kanban' || id === 'source-control' ? id : undefined,
      } as never,
      hash: '',
      replace,
    })
  }
  // Tasks are listed on the Kanban app only. A search result or link to a Task
  // opens it there; with Kanban turned off the board opens inside Chat instead.
  const openTaskBoard = () =>
    resolveWorkspaceApp(railPreferences(), 'kanban')?.id === 'kanban'
      ? () => changeApp('kanban')
      : undefined
  const changeView = (nextView: WorkspaceView) => {
    if (resolveWorkspaceApp(railPreferences(), nextView)?.id !== nextView) openAppLibrary()
    else changeApp(nextView)
  }
  const openAppLibrary = (replace = false) => {
    workspaceStore.getState().setGlobalPanel(null)
    if (currentSearch().app === 'library') return
    setRoomDesignerEnabled(false)
    setCharacterDesignerEnabled(false)
    void navigate({
      search: {
        ...currentSearch(),
        app: 'library',
        roomDesigner: undefined,
        characterDesigner: undefined,
      } as never,
      hash: '',
      replace,
    })
  }

  const setRoomDesignerRoute = (enabled: boolean) => {
    setRoomDesignerEnabled(enabled)
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set('roomDesigner', enabled ? '1' : '0')
    if (enabled) nextUrl.searchParams.set('view', 'virtual')
    window.history.replaceState(null, '', nextUrl)
    // `replaceState` emits no event, so the router never re-read the search
    // params. The reconcile effect then calls `navigate({ search: { ...currentSearch(), scene } })`
    // from the router's STALE search — which has no `roomDesigner` key — so it
    // re-serialised the query string and deleted `roomDesigner=1` from the
    // address bar while `roomDesignerEnabled()` stayed true. The designer stayed
    // mounted at a URL that no longer opened it, and a reload or a shared link
    // lost it. The sibling `replaceState` in `desktop-workspace-entry.tsx`
    // dispatches the same synthetic event; this now does too.
    window.dispatchEvent(new PopStateEvent('popstate'))
    if (enabled && view() !== 'virtual') void setViewParam('virtual')
  }
  const openSettings = (section: 'account' | 'input-notifications' | 'integrations') => {
    window.history.replaceState(null, '', `#settings/${section}`)
    setHashSettingsOpen(true)
    // Settings is a global overlay. Keep the current surface mounted so the
    // virtual scene does not disappear before its dialog can open.
    workspaceStore.getState().setGlobalPanel('settings')
  }
  const openSearch = () => {
    if (resolveWorkspaceApp(railPreferences(), 'chat')?.id !== 'chat') {
      setLibrarySearchRequest((request) => request + 1)
      openAppLibrary()
      return
    }
    if (libraryOpen() || view() !== 'chat') changeView('chat')
    workspaceStore.getState().setGlobalPanel('search')
  }
  createEffect(() => {
    // Recovery is a real destination. Enabling the first app must not dismiss
    // Library before the user chooses Open, including stale disabled links.
    if (currentSearch().app === 'library') return
    const destination = activeApp()
    if (!destination) openAppLibrary(true)
    else if (destination.id !== requestedAppId()) changeApp(destination.id, true)
  })
  return (
    <div
      class={`workspace-frame workspace-frame--${view()}`}
      data-designer-mode={designerActive() ? 'true' : undefined}
    >
      <WorkspaceTopBar
        hideSidebarToggle={designerActive()}
        platform={props.platform}
        title={libraryOpen() ? 'App Library' : (props.activeWorkspace?.name ?? 'Adea')}
        onOpenNotifications={() => openSettings('input-notifications')}
        actionsMount={setToolbarMount}
        showDevActions={activeAppId() === 'dev'}
        resources={<RuntimeResourcesControl runtime={props.services.devRuntime} />}
        sidebarMount={setSidebarActionMount}
        showSidebarDivider={contextualUtilitiesAvailable()}
        sidebarToggleRef={setSidebarOpener}
      />
      <Show when={contextualUtilitiesAvailable() && sidebarActionMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <ActionButton
              ref={setUtilityOpener}
              type="button"
              variant="outline"
              size="icon-sm"
              class="workspace-topbar__control"
              tooltip={
                utilityOwner.rightUtilityOpen()
                  ? 'Collapse utility sidebar'
                  : 'Expand utility sidebar'
              }
              aria-label={
                utilityOwner.rightUtilityOpen()
                  ? 'Collapse utility sidebar'
                  : 'Expand utility sidebar'
              }
              aria-expanded={utilityOwner.rightUtilityOpen()}
              onClick={() => utilityOwner.toggleRightUtility()}
            >
              <Show
                when={utilityOwner.rightUtilityOpen()}
                fallback={<PanelRightOpen aria-hidden="true" />}
              >
                <PanelRightClose aria-hidden="true" />
              </Show>
            </ActionButton>
          </Portal>
        )}
      </Show>
      <GlobalWorkspaceRail
        account={{
          authenticated: props.account.authenticated,
          busy: props.account.busy,
          label: props.account.label,
          onSignIn: props.account.onSignIn,
          onSignOut: () => void props.account.onSignOut(),
          ...(props.account.onOpenUpdates
            ? {
                onOpenUpdates: (opener: HTMLButtonElement | undefined) => {
                  setUpdatesOpener(opener)
                  props.account.onOpenUpdates?.(opener)
                },
              }
            : {}),
          onOpenHelp: (opener: HTMLButtonElement | undefined) => {
            void opener
            workspaceStore.getState().setGlobalPanel('help')
          },
          onOpenFeedback: openFeedback,
          platform: props.platform,
        }}
        onOpenAbout={() => workspaceStore.getState().setGlobalPanel('about')}
        onOpenPlugins={() => workspaceStore.getState().setGlobalPanel('plugins')}
        onOpenAppLibrary={() => openAppLibrary()}
        libraryActive={libraryOpen()}
        onOpenSearch={openSearch}
        onOpenSettings={() => openSettings('account')}
        activeWorkspace={props.activeWorkspace}
        onWorkspaceChange={(workspace) => void switchToWorkspace(workspace)}
        onViewChange={(id) => changeApp(id)}
        onViewIntent={preloadView}
        onPanelIntent={preloadPanel}
        reorder={{
          onDrop: (id, targetId, position) => {
            const previous = railPreferences()
            const next = reorderRailItemsRelativeTo(previous, id, targetId, position)
            persistRailPreferences(next)
            return railMoveAnnouncementFor(id, previous, next)
          },
          onMove: (id, direction) => {
            const previous = railPreferences()
            const next = reorderRailItems(previous, id, direction, orderedViews())
            persistRailPreferences(next)
            return railMoveAnnouncementFor(id, previous, next)
          },
        }}
        view={activeAppId()}
        views={orderedViews()}
        workspaces={props.workspaces}
      />
      <div class="workspace-frame__surface" aria-busy={switchingWorkspaceId() ? true : undefined}>
        <Show when={feedbackError()}>
          {(message) => (
            <div class="workspace-feedback-error">
              <Alert variant="destructive" role="alert">
                <AlertDescription>{message()}</AlertDescription>
              </Alert>
            </div>
          )}
        </Show>
        <Show when={switchingWorkspaceId()}>
          <p class="workspace-switching" role="status">
            Switching workspace…
          </p>
        </Show>
        <div
          class={cn('workspace-contextual-utility-frame', {
            'workspace-contextual-utility-frame--utility-full':
              contextualUtilitiesVisible() &&
              Boolean(
                utilityOwner
                  .utilityPreferences()
                  .some((item) => item.side === 'right' && item.visible && item.fullWidth)
              ),
          })}
        >
          <div class="workspace-contextual-utility-frame__view">
            <Show
              when={!libraryOpen()}
              fallback={
                <AppLibraryPage
                  focusSearchRequest={librarySearchRequest()}
                  focusSearchRequestHandled={librarySearchRequestHandled()}
                  onFocusSearchRequestHandled={(request) =>
                    setLibrarySearchRequestHandled((handled) => Math.max(handled, request))
                  }
                  preferences={railPreferences()}
                  onReorder={(id, targetId, position) => {
                    const previous = railPreferences()
                    const next = reorderWorkspaceAppsRelativeTo(previous, id, targetId, position)
                    if (next !== previous) persistRailPreferences(next)
                    return appLibraryMoveAnnouncementFor(id, previous, next)
                  }}
                  onSetEnabled={(id, enabled) =>
                    persistRailPreferences(setWorkspaceAppEnabled(railPreferences(), id, enabled))
                  }
                  onOpen={(id) => changeApp(id)}
                  onReset={() => persistRailPreferences(defaultRailPreferences)}
                />
              }
            >
              <Show
                when={view() !== 'dev'}
                fallback={
                  <Show when={toolbarMount()} fallback={<WorkspaceEntryLoading />}>
                    {(mount) => (
                      <Show
                        when={activeAppId() === 'source-control'}
                        fallback={
                          <DevWorkspace
                            fixture={
                              import.meta.env.DEV &&
                              Reflect.get(currentSearch(), 'devE2e') === 'preserved'
                            }
                            runtime={utilityRuntime}
                            toolbarMount={mount()}
                            sidebarActionMount={sidebarActionMount()}
                            sidebarOpener={sidebarOpener}
                            utilityOwner={utilityOwner}
                            utilityHostOwnedByShell
                            deepLinkSelection={devDeepLinkSelection}
                            onSelectionChange={applyDevSelection}
                          />
                        }
                      >
                        <SourceControlView
                          runtime={utilityRuntime}
                          toolbarMount={mount()}
                          onOpenDev={() => changeApp('dev')}
                        />
                      </Show>
                    )}
                  </Show>
                }
              >
                <Show
                  when={view() === 'virtual'}
                  fallback={
                    <Show
                      when={import.meta.env.DEV && currentSearch().chatE2e === 'visual'}
                      fallback={
                        props.chatEntry && activeAppId() !== 'kanban' ? (
                          props.chatEntry(
                            <ConventionalWorkspace
                              archiveAction={archiveAction}
                              restoreFocusRef={sidebarOpener}
                              client={props.client}
                              deepLink={deepLink}
                              manageSettings={false}
                              onConsumeDeepLink={consumeDeepLink}
                              onOpenTaskBoard={openTaskBoard()}
                              onViewChange={changeView}
                              services={props.services}
                            />,
                            archiveAction,
                            sidebarOpener
                          )
                        ) : (
                          <ConventionalWorkspace
                            archiveAction={archiveAction}
                            restoreFocusRef={sidebarOpener}
                            taskBoardOnly={activeAppId() === 'kanban'}
                            client={props.client}
                            deepLink={deepLink}
                            manageSettings={false}
                            onConsumeDeepLink={consumeDeepLink}
                            onOpenTaskBoard={
                              activeAppId() === 'kanban' ? undefined : openTaskBoard()
                            }
                            onViewChange={changeView}
                            services={props.services}
                          />
                        )
                      }
                    >
                      <ChatVisualFixture state={chatVisualState()} />
                    </Show>
                  }
                >
                  <Show
                    when={designerActive()}
                    fallback={
                      <SpatialWorkspace
                        {...props.virtualProps}
                        archiveAction={archiveAction}
                        restoreFocusRef={sidebarOpener}
                        apiClient={props.client}
                        initialScene={scene()}
                        onOpenRoomDesigner={() => setRoomDesignerRoute(true)}
                        onWorkspaceViewChange={changeView}
                        services={props.services}
                        workspaceView={view()}
                      />
                    }
                  >
                    <Show
                      when={characterDesignerEnabled()}
                      fallback={
                        <RoomDesignerWorkspace
                          client={props.client}
                          restoreFocusRef={sidebarOpener}
                          onOpenChat={() => changeView('chat')}
                          initialCharacter={props.virtualProps.initialCharacter}
                          initialScene={scene()}
                          onClose={() => setRoomDesignerRoute(false)}
                        />
                      }
                    >
                      <CharacterDesignerWorkspace
                        initialCharacter={props.virtualProps.initialCharacter}
                        onClose={() => changeApp('virtual')}
                      />
                    </Show>
                  </Show>
                </Show>
              </Show>
            </Show>
          </div>
          <Show when={contextualUtilitiesVisible() && utilityOwner.rightUtilityOpen()}>
            <SharedDevUtilityHost owner={utilityOwner} restoreFocusRef={utilityOpener} />
          </Show>
        </div>
      </div>
      <Show when={props.activeWorkspace && settingsOpen()}>
        <WorkspaceSettingsOverlay
          accountAuthenticated={props.account.authenticated}
          accountLabel={props.account.label}
          busy={props.account.busy}
          client={props.client}
          onClose={() => {
            setHashSettingsOpen(false)
            workspaceStore.getState().setGlobalPanel(null)
          }}
          onOpenAgents={() => {
            workspaceStore.getState().setActiveSurface('agents')
            workspaceStore.getState().setGlobalPanel(null)
            changeView('chat')
          }}
          onSignIn={props.account.onSignIn}
          onSignOut={() => void props.account.onSignOut()}
          open
          services={props.services}
          workspace={props.activeWorkspace!}
        />
      </Show>
      {/* Both dialogs mount only when their panel opens: an always-mounted
          lazyComponent fetches its chunk at startup, which silently defeats
          the code split these boundaries exist to create. */}
      <Show when={globalPanel() === 'plugins' && props.activeWorkspace}>
        <PluginsDialog
          open
          onClose={() => workspaceStore.getState().setGlobalPanel(null)}
          provider={props.services.plugins}
        />
      </Show>
      <Show when={globalPanel() === 'about'}>
        <WorkspaceAboutDialog
          appName={props.services.app?.name ?? 'Adea'}
          appIcon="/icon.svg"
          copyright="Copyright © 2026 0xPlayerOne"
          open
          onOpenChange={(next) => {
            if (!next) workspaceStore.getState().setGlobalPanel(null)
          }}
          openExternal={openExternal}
          platform={props.platform}
          sourceUrl="https://github.com/adea-ai/adea"
          version={props.services.app?.version}
        />
      </Show>
      <Show when={globalPanel() === 'help'}>
        <WorkspaceHelpCenter
          appName={props.services.app?.name ?? 'Adea'}
          open
          onClose={() => workspaceStore.getState().setGlobalPanel(null)}
          openExternal={openExternal}
        />
      </Show>
      <Show when={props.updates}>
        {(updates) => (
          <VersionDialog
            channelService={props.services.updates}
            open={updates().open}
            onOpenChange={updates().onOpenChange}
            restoreFocusRef={updatesOpener}
          />
        )}
      </Show>
    </div>
  )
}
