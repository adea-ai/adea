import type { AgentSummary, WorkspaceSummary, WorkspaceUpdate } from '@adea-ai/types'
import { MusicToggle } from '@adea-ai/audio'
import { WorkspaceLogo } from '@adea-ai/app-ui/components/workspace-logo'
import { ThemeToggle } from '@adea-ai/app-ui/components/theme-toggle'
import { useOptionalTheme } from '@adea-ai/app-ui/components/theme-provider'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { Switch } from '@adea-ai/ui/components/ui/switch'
import {
  SettingsNavigation,
  SettingsRow as SharedSettingsRow,
} from '@adea-ai/ui/components/composites/settings'
import { Tabs, TabsContent } from '@adea-ai/ui/components/ui/tabs'
import {
  Bell,
  Bot,
  Brain,
  Database,
  LockKeyhole,
  EyeOff,
  Link2,
  Mic,
  MonitorCog,
  ShieldCheck,
  UserRound,
} from 'lucide-solid'
import {
  createEffect,
  createSignal,
  For,
  lazy,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type JSX,
} from 'solid-js'

import { CapabilityList } from './capability-card'
import { WorkspaceIdentitySettings } from './workspace-identity-settings'
import { keyedRows } from './keyed-rows'
import { ModalDialog } from '@adea-ai/ui/components/ui/modal-dialog'
import {
  defaultWorkspacePreferences,
  type CapabilitySnapshot,
  type WorkspacePlatformServices,
  type WorkspacePreferences,
} from './platform'
import type { MacPermissionsPageService } from '@adea-ai/dev-view/permissions'
import {
  settingsSectionFromHash,
  settingsSectionGroups,
  settingsSectionLabels,
  type SettingsSection,
} from './settings-section'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'

const sectionIcons = {
  account: UserRound,
  appearance: MonitorCog,
  workspace: MonitorCog,
  memory: Brain,
  agents: Bot,
  'input-notifications': Mic,
  'privacy-data': EyeOff,
  integrations: Link2,
  connections: LockKeyhole,
  permissions: ShieldCheck,
} satisfies Record<SettingsSection, typeof UserRound>

// Lazy: the permissions pane (and its dev-view chunk) loads only when the
// section opens, never with the workspace chrome.
const PermissionsPane = lazy(() =>
  import('@adea-ai/dev-view/permissions').then((module) => ({ default: module.PermissionsPane }))
)
// Lazy for the same reason: the Memory pane loads when its section opens.
const MemoryPane = lazy(() => import('./memory-pane'))
// Lazy for the same reason: workspace connections load only when opened.
const ConnectionsPane = lazy(() =>
  import('./connections-pane').then((module) => ({ default: module.ConnectionsPane }))
)

// The shared settings row: same label/description/control contract the
// published settings composite defines, so this dialog composes the library
// instead of restyling its own rows.
function SettingsRow(props: { children?: JSX.Element; detail: string; title: string }) {
  return (
    <SharedSettingsRow label={props.title} description={props.detail}>
      {props.children}
    </SharedSettingsRow>
  )
}

// True while an appearance theme dropdown is mounted inside the settings
// dialog. Read at scroll-time rather than tracked so it always reflects the
// DOM, whichever side of the open/close race a scroll event lands on.
function appearanceMenuOpen() {
  return Boolean(document.querySelector('[data-appearance-editor] [role="menu"]'))
}

