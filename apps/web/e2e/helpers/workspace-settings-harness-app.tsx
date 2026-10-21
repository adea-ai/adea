import '../../src/start/globals.css'
import { createSignal, Show, onCleanup, onMount } from 'solid-js'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Toaster } from '@adea-ai/ui/components/ui/toast'
import { render } from 'solid-js/web'
import { WorkspaceSettingsDialog } from '@adea-ai/workspace-ui/workspace-settings'
import { ThemeProvider } from '@adea-ai/app-ui/components/theme-provider'
import { AgentHqQueryProvider } from '@adea-ai/data/provider'
import { ApiClientError, type AgentHqApiClient } from '@adea-ai/api-client'
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

const harnessRoot = () => document.querySelector('#harness-root')!
const countCall = (name: string) => {
  const next = Number(harnessRoot().getAttribute(name) ?? 0) + 1
  harnessRoot().setAttribute(name, String(next))
  return next
}

// The owner's archived rows outlive the dialog that archived them, as the query cache does in the app.
let archivedRows: WorkspaceSummary[] = []
// Archived projects staged for the restore flow; `data-archived-projects` seeds them once.
type FixtureProject = { id: string; name: string; version: number }
let archivedProjects: FixtureProject[] | undefined
function archivedProjectRows(): FixtureProject[] {
  archivedProjects ??= harnessRoot().hasAttribute('data-archived-projects')
    ? [
        { id: 'project-billing', name: 'Billing rebuild', version: 3 },
        { id: 'project-mobile', name: 'Mobile', version: 1 },
      ]
    : []
  return archivedProjects
}
const fixtureNames: Record<string, string> = {
  'settings-sibling': 'Secondary',
  'workspace-settings-e2e': 'Settings harness',
}

/**
 * The archive fixture's contract: archive, reopen and the archived listing answer from module state
 * and data attributes, so the spec can stage success, a refusal, a transient failure and a repeat.
 */
