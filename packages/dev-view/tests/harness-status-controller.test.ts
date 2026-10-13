// Agents-pane harness reads and actions (#400), without a DOM: a scan happens
// only when the user rescans, a failed read is a local message with a retry,
// and a workspace default whose installation vanished stays visible and
// clearable.
import { describe, expect, test } from 'bun:test'
import { createRoot } from 'solid-js'

import type {
  DevCommand,
  DevReply,
  HarnessPreference,
  RuntimeConnectionInventoryEntry,
  Scope,
} from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService } from '../src/platform'
import type { DevUtilityContext } from '../src/utility-context'
import { createHarnessStatusController } from '../src/agents/harness-status-controller'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

function entry(overrides: Partial<RuntimeConnectionInventoryEntry> = {}) {
  return {
    id: 'inst-codex',
    scope: SCOPE,
    family: 'codex',
    displayName: 'Codex',
    version: '1.2.3',
    auth: 'ready',
    health: 'healthy',
    capabilities: ['native'],
    eligibility: { eligible: true, blockers: [] },
    ...overrides,
  } as unknown as RuntimeConnectionInventoryEntry
}

function preference(overrides: Partial<HarnessPreference> = {}): HarnessPreference {
  return {
    scope: SCOPE,
    harnessInstallationId: 'inst-codex',
    enabled: true,
    sortKey: '0000000001',
    default: false,
    version: 1,
    ...overrides,
  }
}

type World = {
  items: RuntimeConnectionInventoryEntry[]
  preferences: HarnessPreference[]
  deviceDefaultFamily?: string
  /** Operations that answer with a typed failure while set. */
  failing: Set<string>
}

/** A runtime that answers the harness reads from `world` and records every command. */
function fakeRuntime(world: World) {
  const commands: DevCommand[] = []
  const runtime: DevRuntimeService = {
    state: () => ({ status: 'ready' }) as ReturnType<DevRuntimeService['state']>,
    capabilitySnapshot: async () => {
      throw new Error('not used')
    },
    execute: async (command): Promise<DevReply> => {
      commands.push(command)
      const base = {
        schemaVersion: 1 as const,
        operation: command.operation,
        requestId: command.requestId,
      }
      if (world.failing.has(command.operation)) {
        return {
          ...base,
          ok: false,
          error: { code: 'unavailable', retryable: true, message: `${command.operation} failed` },
        } as DevReply
      }
      const ok = (value: unknown) => ({ ...base, ok: true, value }) as DevReply
      switch (command.operation) {
        case 'dev.harness.runs':
          return ok({ items: [] })
        case 'dev.harness.preferences':
          return ok({ items: world.preferences })
        case 'dev.harness.inventory':
        case 'dev.harness.inventoryRefresh':
          return ok({
            scope: SCOPE,
            items: world.items,
            freshness: world.items.map(() => 'fresh'),
          })
        case 'dev.harness.deviceDefault':
          return ok({
            ...(world.deviceDefaultFamily ? { family: world.deviceDefaultFamily } : {}),
            version: 1,
            observedAt: '2026-10-13T12:00:00Z',
          })
        case 'dev.harness.managedPiStatus':
          return ok({ scope: SCOPE, state: 'absent' })
        case 'dev.harness.preferenceUpdate': {
          const body = command.body as {
            installationId: string
            patch: { default?: boolean }
          }
          world.preferences = world.preferences.map((item) =>
            item.harnessInstallationId === body.installationId
              ? { ...item, default: body.patch.default ?? item.default, version: item.version + 1 }
              : item
          )
          return ok({})
        }
        default:
          throw new Error(`unexpected operation ${command.operation}`)
      }
    },
  }
  return { runtime, commands }
}

function context(runtime: DevRuntimeService): () => DevUtilityContext {
  return () => ({
    view: 'dev',
    runtime,
    scope: SCOPE,
    projectId: 'project-1',
    runtimeSessionId: 'session-1',
    sessionGeneration: 1,
    revision: 1,
  })
}

async function withController(
  world: World,
  run: (
    controller: ReturnType<typeof createHarnessStatusController>,
    commands: DevCommand[]
  ) => Promise<void>
) {
  const { runtime, commands } = fakeRuntime(world)
  await createRoot(async (dispose) => {
    try {
      const controller = createHarnessStatusController(context(runtime))
      await settle()
      await run(controller, commands)
    } finally {
      dispose()
    }
  })
}

