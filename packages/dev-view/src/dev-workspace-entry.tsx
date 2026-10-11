/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Shell decomposition and hierarchy semantics are substantially translated
 * from KiroCrew website/src/pages/ChatSidebar.tsx,
 * website/src/pages/chat/SidePanel.tsx, and website/src/hooks/panelTabRegistry.ts
 * (Apache-2.0), revision
 * 283e136c0f902e965a535a7c9548c57c7504fed0. Modified for Solid, Adea's
 * runtime authority boundaries, accessibility, and unavailable typed seams.
 * See NOTICE and docs/research/dev-view-donor-audit.md.
 */
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'
import type {
  DevCapability,
  DevUtilityPane,
  DevUtilityPreference,
  DevReply,
  DevStreamFrame,
} from '@adea-ai/types/dev-runtime'
import {
  devOperationMetadataFor_dev_group_reorder,
  devOperationMetadataFor_dev_project_reorder,
  devOperationMetadataFor_dev_session_get,
  devOperationMetadataFor_dev_session_list,
  devOperationMetadataFor_dev_session_unarchive,
} from '@adea-ai/types/dev-runtime-operation-metadata'
import '@adea-ai/app-ui/dev-view.css'
import { cn } from '@adea-ai/app-ui/lib/utils'
import {
  Columns2,
  FolderTree,
  GitBranch,
  Maximize2,
  X,
} from 'lucide-solid'
import {
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
} from 'solid-js'
import { Portal } from 'solid-js/web'

import { createDevKeyboardController } from './keyboard'
import { buildDevCommandFromMetadata } from './browser/command-core'
import {
  closePane,
  countLeaves,
  focusPane,
  listLeaves,
  neighborLeaf,
  resizeSplit,
  splitPane,
  undoClosePane,
  movePane,
  type DevLayoutState,
} from './layout/operations'
import type { DevRuntimeService } from './platform'
import type { TerminalStreamSocket } from './terminal/transport'
import type { ShellObservation } from './terminal/blocks'
import { useDevUtilityOwner } from './utility/owner'
import type { DevGroupFixture } from './utility/types'
import { devViewFixtureGroups } from './utility/fixtures'
export type { DevGroupFixture, DevProjectFixture } from './utility/types'
import {
  archiveShelfError,
  archiveShelfReady,
  archiveShelfUnavailable,
  beginArchiveShelfLoad,
  cancelPendingDelete,
  confirmPendingDelete,
  requestDelete,
  restoreCompleted,
  SESSION_DELETE_OPERATION,
  type ArchiveShelfState,
} from './sidebar/archive-shelf-model'
import { AddProjectPanel } from './sidebar/add-project-panel'
import { DevSidebarShell } from './sidebar/dev-sidebar-shell'
import {
  announcementForMove,
  moveIdInOrder,
  reorderGroups,
  reorderGroupsRelativeTo,
  reorderProjects,
  reorderProjectsRelativeTo,
} from './sidebar/reorder'
import { Button } from '@adea-ai/ui/components/ui/button'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { ButtonGroup } from '@adea-ai/ui/components/ui/button-group'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@adea-ai/ui/components/ui/resizable'
import {
  paneCapability as PANE_CAPABILITY,
  snapUtilitySize,
  utilityItemByPane,
} from './utility/definitions'

// Keep the sidebar and runtime controls independent of the central split
// renderer. Its resize dependency is loaded when the panes actually mount.
const DevLayoutView = lazy(() =>
  import('./layout/layout-view').then((module) => ({ default: module.DevLayoutView }))
)

// Test transport and fake output are development-only, never production code.
const FixtureTerminalPane = import.meta.env.DEV
  ? lazy(() =>
      import('./terminal/fixture-terminal-pane').then((module) => ({
        default: module.FixtureTerminalPane,
      }))
    )
  : undefined

const devWorkspaceReorderMetadata = {
  'dev.group.reorder': devOperationMetadataFor_dev_group_reorder,
  'dev.project.reorder': devOperationMetadataFor_dev_project_reorder,
} as const

export type DevWorkspaceEntryProps = Readonly<{
  runtime: DevRuntimeService
  /** E2E/development fixtures only; production consumes the runtime projection. */
  groups?: readonly DevGroupFixture[]
  toolbarMount?: HTMLElement
  appMode?: 'source-control'
}>

export { devViewFixtureGroups }

const utilitySizeSteps = [240, 288, 336, 384] as const
/*
 * #399: Files/Source Control utility panes and the central editor leaf ride
 * their own lazy chunks inside the Dev boundary, exactly like the browser and
 * device panes; the editor's CodeMirror family loads one dynamic import
 * deeper still (inside the editor slice).
 */
const FilesPane = lazy(() =>
  import('./files/files-pane').then((module) => ({ default: module.FilesPane }))
)
const SourceControlPane = lazy(() =>
  import('./source-control/source-control-pane').then((module) => ({
    default: module.SourceControlPane,
  }))
)
const CodeEditor = lazy(() =>
  import('./editor/code-editor').then((module) => ({ default: module.CodeEditor }))
)
const RuntimeTerminalPane = lazy(() =>
  import('./terminal/runtime-terminal-pane').then((module) => ({
    default: module.RuntimeTerminalPane,
  }))
)
/*
 * #398 follow-up: the sidebar repository registry panel rides its own lazy
 * chunk exactly like the utility panes — the client budget the bundle check
 * enforces leaves no room for it in the Dev shell chunk.
 */
