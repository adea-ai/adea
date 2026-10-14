/*
 * The Agents pane's harness reads and actions (#400), kept apart from the
 * rendering so the read contract is testable without a DOM. Reads never probe
 * the device: a scan happens only through `rescan`. A failed read becomes a
 * message in `readErrors` (with `retryReads`), never a thrown render error, and
 * the rest of the pane stays usable.
 */
import type {
  DevError,
  HarnessDeviceDefault,
  HarnessPreference,
  HarnessRun,
  ManagedPiStatus,
  RuntimeConnectionInventorySnapshot,
} from '@adea-ai/types/dev-runtime'
import { createMemo, createResource, createSignal, onCleanup } from 'solid-js'

import {
  createDevUtilityFenceSource,
  devUtilityContextKey,
  hasDevUtilitySession,
  isDevUtilityContextChanged,
  sameDevUtilityScope,
  type DevUtilityContextReader,
} from '../utility-context'
import { executeDevUtilityCommand, readDevUtilityCommand } from '../utility-command'
import {
  buildHarnessInventoryRows,
  storedWorkspaceDefault,
  summarizeHarnessDefault,
  type HarnessInventoryRow,
} from './harness-status-model'

/** Runs a version-fenced write, retrying once at the version a stale refusal reports. */
async function fenced(
  initialVersion: number,
  write: (expectedVersion: number) => Promise<unknown>
): Promise<void> {
  let expectedVersion = initialVersion
  for (let attempt = 0; ; attempt += 1) {
    try {
      await write(expectedVersion)
      return
    } catch (error) {
      const typed = (error as { error?: DevError } | null)?.error
      if (attempt === 0 && typed?.code === 'stale_version' && typed.currentVersion !== undefined) {
        expectedVersion = typed.currentVersion
        continue
      }
      throw error
    }
  }
}

/** The message of a typed failure thrown as a failed reply, else a generic one. */
function failureMessage(error: unknown, fallback: string): string {
  const typed = (error as { error?: DevError } | null)?.error
  return typeof typed?.message === 'string' && typed.message.length > 0 ? typed.message : fallback
}

/**
 * A failed read becomes `failure` data so the pane says so beside a retry instead of throwing; a
 * read that only lost its context is superseded, not failed.
 */
async function guarded<T extends object>(
  key: string,
  what: string,
  read: () => Promise<T>,
  empty: T
) {
  try {
    return { contextKey: key, ...(await read()) }
  } catch (error) {
    return {
      ...empty,
      contextKey: key,
      failure: isDevUtilityContextChanged(error)
        ? undefined
        : failureMessage(error, `Couldn't read ${what}.`),
    }
  }
}

