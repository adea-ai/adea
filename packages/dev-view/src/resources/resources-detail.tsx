/*
 * Server details: one row's memory and CPU history, what it is, who started
 * it, and how Adea knows. For Adea's own processes the ownership line names
 * the proven launch record; for everything else it says Adea did not start
 * it and why it is or is not stoppable.
 */
import { ChevronLeft, ExternalLink, RotateCcw, Square, SquareTerminal } from 'lucide-solid'
import { Show } from 'solid-js'
import { Alert, AlertDescription, AlertTitle } from '@adea-ai/ui/components/ui/alert'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'

import type { ResourcePreferencesInput } from '@adea-ai/types/dev-runtime'

import { TrendChart } from './resources-charts'
import {
  formatDuration,
  formatPercent,
  formatSize,
  startedLabel,
  STATE_LABELS,
  type ServerRow,
} from './resources-view-model'

const PROTECTION_TEXT = {
  none: 'Not protected',
  protected_list: 'Protected by your settings',
  system: 'Part of the system or Adea',
  other_user: 'Owned by another user',
} as const

export function ServerDetail(props: {
  row: ServerRow
  busy: boolean
  alerts: ResourcePreferencesInput['alerts']
  now: number
  onBack(): void
  onStop(row: ServerRow): void
  onRestart(row: ServerRow): void
  /** Opens the row's preview URL; absent hides the action. */
  onOpenPreview?(url: string): void
  /** Focuses the row's runtime session in Dev; absent hides the action. */
  onOpenSession?(row: Extract<ServerRow, { kind: 'owned' }>): void
}) {
  const row = () => props.row
  const foreign = () =>
    row().kind === 'foreign' ? (row() as Extract<ServerRow, { kind: 'foreign' }>) : undefined
  const owned = () =>
    row().kind === 'owned' ? (row() as Extract<ServerRow, { kind: 'owned' }>) : undefined
  const limit = () => {
    const value = Number(props.alerts.residentBytesAbove)
    return Number.isFinite(value) && value > 0 ? value : undefined
  }
  const ports = () =>
    row().kind === 'owned'
      ? (owned()?.ports ?? []).map((port) => `${port.host}:${port.port}`)
      : (foreign()?.ports ?? []).map((port) => `:${port}`)
  return (
    <div class="dev-resources__view" aria-label={`Details for ${row().title}`} role="group">
      <div class="dev-resources__view-header">
        <ActionButton
          type="button"
          variant="ghost"
          size="icon-sm"
          tooltip="Back"
          aria-label="Back to servers"
          onClick={props.onBack}
        >
          <ChevronLeft aria-hidden="true" />
        </ActionButton>
        <div class="dev-resources__row-main">
          <span class="dev-resources__row-title">
            <Show when={ports()[0]}>
              {(port) => <span class="dev-resources__code">{port()}</span>}
            </Show>
            <span class="dev-resources__truncate">{row().title}</span>
            <Show when={row().leak.kind !== 'normal'}>
              <Badge variant="warning" size="sm">
                {row().leak.kind === 'growing' ? 'Leaking' : 'Over limit'}
              </Badge>
            </Show>
            <Badge variant="outline" size="sm">
              {row().kind === 'owned' ? 'Started by Adea' : 'Not started by Adea'}
            </Badge>
          </span>
          <span class="dev-resources__row-detail">{row().detail}</span>
        </div>
      </div>

      <div class="dev-resources__view-actions">
        <Show when={props.onOpenPreview && owned()?.previewUrl}>
          {(url) => (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => props.onOpenPreview?.(url())}
            >
              <ExternalLink aria-hidden="true" />
              Open preview
            </Button>
          )}
        </Show>
        <Show when={props.onOpenSession && owned()?.record.runtimeSessionId !== undefined}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const current = owned()
              if (current) props.onOpenSession?.(current)
            }}
          >
            <SquareTerminal aria-hidden="true" />
            Go to session
          </Button>
        </Show>
        <span class="dev-resources__spacer" />
        <Show when={owned()?.stoppable}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.busy}
            onClick={() => props.onRestart(row())}
          >
            <RotateCcw aria-hidden="true" />
            Restart
          </Button>
        </Show>
        <Show when={row().stoppable}>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={props.busy}
            onClick={() => props.onStop(row())}
          >
            <Square aria-hidden="true" />
            Stop…
          </Button>
        </Show>
      </div>

      <Show when={row().leak.kind !== 'normal'}>
        <Alert variant="warning">
          <AlertTitle>
            {row().leak.kind === 'growing'
              ? `Memory grew ${formatSize(row().leak.growthBytes)} in ${formatDuration(row().leak.windowSeconds ?? props.alerts.growthWindowSeconds)}`
              : `Memory is over your ${formatSize(limit())} limit`}
          </AlertTitle>
          <AlertDescription>
            {row().kind === 'owned'
              ? 'Restarting usually releases it.'
              : 'Stopping it releases the memory; Adea did not start it, so it asks first.'}
          </AlertDescription>
        </Alert>
      </Show>

      <div class="dev-resources__tiles">
        <div class="dev-resources__tile">
          <span class="dev-resources__row-detail">Memory</span>
          <span class="dev-resources__tile-value">{formatSize(row().residentBytes)}</span>
          <TrendChart
            samples={row().history.map((point) => ({ at: point.at, value: point.bytes }))}
            tone={row().leak.kind !== 'normal' ? 'warning' : 'neutral'}
            {...(limit() !== undefined
              ? { threshold: limit(), thresholdLabel: `Limit ${formatSize(limit())}` }
              : {})}
            now={props.now}
            label={`Memory history for ${row().title}`}
          />
        </div>
        <div class="dev-resources__tile">
          <span class="dev-resources__row-detail">CPU</span>
          <span class="dev-resources__tile-value">{formatPercent(row().cpuPercent)}</span>
          <TrendChart
            samples={owned()?.cpuPoints ?? []}
            tone="cpu"
            now={props.now}
            label={`CPU history for ${row().title}`}
          />
        </div>
      </div>

      <dl class="dev-resources__facts">
        <Show when={foreign()}>
          {(current) => (
            <>
              <Show when={current().record.commandPreview}>
                <dt>Command</dt>
                <dd class="dev-resources__code">{current().record.commandPreview}</dd>
              </Show>
              <Show when={current().record.cwdLabel}>
                <dt>Folder</dt>
                <dd class="dev-resources__code">{current().record.cwdLabel}</dd>
              </Show>
              <dt>Started by</dt>
              <dd>{current().attributionLabel ?? 'Unknown'}</dd>
              <dt>Process</dt>
              <dd>
                PID {current().record.pid} · {current().record.childCount} child{' '}
                {current().record.childCount === 1 ? 'process' : 'processes'}
              </dd>
              <dt>Started</dt>
              <dd>{startedLabel(current().record.startIdentity, props.now)}</dd>
              <dt>Executable</dt>
              <dd class="dev-resources__code">{current().record.executableIdentity}</dd>
              <dt>Protection</dt>
              <dd>{PROTECTION_TEXT[current().record.protection]}</dd>
            </>
          )}
        </Show>
        <Show when={owned()}>
          {(current) => (
            <>
              <dt>Owner</dt>
              <dd>{current().title}</dd>
              <dt>Command</dt>
              <dd class="dev-resources__code">{current().record.executableIdentity}</dd>
              <Show when={current().sessionLabel}>
                <dt>Session</dt>
                <dd>{current().sessionLabel}</dd>
              </Show>
              <dt>Started</dt>
              <dd>{startedLabel(current().record.startIdentity, props.now)}</dd>
              <Show when={current().previewUrl}>
                <dt>Preview</dt>
                <dd class="dev-resources__code">{current().previewUrl}</dd>
              </Show>
              <dt>State</dt>
              <dd>{STATE_LABELS[current().record.state]}</dd>
              <dt>Ownership</dt>
              <dd>
                Proven launch record · PID {current().record.pid} · generation{' '}
                {current().record.generation}
              </dd>
            </>
          )}
        </Show>
      </dl>
    </div>
  )
}