const RepoRegistryPanel = lazy(() =>
  import('./sidebar/repo-registry-panel').then((module) => ({
    default: module.RepoRegistryPanel,
  }))
)

function focusPaneElement(leafId: string) {
  requestAnimationFrame(() => {
    const target = [...document.querySelectorAll<HTMLElement>('[data-pane-id]')].find(
      (element) => element.dataset.paneId === leafId
    )
    target?.focus()
  })
}

/** Fixture-only stream used by headless owner-journey coverage. It models the
 * authenticated terminal contract, including one bounded reconnect, without
 * creating a PTY or claiming production runtime authority. */
function createFixtureTerminalConnect() {
  let attempts = 0
  return (handlers: {
    onFrame: (frame: DevStreamFrame) => void
    onClose: () => void
  }): TerminalStreamSocket => {
    const attempt = ++attempts
    let open = true
    const reconnectTimer = setTimeout(() => {
      if (attempt !== 1 || !open) return
      open = false
      handlers.onClose()
    }, 250)
    queueMicrotask(() => {
      if (!open) return
      handlers.onFrame({
        type: 'opened',
        protocol: 'terminal-bytes-v1',
        generation: 1,
        nextSequence: attempt === 1 ? '0' : '1',
      })
      handlers.onFrame({
        type: 'data',
        sequence: attempt === 1 ? '0' : '1',
        bytes: new TextEncoder().encode(
          attempt === 1
            ? 'fixture terminal connected\\r\\n$ '
            : 'fixture terminal reconnected\\r\\n$ '
        ),
      })
    })
    return {
      get open() {
        return open
      },
      bufferedAmount: 0,
      send: (_frame) => undefined,
      close: () => {
        if (!open) return
        open = false
        clearTimeout(reconnectTimer)
      },
    }
  }
}

function createFixtureTerminalObservations() {
  return (handler: (observation: ShellObservation) => void) => {
    queueMicrotask(() => {
      const at = new Date().toISOString()
      handler({ kind: 'preexec', command: 'printf fixture', at, sequence: '0' })
      handler({ kind: 'cwd', cwd: '/fixture/runtime', at })
      handler({ kind: 'precmd', exitCode: 0, at: new Date().toISOString(), sequence: '0' })
    })
    return () => undefined
  }
}

