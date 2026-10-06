/*
 * Server details: one row's memory and CPU history, what it is, who started
 * it, and how Adea knows. For Adea's own processes the ownership line names
 * the proven launch record; for everything else it says Adea did not start
 * it and why it is or is not stoppable.
 */
import { ChevronLeft, RotateCcw, Square } from 'lucide-solid'
import { Show } from 'solid-js'
import { Alert, AlertDescription, AlertTitle } from '@adea-ai/ui/components/ui/alert'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'

import { Sparkline } from './resources-charts'
import { formatPercent, formatSize, STATE_LABELS, type ServerRow } from './resources-view-model'

const PROTECTION_TEXT = {
  none: 'Not protected',
  protected_list: 'Protected by your settings',
  system: 'Part of the system or Adea',
  other_user: 'Owned by another user',
} as const

export function ServerDetail(props: {
  row: ServerRow
  busy: boolean
  onBack(): void
  onStop(row: ServerRow): void
  onRestart(row: ServerRow): void
}) {
  const row = () => props.row
  const foreign = () =>
    row().kind === 'foreign' ? (row() as Extract<ServerRow, { kind: 'foreign' }>) : undefined
  const owned = () =>
    row().kind === 'owned' ? (row() as Extract<ServerRow, { kind: 'owned' }>) : undefined
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
              ? `Memory grew ${formatSize(row().leak.growthBytes)} recently`
              : 'Memory is over your limit'}
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
          <span class="dev-resources__row-detail">Memory · recent</span>
          <span class="dev-resources__tile-value">{formatSize(row().residentBytes)}</span>
          <Sparkline
            values={row().history.map((point) => point.bytes)}
            tone={row().leak.kind !== 'normal' ? 'warning' : 'neutral'}
            width={240}
            height={64}
            label={`Memory history for ${row().title}`}
          />
        </div>
        <div class="dev-resources__tile">
          <span class="dev-resources__row-detail">CPU</span>
          <span class="dev-resources__tile-value">{formatPercent(row().cpuPercent)}</span>
          <Sparkline
            values={owned()?.cpuHistory ?? []}
            tone="cpu"
            width={240}
            height={64}
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
