import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { AgentSummary, WorkspaceSummary, WorkspaceUpdate } from '@adea-ai/types'
import { MusicToggle } from '@adea-ai/audio'
import { WorkspaceLogo } from '@adea-ai/app-ui/components/workspace-logo'
import { ThemeToggle } from '@adea-ai/app-ui/components/theme-toggle'
import { useOptionalTheme } from '@adea-ai/ui/components/theme/lazy'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { Switch } from '@adea-ai/ui/components/ui/switch'
import { SettingsNavigation, SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Tabs, TabsContent } from '@adea-ai/ui/components/ui/tabs'
import { WorkspaceIdentityMark } from '@adea-ai/app-ui/components/workspace-identity-mark'
import {
  Bell,
  Bot,
  Boxes,
  Brain,
  Database,
  EyeOff,
  Link2,
  LockKeyhole,
  Mic,
  MonitorCog,
  Settings2,
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

import { Dynamic } from 'solid-js/web'

import { CapabilityList } from './capability-card'
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
  isWorkspaceScopedSection,
  settingsSectionFromHash,
  settingsSectionGroups,
  settingsSectionHash,
  settingsSectionLabels,
  settingsSections,
  workspaceScopedSettingsSections,
  type SettingsSection,
  type WorkspaceScopedSettingsSection,
} from './settings-section'
import { isSettingsHash } from './workspace-settings-section'
import {
  WorkspaceSettingsSectionBody,
  workspaceSectionDescription,
} from './workspace-settings-panels'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Heading, Text } from '@adea-ai/ui/components/ui/typography'

const sectionIcons = {
  account: UserRound,
  appearance: MonitorCog,
  agents: Bot,
  'input-notifications': Mic,
  'privacy-data': EyeOff,
  integrations: Link2,
  permissions: ShieldCheck,
  workspaces: Boxes,
  'workspace-general': Settings2,
  'workspace-memory': Brain,
  'workspace-connections': LockKeyhole,
} satisfies Record<SettingsSection, typeof UserRound>

// One active panel shares its header and tab semantics across all settings sections.
const sectionDescriptions: Record<SettingsSection, string> = {
  account: 'Session and installed product information.',
  appearance: 'Shared presentation preferences.',
  agents: 'Durable identity and explicit profile references.',
  'input-notifications': 'Desktop dictation and bounded notification preferences.',
  'privacy-data':
    'Understand what this device can access without exposing cryptographic internals.',
  integrations: 'Control Plane-owned descriptors, not a second plugin system.',
  permissions: 'macOS capabilities this app is granted, with the system panes that control them.',
  workspaces: 'Pick the workspace you are working in, add another, or open one to customize it.',
  // The workspace sections take their description from the selected workspace.
  'workspace-general': '',
  'workspace-memory': '',
  'workspace-connections': '',
}

// Lazy: the permissions pane (and its dev-view chunk) loads only when the
// section opens, never with the workspace chrome.
const PermissionsPane = lazy(() =>
  import('@adea-ai/dev-view/permissions').then((module) => ({ default: module.PermissionsPane }))
)

// True while an appearance theme dropdown is mounted inside the settings
// dialog. Read at scroll-time rather than tracked so it always reflects the
// DOM, whichever side of the open/close race a scroll event lands on.
function appearanceMenuOpen() {
  return Boolean(document.querySelector('[data-appearance-editor] [role="menu"]'))
}

/** Names the workspace a workspace-scoped section is configuring, with a way to pick another. */
function WorkspaceTarget(props: { workspace: WorkspaceSummary; onChange: () => void }) {
  return (
    <div
      class="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2"
      data-slot="settings-workspace-target"
    >
      <WorkspaceIdentityMark
        accent={props.workspace.accent}
        logo={props.workspace.logo}
        name={props.workspace.name}
        size="sm"
      />
      <span class="min-w-0 flex-1 truncate">
        <Text as="span" variant="label">
          Settings for {props.workspace.name}
        </Text>
      </span>
      <Button type="button" variant="outline" size="sm" onClick={() => props.onChange()}>
        Change workspace
      </Button>
    </div>
  )
}

/**
 * The directory of the member's workspaces: which one the app is showing, a
 * way to switch or add one, and a shortcut into a workspace's own settings.
 * Switching only changes what the window looks at; nothing is moved or restarted.
 */
