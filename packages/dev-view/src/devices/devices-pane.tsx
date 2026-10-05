/*
 * Devices pane: responsive emulation plus capability-gated iOS/Android
 * sessions. Inventory grouping, capability guidance strings, and explicit
 * start/stop semantics follow Orca's emulator availability surface (MIT,
 * revision 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7) translated to Solid;
 * the responsive lane is always available (Dev Runtime spec).
 */
import type {
  DeviceCapabilityReport,
  DeviceInventoryItem,
  DeviceSession,
} from '@adea-ai/types/dev-runtime'
import { MonitorSmartphone, Play, Smartphone, Square, Tablet } from 'lucide-solid'
import { For, Show, createResource, createSignal, onCleanup } from 'solid-js'

import { findResponsiveInventoryItem, groupDeviceInventory } from './device-model'
import '../browser/browser-pane.css'
import { Button } from '@adea-ai/ui/components/ui/button'
import { ListRowControl } from '@adea-ai/ui/components/composites/list-row'
import {
  createDevUtilityFenceSource,
  devUtilityContextKey,
  hasDevUtilitySession,
  isDevUtilityContextChanged,
  sameDevUtilityScope,
  type DevUtilityContextReader,
} from '../utility-context'
import { executeDevUtilityCommand, readDevUtilityCommand } from '../utility-command'

export type DeviceInventoryPage = { items: readonly DeviceInventoryItem[] }
export type DeviceSessionsPage = { items: readonly DeviceSession[] }

