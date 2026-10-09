import '../../src/start/globals.css'
import { createSignal, Show, onCleanup, onMount } from 'solid-js'
import { Button } from '@adea-ai/ui/components/ui/button'
import { render } from 'solid-js/web'
import { WorkspaceSettingsDialog } from '@adea-ai/workspace-ui/workspace-settings'
import { WorkspaceDetailsDialog } from '@adea-ai/workspace-ui/workspace-details-dialog'
import { workspaceSettingsSectionFromHash } from '@adea-ai/workspace-ui/workspace-settings-section'
import { ThemeProvider } from '@adea-ai/app-ui/components/theme-provider'
import { AgentHqQueryProvider } from '@adea-ai/data/provider'
import type { WorkspaceSummary, WorkspaceUpdate } from '@adea-ai/types'
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

const initialWorkspace: WorkspaceSummary = {
  id: 'workspace-settings-e2e',
  canDelete: true,
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
 * section it exercises. A `#workspace-settings/<section>` deep link mounts the
 * workspace settings dialog instead, under the same no-providers contract.
 */
function Harness() {
  const missingDesktopBridge = document
    .querySelector('#harness-root')
    ?.hasAttribute('data-missing-desktop-bridge')
  const [open, setOpen] = createSignal(true)
  const [workspace, setWorkspace] = createSignal({
    ...initialWorkspace,
    isPersonal: document.querySelector('#harness-root')?.hasAttribute('data-personal') ?? false,
    deletionPending:
      document.querySelector('#harness-root')?.hasAttribute('data-delete-pending') ?? false,
    logo: document.querySelector('#harness-root')?.hasAttribute('data-personal')
      ? { kind: 'home' as const }
      : initialWorkspace.logo,
    canDelete: !document.querySelector('#harness-root')?.hasAttribute('data-read-only'),
  })
  const sibling = {
    ...initialWorkspace,
    id: 'settings-sibling',
    name: 'Secondary',
    logo: { kind: 'box' as const },
    sortOrder: 1,
  }
  const [orderIds, setOrderIds] = createSignal([initialWorkspace.id, sibling.id])
  const workspaceOrder = () =>
    orderIds().map((id, sortOrder) => ({
      ...(id === sibling.id ? sibling : workspace()),
      sortOrder,
    }))
  let reorderCalls = 0
  let deleteCalls = 0
  const workspaceDialog = workspaceSettingsSectionFromHash(window.location.hash) !== undefined
  // A versioned in-memory workspace store: a stale version is refused the way
  // the API refuses it, so the General section's conflict path is reachable.
  const updateWorkspace = async (
    update: WorkspaceUpdate & Readonly<{ expectedVersion: number }>
  ) => {
    const { expectedVersion, ...changes } = update
    if (expectedVersion !== workspace().version) throw new Error('Workspace version conflict')
    setWorkspace({
      ...workspace(),
      ...changes,
      version: workspace().version + 1,
    } as WorkspaceSummary)
    document
      .querySelector('#harness-root')
      ?.setAttribute('data-workspace', JSON.stringify(workspace()))
  }
  const controlPlaneMode = document
    .querySelector('#harness-root')
    ?.getAttribute('data-control-plane')
  const [client, setClient] = createSignal(
    controlPlaneMode === 'scoped' || controlPlaneMode === 'unavailable'
      ? controlPlaneSettingsClient(controlPlaneMode)
      : undefined
  )
  const switchScope = (event: Event) => {
    const detail = (event as CustomEvent<{ workspaceId?: string; replaceClient?: boolean }>).detail
    if (detail.workspaceId)
      setWorkspace({ ...workspace(), id: detail.workspaceId, name: 'Other workspace' })
    if (detail.replaceClient) setClient(controlPlaneSettingsClient('scoped'))
  }
  onMount(() => {
    if (!document.querySelector('#harness-root')?.hasAttribute('data-runtime-inventory')) return
    window.addEventListener('runtime-fixture-switch-scope', switchScope)
    onCleanup(() => window.removeEventListener('runtime-fixture-switch-scope', switchScope))
  })
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open settings fixture</Button>
      <Button id="resolve-permission-fixture" onClick={() => resolvePermission?.('granted')}>
        Resolve permission fixture
      </Button>
      <Show
        when={!workspaceDialog}
        fallback={
          <WorkspaceDetailsDialog
            open={open()}
            client={client()}
            onClose={() => setOpen(false)}
            workspaceOrder={workspaceOrder()}
            onReorderWorkspaces={async (ids) => {
              reorderCalls += 1
              const root = document.querySelector('#harness-root')!
              root.setAttribute('data-reorder-calls', String(reorderCalls))
              if (root.hasAttribute('data-reorder-failure') && reorderCalls === 1)
                throw new Error('fixture ordering failure')
              setOrderIds([...ids])
              root.setAttribute('data-order', JSON.stringify(ids))
            }}
            onDeleteWorkspace={async () => {
              deleteCalls += 1
              const root = document.querySelector('#harness-root')!
              root.setAttribute('data-delete-calls', String(deleteCalls))
              if (root.hasAttribute('data-delete-failure') && deleteCalls === 1)
                throw new Error('Fixture deletion failed')
              if (root.hasAttribute('data-delete-delayed'))
                await new Promise<void>((resolve) =>
                  window.addEventListener('fixture:delete-complete', () => resolve(), {
                    once: true,
                  })
                )
            }}
            {...(document.querySelector('#harness-root')?.hasAttribute('data-read-only')
              ? {}
              : { onUpdateWorkspace: updateWorkspace })}
            workspace={workspace()}
          />
        }
      >
        <WorkspaceSettingsDialog
          open={open()}
          accountAuthenticated={false}
          accountLabel="Guest"
          agents={[]}
          busy={false}
          onClose={() => setOpen(false)}
          onOpenAgents={() => undefined}
          onSignIn={() => undefined}
          onSignOut={() => undefined}
          workspace={workspace()}
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
      </Show>
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
