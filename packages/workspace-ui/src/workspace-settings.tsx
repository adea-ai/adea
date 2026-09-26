import type { AgentSummary, WorkspaceSummary } from '@adea-ai/types'
import { MusicToggle } from '@adea-ai/audio'
import { WorkspaceLogo } from '@adea-ai/app-ui/components/workspace-logo'
import { ThemeToggle } from '@adea-ai/app-ui/components/theme-toggle'
import { Switch } from '@adea-ai/ui/components/ui/switch'
import {
  Bell,
  Bot,
  Database,
  EyeOff,
  Link2,
  Mic,
  MonitorCog,
  ShieldCheck,
  UserRound,
} from 'lucide-solid'
import { createEffect, createSignal, For, lazy, onCleanup, Show, type JSX } from 'solid-js'

import { CapabilityList } from './capability-card'
import { keyedRows } from './keyed-rows'
import { ModalDialog } from './modal-dialog'
import {
  defaultWorkspacePreferences,
  type CapabilitySnapshot,
  type WorkspacePlatformServices,
  type WorkspacePreferences,
} from './platform'
import type { MacPermissionsPageService } from '@adea-ai/dev-view/permissions'
import {
  nextSettingsSection,
  settingsSectionFromHash,
  settingsSectionGroups,
  settingsSectionLabels,
  type SettingsSection,
} from './settings-section'

const sectionIcons = {
  account: UserRound,
  appearance: MonitorCog,
  workspace: MonitorCog,
  agents: Bot,
  'input-notifications': Mic,
  'privacy-data': EyeOff,
  integrations: Link2,
  permissions: ShieldCheck,
} satisfies Record<SettingsSection, typeof UserRound>

// Lazy: the permissions pane (and its dev-view chunk) loads only when the
// section opens, never with the workspace chrome.
const PermissionsPane = lazy(() =>
  import('@adea-ai/dev-view/permissions').then((module) => ({ default: module.PermissionsPane }))
)

