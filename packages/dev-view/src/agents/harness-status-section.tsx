/*
 * Agents pane status section (#400): fetches the canonical run records, the
 * harness preference overlay, and the managed-Pi status through the gate and
 * projects them through the pure HarnessStatusPane model. The section owns no
 * authority and fabricates nothing: an unavailable runtime renders the typed
 * state, and empty runs render idle.
 */
import type {
  DevError,
  HarnessDeviceDefault,
  HarnessPreference,
  HarnessRun,
  ManagedPiStatus,
  RuntimeConnectionInventorySnapshot,
} from '@adea-ai/types/dev-runtime'
import '@adea-ai/app-ui/dev-view.css'
import { Show, createMemo, createResource, createSignal, onCleanup } from 'solid-js'

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
  summarizeHarnessDefault,
  type HarnessInventoryRow,
} from './harness-status-model'
import { HarnessStatusPane } from './harness-status-pane'

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

export type HarnessStatusSectionProps = {
  context: DevUtilityContextReader
}

export function HarnessStatusSection(props: HarnessStatusSectionProps) {
  const context = () => props.context()
  const runtime = () => context().runtime
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
  let autoScanned = false
  const refetchKey = () => {
    const key = contextKey()
    return key ? { key, tick: tick() } : undefined
  }

  const [runs] = createResource(contextKey, async (key) => {
    const fence = fences.capture('session')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key)
      return { items: [] as readonly HarnessRun[] }
    const page = await readDevUtilityCommand<{ items: readonly HarnessRun[] }>(
      fence,
      'dev.harness.runs',
      {
        runtimeSessionId: fence.context.runtimeSessionId!,
      }
    )
    return {
      contextKey: key,
      items: (page?.items ?? []).filter(
        (run) =>
          run.runtimeSessionId === fence.context.runtimeSessionId &&
          sameDevUtilityScope(run.scope, fence.context.scope)
      ),
    }
  })
  const [preferences] = createResource(refetchKey, async ({ key }) => {
    const fence = fences.capture('session')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key)
      return { items: [] as readonly HarnessPreference[] }
    const page = await readDevUtilityCommand<{ items: readonly HarnessPreference[] }>(
      fence,
      'dev.harness.preferences',
      { projectId: fence.context.projectId! }
    )
    return {
      contextKey: key,
      items: (page?.items ?? []).filter(
        (preference) =>
          sameDevUtilityScope(preference.scope, fence.context.scope) &&
          (preference.projectId === undefined || preference.projectId === fence.context.projectId)
      ),
    }
  })
  const [inventory] = createResource(refetchKey, async ({ key }) => {
    const fence = fences.capture('session')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key) return undefined
    let snapshot = await readDevUtilityCommand<RuntimeConnectionInventorySnapshot>(
      fence,
      'dev.harness.inventory',
      {}
    )
    // Reads never probe, so a device that was never scanned looks empty. Scan
    // it once on first view; a failed scan leaves the stored (empty) read.
    if (snapshot && snapshot.items.length === 0 && !autoScanned) {
      autoScanned = true
      try {
        snapshot =
          (await readDevUtilityCommand<RuntimeConnectionInventorySnapshot>(
            fence,
            'dev.harness.inventoryRefresh',
            {}
          )) ?? snapshot
      } catch {
        // Typed failures surface through the explicit Rescan action.
      }
    }
    return {
      contextKey: key,
      snapshot:
        snapshot && sameDevUtilityScope(snapshot.scope, fence.context.scope) ? snapshot : undefined,
    }
  })
  const [deviceDefault] = createResource(refetchKey, async ({ key }) => {
    const fence = fences.capture('session')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key) return undefined
    const value = await readDevUtilityCommand<HarnessDeviceDefault>(
      fence,
      'dev.harness.deviceDefault',
      {}
    )
    return { contextKey: key, value }
  })
  const [managedPi] = createResource(contextKey, async (key) => {
    const fence = fences.capture('session')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key) return undefined
    const status = await readDevUtilityCommand<ManagedPiStatus>(
      fence,
      'dev.harness.managedPiStatus',
      {}
    )
    return {
      contextKey: key,
      status: status && sameDevUtilityScope(status.scope, fence.context.scope) ? status : undefined,
    }
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

  const useDeviceDefault = () =>
    perform(async (fence) => {
      const override = inventoryRows().find((row) => row.isWorkspaceDefault)
      const choice = override ? workspaceChoice(override.installationId) : undefined
      if (!override || !choice) return
      await fenced(choice.version, (expectedVersion) =>
        executeDevUtilityCommand(fence, 'dev.harness.preferenceUpdate', {
          installationId: override.installationId,
          expectedVersion,
          patch: { default: false },
        })
      )
    })

  return (
    <Show
      when={hasDevUtilitySession(context())}
      fallback={
        <p class="dev-pane-state__line" role="status">
          Agent status is unavailable until this view is bound to a canonical runtime session.
        </p>
      }
    >
      <Show
        when={runtime().state().status === 'ready'}
        fallback={<p class="dev-pane-state__line">Runtime unavailable</p>}
      >
        <HarnessStatusPane
          runs={
            runs()?.contextKey === contextKey()
              ? (runs()?.items ?? []).filter(
                  (run) =>
                    run.runtimeSessionId === context().runtimeSessionId &&
                    sameDevUtilityScope(run.scope, context().scope)
                )
              : []
          }
          preferences={currentPreferences()}
          managedPi={currentManagedPi()}
          inventoryRows={inventoryRows()}
          busy={busy()}
          {...(actionError() !== undefined ? { actionError: actionError() } : {})}
          defaultSummary={defaultSummary()}
          onMakeDeviceDefault={(row) => void makeDeviceDefault(row)}
          onUseInWorkspace={(row) => void useInWorkspace(row)}
          onUseDeviceDefault={() => void useDeviceDefault()}
          onRescan={() => void rescan()}
        />
      </Show>
    </Show>
  )
}