export function DevWorkspaceEntry(props: DevWorkspaceEntryProps) {
  let nextPaneId = 0
  const fixtureTerminalObservations = import.meta.env.DEV
    ? createFixtureTerminalObservations()
    : undefined
  const owner = useDevUtilityOwner()
  // #399: the file the central editor leaf shows. Open files are session-local
  // leaves in the split model — selecting a file focuses (or creates) the
  // editor leaf beside the active terminal; it never builds a tab forest.
  const [activeEditorFile, setActiveEditorFile] = createSignal<
    | {
        worktreeId: string
        generation: number
        rootIdentity: { device?: string; inode?: string; mtimeNs: string; size: string }
        relativePath: string
        identity: {
          device?: string
          inode?: string
          birthtimeNs?: string
          mtimeNs: string
          size: string
          contentSha256?: string
        }
      }
    | undefined
  >(undefined)
  const groups = owner.groups
  const setFixtureGroups = owner.replaceGroups
  const projection = owner.projection
  const projectionStatus = owner.projectionStatus
  const selectedProject = owner.selectedProject
  const selectedSession = owner.selectedSession
  const selectedSessionRecord = owner.selectedSessionRecord
  const selectedSessionWorktreeId = owner.selectedSessionWorktreeId
  const selectedProjectLabel = owner.selectedProjectLabel
  const focusMode = owner.focusMode
  const utilityPreferences = owner.utilityPreferences
  const layout = owner.layout
  const announcement = owner.announcement
  const setAnnouncement = owner.announce
  const capabilities = owner.capabilities
  const capabilityOf = owner.capabilityOf
  const capabilitySnapshotStatus = owner.capabilitySnapshotStatus
  const recoveryNotice = owner.recoveryNotice
  const setRecoveryNotice = owner.setRecoveryNotice
  const collapsedGroupIds = useWorkspaceState((state) => state.collapsedDevGroupIds)
  const collapsedProjectIds = useWorkspaceState((state) => state.collapsedDevProjectIds)
  const compactSidebarOpen = useWorkspaceState((state) => state.mobileSidebarOpen)
  const runtimeState = createMemo(() => props.runtime.state())
  const fixtureMode = owner.fixtureMode
  const activeScope = owner.activeScope
  const firstUnboundTerminalLeafId = createMemo(
    () =>
      listLeaves(layout().center).find(
        (leaf) => leaf.pane === 'terminal' && leaf.resourceId === undefined
      )?.id
  )
  const [archiveShelf, setArchiveShelf] = createSignal<ArchiveShelfState>(beginArchiveShelfLoad())
  const [archiveHandoff, setArchiveHandoff] = createSignal<string | undefined>()
  const recoveryMessage = () => recoveryNotice()
  const visiblePaneOf = (side: 'left' | 'right') => {
    if (props.appMode === 'source-control') {
      const item = utilityPreferences().find((entry) => entry.pane === 'source_control')
      return side === item?.side ? { ...item, visible: true, fullWidth: true } : undefined
    }
    return owner.visiblePaneOf(side)
  }
  const panesOfSide = owner.panesOfSide
  const updateLayout = owner.updateLayout
  const showPane = owner.showPane
  const collapseSide = owner.collapseSide
  const toggleUtilityGroup = owner.toggleUtilityGroup
  const setPaneFullWidth = owner.setPaneFullWidth
  const setPaneSize = owner.setPaneSize

  /** Projection, capability, selection, and V2 layout ownership live in the shell owner. */
  const loadProjection = async () => {
    if (fixtureMode()) return
    await owner.reloadProjection()
    if (projectionStatus() === 'ready') void loadArchivedSessions()
    else if (projectionStatus() === 'unavailable')
      setArchiveShelf(archiveShelfUnavailable('unavailable'))
  }

  onMount(() => {
    if (!props.groups) return
    setArchiveShelf(
      archiveShelfReady(
        props.groups.flatMap((group) =>
          group.projects.flatMap((project) =>
            project.sessions
              .filter((session) => session.state === 'archived')
              .map((session) => ({
                id: session.id,
                projectId: project.id,
                title: session.title,
                archivedAt: 'fixture',
              }))
          )
        )
      )
    )
  })

  createEffect(() => {
    if (!fixtureMode() && projectionStatus() === 'ready') void loadArchivedSessions()
  })

  /** #399: selecting a file opens or refocuses one editor leaf. */
  const openFileInEditorLeaf = (file: {
    worktreeId: string
    generation: number
    rootIdentity: { device?: string; inode?: string; mtimeNs: string; size: string }
    relativePath: string
    identity: {
      device?: string
      inode?: string
      birthtimeNs?: string
      mtimeNs: string
      size: string
      contentSha256?: string
    }
  }) => {
    setActiveEditorFile(file)
    const existing = listLeaves(layout().center).find((leaf) => leaf.pane === 'editor')
    if (existing) {
      updateLayout((state) => focusPane(state, existing.id))
      focusPaneElement(existing.id)
      return
    }
    const suffix = ++nextPaneId
    updateLayout((state) =>
      splitPane(state, state.focusedLeafId, {
        direction: 'row',
        placement: 'after',
        leaf: { kind: 'leaf', id: `dev-editor-${suffix}`, pane: 'editor' },
        splitId: `dev-split-${suffix}`,
      })
    )
    focusPaneElement(`dev-editor-${suffix}`)
  }
  /*
   * Accessible reordering. Keyboard moves and pointer drops funnel through
   * one pure model; in production the resulting order is sent to the runtime
   * (`dev.group.reorder` / `dev.project.reorder`) and the authoritative
   * projection is reloaded — a refused reorder is reverted, never kept.
   */
  const reorderVersionOf = (groupId: string) =>
    projection()?.groups.find((g) => g.id === groupId)?.version

  const executeReorder = async (
    operation: 'dev.group.reorder' | 'dev.project.reorder',
    body: Record<string, unknown>
  ): Promise<boolean> => {
    const scope = activeScope()
    if (!scope) return false
    const reply: DevReply = await props.runtime.execute(
      buildDevCommandFromMetadata(devWorkspaceReorderMetadata[operation], { scope, body })
    )
    if (!reply.ok) {
      setAnnouncement(`Reorder was refused: ${reply.error.message}`)
      await loadProjection()
      return false
    }
    await loadProjection()
    return true
  }

  const applyGroups = (next: readonly DevGroupFixture[]) => {
    // Fixture optimism and production projection overrides share the shell
    // owner's group state; completed runtime commands reload its projection.
    setFixtureGroups(next)
  }

  const moveGroupHandler = (id: string, direction: 'up' | 'down') => {
    const current = groups()
    const moved = Boolean(
      moveIdInOrder(
        current.map((group) => group.id),
        id,
        direction
      )
    )
    const next = reorderGroups(current, id, direction)
    applyGroups(next)
    const position = next.findIndex((group) => group.id === id) + 1
    const label = current.find((group) => group.id === id)?.name ?? id
    setAnnouncement(announcementForMove(label, position, next.length, moved))
    if (!moved || fixtureMode()) return
    void executeReorder('dev.group.reorder', { orderedGroupIds: next.map((group) => group.id) })
  }

  const dropGroupHandler = (id: string, targetId: string) => {
    const current = groups()
    const next = reorderGroupsRelativeTo(current, id, targetId)
    if (next === current) return
    applyGroups(next)
    const label = current.find((group) => group.id === id)?.name ?? id
    const position = next.findIndex((group) => group.id === id) + 1
    setAnnouncement(announcementForMove(label, position, next.length, true))
    if (fixtureMode()) return
    void executeReorder('dev.group.reorder', { orderedGroupIds: next.map((group) => group.id) })
  }

  const moveProjectHandler = (groupId: string, id: string, direction: 'up' | 'down') => {
    const current = groups()
    const group = current.find((candidate) => candidate.id === groupId)
    const next = reorderProjects(current, groupId, id, direction)
    applyGroups(next)
    const position =
      next.find((candidate) => candidate.id === groupId)?.projects.findIndex((p) => p.id === id) ??
      -1
    const label = group?.projects.find((project) => project.id === id)?.name ?? id
    const total = group?.projects.length ?? 0
    const moved = Boolean(
      group &&
      moveIdInOrder(
        group.projects.map((project) => project.id),
        id,
        direction
      )
    )
    if (position >= 0) setAnnouncement(announcementForMove(label, position + 1, total, moved))
    if (!moved || fixtureMode()) return
    const expectedGroupVersion = reorderVersionOf(groupId)
    if (expectedGroupVersion === undefined) {
      setAnnouncement(
        'Reorder needs the connected provider to expose group versions; nothing was changed on the runtime.'
      )
      return
    }
    void executeReorder('dev.project.reorder', {
      groupId,
      orderedProjectIds:
        next.find((candidate) => candidate.id === groupId)?.projects.map((project) => project.id) ??
        [],
      expectedGroupVersion,
    })
  }

  const dropProjectHandler = (groupId: string, id: string, targetId: string) => {
    const current = groups()
    const group = current.find((candidate) => candidate.id === groupId)
    const next = reorderProjectsRelativeTo(current, groupId, id, targetId)
    if (next === current) return
    applyGroups(next)
    const position =
      next.find((candidate) => candidate.id === groupId)?.projects.findIndex((p) => p.id === id) ??
      -1
    const label = group?.projects.find((project) => project.id === id)?.name ?? id
    if (position >= 0)
      setAnnouncement(announcementForMove(label, position + 1, group?.projects.length ?? 0, true))
    if (fixtureMode()) return
    const expectedGroupVersion = reorderVersionOf(groupId)
    if (expectedGroupVersion === undefined) {
      setAnnouncement(
        'Reorder needs the connected provider to expose group versions; nothing was changed on the runtime.'
      )
      return
    }
    void executeReorder('dev.project.reorder', {
      groupId,
      orderedProjectIds:
        next.find((candidate) => candidate.id === groupId)?.projects.map((project) => project.id) ??
        [],
      expectedGroupVersion,
    })
  }

  /*
   * Provider-backed archive shelf. Restore rides `dev.session.unarchive`;
   * the destructive delete commit reports the missing `dev.session.delete`
   * host contract instead of pretending to succeed.
   */
  const loadArchivedSessions = async () => {
    const scope = activeScope()
    if (!scope) {
      setArchiveShelf(archiveShelfUnavailable('channel_unauthenticated'))
      return
    }
    setArchiveShelf((current) => (current.status === 'ready' ? current : beginArchiveShelfLoad()))
    const reply = await props.runtime.execute(
      buildDevCommandFromMetadata(devOperationMetadataFor_dev_session_list, {
        scope,
        body: { archived: true },
      })
    )
    if (!reply.ok) {
      setArchiveShelf((current) =>
        archiveShelfError(
          reply.error.code,
          current.status === 'ready' ? current : beginArchiveShelfLoad()
        )
      )
      return
    }
    const sessions = (reply.value as { items: readonly Record<string, unknown>[] }).items
    setArchiveShelf(
      archiveShelfReady(
        sessions.map((raw) => ({
          id: String(raw.id),
          projectId: String(raw.projectId ?? ''),
          title: typeof raw.displayName === 'string' ? raw.displayName : String(raw.id),
          archivedAt: 'recently',
          ...(typeof raw.generation === 'number' ? { generation: raw.generation } : {}),
        }))
      )
    )
  }

  const restoreFromArchive = async (runtimeSessionId: string) => {
    setArchiveHandoff(undefined)
    if (props.groups !== undefined) {
      setArchiveShelf((current) => restoreCompleted(current, runtimeSessionId))
      setAnnouncement('Archived session restored (fixtures)')
      return
    }
    const scope = activeScope()
    if (!scope) return
    // The authoritative generation is carried by the archive list record; the
    // register binds archive transitions to it. Never send a wildcard/zero
    // generation because the host rejects stale resource bindings.
    const archived = archiveShelf().items.find((item) => item.id === runtimeSessionId)
    if (archived?.generation === undefined) {
      setArchiveHandoff(
        'Restore failed: the session generation is unavailable; refresh Archived sessions.'
      )
      return
    }
    const reply = await props.runtime.execute(
      buildDevCommandFromMetadata(devOperationMetadataFor_dev_session_get, {
        scope,
        body: { runtimeSessionId },
        resource: {
          kind: 'runtime_session',
          id: runtimeSessionId,
          generation: archived.generation,
        },
      })
    )
    if (!reply.ok) {
      setArchiveHandoff(`Restore failed: ${reply.error.message}`)
      return
    }
    const record = reply.value as { generation?: number }
    const unarchive = await props.runtime.execute(
      buildDevCommandFromMetadata(devOperationMetadataFor_dev_session_unarchive, {
        scope,
        body: { runtimeSessionId, expectedGeneration: record.generation ?? 1 },
        resource: {
          kind: 'runtime_session',
          id: runtimeSessionId,
          generation: record.generation ?? 1,
        },
      })
    )
    if (!unarchive.ok) {
      setArchiveHandoff(`Restore failed: ${unarchive.error.message}`)
      return
    }
    setArchiveShelf((current) => restoreCompleted(current, runtimeSessionId))
    setAnnouncement('Archived session restored')
    await loadProjection()
  }

  const requestArchiveDelete = (runtimeSessionId: string) => {
    setArchiveShelf((current) => requestDelete(current, runtimeSessionId))
  }
  const cancelArchiveDelete = () => {
    setArchiveShelf((current) => cancelPendingDelete(current))
  }
  const confirmArchiveDelete = () => {
    const commit = confirmPendingDelete(archiveShelf())
    setArchiveShelf(commit.state)
    if (!commit.commitId) return
    // The destructive delete commit is an explicit handoff: the M12 registry
    // has no dev.session.delete operation, so nothing is invented here.
    setArchiveHandoff(
      `Deleting sessions needs the ${SESSION_DELETE_OPERATION} host contract, which this build does not provide. The session stays archived and recoverable.`
    )
  }

  onMount(() => {
    const controller = createDevKeyboardController({
      target: window,
      actions: {
        toggleFocusMode: () => {
          const next = !focusMode()
          owner.setFocusMode(next)
          setAnnouncement(next ? 'Focus mode enabled' : 'Focus mode disabled')
        },
        moveFocusedPane: ({ step, direction }) => {
          const state = layout()
          const neighbor = neighborLeaf(state, state.focusedLeafId, step)
          if (!neighbor) {
            setAnnouncement('No adjacent pane to move into')
            return
          }
          const suffix = ++nextPaneId
          updateLayout((current) =>
            movePane(
              current,
              current.focusedLeafId,
              neighbor.id,
              step === 1 ? 'after' : 'before',
              direction,
              `dev-move-${suffix}`
            )
          )
          focusPaneElement(state.focusedLeafId)
          setAnnouncement('Pane moved')
        },
      },
    })
    onCleanup(() => controller.dispose())
  })

  const leftFullWidth = () => visiblePaneOf('left')?.fullWidth ?? false

  const leftUtilityToggleControl = () => {
    const open = () => Boolean(visiblePaneOf('left'))
    return (
      <ActionButton
        type="button"
        variant="outline"
        size="icon-sm"
        class="workspace-topbar__control"
        tooltip={open() ? 'Collapse left utility sidebar' : 'Expand left utility sidebar'}
        aria-label={open() ? 'Collapse left utility sidebar' : 'Expand left utility sidebar'}
        aria-expanded={open()}
        onClick={() => toggleUtilityGroup(['files', 'source_control'])}
      >
        <FolderTree aria-hidden="true" />
      </ActionButton>
    )
  }

  const devPaneActions = () => (
    <Show when={props.appMode !== 'source-control'}>
      {leftUtilityToggleControl()}
      <ActionButton
        type="button"
        variant="ghost"
        size="icon-sm"
        class="workspace-topbar__control"
        tooltip="Split pane"
        aria-label="Split pane"
        disabled={countLeaves(layout().center) >= 8}
        onClick={() => {
          const suffix = ++nextPaneId
          updateLayout((state) => {
            const focused = listLeaves(state.center).find((leaf) => leaf.id === state.focusedLeafId)
            if (!focused) return state
            return splitPane(state, state.focusedLeafId, {
              direction: 'row',
              placement: 'after',
              leaf: {
                kind: 'leaf',
                id: `dev-pane-${suffix}`,
                pane: focused.pane,
                ...(focused.pane === 'editor' && focused.resourceId !== undefined
                  ? { resourceId: focused.resourceId }
                  : {}),
              },
              splitId: `dev-split-${suffix}`,
            })
          })
        }}
      >
        <Columns2 aria-hidden="true" />
      </ActionButton>
      <ActionButton
        type="button"
        variant="ghost"
        size="icon-sm"
        class="workspace-topbar__control"
        tooltip="Reopen the last closed pane in this window"
        aria-label="Reopen closed pane"
        disabled={layout().closed.length === 0}
        onClick={() => updateLayout(undoClosePane)}
      >
        <Undo2 aria-hidden="true" />
      </ActionButton>
    </Show>
  )

  return (
    <main
      class={cn('dev-workspace', {
        'dev-workspace--source-control-app': props.appMode === 'source-control',
        'dev-workspace--focus': focusMode() && props.appMode !== 'source-control',
        'dev-workspace--left-full': leftFullWidth(),
      })}
    >
      <a class="dev-skip-link" href="#dev-center">
        Skip to workspace
      </a>
      <Show
        when={props.toolbarMount}
        fallback={
          <header class="dev-toolbar">
            <div
              class="dev-toolbar__actions"
              role="toolbar"
              aria-label="Developer workspace actions"
            >
              {devPaneActions()}
            </div>
          </header>
        }
      >
        {(mount) => <Portal mount={mount()}>{devPaneActions()}</Portal>}
      </Show>
      <Show when={recoveryMessage()}>
        <p class="dev-recovery-banner" role="status">
          {recoveryMessage()}
        </p>
      </Show>

      <div class="dev-workspace__body">
        <DevSidebarShell
          groups={groups()}
          selectedProject={selectedProject()}
          selectedSession={selectedSession()}
          collapsedGroups={new Set(collapsedGroupIds())}
          collapsedProjects={new Set(collapsedProjectIds())}
          compactOpen={compactSidebarOpen()}
          reorder={{
            onMoveGroup: moveGroupHandler,
            onMoveProject: moveProjectHandler,
            onDropGroup: dropGroupHandler,
            onDropProject: dropProjectHandler,
          }}
          archiveShelf={archiveShelf()}
          archiveHandoffMessage={archiveHandoff()}
          addProject={
            !fixtureMode() && activeScope() ? (
              <AddProjectPanel
                scope={activeScope()!}
                execute={(command) => props.runtime.execute(command)}
                knownProjectNames={groups().flatMap((group) =>
                  group.projects.map((project) => project.name)
                )}
                onImported={() => void loadProjection()}
                announce={setAnnouncement}
              />
            ) : undefined
          }
          repoRegistry={
            !fixtureMode() && activeScope() ? (
              <Suspense fallback={<p class="dev-tree-empty">Loading repositories…</p>}>
                <RepoRegistryPanel
                  scope={activeScope()!}
                  execute={(command) => props.runtime.execute(command)}
                  announce={setAnnouncement}
                />
              </Suspense>
            ) : undefined
          }
          onArchiveRestore={(id) => void restoreFromArchive(id)}
          onArchiveRequestDelete={requestArchiveDelete}
          onArchiveCancelDelete={cancelArchiveDelete}
          onArchiveConfirmDelete={confirmArchiveDelete}
          onProjectSelect={(id) => {
            setRecoveryNotice('')
            workspaceStore.getState().setSelectedDevProjectId(id)
          }}
          onSessionSelect={(projectId, sessionId) => {
            setRecoveryNotice('')
            const store = workspaceStore.getState()
            if (store.selectedDevProjectId !== projectId) store.setSelectedDevProjectId(projectId)
            workspaceStore.getState().setSelectedRuntimeSessionId(sessionId)
          }}
          onToggleGroup={(id) => workspaceStore.getState().toggleDevGroupCollapsed(id)}
          onToggleProject={(id) => workspaceStore.getState().toggleDevProjectCollapsed(id)}
        />

        <Show when={visiblePaneOf('left')}>
          <UtilitySlot
            fixedPane={props.appMode === 'source-control'}
            panes={
              props.appMode === 'source-control'
                ? panesOfSide('left').filter((item) => item.pane === 'source_control')
                : panesOfSide('left')
            }
            visiblePane={visiblePaneOf('left')}
            runtime={props.runtime}
            runtimeSessionId={selectedSession() || undefined}
            sessionWorktreeId={selectedSessionWorktreeId()}
            capabilityOf={capabilityOf}
            onShow={showPane}
            onCollapse={() => collapseSide('left')}
            onToggleFullWidth={setPaneFullWidth}
            onResize={setPaneSize}
            onOpenFile={openFileInEditorLeaf}
          />
        </Show>
        <section
          class="dev-center"
          id="dev-center"
          aria-label="Developer workspace panes"
          tabIndex={-1}
        >
          <Suspense fallback={<p class="dev-pane-state__line">Loading workspace panes…</p>}>
            <DevLayoutView
              state={layout()}
              unavailable={runtimeState().status === 'unavailable'}
              renderTerminalLeaf={(leaf) => {
                if (import.meta.env.DEV && FixtureTerminalPane && fixtureMode())
                  return (
                    <Suspense fallback={<p class="dev-pane-state__line">Loading test terminal…</p>}>
                      <FixtureTerminalPane
                        connect={createFixtureTerminalConnect()}
                        fromSequence="0"
                        subscribeToObservations={fixtureTerminalObservations}
                        write={() => true}
                        worktreeLabel="Example project"
                      />
                    </Suspense>
                  )

                const scope = activeScope()
                const runtimeSessionId = selectedSession()
                const worktreeId = selectedSessionWorktreeId()
                if (!scope)
                  return (
                    <p class="dev-pane-state__line" role="status" data-state="unavailable">
                      Terminal access requires an authenticated runtime scope.
                    </p>
                  )
                if (!runtimeSessionId)
                  return (
                    <p class="dev-pane-state__line" role="status" data-state="unavailable">
                      No live runtime session is selected.
                    </p>
                  )
                if (!worktreeId)
                  return (
                    <p class="dev-pane-state__line" role="status" data-state="unavailable">
                      The selected session has no worktree binding.
                    </p>
                  )

                const terminalId =
                  leaf.resourceId !== undefined
                    ? leaf.resourceId
                    : firstUnboundTerminalLeafId() === leaf.id
                      ? selectedSessionRecord()?.terminalId
                      : undefined

                return (
                  <Suspense fallback={<p class="dev-pane-state__line">Loading terminal…</p>}>
                    <RuntimeTerminalPane
                      runtime={props.runtime}
                      scope={scope}
                      runtimeSessionId={runtimeSessionId}
                      worktreeId={worktreeId}
                      terminalId={terminalId}
                      worktreeLabel={selectedProjectLabel()}
                      capabilityStatus={capabilitySnapshotStatus()}
                      canAttach={capabilities().get('dev.terminal.attach')?.granted}
                      canInput={capabilities().get('dev.terminal.input')?.granted}
                      canManage={capabilities().get('dev.terminal.manage')?.granted}
                    />
                  </Suspense>
                )
              }}
              renderEditorLeaf={() => {
                const file = activeEditorFile()
                if (!file) return undefined
                const scope = activeScope()
                if (!scope) return undefined
                return (
                  <Suspense fallback={<p class="dev-pane-state__line">Loading editor…</p>}>
                    <CodeEditor
                      runtime={props.runtime}
                      worktree={{
                        worktreeId: file.worktreeId,
                        generation: file.generation,
                        rootIdentity: file.rootIdentity,
                      }}
                      relativePath={file.relativePath}
                      identity={file.identity}
                      onClose={() => setActiveEditorFile(undefined)}
                    />
                  </Suspense>
                )
              }}
              onClose={(leafId) => {
                let nextFocusId = layout().focusedLeafId
                updateLayout((state) => {
                  const next = closePane(state, leafId, () => `dev-placeholder-${++nextPaneId}`)
                  nextFocusId = next.focusedLeafId
                  return next
                })
                focusPaneElement(nextFocusId)
                return nextFocusId
              }}
              onFocus={(leafId) => updateLayout((state) => focusPane(state, leafId))}
              onResize={(splitId, ratio) =>
                updateLayout((state) => resizeSplit(state, splitId, Math.round(ratio * 20) / 20))
              }
              onMoveTo={(leafId, targetLeafId, placement, direction) => {
                const suffix = ++nextPaneId
                updateLayout((state) =>
                  movePane(state, leafId, targetLeafId, placement, direction, `dev-move-${suffix}`)
                )
                focusPaneElement(leafId)
                setAnnouncement('Pane moved')
              }}
            />
          </Suspense>
        </section>

      </div>
      <p class="sr-only" aria-live="polite">
        {announcement()}
      </p>
    </main>
  )
}

