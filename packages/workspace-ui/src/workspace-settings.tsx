import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentSummary, WorkspaceSummary } from '@agent-hq/types'
import { MusicToggle } from '@agent-hq/audio'
import { WorkspaceLogo } from '@agent-hq/ui/components/workspace-logo'
import { ThemeToggle } from '@agent-hq/ui/components/theme-toggle'
import { Switch } from '@agent-hq/ui/components/ui/switch'
import { Bell, Bot, Database, EyeOff, Link2, Mic, MonitorCog, UserRound } from 'lucide-react'

import { ModalDialog } from './modal-dialog'
import {
  defaultWorkspacePreferences,
  type WorkspacePlatformServices,
  type WorkspacePreferences,
} from './platform'
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
} satisfies Record<SettingsSection, typeof UserRound>

function SettingsRow({
  children,
  detail,
  title,
}: Readonly<{ children?: ReactNode; detail: string; title: string }>) {
  return (
    <div className="conventional-settings-row">
      <div>
        <h4>{title}</h4>
        <p>{detail}</p>
      </div>
      {children}
    </div>
  )
}

export function WorkspaceSettingsDialog({
  accountAuthenticated,
  accountLabel,
  agents,
  busy,
  onClose,
  onOpenAgents,
  onSignIn,
  onSignOut,
  open,
  services,
  workspace,
}: Readonly<{
  accountAuthenticated: boolean
  accountLabel: string
  agents: readonly AgentSummary[]
  busy: boolean
  onClose: () => void
  onOpenAgents: () => void
  onSignIn: () => void
  onSignOut: () => void
  open: boolean
  services?: WorkspacePlatformServices
  workspace: WorkspaceSummary
}>) {
  const [section, setSection] = useState<SettingsSection>('account')
  const [preferences, setPreferences] = useState(defaultWorkspacePreferences)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [permissionState, setPermissionState] = useState<
    'denied' | 'granted' | 'idle' | 'prompt' | 'unavailable'
  >('idle')
  const [privateHealth, setPrivateHealth] = useState<'available' | 'checking' | 'unavailable'>(
    services?.privateContent ? 'checking' : 'unavailable'
  )
  const navigationRefs = useRef(new Map<SettingsSection, HTMLButtonElement>())

  useEffect(() => {
    if (!open) return
    const next = settingsSectionFromHash(window.location.hash)
    setSection(next)
    let active = true
    void services?.settings
      ?.load()
      .then((loaded) => active && setPreferences(loaded))
      .catch(() => active && setSaveState('error'))
    if (services?.privateContent?.health) {
      setPrivateHealth('checking')
      void services.privateContent
        .health(workspace.id)
        .then(
          ({ available }) => active && setPrivateHealth(available ? 'available' : 'unavailable')
        )
        .catch(() => active && setPrivateHealth('unavailable'))
    }
    return () => {
      active = false
    }
  }, [open, services?.privateContent, services?.settings, workspace.id])

  useEffect(() => {
    if (!open) return
    const revealSelected = () =>
      navigationRefs.current.get(section)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    revealSelected()
    window.addEventListener('resize', revealSelected)
    return () => window.removeEventListener('resize', revealSelected)
  }, [open, section])

  const selectSection = (next: SettingsSection, focus = false) => {
    setSection(next)
    window.history.replaceState(null, '', `#settings/${next}`)
    if (focus) requestAnimationFrame(() => navigationRefs.current.get(next)?.focus())
  }
  const close = () => {
    if (window.location.hash.startsWith('#settings'))
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    onClose()
  }
  const save = async (next: WorkspacePreferences) => {
    setPreferences(next)
    if (!services?.settings) return
    setSaveState('saving')
    try {
      setPreferences(await services.settings.save(next))
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }
  const toggle = (key: 'notifyMentions' | 'notifyTasks' | 'privateNotificationPreviews') =>
    void save({ ...preferences, [key]: !preferences[key] })

  return (
    <ModalDialog
      className="conventional-settings-dialog"
      open={open}
      onClose={close}
      headerLeading={
        <WorkspaceLogo
          aria-hidden="true"
          className="conventional-settings-logo"
          role="presentation"
        />
      }
      title="Settings"
      description="Product preferences and boundaries for this Agent HQ workspace."
    >
      <div className="conventional-settings-shell">
        <nav aria-label="Settings sections" className="conventional-settings-nav">
          {settingsSectionGroups.map((group) => (
            <div className="conventional-settings-nav__group" key={group.label}>
              <p className="conventional-settings-nav__label">{group.label}</p>
              {group.items.map((item) => {
                const Icon = sectionIcons[item]
                return (
                  <button
                    key={item}
                    ref={(element) => {
                      if (element) navigationRefs.current.set(item, element)
                      else navigationRefs.current.delete(item)
                    }}
                    type="button"
                    role="tab"
                    aria-selected={section === item}
                    aria-controls={`settings-panel-${item}`}
                    tabIndex={section === item ? 0 : -1}
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
              })}
            </div>
          ))}
        </nav>
        <section
          id={`settings-panel-${section}`}
          className="conventional-settings-panel"
          role="tabpanel"
          aria-label={settingsSectionLabels[section]}
        >
          {section === 'account' ? (
            <>
              <header>
                <UserRound aria-hidden="true" />
                <div>
                  <h3>{settingsSectionLabels.account}</h3>
                  <p>Session and installed product information.</p>
                </div>
              </header>
              <SettingsRow
                title={accountAuthenticated ? accountLabel : 'Guest workspace'}
                detail={
                  accountAuthenticated
                    ? 'This workspace is saved to your account.'
                    : 'Sign in when you want to keep this workspace across devices.'
                }
              >
                <button
                  type="button"
                  disabled={busy}
                  onClick={accountAuthenticated ? onSignOut : onSignIn}
                >
                  {accountAuthenticated ? 'Sign out' : 'Sign in'}
                </button>
              </SettingsRow>
              <SettingsRow
                title={services?.app?.name ?? 'Agent HQ'}
                detail={`${services?.app?.platform === 'desktop' ? 'Desktop application' : 'Web application'}${services?.app?.version ? ` · v${services.app.version}` : ''}`}
              />
              <SettingsRow
                title="Spatial preview"
                detail="The Three.js representation is retained for M4 and does not define conventional workspace state."
              >
                <a href="/?view=spatial">Open preview</a>
              </SettingsRow>
            </>
          ) : section === 'appearance' ? (
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
              <SettingsRow
                title="Workspace soundtrack"
                detail="Optional local audio; message notifications are configured separately."
              >
                <MusicToggle />
              </SettingsRow>
            </>
          ) : section === 'workspace' ? (
            <>
              <header>
                <MonitorCog aria-hidden="true" />
                <div>
                  <h3>{settingsSectionLabels.workspace}</h3>
                  <p>Opinionated Room defaults for the active workspace.</p>
                </div>
              </header>
              <SettingsRow
                title={workspace.name}
                detail={`${workspace.scene === 'work' ? 'Work' : 'Home'} template · Rooms remain the primary navigation.`}
              />
              <SettingsRow
                title="Room defaults"
                detail="Primary Channels stay implicit; additional Channels are progressively disclosed. Arbitrary sidebar sections are intentionally unavailable in M2."
              />
            </>
          ) : section === 'agents' ? (
            <>
              <header>
                <Bot aria-hidden="true" />
                <div>
                  <h3>{settingsSectionLabels.agents}</h3>
                  <p>Durable identity and explicit profile references.</p>
                </div>
              </header>
              {agents.slice(0, 5).map((agent) => (
                <SettingsRow
                  key={agent.id}
                  title={agent.name}
                  detail={`${agent.profile.id} · v${agent.profile.version} · ${agent.lifecycleState.replace('_', ' ')}`}
                />
              ))}
              <button
                type="button"
                className="conventional-primary-button"
                onClick={() => {
                  close()
                  onOpenAgents()
                }}
              >
                Customize Agents
              </button>
            </>
          ) : section === 'input-notifications' ? (
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
                  services?.transcription
                    ? `Uses ${services.transcription.label}; text stays editable and is never auto-sent.`
                    : 'Install Agent HQ Desktop to use system dictation.'
                }
              >
                <button
                  type="button"
                  disabled={!services?.transcription}
                  onClick={() =>
                    void services?.transcription?.requestPermission().then(setPermissionState)
                  }
                >
                  {permissionState === 'idle' ? 'Check microphone' : permissionState}
                </button>
              </SettingsRow>
              <SettingsRow
                title="Dictation language"
                detail="Leave blank to follow the operating-system language."
              >
                <input
                  aria-label="Dictation language"
                  value={preferences.dictationLocale}
                  placeholder="System default"
                  maxLength={35}
                  onChange={(event) =>
                    setPreferences({ ...preferences, dictationLocale: event.target.value })
                  }
                  onBlur={() => void save(preferences)}
                />
              </SettingsRow>
              <SettingsRow
                title="Mention notifications"
                detail="Save the preference now; live event delivery arrives with M3."
              >
                <Switch
                  checked={preferences.notifyMentions}
                  onCheckedChange={() => toggle('notifyMentions')}
                  aria-label="Mention notifications"
                />
              </SettingsRow>
              <SettingsRow
                title="Task notifications"
                detail="Save the preference now; live event delivery arrives with M3."
              >
                <Switch
                  checked={preferences.notifyTasks}
                  onCheckedChange={() => toggle('notifyTasks')}
                  aria-label="Task notifications"
                />
              </SettingsRow>
              <p className="conventional-settings-note">
                <Bell aria-hidden="true" /> Notification clicks will use canonical Room, Channel,
                Message, and Task identities when live events are wired in M3.
              </p>
            </>
          ) : section === 'privacy-data' ? (
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
                  privateHealth === 'checking'
                    ? 'Checking this device…'
                    : privateHealth === 'available'
                      ? 'Available on this authorized desktop device.'
                      : 'Unavailable in this app or on this device.'
                }
              />
              <SettingsRow
                title="Private notification previews"
                detail="Off by default. Enabling is explicit authorization to show private plaintext in desktop notification previews once M3 delivery exists."
              >
                <Switch
                  checked={preferences.privateNotificationPreviews}
                  onCheckedChange={() => toggle('privateNotificationPreviews')}
                  aria-label="Private notification previews"
                />
              </SettingsRow>
              <p className="conventional-settings-note">
                <EyeOff aria-hidden="true" /> Private bodies are never sent to cloud search, logs,
                telemetry, or WorkspaceEvents.
              </p>
            </>
          ) : (
            <>
              <header>
                <Link2 aria-hidden="true" />
                <div>
                  <h3>{settingsSectionLabels.integrations}</h3>
                  <p>Control Plane-owned descriptors, not a second plugin system.</p>
                </div>
              </header>
              {agents.length ? (
                agents
                  .slice(0, 5)
                  .map((agent) => (
                    <SettingsRow
                      key={agent.id}
                      title={`${agent.profile.id} v${agent.profile.version}`}
                      detail={`AgentProfile reference for ${agent.name}; execution availability is not implied.`}
                    />
                  ))
              ) : (
                <SettingsRow
                  title="No AgentProfile descriptors"
                  detail="Create an Agent to establish an authoritative profile reference."
                />
              )}
              <SettingsRow
                title="Plugin runtime connections"
                detail="Manage enabled plugins from the global Plugins menu. Runtime credentials and execution remain unavailable until an authoritative Control Plane provider is connected."
              />
            </>
          )}
          <div className="visually-hidden" aria-live="polite">
            {saveState === 'saving'
              ? 'Saving settings'
              : saveState === 'saved'
                ? 'Settings saved'
                : saveState === 'error'
                  ? 'Settings could not be saved'
                  : ''}
          </div>
        </section>
      </div>
    </ModalDialog>
  )
}
