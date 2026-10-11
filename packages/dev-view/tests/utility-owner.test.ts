import { describe, expect, test } from 'bun:test'
import { createRoot, createSignal } from 'solid-js'

import {
  createDevUtilityOwnerModel,
  type DevUtilityOwnerModel,
} from '../src/utility/owner'
import { defaultUtilityPreferences } from '../src/utility/definitions'
import { createLayoutState } from '../src/layout/operations'
import { layoutStorageKeyV2, serializeLayoutPreferencesV2 } from '../src/layout/persistence'
import type { LayoutStorage } from '../src/layout/storage'
import type { DevRuntimeService, DevWorkspaceProjection } from '../src/platform'
import type {
  CapabilitySnapshot,
  DevCapability,
  DevLayoutPreferencesV2,
  PaneLeaf,
  Scope,
} from '@adea-ai/types/dev-runtime'

const now = () => new Date().toISOString()

const scope = (workspaceId: string): Scope => ({
  accountId: 'account-1',
  workspaceId,
  runtimeNodeId: 'node-1',
})

function projection(
  projectId: string,
  sessionId: string,
  worktreeId: string
): DevWorkspaceProjection {
  return {
    observedAt: now(),
    groups: [
      {
        id: `group-${projectId}`,
        name: 'Project group',
        projects: [
          {
            id: projectId,
            name: projectId,
            repository: 'adea/adea',
            branch: 'main',
            sessions: [
              {
                id: sessionId,
                title: sessionId,
                worktreeId,
                state: 'active',
                generation: 1,
              },
            ],
          },
        ],
      },
    ],
  }
}

function layoutDocument(
  runtimeScope: Scope,
  projectId: string,
  runtimeSessionId: string,
  pane: 'browser' | 'devices' | 'history',
  size: number
): DevLayoutPreferencesV2 {
  const utility = defaultUtilityPreferences().map((item) => ({
    ...item,
    visible: item.pane === pane,
    ...(item.pane === pane ? { size, lastNonzeroSize: size } : {}),
  }))
  return {
    schemaVersion: 2,
    scope: runtimeScope,
    projectId,
    runtimeSessionId,
    center: createLayoutState<PaneLeaf>({ kind: 'leaf', id: 'dev-terminal', pane: 'terminal' })
      .center,
    utility,
    focusMode: false,
  }
}

function memoryStorage(): LayoutStorage & { entries(): ReadonlyMap<string, string> } {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    entries: () => values,
  }
}

function runtimeService(
  preferenceScope: () => Scope | undefined,
  projectionFor: DevRuntimeService['projection'],
  capabilitySnapshot: DevRuntimeService['capabilitySnapshot']
): DevRuntimeService {
  return {
    state: () => ({ status: 'ready' }),
    preferenceScope,
    projection: projectionFor,
    capabilitySnapshot,
    execute: async () => {
      throw new Error('execute is outside this owner test')
    },
  }
}

function ownerHarness(options: {
  runtime: () => DevRuntimeService
  storage: LayoutStorage
  workspaceId?: () => string | undefined
  selectedProjectId: () => string | undefined
  setSelectedProjectId(id: string): void
  selectedRuntimeSessionId: () => string | undefined
  setSelectedRuntimeSessionId(id: string): void
}) {
  let owner!: DevUtilityOwnerModel
  const dispose = createRoot((disposeRoot) => {
    owner = createDevUtilityOwnerModel({
      runtime: options.runtime,
      workspaceId: options.workspaceId,
      storage: () => options.storage,
      selectedProjectId: options.selectedProjectId,
      setSelectedProjectId: options.setSelectedProjectId,
      selectedRuntimeSessionId: options.selectedRuntimeSessionId,
      setSelectedRuntimeSessionId: options.setSelectedRuntimeSessionId,
      focusMode: () => false,
      setFocusMode: () => undefined,
    })
    return disposeRoot
  })
  return { dispose, owner }
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 40 && !check(); attempt += 1)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(check()).toBe(true)
}

