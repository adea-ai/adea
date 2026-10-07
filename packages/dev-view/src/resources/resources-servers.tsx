/*
 * Servers & apps tab: Adea's servers grouped by worktree, then everything
 * else running on the machine. A row shows its port, what it is, who started
 * it, a memory sparkline, and its memory; row actions are the shared
 * ActionButton with an explanatory tooltip. Stop and restart only appear
 * when the host marked the row actionable; protected rows show why instead.
 */
import { ChevronRight, GitBranch, Lock, RotateCcw, Square } from 'lucide-solid'
import { For, Show } from 'solid-js'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { cn } from '@adea-ai/ui/lib/utils'

import { Sparkline } from './resources-charts'
import { sectionExpanded, toggleSection } from './resources-preview'
import {
  formatSize,
  leakText,
  listPreview,
  LIST_PREVIEW_LIMIT,
  type ServerGroup,
  type ServerRow,
} from './resources-view-model'

export type ServerActions = Readonly<{
  onDetails(row: ServerRow): void
  onStop(row: ServerRow): void
  onRestart(row: ServerRow): void
  busy: boolean
}>

function portLabels(row: ServerRow): string[] {
  if (row.kind === 'owned') return row.ports.map((port) => `${port.host}:${port.port}`)
  return row.ports.map((port) => `:${port}`)
}

function protectionText(row: ServerRow): string | undefined {
  if (row.kind !== 'foreign') return undefined
  switch (row.record.protection) {
    case 'protected_list':
      return 'Protected by your settings'
    case 'system':
      return 'Part of the system or Adea'
    case 'other_user':
      return 'Owned by another user'
    default:
      return undefined
  }
}

export function ServerRowView(props: { row: ServerRow; actions: ServerActions }) {
  const row = () => props.row
  const warning = () => row().leak.kind !== 'normal'
  const ports = () => portLabels(row())
  return (
    <li
      class={cn('dev-resources__server', {
        'dev-resources__server--warning': warning(),
        'dev-resources__server--muted': row().kind === 'owned' && !row().stoppable,
      })}
    >
      <span class="dev-resources__server-port" title={ports().join(', ') || undefined}>
        <Show when={ports().length > 0} fallback={<span class="dev-resources__row-detail">—</span>}>
          <span class="dev-resources__code">{ports()[0]}</span>
          <Show when={ports().length > 1}>
            <span class="dev-resources__row-detail">+{ports().length - 1}</span>
          </Show>
        </Show>
      </span>
      <span class="dev-resources__row-main">
        <span class="dev-resources__row-title">
          <span class="dev-resources__truncate">{row().title}</span>
          <Show
            when={
              row().kind === 'foreign' && (row() as { attributionLabel?: string }).attributionLabel
            }
          >
            {(label) => (
              <Badge variant="info" size="sm">
                {label()}
              </Badge>
            )}
          </Show>
        </span>
        <span
          class={cn('dev-resources__row-detail dev-resources__truncate', {
            'dev-resources__row-detail--warning': warning(),
          })}
        >
          {leakText(row().leak) ?? protectionText(row()) ?? row().detail}
        </span>
      </span>
      <Sparkline
        values={row().history.map((point) => point.bytes)}
        tone={warning() ? 'warning' : 'neutral'}
      />
      <span
        class={cn('dev-resources__server-memory', {
          'dev-resources__server-memory--warning': warning(),
        })}
      >
        {formatSize(row().residentBytes)}
      </span>
      <span class="dev-resources__server-actions">
        <Show
          when={
            row().kind === 'foreign' &&
            (row() as { record: { protection: string } }).record.protection !== 'none'
          }
        >
          <Lock class="dev-resources__icon" aria-label="Protected" />
        </Show>
        <Show when={row().kind === 'owned' && row().stoppable}>
          <ActionButton
            type="button"
            variant="ghost"
            size="icon-sm"
            tooltip="Restart: stop it and start it again"
            aria-label={`Restart ${row().title}`}
            disabled={props.actions.busy}
            onClick={() => props.actions.onRestart(row())}
          >
            <RotateCcw aria-hidden="true" />
          </ActionButton>
        </Show>
        <Show when={row().stoppable}>
          <ActionButton
            type="button"
            variant="ghost"
            size="icon-sm"
            tooltip={
              row().kind === 'foreign' ? 'Stop… Adea did not start this; it asks first' : 'Stop…'
            }
            aria-label={`Stop ${row().title}`}
            disabled={props.actions.busy}
            onClick={() => props.actions.onStop(row())}
          >
            <Square aria-hidden="true" />
          </ActionButton>
        </Show>
        <ActionButton
          type="button"
          variant="ghost"
          size="icon-sm"
          tooltip="Details"
          aria-label={`Details for ${row().title}`}
          onClick={() => props.actions.onDetails(row())}
        >
          <ChevronRight aria-hidden="true" />
        </ActionButton>
      </span>
    </li>
  )
}

export function ServersTab(props: {
  groups: readonly ServerGroup[]
  /** Why rows from elsewhere are missing, when they are. */
  foreignNote?: string
  actions: ServerActions
}) {
  return (
    <div class="dev-resources__tab">
      <Show
        when={props.groups.length > 0}
        fallback={<p class="dev-resources__note">Nothing is running right now.</p>}
      >
        <For each={props.groups}>
          {(group) => {
            // Massive sections collapse to the first 8 rows; expanding one is
            // a per-session choice (resources-preview).
            const preview = () => listPreview(group.rows, sectionExpanded(group.id))
            return (
              <section class="dev-resources__group" aria-label={group.title}>
                <h3 class="dev-resources__group-header">
                  <Show when={group.kind === 'worktree' || group.kind === 'missing_worktree'}>
                    <GitBranch class="dev-resources__icon" aria-hidden="true" />
                  </Show>
                  <Show when={group.kind === 'protected'}>
                    <Lock class="dev-resources__icon" aria-hidden="true" />
                  </Show>
                  <span class="dev-resources__group-title">{group.title}</span>
                  <span class="dev-resources__row-detail">{group.subtitle}</span>
                  <span class="dev-resources__spacer" />
                  <span class="dev-resources__row-detail">{formatSize(group.totalBytes)}</span>
                </h3>
                <ul class="dev-resources__list">
                  <For each={preview().visible}>
                    {(row) => <ServerRowView row={row} actions={props.actions} />}
                  </For>
                </ul>
                <Show when={preview().hidden > 0}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleSection(group.id, true)}
                  >
                    Show {preview().hidden} more
                  </Button>
                </Show>
                <Show when={preview().expanded && group.rows.length > LIST_PREVIEW_LIMIT}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleSection(group.id, false)}
                  >
                    Show less
                  </Button>
                </Show>
              </section>
            )
          }}
        </For>
      </Show>
      <Show when={props.foreignNote}>{(note) => <p class="dev-resources__note">{note()}</p>}</Show>
    </div>
  )
}
