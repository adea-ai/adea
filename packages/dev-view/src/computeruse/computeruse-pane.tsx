/*
 * Computer use pane (issue #472): capability-state consumption and the
 * supervised lane surface, structured like the devices pane and mirroring
 * the permissions page's honest-degradation and announcement rules. The
 * pane never fabricates capability state: rows render only what the
 * desktop shell reports, and the human takeover / kill-switch controls are
 * always reachable while a lane is live.
 */
import type { ComputerUseCapabilityReport, ComputerUseLane } from '@adea-ai/types/dev-runtime'
import { For, Show, createResource, createSignal } from 'solid-js'

import type { DevRuntimeService } from '../platform'
import { buildDevCommand } from '../browser/command'
import {
  capabilityRows,
  laneActions,
  laneChangeAnnouncement,
  laneSummary,
  type LaneActionKind,
} from './computeruse-model'
import '../browser/browser-pane.css'

export type ComputerUseLanesPage = { items: readonly ComputerUseLane[] }

export function ComputerUsePane(props: { runtime: DevRuntimeService; runtimeSessionId?: string }) {
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [announcement, setAnnouncement] = createSignal('')
  const knownLanes = new Map<
    string,
    { state: string; generation: number; automationOwner: string }
  >()
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
  const [report] = createResource(serviceReady, async (ready) =>
    ready ? execute<ComputerUseCapabilityReport>('dev.computeruse.capabilities', {}) : undefined
  )
  const [lanes, { refetch }] = createResource(serviceReady, async (ready) => {
    if (!ready) return { items: [] as readonly ComputerUseLane[] }
    const page = await execute<ComputerUseLanesPage>('dev.computeruse.lanes', {})
    for (const lane of page.items) {
      const before = knownLanes.get(lane.id)
      const message = laneChangeAnnouncement(
        before
          ? {
              ...lane,
              state: before.state as ComputerUseLane['state'],
              generation: before.generation,
              automationOwner: before.automationOwner as ComputerUseLane['automationOwner'],
            }
          : undefined,
        lane
      )
      if (message) setAnnouncement(message)
      knownLanes.set(lane.id, {
        state: lane.state,
        generation: lane.generation,
        automationOwner: lane.automationOwner,
      })
    }
    return page
  })

  function run(lane: ComputerUseLane, kind: LaneActionKind): void {
    const resource = {
      kind: 'computeruse_lane',
      id: lane.id,
      generation: lane.generation,
    }
    const operations: Record<LaneActionKind, Parameters<typeof execute>[0]> = {
      consent: 'dev.computeruse.consent',
      takeover: 'dev.computeruse.takeover',
      release: 'dev.computeruse.release',
      close: 'dev.computeruse.laneClose',
    }
    const bodies: Record<LaneActionKind, Record<string, unknown>> = {
      consent: {
        computerUseLaneId: lane.id,
        expectedGeneration: lane.generation,
        confirmationId: `consent-${lane.id}-${lane.generation}`,
      },
      takeover: { computerUseLaneId: lane.id, expectedGeneration: lane.generation },
      release: { computerUseLaneId: lane.id, expectedGeneration: lane.generation },
      close: {
        computerUseLaneId: lane.id,
        expectedGeneration: lane.generation,
        confirmationId: `kill-${lane.id}`,
      },
    }
    execute(operations[kind], bodies[kind], resource)
      .then(() => {
        setError(undefined)
        void refetch()
      })
      .catch((reply) =>
        setError(`${reply.error?.code ?? 'error'}: ${reply.error?.message ?? 'action failed'}`)
      )
  }

  return (
    <section class="dev-browser" aria-label="Computer use">
      <div class="dev-browser__identity" role="status">
        <strong>Computer use</strong>
        <span>supervised desktop automation · session-scoped consent · instant takeover</span>
      </div>
      <p class="visually-hidden" role="status" aria-live="polite">
        {announcement()}
      </p>
      <Show
        when={props.runtime.state().status === 'ready'}
        fallback={<p class="dev-empty-state">Computer-use lanes are unavailable.</p>}
      >
        <div class="dev-devices__list">
          <Show when={error()}>
            {(shown) => (
              <p class="dev-terminal-muted" role="alert">
                {shown()}
              </p>
            )}
          </Show>

          <p class="dev-browser__section-title">Capabilities on this host</p>
          <For each={capabilityRows(report())}>
            {(row) => (
              <div class="dev-browser__row">
                <span class="dev-browser__row-main">
                  <span>{row.label}</span>
                  <span class="dev-browser__row-meta">
                    {row.stateLabel}
                    {row.hint ? ` — ${row.hint}` : ''}
                  </span>
                </span>
              </div>
            )}
          </For>

          <p class="dev-browser__section-title">Lanes for this session</p>
          <Show
            when={props.runtimeSessionId}
            fallback={
              <p class="dev-terminal-muted">
                No active runtime session; lanes bind to a session and die with it.
              </p>
            }
          >
            <Show
              when={(lanes()?.items ?? []).length > 0}
              fallback={<p class="dev-terminal-muted">No computer-use lanes are open.</p>}
            >
              <For each={lanes()?.items ?? []}>
                {(lane) => (
                  <div class="dev-browser__row">
                    <span class="dev-browser__row-main">
                      <span>{lane.id.slice(0, 8)}</span>
                      <span class="dev-browser__row-meta">{laneSummary(lane)}</span>
                    </span>
                    <span class="dev-browser__actions">
                      <For each={laneActions(lane)}>
                        {(action) => (
                          <button
                            type="button"
                            class="dev-button"
                            disabled={!action.enabled}
                            onClick={() => run(lane, action.kind)}
                          >
                            {action.label}
                          </button>
                        )}
                      </For>
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </Show>
    </section>
  )
}