export function DevicesPane(props: { context: DevUtilityContextReader }) {
  const [error, setError] = createSignal<string | undefined>(undefined)
  const context = () => props.context()
  const runtime = () => context().runtime
  const fences = createDevUtilityFenceSource(context)
  onCleanup(() => fences.dispose())

  const contextKey = () => {
    const current = context()
    return current.runtime.state().status === 'ready' && current.scope
      ? devUtilityContextKey(current)
      : undefined
  }
  const sessionKey = () => (hasDevUtilitySession(context()) ? contextKey() : undefined)

  const serviceReady = () => runtime().state().status === 'ready'
  const [inventory] = createResource(contextKey, async (key) => {
    const fence = fences.capture('scope')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key) return { items: [] }
    const page = await readDevUtilityCommand<DeviceInventoryPage>(fence, 'dev.device.list', {})
    return { contextKey: key, items: page?.items ?? [] }
  })
  const [sessions, { refetch: refetchSessions }] = createResource(sessionKey, async (key) => {
    const fence = fences.capture('session')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key) return { items: [] }
    const page = await readDevUtilityCommand<DeviceSessionsPage>(fence, 'dev.device.sessions', {
      runtimeSessionId: fence.context.runtimeSessionId!,
    })
    return {
      contextKey: key,
      items: (page?.items ?? []).filter(
        (session) =>
          session.runtimeSessionId === fence.context.runtimeSessionId &&
          sameDevUtilityScope(session.scope, fence.context.scope)
      ),
    }
  })
  const [capabilities] = createResource(contextKey, async (key) => {
    const fence = fences.capture('scope')
    if (!key || !fence || devUtilityContextKey(fence.context) !== key) return undefined
    const report = await readDevUtilityCommand<DeviceCapabilityReport>(
      fence,
      'dev.device.capabilities',
      {}
    )
    return { contextKey: key, report }
  })

  const platformAvailability = () => {
    if (capabilities.state !== 'ready' && capabilities.state !== 'refreshing') return undefined
    if (capabilities()?.contextKey !== contextKey()) return undefined
    const rows = capabilities()?.report?.items
    const ios = rows?.find((item) => item.platform === 'ios')
    const android = rows?.find((item) => item.platform === 'android')
    return ios && android
      ? { ios: ios.state === 'available', android: android.state === 'available' }
      : undefined
  }

  const inventoryItems = () =>
    inventory.state === 'ready' || inventory.state === 'refreshing'
      ? inventory()?.contextKey === contextKey()
        ? (inventory()?.items ?? [])
        : []
      : []

  const sessionItems = () =>
    (sessions()?.contextKey === contextKey() ? sessions()?.items : undefined) ?? []

  function startDevice(item: DeviceInventoryItem): void {
    const fence = fences.capture('session')
    if (
      !fence ||
      !inventoryItems().some(
        (current) => current.id === item.id && current.generation === item.generation
      )
    ) {
      setError('no active runtime session')
      return
    }
    const runtimeSessionId = fence.context.runtimeSessionId!
    // `dev.device.start` binds a `device_inventory` resource, so the command
    // MUST carry it — `buildDevCommand` throws without one, which made every
    // inventory-row start fail locally before any request was sent.
    executeDevUtilityCommand<DeviceSession>(
      fence,
      'dev.device.start',
      { inventoryId: item.id, expectedGeneration: item.generation, runtimeSessionId },
      { kind: 'device_inventory', id: item.id, generation: item.generation }
    )
      .then(() => {
        if (!fence.isCurrent()) return
        setError(undefined)
        void refetchSessions()
      })
      .catch((reply) => {
        if (fence.isCurrent() && !isDevUtilityContextChanged(reply))
          setError(`${reply.error?.code ?? 'error'}: ${reply.error?.message ?? 'start failed'}`)
      })
  }

  function startResponsive(): void {
    const fence = fences.capture('session')
    if (!fence) {
      setError('no active runtime session')
      return
    }
    const runtimeSessionId = fence.context.runtimeSessionId!
    // The responsive row is an inventory entry like any other: it needs the
    // same resource binding and generation, not a hardcoded id and no binding.
    const responsive = findResponsiveInventoryItem(inventoryItems())
    if (!responsive) {
      setError('the responsive device inventory entry is not available')
      return
    }
    executeDevUtilityCommand<DeviceSession>(
      fence,
      'dev.device.start',
      {
        inventoryId: responsive.id,
        expectedGeneration: responsive.generation,
        runtimeSessionId,
      },
      { kind: 'device_inventory', id: responsive.id, generation: responsive.generation }
    )
      .then(() => {
        if (!fence.isCurrent()) return
        setError(undefined)
        void refetchSessions()
      })
      .catch((reply) => {
        if (fence.isCurrent() && !isDevUtilityContextChanged(reply))
          setError(`${reply.error?.code ?? 'error'}: ${reply.error?.message ?? 'start failed'}`)
      })
  }

  function stopDevice(session: DeviceSession): void {
    const fence = fences.capture('session')
    if (
      !fence ||
      session.runtimeSessionId !== fence.context.runtimeSessionId ||
      !sameDevUtilityScope(session.scope, fence.context.scope)
    )
      return
    executeDevUtilityCommand<DeviceSession>(
      fence,
      'dev.device.stop',
      {
        deviceSessionId: session.id,
        expectedGeneration: session.generation,
        confirmationId: `stop-${session.inventoryId}`,
      },
      { kind: 'device_session', id: session.id, generation: session.generation }
    )
      .then(() => {
        if (!fence.isCurrent()) return
        setError(undefined)
        void refetchSessions()
      })
      .catch((reply) => {
        if (fence.isCurrent() && !isDevUtilityContextChanged(reply))
          setError(`${reply.error?.code ?? 'error'}: ${reply.error?.message ?? 'stop failed'}`)
      })
  }

  const responsiveSession = () =>
    sessionItems().find(
      (entry) =>
        entry.kind === 'responsive' &&
        entry.runtimeSessionId === context().runtimeSessionId &&
        sameDevUtilityScope(entry.scope, context().scope)
    )

  return (
    <section class="dev-browser" aria-label="Devices">
      <div class="dev-browser__identity" role="status">
        <MonitorSmartphone aria-hidden="true" />
        <strong>Device mode</strong>
        <span>responsive always available · simulators capability-gated</span>
      </div>
      <Show
        when={context().scope}
        fallback={
          <p class="dev-empty-state" role="status">
            Device inventory is unavailable until the runtime scope is bound.
          </p>
        }
      >
        <Show
          when={serviceReady()}
          fallback={<p class="dev-empty-state">Device sessions are unavailable.</p>}
        >
          <div class="dev-devices__list">
            <Show when={error()}>
              {(shown) => (
                <p class="dev-terminal-muted" role="alert">
                  {shown()}
                </p>
              )}
            </Show>

            <p class="dev-browser__section-title">Responsive</p>
            <div class="dev-browser__actions">
              <Show when={!hasDevUtilitySession(context())}>
                <p class="dev-terminal-muted" role="status">
                  Start and stop actions are unavailable until this view is bound to a canonical
                  runtime session.
                </p>
              </Show>
              <Show
                when={responsiveSession()}
                fallback={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!hasDevUtilitySession(context())}
                    onClick={startResponsive}
                  >
                    <Play aria-hidden="true" />
                    Start responsive session
                  </Button>
                }
              >
                {(session) => (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => stopDevice(session())}
                  >
                    <Square aria-hidden="true" />
                    Stop responsive session ({session().state})
                  </Button>
                )}
              </Show>
            </div>
            <p class="dev-terminal-muted">
              Configure responsive viewport size and orientation in the Browser pane.
            </p>
            <Show
              when={platformAvailability()}
              fallback={
                <p class="dev-terminal-muted" role="status">
                  {capabilities.state === 'errored'
                    ? 'Simulator toolchain availability could not be checked.'
                    : 'Checking simulator toolchains…'}
                </p>
              }
            >
              {(availability) => (
                <Show
                  when={inventory.state === 'ready' || inventory.state === 'refreshing'}
                  fallback={
                    <p
                      class="dev-terminal-muted"
                      role={inventory.state === 'errored' ? 'alert' : 'status'}
                    >
                      {inventory.state === 'errored'
                        ? 'Device inventory could not be loaded.'
                        : 'Loading device inventory…'}
                    </p>
                  }
                >
                  <For
                    each={groupDeviceInventory(inventoryItems(), availability()).filter(
                      (group) => group.platform !== 'responsive'
                    )}
                  >
                    {(group) => (
                      <>
                        <p class="dev-browser__section-title">{group.label}</p>
                        <Show when={group.guidance}>
                          {(guidance) => <p class="dev-terminal-muted">{guidance()}</p>}
                        </Show>
                        <Show when={!group.guidance && group.items.length === 0}>
                          <p class="dev-terminal-muted">No devices found.</p>
                        </Show>
                        <For each={group.items}>
                          {(item) => {
                            const attached = () =>
                              sessionItems().some(
                                (session) =>
                                  session.inventoryId === item.id && session.state === 'attached'
                              )
                            return (
                              <ListRowControl
                                as="div"
                                description={`${item.platform} · ${item.state}`}
                                leading={
                                  <Show
                                    when={item.kind === 'ios_simulator'}
                                    fallback={<Smartphone aria-hidden="true" />}
                                  >
                                    <Tablet aria-hidden="true" />
                                  </Show>
                                }
                                trailing={
                                  <Show
                                    when={attached()}
                                    fallback={
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        disabled={
                                          item.state === 'unauthorized' ||
                                          !hasDevUtilitySession(context())
                                        }
                                        onClick={() => startDevice(item)}
                                      >
                                        <Play aria-hidden="true" />
                                        Start
                                      </Button>
                                    }
                                  >
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => {
                                        const session = sessionItems().find(
                                          (entry) =>
                                            entry.inventoryId === item.id &&
                                            entry.state === 'attached'
                                        )
                                        if (session) stopDevice(session)
                                      }}
                                    >
                                      <Square aria-hidden="true" />
                                      Stop
                                    </Button>
                                  </Show>
                                }
                              >
                                {item.name}
                              </ListRowControl>
                            )
                          }}
                        </For>
                      </>
                    )}
                  </For>
                </Show>
              )}
            </Show>
          </div>
        </Show>
      </Show>
    </section>
  )
}
