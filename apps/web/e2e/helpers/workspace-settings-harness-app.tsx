import '../../src/start/globals.css'
import { createSignal } from 'solid-js'
import { Button } from '@adea-ai/ui/components/ui/button'
import { render } from 'solid-js/web'
import { WorkspaceSettingsDialog } from '@adea-ai/workspace-ui/workspace-settings'
import { ThemeProvider } from '@adea-ai/app-ui/components/theme-provider'
import { AgentHqQueryProvider } from '@adea-ai/data/provider'
import type { WorkspaceSummary } from '@adea-ai/types'
import type { TranscriptionProvider, WorkspacePreferences } from '@adea-ai/workspace-ui/platform'
import { createDesktopSettingsProvider } from '../../src/lib/desktop-platform-services'
import { localContentAuthority } from '../../src/lib/desktop-local-content'
import { desktopMacPermissionsService } from '../../src/lib/desktop-permissions'
import { controlPlaneSettingsClient } from './control-plane-settings-fixture'

let permissionRequests = 0
let resolvePermission: ((state: 'granted') => void) | undefined
const transcription: TranscriptionProvider = {
  id: 'microphone-retry-fixture',
  label: 'Desktop dictation fixture',
  async requestPermission() {
    if (document.querySelector('#harness-root')?.hasAttribute('data-microphone-delayed')) {
      return new Promise<'granted'>((resolve) => {
        resolvePermission = resolve
      })
    }
    permissionRequests += 1
    if (permissionRequests === 1) throw new Error('Host permission service failed')
    return 'granted'
  },
  async start() {
    throw new Error('Transcription is outside this permission fixture')
  },
}

let storedPreferences: WorkspacePreferences | null = null
let writeFailed = false
const desktopSettings = createDesktopSettingsProvider(async (command, args) => {
  if (command === 'desktop_preferences_load') return storedPreferences
  if (
    !writeFailed &&
    document.querySelector('#harness-root')?.hasAttribute('data-desktop-write-failure')
  ) {
    writeFailed = true
    throw new Error('Native preferences write failed')
  }
  storedPreferences = args?.preferences ?? null
  return null
})

const workspace: WorkspaceSummary = {
  id: 'workspace-settings-e2e',
  name: 'Settings harness',
  scene: 'work',
  accent: null,
  logo: { kind: 'monogram' as const },
  sortOrder: 0,
  version: 1,
  updatedAt: '2026-10-02T00:00:00.000Z',
} as WorkspaceSummary

/**
 * Mounts the settings dialog with no application providers above it —
 * deliberately: the harness pins the dialog's contract that every section
 * renders standalone. The deep link (#settings/<section>) the dialog reads on
 * open decides the active tab, so the spec opens this page straight onto the
 * section it exercises.
 */
function Harness() {
  const missingDesktopBridge = document
    .querySelector('#harness-root')
    ?.hasAttribute('data-missing-desktop-bridge')
  const [open, setOpen] = createSignal(true)
  const controlPlaneMode = document
    .querySelector('#harness-root')
    ?.getAttribute('data-control-plane')
  const client =
    controlPlaneMode === 'scoped' || controlPlaneMode === 'unscoped'
      ? controlPlaneSettingsClient(controlPlaneMode)
      : undefined
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open settings fixture</Button>
      <Button id="resolve-permission-fixture" onClick={() => resolvePermission?.('granted')}>
        Resolve permission fixture
      </Button>
      <WorkspaceSettingsDialog
        open={open()}
        accountAuthenticated={false}
        accountLabel="Guest"
        agents={[]}
        busy={false}
        client={client}
        onClose={() => setOpen(false)}
        onOpenAgents={() => undefined}
        onSignIn={() => undefined}
        onSignOut={() => undefined}
        workspace={workspace}
        permissionsService={missingDesktopBridge ? desktopMacPermissionsService : undefined}
        services={{
          ...(missingDesktopBridge ? { privateContent: localContentAuthority } : {}),
          ...(document
            .querySelector('#harness-root')
            ?.matches('[data-microphone-retry], [data-microphone-delayed]')
            ? { transcription }
            : {}),
          ...(document.querySelector('#harness-root')?.hasAttribute('data-desktop-preferences')
            ? { settings: desktopSettings }
            : {}),
        }}
      />
    </>
  )
}

// The query provider is mounted only for the Control Plane fixtures, so the
// default harness still proves every section renders with no providers.
function Providers() {
  return document.querySelector('#harness-root')?.hasAttribute('data-control-plane') ? (
    <AgentHqQueryProvider>
      <Harness />
    </AgentHqQueryProvider>
  ) : (
    <Harness />
  )
}

render(
  () =>
    document.querySelector('#harness-root')?.hasAttribute('data-theme-provider') ? (
      <ThemeProvider>
        <Providers />
      </ThemeProvider>
    ) : (
      <Providers />
    ),
  document.querySelector('#harness-root')!
)