function SettingsRow(props: { children?: JSX.Element; detail: string; title: string }) {
  return (
    <div class="conventional-settings-row">
      <div>
        <h4>{props.title}</h4>
        <p>{props.detail}</p>
      </div>
      {props.children}
    </div>
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
   * The full appearance editor, injected by the host as an accessor
   * (dev-view's `AppearancePanel`) so it mounts only while this section is
   * the active one. Omitted falls back to the simple theme toggle, which is
   * what a host without the editor can offer.
   */
  appearancePanel?: () => JSX.Element
  /** The desktop bridge permission service; omitted (web-only) renders the
   * pane's honest typed-unavailable states. */
  permissionsService?: MacPermissionsPageService
  services?: WorkspacePlatformServices
  workspace: WorkspaceSummary
}) {
  const [section, setSection] = createSignal<SettingsSection>('account')
  const [preferences, setPreferences] = createSignal<WorkspacePreferences>(
    defaultWorkspacePreferences
  )
  const [saveState, setSaveState] = createSignal<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [permissionState, setPermissionState] = createSignal<
    'denied' | 'granted' | 'idle' | 'prompt' | 'unavailable'
  >('idle')
  const [privateHealth, setPrivateHealth] = createSignal<'available' | 'checking' | 'unavailable'>(
    props.services?.privateContent ? 'checking' : 'unavailable'
  )
  const [capabilities, setCapabilities] = createSignal<CapabilitySnapshot | undefined>()
  const [capabilitiesBusy, setCapabilitiesBusy] = createSignal(false)
  const navigationRefs = new Map<SettingsSection, HTMLButtonElement>()
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
    if (props.services?.privateContent?.health) {
      setPrivateHealth('checking')
      void props.services.privateContent
        .health(props.workspace.id)
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

  createEffect(() => {
    if (!props.open) return
    const current = section()
    const revealSelected = () =>
      navigationRefs.get(current)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    revealSelected()
    window.addEventListener('resize', revealSelected)
    onCleanup(() => window.removeEventListener('resize', revealSelected))
  })

  const selectSection = (next: SettingsSection, focus = false) => {
    setSection(next)
    // Re-writing an already-current hash makes the router re-resolve the route,
    // whose server-only entry loader then runs on the client and tears the
    // whole workspace down — observed as the dialog dismissing when the
    // already-selected tab trigger is clicked (#601). Only write the deep link
    // when it actually changes.
    const nextHash = `#settings/${next}`
    if (window.location.hash !== nextHash) window.history.replaceState(null, '', nextHash)
    if (focus) requestAnimationFrame(() => navigationRefs.get(next)?.focus())
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

  return (
    <ModalDialog
      class="conventional-settings-dialog"
      open={props.open}
      onClose={close}
      headerLeading={
        <WorkspaceLogo aria-hidden="true" class="conventional-settings-logo" role="presentation" />
      }
      title="Settings"
      description="Product preferences and boundaries for this Adea workspace."
    >
      <div class="conventional-settings-shell">
        {/* WAI-ARIA tabs pattern: the section nav IS the tablist. Group
            captions take role="none" so the tablist's owned content stays
            only its tab buttons (axe aria-required-children). */}
        <nav
          role="tablist"
          aria-orientation="vertical"
          aria-label="Settings sections"
          class="conventional-settings-nav"
        >
          <For each={settingsSectionGroups}>
            {(group) => (
              <div class="conventional-settings-nav__group">
                <p role="none" class="conventional-settings-nav__label">
                  {group.label}
                </p>
                <For each={group.items}>
                  {(item) => {
                    const Icon = sectionIcons[item]
                    return (
                      <button
                        ref={(element) => {
                          if (element) navigationRefs.set(item, element)
                          else navigationRefs.delete(item)
                        }}
                        id={`settings-tab-${item}`}
                        type="button"
                        role="tab"
                        aria-selected={section() === item}
                        aria-controls="settings-panel"
                        tabIndex={section() === item ? 0 : -1}
                        onClick={() => selectSection(item)}
                        onKeyDown={(event) => {
                          if (!['ArrowDown', 'ArrowUp', 'End', 'Home'].includes(event.key)) return
                          event.preventDefault()
                          selectSection(
                            nextSettingsSection(
                              item,
                              event.key as 'ArrowDown' | 'ArrowUp' | 'End' | 'Home'
                            ),
                            true
                          )
                        }}
                      >
                        <Icon aria-hidden="true" />
                        <span>{settingsSectionLabels[item]}</span>
                      </button>
                    )
                  }}
                </For>
              </div>
            )}
          </For>
        </nav>
        {/* One swapping panel: a stable id keeps every tab's aria-controls
            resolvable, and the selected tab names it (tabs pattern). */}
        <section
          id="settings-panel"
          class="conventional-settings-panel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${section()}`}
        >
          <Show when={section() === 'account'}>
            <>
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
                <button
                  type="button"
                  disabled={props.busy}
                  onClick={props.accountAuthenticated ? props.onSignOut : props.onSignIn}
                >
                  {props.accountAuthenticated ? 'Sign out' : 'Sign in'}
                </button>
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
            </>
          </Show>
          <Show when={section() === 'appearance'}>
            <>
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
                      <ThemeToggle />
                    </SettingsRow>
                  </>
                }
              >
                {props.appearancePanel?.()}
              </Show>
            </>
          </Show>
          <Show when={section() === 'workspace'}>
            <>
              <header>
                <MonitorCog aria-hidden="true" />
                <div>
                  <h3>{settingsSectionLabels.workspace}</h3>
                  <p>Opinionated Room defaults for the active workspace.</p>
                </div>
              </header>
              <SettingsRow
                title={props.workspace.name}
                detail={`${props.workspace.scene === 'work' ? 'Work' : 'Home'} scene · Rooms remain the primary navigation.`}
              />
              <SettingsRow
                title="Room defaults"
                detail="Primary Channels stay implicit; additional Channels are progressively disclosed. Arbitrary sidebar sections are intentionally unavailable in M2."
              />
            </>
          </Show>
          <Show when={section() === 'agents'}>
            <>
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
              <button
                type="button"
                class="conventional-primary-button"
                onClick={() => {
                  close()
                  props.onOpenAgents()
                }}
              >
                Customize Agents
              </button>
            </>
          </Show>
          <Show when={section() === 'input-notifications'}>
            <>
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
                <button
                  type="button"
                  disabled={!props.services?.transcription}
                  onClick={() =>
                    void props.services?.transcription
                      ?.requestPermission()
                      .then((state) => setPermissionState(state))
                  }
                >
                  {permissionState() === 'idle' ? 'Check microphone' : permissionState()}
                </button>
              </SettingsRow>
              <SettingsRow
                title="Dictation language"
                detail="Leave blank to follow the operating-system language."
              >
                <input
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
                <Bell aria-hidden="true" /> Notification clicks will use canonical Room, Channel,
                Message, and Task identities when live events are wired in M3.
              </p>
            </>
          </Show>
          <Show when={section() === 'privacy-data'}>
            <>
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
            </>
          </Show>
          <Show when={section() === 'integrations'}>
            <>
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
            </>
          </Show>
          <Show when={section() === 'permissions'}>
            <>
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
            </>
          </Show>
          <div class="visually-hidden" aria-live="polite">
            {saveState() === 'saving'
              ? 'Saving settings'
              : saveState() === 'saved'
                ? 'Settings saved'
                : saveState() === 'error'
                  ? 'Settings could not be saved'
                  : ''}
          </div>
        </section>
      </div>
    </ModalDialog>
  )
}