export function WorkspaceSettingsDialog(props: {
  accountAuthenticated: boolean
  accountLabel: string
  agents: readonly AgentSummary[]
  busy: boolean
  onClose: () => void
  onOpenAgents: () => void
  onSignIn: () => void
  onSignOut: () => void
  /** Saves a versioned workspace identity change; omitted renders read-only. */
  onUpdateWorkspace?: (
    update: WorkspaceUpdate & Readonly<{ expectedVersion: number }>
  ) => Promise<void>
  open: boolean
  /**
   * The control to restore focus to when the dialog closes. The account-menu
   * path hands over the rail trigger after suppressing the menu's own focus
   * restore; other paths leave this undefined and the shared dialog falls
   * back to capturing the element focused before it opened.
   */
  restoreFocusRef?: Accessor<HTMLButtonElement | undefined>
  /**
   * The full appearance editor, injected by the host as an accessor
   * (dev-view's `AppearancePanel`) so it mounts only while this section is
   * the active one. Omitted falls back to the simple theme toggle, which is
   * what a host without the editor can offer. A host without an appearance
   * provider reports the unavailable preference instead of throwing.
   */
  appearancePanel?: () => JSX.Element
  /** The desktop bridge permission service; omitted (web-only) renders the
   * pane's honest typed-unavailable states. */
  permissionsService?: MacPermissionsPageService
  services?: WorkspacePlatformServices
  workspace: WorkspaceSummary
}) {
  const themeContext = useOptionalTheme()
  const [section, setSection] = createSignal<SettingsSection>('account')
  const [preferences, setPreferences] = createSignal<WorkspacePreferences>(
    defaultWorkspacePreferences
  )
  const [saveState, setSaveState] = createSignal<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [permissionState, setPermissionState] = createSignal<
    'denied' | 'granted' | 'idle' | 'prompt' | 'unavailable'
  >('idle')
  const [permissionBusy, setPermissionBusy] = createSignal(false)
  const [permissionError, setPermissionError] = createSignal<string | null>(null)
  let disposed = false
  let permissionRequest = 0
  createEffect(() => {
    // Closing/reopening or replacing the host invalidates pending permission work.
    void props.open
    void props.services?.transcription
    permissionRequest += 1
    setPermissionBusy(false)
    setPermissionError(null)
    setPermissionState('idle')
  })
  onCleanup(() => {
    disposed = true
  })
  const checkMicrophone = async () => {
    const transcription = props.services?.transcription
    if (!transcription || permissionBusy()) return
    const request = ++permissionRequest
    setPermissionBusy(true)
    setPermissionError(null)
    const current = () =>
      !disposed &&
      permissionRequest === request &&
      props.open &&
      props.services?.transcription === transcription
    try {
      const state = await transcription.requestPermission()
      if (current()) setPermissionState(state)
    } catch {
      if (current()) setPermissionError('Microphone access could not be checked. Try again.')
    } finally {
      if (!disposed && permissionRequest === request) setPermissionBusy(false)
    }
  }
  const [privateHealth, setPrivateHealth] = createSignal<'available' | 'checking' | 'unavailable'>(
    props.services?.privateContent ? 'checking' : 'unavailable'
  )
  const [capabilities, setCapabilities] = createSignal<CapabilitySnapshot | undefined>()
  const [capabilitiesBusy, setCapabilitiesBusy] = createSignal(false)

  const topAgentRows = keyedRows(
    () => props.agents.slice(0, 5),
    (agent) => agent.id
  )

  const refreshCapabilities = async (force: boolean) => {
    if (!props.services?.capabilities) return
    setCapabilitiesBusy(true)
    try {
      setCapabilities(await props.services.capabilities.snapshot({ force }))
    } catch {
      setCapabilities(undefined)
    } finally {
      setCapabilitiesBusy(false)
    }
  }

  createEffect(() => {
    if (!props.open) return
    const next = settingsSectionFromHash(window.location.hash)
    setSection(next)
    let active = true
    void props.services?.settings
      ?.load()
      .then((loaded) => {
        if (active) setPreferences(loaded)
      })
      .catch(() => {
        if (active) setSaveState('error')
      })
    void refreshCapabilities(false)
    const privateContent = props.services?.privateContent
    const health = privateContent?.health?.bind(privateContent)
    const workspaceId = props.workspace.id
    if (health) {
      setPrivateHealth('checking')
      void Promise.resolve()
        .then(() => health(workspaceId))
        .then(({ available }) => {
          if (active) setPrivateHealth(available ? 'available' : 'unavailable')
        })
        .catch(() => {
          if (active) setPrivateHealth('unavailable')
        })
    }
    onCleanup(() => {
      active = false
    })
  })

  const selectSection = (next: SettingsSection) => {
    setSection(next)
    // Re-writing an already-current hash makes the router re-resolve the route,
    // whose server-only entry loader then runs on the client and tears the
    // whole workspace down — observed as the dialog dismissing when the
    // already-selected tab trigger is clicked (#601). Only write the deep link
    // when it actually changes.
    const nextHash = `#settings/${next}`
    if (window.location.hash !== nextHash) window.history.replaceState(null, '', nextHash)
  }
  const close = () => {
    if (window.location.hash.startsWith('#settings'))
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    props.onClose()
  }
  const save = async (next: WorkspacePreferences) => {
    setPreferences(next)
    if (!props.services?.settings) return
    setSaveState('saving')
    try {
      setPreferences(await props.services.settings.save(next))
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }
  const toggle = (key: 'notifyMentions' | 'notifyTasks' | 'privateNotificationPreviews') =>
    void save({ ...preferences(), [key]: !preferences()[key] })

  // The appearance theme menus mount their popper inside the section panel
  // (the shared theme row keeps the mount in-dialog for focus containment),
  // and the menu's open-focus pass drags the dialog and the panel to the
  // menu's untransformed position: the whole view jumps and the menu lands
  // detached from its trigger. While an appearance menu is open, hold the
  // dialog and panel at their last menu-free scroll offsets — the menu is
  // positioned against the dialog, so restoring the offsets keeps it glued
  // to its trigger and the drag is never visible. Offsets are sampled on an
  // interval (never while a menu is open, so a drag can never poison them)
  // and restored on the scroll events the drag fires, which fire after it
  // regardless of how the open sequence is ordered internally.
  onMount(() => {
    let stableDialog = 0
    let stablePanel = 0
    const sample = () => {
      if (appearanceMenuOpen()) return
      stableDialog = document.querySelector('.conventional-settings-dialog')?.scrollTop ?? 0
      stablePanel = document.querySelector('#settings-panel-appearance')?.scrollTop ?? 0
    }
    const onScroll = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (!target.closest('.conventional-settings-dialog')) return
      if (!appearanceMenuOpen()) {
        sample()
        return
      }
      const dialog = document.querySelector('.conventional-settings-dialog')
      if (dialog && dialog.scrollTop !== stableDialog) dialog.scrollTop = stableDialog
      const panel = document.querySelector('#settings-panel-appearance')
      if (panel && panel.scrollTop !== stablePanel) panel.scrollTop = stablePanel
    }
    const sampler = setInterval(sample, 200)
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    onCleanup(() => {
      clearInterval(sampler)
      document.removeEventListener('scroll', onScroll, true)
    })
  })

  return (
    <ModalDialog
      modal={false}
      size="settings"
      class="conventional-settings-dialog"
      open={props.open}
      onClose={close}
      restoreFocusRef={props.restoreFocusRef}
      headerLeading={
        <WorkspaceLogo aria-hidden="true" class="conventional-settings-logo" role="presentation" />
      }
      title="Settings"
    >
      <Tabs
        id="settings-tabs"
        class="conventional-settings-shell"
        orientation="vertical"
        value={section()}
        onChange={(value) => selectSection(value as SettingsSection)}
      >
        <SettingsNavigation
          class="conventional-settings-nav w-full"
          aria-label="Settings sections"
          value={section()}
          onReselect={(value) => selectSection(value as SettingsSection)}
          groups={settingsSectionGroups.map((group) => ({
            label: group.label,
            items: group.items.map((item) => {
              const Icon = sectionIcons[item]
              return {
                value: item,
                label: settingsSectionLabels[item],
                icon: <Icon aria-hidden="true" />,
              }
            }),
          }))}
        />
        <TabsContent
          value="account"
          id="settings-panel-account"
          class="conventional-settings-panel"
        >
          <header>
            <UserRound aria-hidden="true" />
            <div>
              <h3>{settingsSectionLabels.account}</h3>
              <p>Session and installed product information.</p>
            </div>
          </header>
          <SettingsRow
            title={props.accountAuthenticated ? props.accountLabel : 'Guest workspace'}
            detail={
              props.accountAuthenticated
                ? 'This workspace is saved to your account.'
                : 'Sign in when you want to keep this workspace across devices.'
            }
          >
            <Button
              type="button"
              disabled={props.busy}
              onClick={props.accountAuthenticated ? props.onSignOut : props.onSignIn}
            >
              {props.accountAuthenticated ? 'Sign out' : 'Sign in'}
            </Button>
          </SettingsRow>
          <SettingsRow
            title={props.services?.app?.name ?? 'Adea'}
            detail={`${props.services?.app?.platform === 'desktop' ? 'Desktop application' : 'Web application'}${props.services?.app?.version ? ` · v${props.services.app.version}` : ''}`}
          />
          <SettingsRow
            title="Virtual preview"
            detail="The Three.js representation is retained for M4 and does not define conventional workspace state."
          >
            <a href="/?view=virtual">Open preview</a>
          </SettingsRow>
        </TabsContent>
        <TabsContent
          value="appearance"
          id="settings-panel-appearance"
          class="conventional-settings-panel"
        >
          <Show
            when={props.appearancePanel}
            fallback={
              <>
                <header>
                  <MonitorCog aria-hidden="true" />
                  <div>
                    <h3>{settingsSectionLabels.appearance}</h3>
                    <p>Shared presentation preferences.</p>
                  </div>
                </header>
                <SettingsRow
                  title="Color theme"
                  detail="Follow the system or explicitly choose light or dark."
                >
                  <Show
                    when={themeContext}
                    fallback={
                      <EmptyDescription role="status">
                        Appearance settings are unavailable in this view.
                      </EmptyDescription>
                    }
                  >
                    <ThemeToggle />
                  </Show>
                </SettingsRow>
              </>
            }
          >
            {props.appearancePanel?.()}
          </Show>
        </TabsContent>
        <TabsContent
          value="workspace"
          id="settings-panel-workspace"
          class="conventional-settings-panel"
        >
          <header>
            <MonitorCog aria-hidden="true" />
            <div>
              <h3>{settingsSectionLabels.workspace}</h3>
              <p>How this workspace looks and where it opens.</p>
            </div>
          </header>
          <WorkspaceIdentitySettings
            workspace={props.workspace}
            {...(props.onUpdateWorkspace ? { onUpdate: props.onUpdateWorkspace } : {})}
          />
        </TabsContent>
        <TabsContent value="memory" id="settings-panel-memory" class="conventional-settings-panel">
          <header>
            <Brain aria-hidden="true" />
            <div>
              <h3>{settingsSectionLabels.memory}</h3>
              <p>
                Notes for agents working in {props.workspace.name}. Agents can propose notes; they
                become memory only when you accept them.
              </p>
            </div>
          </header>
          <Show when={section() === 'memory'}>
            <MemoryPane service={props.services?.memory} workspaceId={props.workspace.id} />
          </Show>
        </TabsContent>
        <TabsContent value="agents" id="settings-panel-agents" class="conventional-settings-panel">
          <header>
            <Bot aria-hidden="true" />
            <div>
              <h3>{settingsSectionLabels.agents}</h3>
              <p>Durable identity and explicit profile references.</p>
            </div>
          </header>
          <For each={topAgentRows()}>
            {(entry) => (
              <SettingsRow
                title={entry.item().name}
                detail={`${entry.item().profile.id} · v${entry.item().profile.version} · ${entry.item().lifecycleState.replace('_', ' ')}`}
              />
            )}
          </For>
          <Button
            type="button"

            onClick={() => {
              close()
              props.onOpenAgents()
            }}
          >
            Customize Agents
          </Button>
        </TabsContent>
        <TabsContent
          value="input-notifications"
          id="settings-panel-input-notifications"
          class="conventional-settings-panel"
        >
          <header>
            <Mic aria-hidden="true" />
            <div>
              <h3>{settingsSectionLabels['input-notifications']}</h3>
              <p>Desktop dictation and bounded notification preferences.</p>
            </div>
          </header>
          <SettingsRow
            title="Composer dictation"
            detail={
              props.services?.transcription
                ? `Uses ${props.services.transcription.label}; text stays editable and is never auto-sent.`
                : 'Install Adea Desktop to use system dictation.'
            }
          >
            <Button
              type="button"
              disabled={!props.services?.transcription || permissionBusy()}
              aria-busy={permissionBusy()}
              onClick={() => void checkMicrophone()}
            >
              {permissionState() === 'idle' ? 'Check microphone' : permissionState()}
            </Button>
          </SettingsRow>
          <Show when={permissionError()}>
            <p class="conventional-settings-note" role="alert">
              {permissionError()}
            </p>
          </Show>
          <SettingsRow
            title="Dictation language"
            detail="Leave blank to follow the operating-system language."
          >
            <Input
              aria-label="Dictation language"
              value={preferences().dictationLocale}
              placeholder="System default"
              maxLength={35}
              onInput={(event) =>
                setPreferences({
                  ...preferences(),
                  dictationLocale: event.currentTarget.value,
                })
              }
              onBlur={() => void save(preferences())}
            />
          </SettingsRow>
          <SettingsRow
            title="Workspace soundtrack"
            detail="Optional local audio. It sits with input and notifications, not appearance."
          >
            <MusicToggle />
          </SettingsRow>
          <SettingsRow
            title="Mention notifications"
            detail="Save the preference now; live event delivery arrives with M3."
          >
            <Switch
              checked={preferences().notifyMentions}
              onChange={() => toggle('notifyMentions')}
              aria-label="Mention notifications"
              children={false}
            />
          </SettingsRow>
          <SettingsRow
            title="Task notifications"
            detail="Save the preference now; live event delivery arrives with M3."
          >
            <Switch
              checked={preferences().notifyTasks}
              onChange={() => toggle('notifyTasks')}
              aria-label="Task notifications"
              children={false}
            />
          </SettingsRow>
          <p class="conventional-settings-note">
            <Bell aria-hidden="true" /> Notification clicks will use canonical Project, Channel,
            Message, and Task identities when live events are wired in M3.
          </p>
        </TabsContent>
        <TabsContent
          value="privacy-data"
          id="settings-panel-privacy-data"
          class="conventional-settings-panel"
        >
          <header>
            <Database aria-hidden="true" />
            <div>
              <h3>{settingsSectionLabels['privacy-data']}</h3>
              <p>
                Understand what this device can access without exposing cryptographic internals.
              </p>
            </div>
          </header>
          <SettingsRow
            title="Local/private content"
            detail={
              privateHealth() === 'checking'
                ? 'Checking this device…'
                : privateHealth() === 'available'
                  ? 'Available on this authorized desktop device.'
                  : 'Unavailable in this app or on this device.'
            }
          />
          <SettingsRow
            title="Private notification previews"
            detail="Off by default. Enabling is explicit authorization to show private plaintext in desktop notification previews once M3 delivery exists."
          >
            <Switch
              checked={preferences().privateNotificationPreviews}
              onChange={() => toggle('privateNotificationPreviews')}
              aria-label="Private notification previews"
              children={false}
            />
          </SettingsRow>
          <p class="conventional-settings-note">
            <EyeOff aria-hidden="true" /> Private bodies are never sent to cloud search, logs,
            telemetry, or WorkspaceEvents.
          </p>
        </TabsContent>
        <TabsContent
          value="integrations"
          id="settings-panel-integrations"
          class="conventional-settings-panel"
        >
          <header>
            <Link2 aria-hidden="true" />
            <div>
              <h3>{settingsSectionLabels.integrations}</h3>
              <p>Control Plane-owned descriptors, not a second plugin system.</p>
            </div>
          </header>
          <Show
            when={props.agents.length}
            fallback={
              <SettingsRow
                title="No AgentProfile descriptors"
                detail="Create an Agent to establish an authoritative profile reference."
              />
            }
          >
            <For each={topAgentRows()}>
              {(entry) => (
                <SettingsRow
                  title={`${entry.item().profile.id} v${entry.item().profile.version}`}
                  detail={`AgentProfile reference for ${entry.item().name}; execution availability is not implied.`}
                />
              )}
            </For>
          </Show>
          <Show when={capabilities()}>
            {(snapshot) => (
              <CapabilityList
                busy={capabilitiesBusy()}
                onRefresh={() => void refreshCapabilities(true)}
                snapshot={snapshot()}
              />
            )}
          </Show>
          <SettingsRow
            title="Plugin runtime connections"
            detail="Manage enabled plugins from the global Plugins menu. Runtime credentials and execution remain unavailable until an authoritative Control Plane provider is connected."
          />
        </TabsContent>
        <TabsContent
          value="connections"
          id="settings-panel-connections"
          class="conventional-settings-panel"
        >
          <header>
            <LockKeyhole aria-hidden="true" />
            <div>
              <h3>{settingsSectionLabels.connections}</h3>
              <p>
                Which git hosting credentials and harness accounts this workspace uses on this
                device. Secrets stay in the device vault.
              </p>
            </div>
          </header>
          <Show when={section() === 'connections'}>
            <ConnectionsPane service={props.services?.connections} />
          </Show>
        </TabsContent>
        <TabsContent
          value="permissions"
          id="settings-panel-permissions"
          class="conventional-settings-panel"
        >
          <header>
            <ShieldCheck aria-hidden="true" />
            <div>
              <h3>{settingsSectionLabels.permissions}</h3>
              <p>
                macOS capabilities this app is granted, with the system panes that control them.
              </p>
            </div>
          </header>
          <PermissionsPane service={props.permissionsService} />
        </TabsContent>
        <div class="visually-hidden" aria-live="polite">
          {saveState() === 'saving'
            ? 'Saving settings'
            : saveState() === 'saved'
              ? 'Settings saved'
              : saveState() === 'error'
                ? 'Settings could not be saved'
                : ''}
        </div>
      </Tabs>
    </ModalDialog>
  )
}
