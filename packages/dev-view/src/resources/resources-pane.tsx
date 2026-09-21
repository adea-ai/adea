/*
 * Copyright (c) 2026 Adea contributors.
 *
 * Resources pane (#424): the toolbar detail sheet showing Adea-owned
 * processes, loopback ports, provider usage, and the retained-data
 * breakdown. Every destructive action is a plan/commit pair: the pane asks
 * the host for an envelope-bound stop plan, shows the exact target, and only
 * then commits — the host and the supervision engine own every safety check.
 * Unavailable capability renders as typed states; external/unknown rows have
 * no stop control.
 */
import type {
  DevError,
  MutationPlan,
  ProcessRecord,
  ResourceSnapshot,
  UsageRecord,
} from '@adea-ai/types/dev-runtime'
import '@adea-ai/ui/dev-view.css'
import { RefreshCw, X } from 'lucide-solid'
import { For, Show, createResource, createSignal } from 'solid-js'

import type { DevRuntimeService } from '../platform'
import { buildDevCommand } from '../browser/command'
import {
  formatBytes,
  metricSummary,
  processRows,
  retainedGroups,
  usageCards,
} from './resources-model'
import './resources-pane.css'

export type ResourcesPaneProps = {
  runtime: DevRuntimeService
  runtimeSessionId?: string
}

type Snapshot = ResourceSnapshot
type UsagePage = { items: readonly UsageRecord[] }

function commandError(error: unknown): DevError {
  return (
    (error as { error?: DevError })?.error ?? {
      code: 'invalid_state',
      retryable: false,
      message: error instanceof Error ? error.message : 'command failed',
    }
  )
}

