/*
 * Devices pane: responsive emulation plus capability-gated iOS/Android
 * sessions. Inventory grouping, capability guidance strings, and explicit
 * start/stop semantics follow Orca's emulator availability surface (MIT,
 * revision 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7) translated to Solid;
 * the responsive lane is always available (Dev Runtime spec).
 */
import type { DeviceInventoryItem, DeviceSession } from '@adea-ai/types/dev-runtime'
import { cn } from '@adea-ai/ui/lib/utils'
import { MonitorSmartphone, Smartphone, Tablet } from 'lucide-solid'
import { For, Show, createResource, createSignal } from 'solid-js'

import type { DevRuntimeService } from '../platform'
import { buildDevCommand } from '../browser/command'
import {
  presetById,
  resolvePresetViewport,
  RESPONSIVE_PRESETS,
  type ResponsiveOrientation,
  type ResponsivePresetId,
} from '../browser/responsive-presets'
import { groupDeviceInventory } from './device-model'
import '../browser/browser-pane.css'

export type DeviceInventoryPage = { items: readonly DeviceInventoryItem[] }
export type DeviceSessionsPage = { items: readonly DeviceSession[] }

export function DevicesPane(props: { runtime: DevRuntimeService; runtimeSessionId?: string }) {
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [presetId, setPresetId] = createSignal<ResponsivePresetId>('iphone_15_pro')
  const [orientation, setOrientation] = createSignal<ResponsiveOrientation>('portrait')
  const scope = () => props.runtime.preferenceScope?.()

  async function execute<T>(
    operation: Parameters<typeof buildDevCommand>[0]['operation'],
    body: Record<string, unknown>,
    resource?: { kind: string; id: string; generation: number }
  ): Promise<T> {
    const activeScope = scope()
    if (!activeScope) throw new Error('unauthenticated')
    const reply = await props.runtime.execute(
      buildDevCommand({ operation, scope: activeScope, body, ...(resource ? { resource } : {}) })
    )
    if (!reply.ok) throw reply
    return reply.value as T
  }

  const serviceReady = () => props.runtime.state().status === 'ready'
  const [inventory] = createResource(serviceReady, async (ready) =>
    ready ? execute<DeviceInventoryPage>('dev.device.list', {}) : { items: [] }
  )
  const [sessions, { refetch: refetchSessions }] = createResource(serviceReady, async (ready) =>
    ready ? execute<DeviceSessionsPage>('dev.device.sessions', {}) : { items: [] }
  )

  function startDevice(item: DeviceInventoryItem): void {
    const runtimeSessionId = props.runtimeSessionId
    if (!runtimeSessionId) {
      setError('no active runtime session')
      return
    }
    // `dev.device.start` binds a `device_inventory` resource, so the command
    // MUST carry it — `buildDevCommand` throws without one, which made every
    // inventory-row start fail locally before any request was sent.
    execute<DeviceSession>(
      'dev.device.start',
      { inventoryId: item.id, expectedGeneration: item.generation, runtimeSessionId },
      { kind: 'device_inventory', id: item.id, generation: item.generation }
    )
      .then(() => {
        setError(undefined)
        void refetchSessions()
      })
      .catch((reply) =>
        setError(`${reply.error?.code ?? 'error'}: ${reply.error?.message ?? 'start failed'}`)
      )
  }

  function startResponsive(): void {
    const runtimeSessionId = props.runtimeSessionId
    if (!runtimeSessionId) {
      setError('no active runtime session')
      return
    }
    // The responsive row is an inventory entry like any other: it needs the
    // same resource binding and generation, not a hardcoded id and no binding.
    const responsive = (inventory()?.items ?? []).find(
      (entry: { id: string; generation: number }) => entry.id === 'responsive'
    )
    if (!responsive) {
      setError('the responsive device inventory entry is not available')
      return
    }
    execute<DeviceSession>(
      'dev.device.start',
      {
        inventoryId: responsive.id,
        expectedGeneration: responsive.generation,
        runtimeSessionId,
      },
      { kind: 'device_inventory', id: responsive.id, generation: responsive.generation }
    )
      .then(() => {
        setError(undefined)
        void refetchSessions()
      })
      .catch((reply) =>
        setError(`${reply.error?.code ?? 'error'}: ${reply.error?.message ?? 'start failed'}`)
      )
  }

  function stopDevice(session: DeviceSession): void {
    execute<DeviceSession>(
      'dev.device.stop',
      {
        deviceSessionId: session.id,
        expectedGeneration: session.generation,
        confirmationId: `stop-${session.inventoryId}`,
      },
      { kind: 'device_session', id: session.id, generation: session.generation }
    )
      .then(() => {
        setError(undefined)
        void refetchSessions()
      })
      .catch((reply) =>
        setError(`${reply.error?.code ?? 'error'}: ${reply.error?.message ?? 'stop failed'}`)
      )
  }

  const responsiveSession = () =>
    (sessions()?.items ?? []).find((entry) => entry.kind === 'responsive')

  return (
    <section class="dev-browser" aria-label="Devices">
      <div class="dev-browser__identity" role="status">
        <MonitorSmartphone aria-hidden="true" />
        <strong>Device mode</strong>
        <span>responsive always available · simulators capability-gated</span>
      </div>
      <Show
        when={props.runtime.state().status === 'ready'}
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
            <Show
              when={responsiveSession()}
              fallback={
                <button
                  type="button"
                  class="dev-button"
                  disabled={!props.runtimeSessionId}
                  onClick={startResponsive}
                >
                  Start responsive session
                </button>
              }
            >
              {(session) => (
                <button type="button" class="dev-button" onClick={() => stopDevice(session())}>
                  Stop responsive session ({session().state})
                </button>
              )}
            </Show>
          </div>
          <p class="dev-browser__section-title">Device presets</p>
          <div class="dev-browser__actions">
            <For each={RESPONSIVE_PRESETS}>
              {(preset) => (
                <button
                  type="button"
                  class={cn('dev-button', {
                    'dev-utility-tab--selected': preset.id === presetId(),
                  })}
                  aria-pressed={preset.id === presetId()}
                  onClick={() => {
                    setPresetId(preset.id)
                    setOrientation(preset.defaultOrientation)
                  }}
                >
                  {preset.label}
                </button>
              )}
            </For>
            <button
              type="button"
              class="dev-button"
              onClick={() =>
                setOrientation((value) => (value === 'portrait' ? 'landscape' : 'portrait'))
              }
            >
              Rotate
            </button>
            <span class="dev-browser__row-meta">
              {resolvePresetViewport(presetById(presetId()), orientation()).width}×
              {resolvePresetViewport(presetById(presetId()), orientation()).height} · scale{' '}
              {presetById(presetId()).deviceScaleFactor}
            </span>
          </div>

          <For each={groupDeviceInventory(inventory()?.items ?? [], { ios: true, android: true })}>
            {(group) => (
              <>
                <p class="dev-browser__section-title">{group.label}</p>
                <Show when={group.guidance}>
                  {(guidance) => <p class="dev-terminal-muted">{guidance()}</p>}
                </Show>
                <Show when={group.items.length > 0}>
                  <For each={group.items}>
                    {(item) => {
                      const attached = () =>
                        (sessions()?.items ?? []).some(
                          (session) =>
                            session.inventoryId === item.id && session.state === 'attached'
                        )
                      return (
                        <div class="dev-browser__row">
                          <span class="dev-browser__row-main">
                            <span>
                              <Show
                                when={item.kind === 'ios_simulator'}
                                fallback={<Smartphone aria-hidden="true" />}
                              >
                                <Tablet aria-hidden="true" />
                              </Show>{' '}
                              {item.name}
                            </span>
                            <span class="dev-browser__row-meta">
                              {item.platform} · {item.state}
                            </span>
                          </span>
                          <Show
                            when={attached()}
                            fallback={
                              <button
                                type="button"
                                class="dev-button"
                                disabled={item.state === 'unauthorized'}
                                onClick={() => startDevice(item)}
                              >
                                Start
                              </button>
                            }
                          >
                            <button
                              type="button"
                              class="dev-button"
                              onClick={() => {
                                const session = (sessions()?.items ?? []).find(
                                  (entry) =>
                                    entry.inventoryId === item.id && entry.state === 'attached'
                                )
                                if (session) stopDevice(session)
                              }}
                            >
                              Stop
                            </button>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}