export function createHarnessStatusController(readContext: DevUtilityContextReader) {
  const context = () => readContext()
  const fences = createDevUtilityFenceSource(context)
  onCleanup(() => fences.dispose())
  const contextKey = () => {
    const current = context()
    return current.runtime.state().status === 'ready' && hasDevUtilitySession(current)
      ? devUtilityContextKey(current)
      : undefined
  }

  // Bumped after a rescan or a default change so the reads below refetch.
  const [tick, setTick] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [actionError, setActionError] = createSignal<string | undefined>()
  // Bumped by Try again after a failed read.
  const [retryTick, setRetryTick] = createSignal(0)
  const staticKey = () => {
    const key = contextKey()
    return key ? { key, retry: retryTick() } : undefined
  }
  const refetchKey = () => {
    const key = contextKey()
    return key ? { key, tick: tick(), retry: retryTick() } : undefined
  }

  const [runs] = createResource(staticKey, async ({ key }) => {
    const fence = fences.capture('session')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key)
      return { contextKey: undefined, items: [] as readonly HarnessRun[] }
    return guarded(
      key,
      'the harness runs',
      async () => {
        const page = await readDevUtilityCommand<{ items: readonly HarnessRun[] }>(
          fence,
          'dev.harness.runs',
          { runtimeSessionId: fence.context.runtimeSessionId! }
        )
        return {
          items: (page?.items ?? []).filter(
            (run) =>
              run.runtimeSessionId === fence.context.runtimeSessionId &&
              sameDevUtilityScope(run.scope, fence.context.scope)
          ),
        }
      },
      { items: [] as readonly HarnessRun[] }
    )
  })
  const [preferences] = createResource(refetchKey, async ({ key }) => {
    const fence = fences.capture('session')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key)
      return { contextKey: undefined, items: [] as readonly HarnessPreference[] }
    return guarded(
      key,
      'the harness preferences',
      async () => {
        const page = await readDevUtilityCommand<{ items: readonly HarnessPreference[] }>(
          fence,
          'dev.harness.preferences',
          { projectId: fence.context.projectId! }
        )
        return {
          items: (page?.items ?? []).filter(
            (preference) =>
              sameDevUtilityScope(preference.scope, fence.context.scope) &&
              (preference.projectId === undefined ||
                preference.projectId === fence.context.projectId)
          ),
        }
      },
      { items: [] as readonly HarnessPreference[] }
    )
  })
  // Reads never probe: a device that was never scanned lists nothing until the
  // user rescans. Scanning is always an explicit action.
  const [inventory] = createResource(refetchKey, async ({ key }) => {
    const fence = fences.capture('session')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key) return undefined
    return guarded(
      key,
      'the installed harnesses',
      async () => {
        const snapshot = await readDevUtilityCommand<RuntimeConnectionInventorySnapshot>(
          fence,
          'dev.harness.inventory',
          {}
        )
        return {
          snapshot:
            snapshot && sameDevUtilityScope(snapshot.scope, fence.context.scope)
              ? snapshot
              : undefined,
        }
      },
      { snapshot: undefined }
    )
  })
  const [deviceDefault] = createResource(refetchKey, async ({ key }) => {
    const fence = fences.capture('session')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key) return undefined
    return guarded(
      key,
      'the device default',
      async () => ({
        value: await readDevUtilityCommand<HarnessDeviceDefault>(
          fence,
          'dev.harness.deviceDefault',
          {}
        ),
      }),
      { value: undefined }
    )
  })
  const [managedPi] = createResource(staticKey, async ({ key }) => {
    const fence = fences.capture('session')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key) return undefined
    return guarded(
      key,
      'the managed Pi status',
      async () => {
        const status = await readDevUtilityCommand<ManagedPiStatus>(
          fence,
          'dev.harness.managedPiStatus',
          {}
        )
        return {
          status:
            status && sameDevUtilityScope(status.scope, fence.context.scope) ? status : undefined,
        }
      },
      { status: undefined }
    )
  })

  const currentPreferences = (): readonly HarnessPreference[] =>
    preferences()?.contextKey === contextKey()
      ? (preferences()?.items ?? []).filter(
          (preference) =>
            sameDevUtilityScope(preference.scope, context().scope) &&
            (preference.projectId === undefined || preference.projectId === context().projectId)
        )
      : []
  const currentManagedPi = () =>
    managedPi()?.contextKey === contextKey() ? managedPi()?.status : undefined
  const currentDeviceDefault = (): HarnessDeviceDefault | undefined =>
    deviceDefault()?.contextKey === contextKey() ? deviceDefault()?.value : undefined
  const inventoryRows = createMemo(() =>
    buildHarnessInventoryRows({
      inventory: inventory()?.contextKey === contextKey() ? inventory()?.snapshot : undefined,
      preferences: currentPreferences(),
      managedPi: currentManagedPi(),
      deviceDefaultFamily: currentDeviceDefault()?.family,
    })
  )
  const defaultSummary = createMemo(() =>
    summarizeHarnessDefault({
      rows: inventoryRows(),
      preferences: currentPreferences(),
      deviceDefaultFamily: currentDeviceDefault()?.family,
      managedPi: currentManagedPi(),
    })
  )

  // Each failed read says so in the pane, once, with a single retry.
  const readErrors = createMemo((): readonly string[] => {
    const key = contextKey()
    const failures = [runs(), preferences(), inventory(), deviceDefault(), managedPi()].flatMap(
      (read) => {
        const result = read as { contextKey?: string; failure?: string } | undefined
        return result?.contextKey === key && result?.failure !== undefined ? [result.failure] : []
      }
    )
    return [...new Set(failures)]
  })
  const inventoryChecked = () =>
    inventory()?.contextKey === contextKey() && inventory()?.snapshot !== undefined
  const retryReads = () => {
    setActionError(undefined)
    setRetryTick((value) => value + 1)
  }

  async function perform(
    action: (fence: NonNullable<ReturnType<typeof fences.capture>>) => Promise<void>
  ) {
    const fence = fences.capture('session')
    if (!fence || busy()) return
    setBusy(true)
    setActionError(undefined)
    try {
      await action(fence)
      setTick((value) => value + 1)
    } catch (error) {
      if (!isDevUtilityContextChanged(error)) {
        setActionError(failureMessage(error, 'The harness change did not complete.'))
      }
    } finally {
      setBusy(false)
    }
  }

  const rescan = () =>
    perform(async (fence) => {
      await executeDevUtilityCommand(fence, 'dev.harness.inventoryRefresh', {})
    })

  const workspaceChoice = (installationId: string) =>
    currentPreferences().find(
      (preference) =>
        preference.harnessInstallationId === installationId &&
        preference.projectId === undefined &&
        preference.rootDefault !== true
    )

  const makeDeviceDefault = (row: HarnessInventoryRow) =>
    perform(async (fence) => {
      await fenced(currentDeviceDefault()?.version ?? 0, (expectedVersion) =>
        executeDevUtilityCommand(fence, 'dev.harness.deviceDefaultUpdate', {
          family: row.family,
          expectedVersion,
        })
      )
    })

  const useInWorkspace = (row: HarnessInventoryRow) =>
    perform(async (fence) => {
      await fenced(workspaceChoice(row.installationId)?.version ?? 0, (expectedVersion) =>
        executeDevUtilityCommand(fence, 'dev.harness.preferenceUpdate', {
          installationId: row.installationId,
          expectedVersion,
          patch: { default: true },
        })
      )
    })

  // The override comes from the stored preference, not the inventory: it stays
  // clearable after its installation has disappeared.
  const useDeviceDefault = () =>
    perform(async (fence) => {
      const override = storedWorkspaceDefault(currentPreferences())
      if (!override) return
      await fenced(override.version, (expectedVersion) =>
        executeDevUtilityCommand(fence, 'dev.harness.preferenceUpdate', {
          installationId: override.harnessInstallationId,
          expectedVersion,
          patch: { default: false },
        })
      )
    })

  return {
    contextKey,
    runs: () =>
      runs()?.contextKey === contextKey()
        ? (runs()?.items ?? []).filter(
            (run) =>
              run.runtimeSessionId === context().runtimeSessionId &&
              sameDevUtilityScope(run.scope, context().scope)
          )
        : [],
    preferences: currentPreferences,
    managedPi: currentManagedPi,
    inventoryRows,
    inventoryChecked,
    defaultSummary,
    readErrors,
    retryReads,
    busy,
    actionError,
    rescan,
    makeDeviceDefault,
    useInWorkspace,
    useDeviceDefault,
  }
}