function capabilitySnapshot(runtimeScope: Scope, granted: readonly DevCapability[]): CapabilitySnapshot {
  return {
    scope: runtimeScope,
    granted,
    unavailable: [],
    channelGeneration: 1,
    observedAt: now(),
  }
}

describe('shell-lifetime Dev utility owner', () => {
  test('keeps the selected RuntimeSession worktree and V2 preferences bound to one scope', async () => {
    const runtimeScope = scope('workspace-1')
    const store = memoryStorage()
    const saved = layoutDocument(runtimeScope, 'project-1', 'session-1', 'history', 384)
    store.setItem(
      layoutStorageKeyV2(runtimeScope, 'project-1', 'session-1'),
      serializeLayoutPreferencesV2(saved)
    )
    const [selectedProjectId, setSelectedProjectId] = createSignal<string | undefined>('project-1')
    const [selectedRuntimeSessionId, setSelectedRuntimeSessionId] = createSignal<string | undefined>(
      'session-1'
    )
    const service = runtimeService(
      () => runtimeScope,
      async () => projection('project-1', 'session-1', 'worktree-1'),
      async (requestedScope) => capabilitySnapshot(requestedScope, ['dev.browser.read'])
    )
    const { owner, dispose } = ownerHarness({
      runtime: () => service,
      storage: store,
      selectedProjectId,
      setSelectedProjectId,
      selectedRuntimeSessionId,
      setSelectedRuntimeSessionId,
    })

    try {
      await waitFor(() => owner.projectionStatus() === 'ready' && owner.preferencesReady())

      expect(owner.selectedSession()).toBe('session-1')
      expect(owner.selectedSessionWorktreeId()).toBe('worktree-1')
      expect(owner.visiblePaneOf('right')?.pane).toBe('history')
      expect(owner.visiblePaneOf('right')?.size).toBe(384)
      expect(owner.capabilityOf('browser')?.granted).toBe(true)

      owner.toggleRightUtilitySlot()
      expect(owner.visiblePaneOf('right')).toBeUndefined()
      owner.toggleRightUtilitySlot()
      expect(owner.visiblePaneOf('right')?.pane).toBe('history')
    } finally {
      dispose()
    }
  })

  test('hides stale workspace selection until the provider scope changes, then loads that workspace V2 record', async () => {
    const [runtimeScope, setRuntimeScope] = createSignal<Scope | undefined>(scope('workspace-old'))
    const [workspaceId, setWorkspaceId] = createSignal<string | undefined>('workspace-old')
    const [selectedProjectId, setSelectedProjectId] = createSignal<string | undefined>('project-1')
    const [selectedRuntimeSessionId, setSelectedRuntimeSessionId] = createSignal<
      string | undefined
    >('session-1')
    const store = memoryStorage()
    const oldScope = scope('workspace-old')
    const newScope = scope('workspace-new')
    store.setItem(
      layoutStorageKeyV2(oldScope, 'project-1', 'session-1'),
      serializeLayoutPreferencesV2(
        layoutDocument(oldScope, 'project-1', 'session-1', 'history', 384)
      )
    )
    store.setItem(
      layoutStorageKeyV2(newScope, 'project-1', 'session-1'),
      serializeLayoutPreferencesV2(
        layoutDocument(newScope, 'project-1', 'session-1', 'devices', 240)
      )
    )
    const service = runtimeService(
      runtimeScope,
      async (requestedScope) =>
        projection('project-1', 'session-1', `worktree-${requestedScope.workspaceId}`),
      async (requestedScope) => capabilitySnapshot(requestedScope, ['dev.device.read'])
    )
    const { owner, dispose } = ownerHarness({
      runtime: () => service,
      storage: store,
      workspaceId,
      selectedProjectId,
      setSelectedProjectId,
      selectedRuntimeSessionId,
      setSelectedRuntimeSessionId,
    })

    try {
      await waitFor(() => owner.projectionStatus() === 'ready' && owner.preferencesReady())
      expect(owner.activeScope()?.workspaceId).toBe('workspace-old')
      expect(owner.selectedSessionWorktreeId()).toBe('worktree-workspace-old')
      expect(owner.visiblePaneOf('right')?.pane).toBe('history')

      setWorkspaceId('workspace-new')
      await waitFor(() => owner.projectionStatus() === 'unavailable')
      expect(owner.activeScope()).toBeUndefined()
      expect(owner.selectedSession()).toBe('')
      expect(owner.selectedSessionWorktreeId()).toBeUndefined()

      setRuntimeScope(newScope)
      await waitFor(() => owner.activeScope()?.workspaceId === 'workspace-new')
      await waitFor(() => owner.projectionStatus() === 'ready' && owner.preferencesReady())
      expect(owner.selectedSessionWorktreeId()).toBe('worktree-workspace-new')
      expect(owner.visiblePaneOf('right')?.pane).toBe('devices')
      expect(owner.visiblePaneOf('right')?.size).toBe(240)
    } finally {
      dispose()
    }
  })

  test('clears old selection while a new scope loads and ignores stale projection and capability replies', async () => {
    const [currentScope, setCurrentScope] = createSignal<Scope | undefined>(scope('workspace-old'))
    const [selectedProjectId, setSelectedProjectId] = createSignal<string | undefined>('project-old')
    const [selectedRuntimeSessionId, setSelectedRuntimeSessionId] = createSignal<string | undefined>(
      'session-old'
    )
    const store = memoryStorage()
    const newScope = scope('workspace-new')
    store.setItem(
      layoutStorageKeyV2(newScope, 'project-new', 'session-new'),
      serializeLayoutPreferencesV2(
        layoutDocument(newScope, 'project-new', 'session-new', 'devices', 240)
      )
    )
    let releaseOldProjection!: (value: DevWorkspaceProjection) => void
    let releaseOldCapabilities!: (value: CapabilitySnapshot) => void
    let oldRequests = 0
    let oldCapabilityRequests = 0
    const oldProjection = new Promise<DevWorkspaceProjection>((resolve) => {
      releaseOldProjection = resolve
    })
    const oldCapabilities = new Promise<CapabilitySnapshot>((resolve) => {
      releaseOldCapabilities = resolve
    })
    const service = runtimeService(
      currentScope,
      async (requestedScope) => {
        if (requestedScope.workspaceId === 'workspace-old') oldRequests += 1
        return requestedScope.workspaceId === 'workspace-old'
          ? oldProjection
          : projection('project-new', 'session-new', 'worktree-new')
      },
      async (requestedScope) => {
        if (requestedScope.workspaceId === 'workspace-old') {
          oldCapabilityRequests += 1
          return oldCapabilities
        }
        return capabilitySnapshot(requestedScope, ['dev.browser.read'])
      }
    )
    const { owner, dispose } = ownerHarness({
      runtime: () => service,
      storage: store,
      selectedProjectId,
      setSelectedProjectId,
      selectedRuntimeSessionId,
      setSelectedRuntimeSessionId,
    })

    try {
      await waitFor(() => oldRequests === 1 && oldCapabilityRequests === 1)
      setCurrentScope(scope('workspace-new'))
      setSelectedProjectId('project-new')
      setSelectedRuntimeSessionId('session-new')

      await waitFor(() => owner.selectedSession() === 'session-new')
      await waitFor(() => owner.preferencesReady())
      expect(owner.selectedSessionWorktreeId()).toBe('worktree-new')
      expect(owner.visiblePaneOf('right')?.pane).toBe('devices')
      expect(owner.visiblePaneOf('right')?.size).toBe(240)

      releaseOldProjection(
        projection('project-old', 'session-old', 'worktree-old')
      )
      releaseOldCapabilities(capabilitySnapshot(scope('workspace-old'), []))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      expect(owner.selectedSession()).toBe('session-new')
      expect(owner.selectedSessionWorktreeId()).toBe('worktree-new')
      expect(owner.capabilityOf('browser')?.granted).toBe(true)
    } finally {
      dispose()
    }
  })

  test('an explicit but unresolved workspace gate clears selection and fences late replies', async () => {
    const oldScope = scope('workspace-old')
    const [runtimeScope, setRuntimeScope] = createSignal<Scope | undefined>(oldScope)
    const [workspaceId, setWorkspaceId] = createSignal<string | undefined>('workspace-old')
    const [selectedProjectId, setSelectedProjectId] = createSignal<string | undefined>('project-old')
    const [selectedRuntimeSessionId, setSelectedRuntimeSessionId] = createSignal<string | undefined>(
      'session-old'
    )
    const store = memoryStorage()
    let releaseProjection!: (value: DevWorkspaceProjection) => void
    let releaseCapabilities!: (value: CapabilitySnapshot) => void
    let projectionRequests = 0
    let capabilityRequests = 0
    const heldProjection = new Promise<DevWorkspaceProjection>((resolve) => {
      releaseProjection = resolve
    })
    const heldCapabilities = new Promise<CapabilitySnapshot>((resolve) => {
      releaseCapabilities = resolve
    })
    const service = runtimeService(
      runtimeScope,
      async () => {
        projectionRequests += 1
        return heldProjection
      },
      async () => {
        capabilityRequests += 1
        return heldCapabilities
      }
    )
    const { owner, dispose } = ownerHarness({
      runtime: () => service,
      storage: store,
      workspaceId,
      selectedProjectId,
      setSelectedProjectId,
      selectedRuntimeSessionId,
      setSelectedRuntimeSessionId,
    })

    try {
      await waitFor(() => projectionRequests === 1 && capabilityRequests === 1)
      setWorkspaceId(undefined)
      await waitFor(
        () => owner.activeScope() === undefined && owner.projectionStatus() === 'unavailable'
      )
      expect(owner.selectedSession()).toBe('')
      expect(owner.selectedSessionWorktreeId()).toBeUndefined()
      expect(owner.capabilityOf('browser')).toBeUndefined()

      releaseProjection(projection('project-old', 'session-old', 'worktree-old'))
      releaseCapabilities(capabilitySnapshot(oldScope, ['dev.browser.read']))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      expect(owner.activeScope()).toBeUndefined()
      expect(owner.selectedSession()).toBe('')
      expect(owner.selectedSessionWorktreeId()).toBeUndefined()
      expect(owner.capabilityOf('browser')).toBeUndefined()
      expect(store.entries().size).toBe(0)
    } finally {
      dispose()
    }
  })

  test('shows no selected session or persisted scope when the provider has no authenticated scope', async () => {
    const store = memoryStorage()
    const [selectedProjectId, setSelectedProjectId] = createSignal<string | undefined>('project-old')
    const [selectedRuntimeSessionId, setSelectedRuntimeSessionId] = createSignal<string | undefined>(
      'session-old'
    )
    const service = runtimeService(
      () => undefined,
        async () => projection('project-old', 'session-old', 'worktree-old'),
      async (requestedScope) => capabilitySnapshot(requestedScope, [])
    )
    const { owner, dispose } = ownerHarness({
      runtime: () => service,
      storage: store,
      selectedProjectId,
      setSelectedProjectId,
      selectedRuntimeSessionId,
      setSelectedRuntimeSessionId,
    })

    try {
      await waitFor(() => owner.projectionStatus() === 'unavailable')
      expect(owner.selectedSession()).toBe('')
      expect(owner.selectedSessionWorktreeId()).toBeUndefined()

      owner.showPane('browser')
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(store.entries().size).toBe(0)
    } finally {
      dispose()
    }
  })
})