function archiveFixtureClient(): AgentHqApiClient {
  return {
    async archiveWorkspace(workspaceId: string) {
      countCall('data-archive-calls')
      harnessRoot().setAttribute('data-archive-target', workspaceId)
      await new Promise((resolve) => setTimeout(resolve, 150))
      const mode = harnessRoot().getAttribute('data-archive-mode')
      if (mode === 'unavailable')
        throw new ApiClientError('Workspace unavailable', 404, 'workspace_unavailable')
      if (mode === 'error')
        throw new ApiClientError(
          'Workspace could not be archived. Try again.',
          500,
          'workspace_archive_failed'
        )
      archivedRows = [
        ...archivedRows.filter((row) => row.id !== workspaceId),
        { ...initialWorkspace, id: workspaceId, name: fixtureNames[workspaceId] ?? workspaceId },
      ]
      return { archived: true as const, workspaceId }
    },
    async exportWorkspace(workspaceId: string) {
      countCall('data-export-calls')
      harnessRoot().setAttribute('data-export-target', workspaceId)
      await new Promise((resolve) => setTimeout(resolve, 150))
      const mode = harnessRoot().getAttribute('data-export-mode')
      if (mode === 'too_large') throw new ApiClientError('Too large', 413, 'too_large')
      if (mode === 'unavailable')
        throw new ApiClientError('Workspace unavailable', 404, 'workspace_unavailable')
      if (mode === 'error') throw new ApiClientError('Server error', 500)
      const text = JSON.stringify({ format: 'adea.portable-workspace-export', formatVersion: 1 })
      return {
        bytes: text.length,
        fileName: `workspace-${workspaceId}.portable.json`,
        text,
      }
    },
    async importWorkspace(text: string) {
      countCall('data-import-calls')
      harnessRoot().setAttribute('data-import-length', String(text.length))
      await new Promise((resolve) => setTimeout(resolve, 150))
      const refusal = harnessRoot().getAttribute('data-import-refusal')
      // A refusal is staged for the first attempt only, so the retry path is reachable.
      if (refusal && harnessRoot().getAttribute('data-import-calls') === '1')
        throw new ApiClientError('Refused', 422, refusal)
      return {
        contentDigest: 'fixture-digest',
        counts: { agents: 4, channels: 12, messages: 842, projects: 3, tasks: 57 },
        deferred: [],
        workspaceId: 'restored-workspace',
      }
    },
    async listArchivedWorkspaces() {
      return { workspaces: archivedRows }
    },
    async listArchivedProjects() {
      return archivedProjectRows().map((project) => ({
        ...project,
        createdAt: '2026-10-01T00:00:00.000Z',
        iconKey: 'folder',
        lifecycleState: 'archived' as const,
        sortOrder: 0,
        sourceKind: 'none' as const,
        updatedAt: '2026-10-01T00:00:00.000Z',
        visibility: 'workspace' as const,
        workspaceId: initialWorkspace.id,
      }))
    },
    async restoreProject(
      _workspaceId: string,
      projectId: string,
      input: { confirmed: true; expectedVersion: number }
    ) {
      countCall('data-restore-calls')
      harnessRoot().setAttribute('data-restore-target', projectId)
      harnessRoot().setAttribute('data-restore-version', String(input.expectedVersion))
      harnessRoot().setAttribute('data-restore-confirmed', String(input.confirmed))
      await new Promise((resolve) => setTimeout(resolve, 150))
      const mode = harnessRoot().getAttribute('data-restore-mode')
      if (mode === 'conflict') throw new ApiClientError('Conflict', 409, 'project_conflict')
      if (mode === 'error') throw new ApiClientError('Server error', 500)
      const row = archivedProjectRows().find((project) => project.id === projectId)
      if (!row) throw new ApiClientError('Unavailable', 404, 'workspace_unavailable')
      archivedProjects = archivedProjectRows().filter((project) => project.id !== projectId)
      return {
        project: {
          ...row,
          createdAt: '2026-10-01T00:00:00.000Z',
          iconKey: 'folder',
          lifecycleState: 'active' as const,
          sortOrder: 0,
          sourceKind: 'none' as const,
          updatedAt: '2026-10-13T00:00:00.000Z',
          version: row.version + 1,
          visibility: 'workspace' as const,
          workspaceId: initialWorkspace.id,
        },
      }
    },
    async listWorkspaceMembers() {
      countCall('data-members-calls')
      const staged = harnessRoot().getAttribute('data-archive-members')
      if (staged === 'error') throw new ApiClientError('Server error', 500)
      const total = Math.max(1, Number(staged ?? 1))
      return {
        members: Array.from({ length: total }, (_, index) => ({
          displayName: index === 0 ? 'Owner' : `Member ${index}`,
          role: index === 0 ? ('owner' as const) : ('member' as const),
          userId: `member-${index}`,
        })),
      }
    },
    async reopenWorkspace(workspaceId: string) {
      countCall('data-reopen-calls')
      const row = archivedRows.find((candidate) => candidate.id === workspaceId)
      if (!row) throw new ApiClientError('Workspace unavailable', 404, 'workspace_unavailable')
      archivedRows = archivedRows.filter((candidate) => candidate.id !== workspaceId)
      return { workspace: { ...row, canArchive: true } }
    },
  } as unknown as AgentHqApiClient
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
 * section it exercises. The workspace sections (`#settings/workspace-*`, and the
 * retired `#workspace-settings/<section>` links) open in this same dialog.
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
    canArchive:
      document.querySelector('#harness-root')?.hasAttribute('data-archive-client') ?? false,
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
  let openCalls = 0
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
  const archiveMode =
    document.querySelector('#harness-root')?.hasAttribute('data-archive-client') ?? false
  const [client, setClient] = createSignal(
    controlPlaneMode === 'scoped' || controlPlaneMode === 'unavailable'
      ? controlPlaneSettingsClient(controlPlaneMode)
      : archiveMode
        ? archiveFixtureClient()
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
      <Show when={archiveMode}>
        <Button
          id="switch-fixture-workspace"
          onClick={() =>
            setWorkspace({
              ...initialWorkspace,
              id: 'settings-sibling',
              name: 'Secondary',
              logo: { kind: 'box' as const },
              canArchive: true,
            } as WorkspaceSummary)
          }
        >
          Switch fixture workspace
        </Button>
      </Show>
      <Toaster position="bottom-right" />
      <Button id="resolve-permission-fixture" onClick={() => resolvePermission?.('granted')}>
        Resolve permission fixture
      </Button>
      <WorkspaceSettingsDialog
        open={open()}
        accountAuthenticated={false}
        accountLabel="Guest"
        agents={[]}
        busy={false}
        client={client()}
        onClose={() => setOpen(false)}
        onOpenAgents={() => undefined}
        onSignIn={() => undefined}
        onSignOut={() => undefined}
        workspace={workspace()}
        workspaces={workspaceOrder()}
        onSwitchWorkspace={(next) => {
          const root = document.querySelector('#harness-root')!
          root.setAttribute('data-switched-workspace', next.id)
          setWorkspace(next)
        }}
        onCreateWorkspace={() => {
          document.querySelector('#harness-root')!.setAttribute('data-create-workspace', '')
        }}
        onOpenWorkspace={async (id) => {
          const root = document.querySelector('#harness-root')!
          openCalls += 1
          root.setAttribute('data-open-calls', String(openCalls))
          await new Promise((resolve) => setTimeout(resolve, 100))
          // A staged failure covers the first attempt only, so the retry is reachable.
          if (root.hasAttribute('data-open-failure') && openCalls === 1) return false
          root.setAttribute('data-opened-workspace', id)
          return true
        }}
        onReorderWorkspaces={async (ids) => {
          reorderCalls += 1
          const root = document.querySelector('#harness-root')!
          root.setAttribute('data-reorder-calls', String(reorderCalls))
          if (root.hasAttribute('data-reorder-failure') && reorderCalls === 1)
            throw new Error('fixture ordering failure')
          setOrderIds([...ids])
          root.setAttribute('data-order', JSON.stringify(ids))
        }}
        {...(document.querySelector('#harness-root')?.hasAttribute('data-read-only')
          ? {}
          : { onUpdateWorkspace: updateWorkspace })}
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

// The query provider is mounted only for the Control Plane and archive fixtures, so the
// default harness still proves every section renders with no providers.
function Providers() {
  const root = document.querySelector('#harness-root')
  return root?.hasAttribute('data-control-plane') || root?.hasAttribute('data-archive-client') ? (
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