function UtilityResizeHandle(props: { size: number; onResize(size: number): void }) {
  const max = utilitySizeSteps[utilitySizeSteps.length - 1]
  const sizeRatio = () => props.size / max
  const resizedSize = (sizes: readonly number[]) => Math.round((sizes[0] ?? 0) * max)

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      sizes={[sizeRatio(), 1 - sizeRatio()]}
      keyboardDelta="48px"
      class="dev-utility-splitter dev-utility-splitter--left"
      onSizesChange={(sizes) => {
        const nextSize = snapUtilitySize(resizedSize(sizes))
        if (nextSize !== props.size) props.onResize(nextSize)
      }}
    >
      <ResizablePanel minSize={utilitySizeSteps[0] / max} maxSize={1} aria-hidden="true" />
      <ResizableHandle
        withHandle
        label="Resize left utility pane"
        aria-controls="dev-utility-panel-left"
        aria-valuemin={utilitySizeSteps[0]}
        aria-valuemax={max}
        aria-valuenow={props.size}
        class="dev-utility-splitter__handle"
      />
      <ResizablePanel minSize={0} maxSize={1} aria-hidden="true" />
    </ResizablePanelGroup>
  )
}

/**
 * Truthful per-pane provider state: real panes mount where a provider
 * contract exists (browser/devices); panes whose UI surface is owned by
 * another slice name their capability and its exact state — never a generic
 * placeholder.
 */