export function ResourcesPane(props: ResourcesPaneProps) {
  const runtime = () => props.runtime
  const scope = () => runtime().preferenceScope?.()
  const serviceReady = () => runtime().state().status === 'ready'

  async function execute<T>(
    operation: Parameters<typeof buildDevCommand>[0]['operation'],
    body: Record<string, unknown>,
    resource?: { kind: string; id: string; generation: number }
  ): Promise<T> {
    const activeScope = scope()
    if (!activeScope) throw new Error('unauthenticated')
    const reply = await runtime().execute(
      buildDevCommand({ operation, scope: activeScope, body, ...(resource ? { resource } : {}) })
    )
    if (!reply.ok) throw reply
    return reply.value as T
  }

  const [snapshot, { refetch: refetchSnapshot }] = createResource(serviceReady, async (ready) => {
    if (!ready) return undefined
    return execute<Snapshot>('dev.resources.snapshot', {})
  })
  const [usage, { refetch: refetchUsage }] = createResource(serviceReady, async (ready) => {
    if (!ready) return { items: [] as readonly UsageRecord[] }
    return execute<UsagePage>('dev.resources.usage', {})
  })

  const refresh = () => {
    void refetchSnapshot()
    void refetchUsage()
  }

  // ── Stop flow: plan → confirm → commit ────────────────────────────────
  const [pendingPlan, setPendingPlan] = createSignal<
    { plan: MutationPlan; record: ProcessRecord } | undefined
  >(undefined)
  const [stopError, setStopError] = createSignal<DevError | undefined>(undefined)
  const [stopBusy, setStopBusy] = createSignal(false)

  async function requestStop(record: ProcessRecord): Promise<void> {
    setStopError(undefined)
    setStopBusy(true)
    try {
      const plan = await execute<MutationPlan>(
        'dev.resources.stopPlan',
        {
          processRecordId: record.id,
          expectedGeneration: record.generation,
          reason: `stop ${record.ownerKind} ${record.ownerId}`,
        },
        { kind: 'process', id: record.id, generation: record.generation }
      )
      setPendingPlan({ plan, record })
    } catch (error) {
      setStopError(commandError(error))
    } finally {
      setStopBusy(false)
    }
  }

  async function commitStop(): Promise<void> {
    const pending = pendingPlan()
    if (!pending) return
    setStopError(undefined)
    setStopBusy(true)
    try {
      await execute<{ id: string; state: string }>(
        'dev.resources.stopCommit',
        { planId: pending.plan.id, planDigest: pending.plan.digest },
        { kind: 'process', id: pending.record.id, generation: pending.plan.resource.generation }
      )
      setPendingPlan(undefined)
      void refetchSnapshot()
    } catch (error) {
      setStopError(commandError(error))
      setPendingPlan(undefined)
    } finally {
      setStopBusy(false)
    }
  }

  const rows = () => processRows(snapshot()?.processes ?? [])
  const ports = () => snapshot()?.ports ?? []
  const cards = () => usageCards(usage()?.items ?? [], Date.now())
  const retained = () => retainedGroups(snapshot()?.retainedData ?? [])
  const summary = () => metricSummary(snapshot()?.metrics ?? [])

  return (
    <div class="dev-resources" role="region" aria-label="Runtime resources">
      <div class="dev-resources__header">
        <span class="dev-resources__title">Runtime resources</span>
        <button
          type="button"
          class="dev-resources__refresh"
          aria-label="Refresh resources"
          disabled={!serviceReady()}
          onClick={refresh}
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </div>
      <Show
        when={serviceReady()}
        fallback={<p class="dev-resources__unavailable">Runtime unavailable</p>}
      >
        <Show
          when={!snapshot.loading && snapshot()}
          fallback={<p class="dev-resources__note">Loading…</p>}
        >
          <section class="dev-resources__section" aria-label="Processes">
            <h3>Processes</h3>
            <Show
              when={rows().length > 0}
              fallback={<p class="dev-resources__note">No Adea-owned processes are running.</p>}
            >
              <ul class="dev-resources__list">
                <For each={rows()}>
                  {(row) => (
                    <li class="dev-resources__row">
                      <span class="dev-resources__row-main">
                        <span class="dev-resources__row-title">
                          {row.record.ownerKind} · {row.record.ownerId}
                        </span>
                        <span class="dev-resources__row-detail">
                          pid {row.record.pid} · gen {row.record.generation} · {row.stateLabel}
                        </span>
                      </span>
                      <Show when={row.stoppable}>
                        <button
                          type="button"
                          class="dev-resources__stop"
                          disabled={stopBusy()}
                          onClick={() => void requestStop(row.record)}
                        >
                          Stop
                        </button>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
          <section class="dev-resources__section" aria-label="Ports">
            <h3>Ports</h3>
            <Show
              when={ports().length > 0}
              fallback={<p class="dev-resources__note">No loopback listeners observed.</p>}
            >
              <ul class="dev-resources__list">
                <For each={ports()}>
                  {(port) => (
                    <li class="dev-resources__row">
                      <span class="dev-resources__row-main">
                        <span class="dev-resources__row-title">
                          {port.host}:{port.port}
                        </span>
                        <span class="dev-resources__row-detail">
                          {port.owner} · {port.state}
                        </span>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
          <section class="dev-resources__section" aria-label="Metrics">
            <h3>Metrics</h3>
            <p class="dev-resources__row-detail">
              CPU:{' '}
              <Show when={summary().cpuPercent !== undefined} fallback={<span>unknown</span>}>
                {summary().cpuPercent!.toFixed(1)}%
              </Show>{' '}
              · RSS:{' '}
              <Show when={summary().residentBytes !== undefined} fallback={<span>unknown</span>}>
                {formatBytes(Number(summary().residentBytes))}
              </Show>{' '}
              · {summary().sampleCount} samples
            </p>
          </section>
          <section class="dev-resources__section" aria-label="Provider usage">
            <h3>Usage</h3>
            <Show
              when={cards().length > 0}
              fallback={<p class="dev-resources__note">No usage observations yet.</p>}
            >
              <ul class="dev-resources__list">
                <For each={cards()}>
                  {(card) => (
                    <li
                      class="dev-resources__row"
                      classList={{ 'dev-resources__row--alert': card.failure !== undefined }}
                    >
                      <span class="dev-resources__row-main">
                        <span class="dev-resources__row-title">
                          {card.provider}:{' '}
                          {card.failure !== undefined || card.quantityIsUnknown
                            ? 'unknown'
                            : `${card.quantity} ${card.unit}`}
                          {card.stale ? ' (stale)' : ''}
                        </span>
                        <span class="dev-resources__row-detail">
                          {card.sourceLabel}
                          {card.accountLabel !== undefined ? ` · ${card.accountLabel}` : ''}
                        </span>
                        <Show when={card.failure !== undefined}>
                          <span class="dev-resources__row-detail dev-resources__row-detail--error">
                            {card.failure!.code}: {card.failure!.message}
                          </span>
                        </Show>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
          <section class="dev-resources__section" aria-label="Retained data">
            <h3>Retained data</h3>
            <Show
              when={retained().length > 0}
              fallback={<p class="dev-resources__note">No retained data reported.</p>}
            >
              <ul class="dev-resources__list">
                <For each={retained()}>
                  {(group) => (
                    <li class="dev-resources__row">
                      <span class="dev-resources__row-main">
                        <span class="dev-resources__row-title">
                          {group.kind} · {formatBytes(group.totalBytes)}
                        </span>
                        <span class="dev-resources__row-detail">
                          {group.count} item{group.count === 1 ? '' : 's'}
                          {group.protectedBytes > 0
                            ? ` · ${formatBytes(group.protectedBytes)} protected`
                            : ''}
                        </span>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        </Show>
      </Show>
      <Show when={stopError() !== undefined}>
        <p class="dev-resources__error" role="alert">
          {stopError()!.code}: {stopError()!.message}
        </p>
      </Show>
      <Show when={pendingPlan() !== undefined}>
        <div class="dev-resources__confirm" role="alertdialog" aria-label="Confirm stop">
          <p>
            Stop pid {pendingPlan()!.record.pid} ({pendingPlan()!.record.ownerKind}{' '}
            {pendingPlan()!.record.ownerId})? The supervision engine re-verifies ownership before
            signalling.
          </p>
          <div class="dev-resources__confirm-actions">
            <button
              type="button"
              class="dev-resources__stop"
              disabled={stopBusy()}
              onClick={() => void commitStop()}
            >
              Confirm stop
            </button>
            <button
              type="button"
              class="dev-resources__cancel"
              disabled={stopBusy()}
              onClick={() => setPendingPlan(undefined)}
            >
              <X aria-hidden="true" /> Cancel
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}