const world = (overrides: Partial<World> = {}): World => ({
  items: [],
  preferences: [],
  failing: new Set(),
  ...overrides,
})

const operations = (commands: DevCommand[]) => commands.map((command) => command.operation)

describe('opening the pane never scans', () => {
  test('a valid empty scan stays empty and is reported as checked, however often it opens', async () => {
    for (let opened = 0; opened < 2; opened += 1) {
      await withController(world(), async (controller, commands) => {
        expect(operations(commands)).toContain('dev.harness.inventory')
        expect(operations(commands)).not.toContain('dev.harness.inventoryRefresh')
        expect(controller.inventoryChecked()).toBe(true)
        expect(controller.inventoryRows()).toEqual([])
        expect(controller.readErrors()).toEqual([])
      })
    }
  })

  test('rescanning is the explicit action: one refresh, then the list reloads', async () => {
    const state = world()
    await withController(state, async (controller, commands) => {
      state.items = [entry()]
      await controller.rescan()
      await settle()
      expect(operations(commands).filter((op) => op === 'dev.harness.inventoryRefresh')).toEqual([
        'dev.harness.inventoryRefresh',
      ])
      expect(controller.inventoryRows().map((row) => row.name)).toEqual(['Codex'])
    })
  })
})

describe('a failed read is local and retryable', () => {
  test('a failed inventory read says so, keeps the rest of the pane, and Try again recovers', async () => {
    const state = world({
      preferences: [preference({ harnessInstallationId: 'inst-claude', default: true })],
      deviceDefaultFamily: 'codex',
      failing: new Set(['dev.harness.inventory']),
    })
    await withController(state, async (controller, commands) => {
      expect(controller.readErrors()).toEqual(['dev.harness.inventory failed'])
      expect(controller.inventoryChecked()).toBe(false)
      expect(controller.inventoryRows()).toEqual([])
      // The reads that worked still render.
      expect(controller.preferences()).toHaveLength(1)
      expect(controller.defaultSummary().source).toBe('workspace')

      state.failing.clear()
      state.items = [entry(), entry({ id: 'inst-claude', family: 'claude-code' })]
      controller.retryReads()
      await settle()
      expect(controller.readErrors()).toEqual([])
      expect(controller.inventoryChecked()).toBe(true)
      expect(controller.inventoryRows()).toHaveLength(2)
      expect(operations(commands)).not.toContain('dev.harness.inventoryRefresh')
    })
  })

  test('every failing read is reported once, and nothing throws', async () => {
    const state = world({
      failing: new Set([
        'dev.harness.runs',
        'dev.harness.preferences',
        'dev.harness.deviceDefault',
      ]),
    })
    await withController(state, async (controller) => {
      expect([...controller.readErrors()].toSorted()).toEqual([
        'dev.harness.deviceDefault failed',
        'dev.harness.preferences failed',
        'dev.harness.runs failed',
      ])
      expect(controller.runs()).toEqual([])
      expect(controller.preferences()).toEqual([])
    })
  })
})

const missing = () =>
  world({
    items: [entry()],
    preferences: [preference({ harnessInstallationId: 'inst-gone', default: true, version: 4 })],
    deviceDefaultFamily: 'codex',
  })

describe('a workspace default whose installation vanished', () => {
  test('stays the workspace default, unavailable, and remembers the device default it overrides', async () => {
    await withController(missing(), async (controller) => {
      expect(controller.defaultSummary()).toMatchObject({
        source: 'workspace',
        overriddenDeviceName: 'Codex',
        workspaceOverrideUnavailable: true,
      })
      expect(controller.defaultSummary().name).toBeUndefined()
    })
  })

  test('can be cleared, which returns the workspace to the device default', async () => {
    const state = missing()
    await withController(state, async (controller, commands) => {
      await controller.useDeviceDefault()
      await settle()
      const update = commands.find(
        (command) => command.operation === 'dev.harness.preferenceUpdate'
      )
      expect(update?.body).toEqual({
        installationId: 'inst-gone',
        expectedVersion: 4,
        patch: { default: false },
      })
      expect(controller.defaultSummary()).toMatchObject({ source: 'device', name: 'Codex' })
    })
  })
})