function PaneProviderState(props: {
  title: string
  capability: DevCapability
  state?: { granted: boolean; reason?: string }
}) {
  return (
    <div class="dev-pane-state">
      <p class="dev-pane-state__line">
        <Show
          when={props.state}
          fallback={`Requires ${props.capability}, which has not been reported by this provider yet.`}
        >
          <Show
            when={props.state!.granted}
            fallback={`${props.title} requires ${props.capability}, which is unavailable${
              props.state!.reason ? ` (${props.state!.reason})` : ''
            }.`}
          >
            {`${props.title} is connected through ${props.capability}. This pane's interactive surface is delivered by its owning provider slice.`}
          </Show>
        </Show>
      </p>
    </div>
  )
}

function UtilitySlot(props: {
  fixedPane?: boolean
  panes: readonly DevUtilityPreference[]
  visiblePane: DevUtilityPreference | undefined
  runtime: DevRuntimeService
  runtimeSessionId: string | undefined
  /**
   * The selected session's own worktree, so the Files and Source Control
   * panes act on the worktree the session belongs to rather than the first
   * ready one on the node.
   */
  sessionWorktreeId: string | undefined
  capabilityOf(pane: DevUtilityPane): { granted: boolean; reason?: string } | undefined
  onShow(pane: DevUtilityPane): void
  onOpenFile(file: {
    worktreeId: string
    generation: number
    rootIdentity: { device?: string; inode?: string; mtimeNs: string; size: string }
    relativePath: string
    identity: {
      device?: string
      inode?: string
      birthtimeNs?: string
      mtimeNs: string
      size: string
      contentSha256?: string
    }
  }): void
  onCollapse(): void
  onToggleFullWidth(pane: DevUtilityPane, fullWidth: boolean): void
  onResize(pane: DevUtilityPane, size: number): void
}) {
  const visibleItem = () =>
    props.visiblePane ? utilityItemByPane.get(props.visiblePane.pane) : undefined
  const resizablePane = () => {
    const pane = props.visiblePane
    return pane && !pane.fullWidth ? pane : undefined
  }
  const runtimeReady = () => props.runtime.state().status === 'ready'
  const isFileSourceControlSlot = () =>
    props.panes.some((item) => item.pane === 'files') &&
    props.panes.some((item) => item.pane === 'source_control')
  const paneBody = (pane: DevUtilityPane) => {
    if (pane === 'files') {
      return runtimeReady() ? (
        <FilesPane
          runtime={props.runtime}
          worktreeId={props.sessionWorktreeId}
          onOpenFile={props.onOpenFile}
        />
      ) : (
        <PaneProviderState
          title="Files"
          capability={PANE_CAPABILITY[pane]}
          state={props.capabilityOf(pane)}
        />
      )
    }
    if (pane === 'source_control') {
      return runtimeReady() ? (
        <SourceControlPane
          runtime={props.runtime}
          runtimeSessionId={props.runtimeSessionId}
          worktreeId={props.sessionWorktreeId}
        />
      ) : (
        <PaneProviderState
          title="Source Control"
          capability={PANE_CAPABILITY[pane]}
          state={props.capabilityOf(pane)}
        />
      )
    }
    return null
  }
  return (
    <aside
      class={cn('dev-utility dev-utility--left', {
        'dev-utility--open': Boolean(props.visiblePane),
        'dev-utility--size-240': props.visiblePane?.size === 240,
        'dev-utility--size-336': props.visiblePane?.size === 336,
        'dev-utility--size-384': props.visiblePane?.size === 384,
      })}
      id="dev-utility-left"
      aria-label="Developer utilities (left)"
    >
      <section
        id="dev-utility-panel-left"
        aria-labelledby="dev-utility-heading-left"
        class="dev-utility-panel"
      >
        <div class="dev-utility-panel__heading">
          <h2 id="dev-utility-heading-left">{visibleItem()?.title}</h2>
          <Show when={!props.fixedPane}>
            <ActionButton
              type="button"
              variant="ghost"
              size="icon-sm"
              tooltip={
                props.visiblePane?.fullWidth ? 'Restore utility pane' : 'Expand utility pane'
              }
              aria-label={
                props.visiblePane?.fullWidth ? 'Restore utility pane' : 'Expand utility pane'
              }
              aria-pressed={props.visiblePane?.fullWidth ?? false}
              onClick={() =>
                props.onToggleFullWidth(props.visiblePane!.pane, !props.visiblePane!.fullWidth)
              }
            >
              <Maximize2 aria-hidden="true" />
            </ActionButton>
            <ActionButton
              type="button"
              variant="ghost"
              size="icon-sm"
              tooltip="Collapse left utility slot"
              aria-label="Collapse left utility slot"
              onClick={props.onCollapse}
            >
              <X aria-hidden="true" />
            </ActionButton>
          </Show>
        </div>
        <div class="dev-utility-panel__content">
          <Suspense fallback={<p class="dev-pane-state__line">Loading pane…</p>}>
            {paneBody(props.visiblePane!.pane)}
          </Suspense>
        </div>
        <Show when={isFileSourceControlSlot() && !props.fixedPane}>
          <ButtonGroup
            class="dev-utility__file-source-selector w-full"
            label="Files and Source Control"
          >
            <Button
              type="button"
              variant={props.visiblePane?.pane === 'files' ? 'secondary' : 'outline'}
              size="sm"
              aria-label="Files"
              aria-pressed={props.visiblePane?.pane === 'files'}
              onClick={() => props.onShow('files')}
            >
              <FolderTree aria-hidden="true" />
              <span class="dev-utility__selector-label">Files</span>
            </Button>
            <Button
              type="button"
              variant={props.visiblePane?.pane === 'source_control' ? 'secondary' : 'outline'}
              size="sm"
              aria-label="Source control"
              aria-pressed={props.visiblePane?.pane === 'source_control'}
              onClick={() => props.onShow('source_control')}
            >
              <GitBranch aria-hidden="true" />
              <span class="dev-utility__selector-label">Source control</span>
            </Button>
          </ButtonGroup>
        </Show>
      </section>
      <Show when={Boolean(resizablePane())}>
        <UtilityResizeHandle
          side={props.side}
          size={resizablePane()?.size ?? defaultUtilitySize}
          onResize={(size) => {
            const pane = resizablePane()
            if (pane) props.onResize(pane.pane, size)
          }}
        />
      </Show>
    </aside>
  )
}