function WorkspaceDirectory(props: {
  current: WorkspaceSummary
  workspaces: readonly WorkspaceSummary[]
  onCreate?: () => void
  onCustomize: (workspace: WorkspaceSummary) => void
  onSwitch?: (workspace: WorkspaceSummary) => void | Promise<unknown>
}) {
  return (
    <>
      <ul class="flex flex-col gap-2" aria-label="Workspaces">
        <For each={props.workspaces}>
          {(workspace) => (
            <li data-workspace-id={workspace.id}>
              <SettingsRow
                label={workspace.name}
                description={[
                  workspace.id === props.current.id ? 'Current workspace' : undefined,
                  workspace.isPersonal ? 'Home' : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              >
                <div class="flex items-center gap-2">
                  <WorkspaceIdentityMark
                    accent={workspace.accent}
                    logo={workspace.logo}
                    name={workspace.name}
                    size="sm"
                  />
                  <Show when={workspace.id !== props.current.id && props.onSwitch}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Open ${workspace.name}`}
                      onClick={() => void props.onSwitch?.(workspace)}
                    >
                      Open
                    </Button>
                  </Show>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Customize ${workspace.name}`}
                    onClick={() => props.onCustomize(workspace)}
                  >
                    Customize
                  </Button>
                </div>
              </SettingsRow>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.onCreate}>
        <Button type="button" onClick={() => props.onCreate?.()}>
          New workspace
        </Button>
      </Show>
    </>
  )
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
  /** The workspace the workspace-scoped sections configure: the one the app is showing. */
  workspace: WorkspaceSummary
  /** Every workspace the member belongs to, in their own order. */
  workspaces?: readonly WorkspaceSummary[]
  /** Make a workspace the one the app shows; settings then target it. */
  onSwitchWorkspace?: (workspace: WorkspaceSummary) => void | Promise<unknown>
  /** Open the host's create-workspace dialog. */
  onCreateWorkspace?: () => void
  /** The Adea API client for the Control Plane-backed workspace sections. */
  client?: AgentHqApiClient
  accountPrincipalId?: () => string | null | undefined
  onUpdateWorkspace?: (
    update: WorkspaceUpdate & Readonly<{ expectedVersion: number }>
  ) => Promise<void>
  /** Takes the user into a workspace they just restored; true once it is open. */
  onOpenWorkspace?: (workspaceId: string) => Promise<boolean>
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
    // A retired workspace-settings link lands on the canonical Settings hash.
    const canonical = settingsSectionHash(next)
    if (window.location.hash !== canonical) window.history.replaceState(null, '', canonical)
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
    const nextHash = settingsSectionHash(next)
    if (window.location.hash !== nextHash) window.history.replaceState(null, '', nextHash)
  }
  const close = () => {
    if (isSettingsHash(window.location.hash))
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
      stableDialog = document.querySelector('[data-settings-dialog]')?.scrollTop ?? 0
      stablePanel = document.querySelector('#settings-panel-appearance')?.scrollTop ?? 0
    }
    const onScroll = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (!target.closest('[data-settings-dialog]')) return
      if (!appearanceMenuOpen()) {
        sample()
        return
      }
      const dialog = document.querySelector('[data-settings-dialog]')
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
      data-settings-dialog=""
      open={props.open}
      onClose={close}
      restoreFocusRef={props.restoreFocusRef}
      headerLeading={
        <WorkspaceLogo aria-hidden="true" class="block size-10 shrink-0" role="presentation" />
      }
      title="Settings"
    >
      <Tabs
        id="settings-tabs"
        class="h-full w-full max-md:data-[orientation=vertical]:flex-col"
        orientation="vertical"
        value={section()}
        onChange={(value) => selectSection(value as SettingsSection)}
      >
        <SettingsNavigation
          class="w-52 max-md:w-full max-md:data-[orientation=vertical]:flex-row max-md:overflow-x-auto max-md:overflow-y-hidden max-md:*:w-max max-md:*:max-w-full max-md:*:flex-none"
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
        <For each={settingsSections}>
          {(panelSection) => (
            <TabsContent
              value={panelSection}
              id={`settings-panel-${panelSection}`}
              class="min-h-0 min-w-0"
            >
              <div class="conventional-settings-panel">
                <Show when={panelSection !== 'appearance' || !props.appearancePanel}>
                  <header>
                    <Dynamic
                      component={
                        panelSection === 'privacy-data' ? Database : sectionIcons[panelSection]
                      }
                      aria-hidden="true"
                    />
                    <div>
                      <Heading as="h3" size="card">
                        {settingsSectionLabels[panelSection]}
                      </Heading>
                      <p>
                        {isWorkspaceScopedSection(panelSection)
                          ? workspaceSectionDescription(
                              workspaceScopedSettingsSections[panelSection],
                              props.workspace.name
                            )
                          : sectionDescriptions[panelSection]}
                      </p>
                    </div>
                  </header>
                </Show>
                <Show when={panelSection === 'account'}>
                  <SettingsRow
                    label={props.accountAuthenticated ? props.accountLabel : 'Guest workspace'}
                    description={
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
                    label={props.services?.app?.name ?? 'Adea'}
                    description={`${props.services?.app?.platform === 'desktop' ? 'Desktop application' : 'Web application'}${props.services?.app?.version ? ` · v${props.services.app.version}` : ''}`}
                  />
                  <SettingsRow
                    label="Virtual preview"
                    description="The 3D preview is display-only; it does not change workspace state."
                  >
                    <a href="/?view=virtual">Open preview</a>
                  </SettingsRow>
                </Show>
                <Show when={panelSection === 'appearance'}>
                  <Show
                    when={props.appearancePanel}
                    fallback={
                      <>
                        <SettingsRow
                          label="Color theme"
                          description="Follow the system or explicitly choose light or dark."
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
                </Show>
                <Show when={panelSection === 'agents'}>
                  <For each={topAgentRows()}>
                    {(entry) => (
                      <SettingsRow
                        label={entry.item().name}
                        description={`${entry.item().profile.id} · v${entry.item().profile.version} · ${entry.item().lifecycleState.replace('_', ' ')}`}
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
                </Show>
                <Show when={panelSection === 'input-notifications'}>
                  <SettingsRow
                    label="Composer dictation"
                    description={
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
                    <Alert variant="destructive" class="mt-4">
                      <AlertDescription>{permissionError()}</AlertDescription>
                    </Alert>
                  </Show>
                  <SettingsRow
                    label="Dictation language"
                    description="Leave blank to follow the operating-system language."
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
                    label="Workspace soundtrack"
                    description="Optional local audio. It sits with input and notifications, not appearance."
                  >
                    <MusicToggle />
                  </SettingsRow>
                  <For
                    each={
                      [
                        { key: 'notifyMentions', label: 'Mention notifications' },
                        { key: 'notifyTasks', label: 'Task notifications' },
                      ] as const
                    }
                  >
                    {(notification) => (
                      <SettingsRow
                        label={notification.label}
                        description="Save the preference now; live event delivery arrives with M3."
                      >
                        <Switch
                          checked={preferences()[notification.key]}
                          onChange={() => toggle(notification.key)}
                          aria-label={notification.label}
                          children={false}
                        />
                      </SettingsRow>
                    )}
                  </For>
                  <Alert role="note" class="mt-4" icon={<Bell aria-hidden="true" />}>
                    <AlertDescription>
                      Notification clicks will use canonical Project, Channel, Message, and Task
                      identities when live events are wired in M3.
                    </AlertDescription>
                  </Alert>
                </Show>
                <Show when={panelSection === 'privacy-data'}>
                  <SettingsRow
                    label="Local/private content"
                    description={
                      privateHealth() === 'checking'
                        ? 'Checking this device…'
                        : privateHealth() === 'available'
                          ? 'Available on this authorized desktop device.'
                          : 'Unavailable in this app or on this device.'
                    }
                  />
                  <SettingsRow
                    label="Private notification previews"
                    description="Off by default. Enabling is explicit authorization to show private plaintext in desktop notification previews once M3 delivery exists."
                  >
                    <Switch
                      checked={preferences().privateNotificationPreviews}
                      onChange={() => toggle('privateNotificationPreviews')}
                      aria-label="Private notification previews"
                      children={false}
                    />
                  </SettingsRow>
                  <Alert role="note" class="mt-4" icon={<EyeOff aria-hidden="true" />}>
                    <AlertDescription>
                      Private bodies are never sent to cloud search, logs, telemetry, or
                      WorkspaceEvents.
                    </AlertDescription>
                  </Alert>
                </Show>
                <Show when={panelSection === 'integrations'}>
                  <Show
                    when={props.agents.length}
                    fallback={
                      <SettingsRow
                        label="No AgentProfile descriptors"
                        description="Create an Agent to establish an authoritative profile reference."
                      />
                    }
                  >
                    <For each={topAgentRows()}>
                      {(entry) => (
                        <SettingsRow
                          label={`${entry.item().profile.id} v${entry.item().profile.version}`}
                          description={`AgentProfile reference for ${entry.item().name}; execution availability is not implied.`}
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
                    label="Plugin runtime connections"
                    description="Manage enabled plugins from the global Plugins menu. Runtime credentials and execution remain unavailable until an authoritative Control Plane provider is connected."
                  />
                </Show>
                <Show when={panelSection === 'permissions'}>
                  <PermissionsPane service={props.permissionsService} />
                </Show>
                <Show when={panelSection === 'workspaces'}>
                  <WorkspaceDirectory
                    current={props.workspace}
                    workspaces={props.workspaces ?? [props.workspace]}
                    onCreate={props.onCreateWorkspace}
                    onCustomize={(workspace) => {
                      void Promise.resolve(
                        workspace.id === props.workspace.id
                          ? undefined
                          : props.onSwitchWorkspace?.(workspace)
                      ).then(() => selectSection('workspace-general'))
                    }}
                    onSwitch={props.onSwitchWorkspace}
                  />
                </Show>
                <Show when={isWorkspaceScopedSection(panelSection) && panelSection}>
                  {(scoped) => (
                    <>
                      <WorkspaceTarget
                        workspace={props.workspace}
                        onChange={() => selectSection('workspaces')}
                      />
                      <WorkspaceSettingsSectionBody
                        accountPrincipalId={props.accountPrincipalId}
                        client={props.client}
                        open={props.open}
                        section={
                          workspaceScopedSettingsSections[
                            scoped() as WorkspaceScopedSettingsSection
                          ]
                        }
                        onOpenWorkspace={props.onOpenWorkspace}
                        onUpdateWorkspace={props.onUpdateWorkspace}
                        services={props.services}
                        workspace={props.workspace}
                      />
                    </>
                  )}
                </Show>
              </div>
            </TabsContent>
          )}
        </For>
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
