/*
 * Storage tab: what Adea keeps on disk. Worktrees are measured lazily by the
 * host (a walk that is still running or ran out of budget says so), split
 * into source and dependency/build bytes; retained data is the read-only
 * breakdown the owning slices report. Unmeasured sizes render as unknown,
 * never as zero.
 */
import { For, Show } from 'solid-js'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'

import { SegmentBar, Swatch } from './resources-charts'
import { retainedGroups } from './resources-model'
import { formatSize, type StorageRow, type StorageTotals } from './resources-view-model'
import type { RetainedDataRecord } from '@adea-ai/types/dev-runtime'

const RETAINED_LABELS: Record<RetainedDataRecord['kind'], string> = {
  terminal: 'Terminal history',
  checkpoint: 'Terminal checkpoints',
  screenshot: 'Screenshots',
  browser_profile: 'Browser profiles',
  log: 'Logs',
  dependency_template: 'Dependency templates',
}

const STATE_LABELS: Record<StorageRow['state'], string> = {
  measured: '',
  measuring: 'Measuring…',
  stale: 'Still measuring',
  unreadable: 'Unreadable',
  unknown: 'Not measured',
}

const BADGE_VARIANTS = {
  neutral: 'outline',
  success: 'success',
  warning: 'warning',
  danger: 'destructive',
  info: 'info',
} as const

export function StorageTab(props: {
  rows: readonly StorageRow[]
  totals: StorageTotals
  retained: readonly RetainedDataRecord[]
  diskFreeBytes?: number
  available: boolean
}) {
  const groups = () => retainedGroups(props.retained)
  return (
    <div class="dev-resources__tab">
      <div class="dev-resources__hero">
        <div class="dev-resources__hero-line">
          <span class="dev-resources__hero-value">{formatSize(props.totals.totalBytes)}</span>
          <span class="dev-resources__row-detail">on disk from Adea</span>
          <span class="dev-resources__spacer" />
          <Show when={props.diskFreeBytes !== undefined}>
            <span class="dev-resources__row-detail">{formatSize(props.diskFreeBytes)} free</span>
          </Show>
        </div>
        <SegmentBar
          label={`Storage: worktree source ${formatSize(props.totals.sourceBytes)}, builds and dependencies ${formatSize(props.totals.buildBytes)}, retained data ${formatSize(props.totals.retainedBytes)}`}
          parts={[
            { value: props.totals.sourceBytes, tone: 'source' },
            { value: props.totals.buildBytes, tone: 'build' },
            { value: props.totals.retainedBytes, tone: 'retained' },
          ]}
        />
        <div class="dev-resources__legend">
          <span class="dev-resources__legend-item">
            <Swatch tone="source" />
            Worktree source{' '}
            <span class="dev-resources__legend-value">{formatSize(props.totals.sourceBytes)}</span>
          </span>
          <span class="dev-resources__legend-item">
            <Swatch tone="build" />
            Builds &amp; dependencies{' '}
            <span class="dev-resources__legend-value">{formatSize(props.totals.buildBytes)}</span>
          </span>
          <span class="dev-resources__legend-item">
            <Swatch tone="retained" />
            Retained data{' '}
            <span class="dev-resources__legend-value">
              {formatSize(props.totals.retainedBytes)}
            </span>
          </span>
        </div>
        <Show when={props.totals.partial && props.rows.length > 0}>
          <p class="dev-resources__note">Some worktrees are still being measured.</p>
        </Show>
      </div>

      <section class="dev-resources__group" aria-label="Worktrees">
        <h3 class="dev-resources__group-header">
          <span class="dev-resources__group-title">Worktrees</span>
          <span class="dev-resources__row-detail">{props.rows.length}</span>
        </h3>
        <Show
          when={props.available}
          fallback={
            <p class="dev-resources__note">Worktree sizes are not available on this runtime.</p>
          }
        >
          <Show
            when={props.rows.length > 0}
            fallback={<p class="dev-resources__note">No worktrees in this workspace.</p>}
          >
            <ul class="dev-resources__list">
              <For each={props.rows}>
                {(row) => (
                  <li class="dev-resources__storage-row">
                    <span class="dev-resources__row-main">
                      <span class="dev-resources__row-title">
                        <span class="dev-resources__code dev-resources__truncate">{row.title}</span>
                      </span>
                      <span class="dev-resources__row-detail">
                        <Show
                          when={row.state === 'measured' || row.state === 'stale'}
                          fallback={STATE_LABELS[row.state]}
                        >
                          {formatSize(row.sourceBytes)} source · {formatSize(row.buildBytes)} builds
                          <Show when={row.state === 'stale'}> · {STATE_LABELS.stale}</Show>
                        </Show>
                      </span>
                    </span>
                    <span class="dev-resources__badges">
                      <For each={row.badges}>
                        {(badge) => (
                          <Badge variant={BADGE_VARIANTS[badge.tone]} size="sm">
                            {badge.label}
                          </Badge>
                        )}
                      </For>
                    </span>
                    <span class="dev-resources__server-memory">{formatSize(row.totalBytes)}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </section>

      <section class="dev-resources__group" aria-label="Retained data">
        <h3 class="dev-resources__group-header">
          <span class="dev-resources__group-title">Retained data</span>
          <span class="dev-resources__row-detail">Kept by Adea outside worktrees</span>
        </h3>
        <Show
          when={groups().length > 0}
          fallback={<p class="dev-resources__note">No retained data reported.</p>}
        >
          <ul class="dev-resources__list">
            <For each={groups()}>
              {(group) => (
                <li class="dev-resources__storage-row">
                  <span class="dev-resources__row-main">
                    <span class="dev-resources__row-title">{RETAINED_LABELS[group.kind]}</span>
                    <span class="dev-resources__row-detail">
                      {group.count} {group.count === 1 ? 'item' : 'items'}
                    </span>
                  </span>
                  <span class="dev-resources__badges">
                    <Show when={group.protectedBytes > 0}>
                      <StatusChip
                        tone="neutral"
                        label="Protected"
                        detail="Deletion follows the owning slice's own re-proved path"
                      />
                    </Show>
                  </span>
                  <span class="dev-resources__server-memory">{formatSize(group.totalBytes)}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </div>
  )
}
