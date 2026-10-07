/*
 * Copyright (c) 2026 Adea contributors.
 *
 * Machine-wide janitor tab (#424 follow-up): junk regardless of origin —
 * derived data, caches, logs, unregistered git worktrees, and the Trash —
 * with bounded async sizing and an explicit, recoverable cleanup. The safety
 * contract is the host's; the tab only makes it legible: every item names its
 * disposal, nothing runs without a checked selection plus a plan confirmation
 * that names what will be removed and the total size, and the Trash (not a
 * hard delete) is the default destination.
 */
import type {
  DevError,
  JanitorCommitResult,
  JanitorItem,
  JanitorPlan,
  JanitorScanReport,
} from '@adea-ai/types/dev-runtime'
import { Trash2 } from 'lucide-solid'
import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@adea-ai/ui/components/ui/alert-dialog'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Checkbox } from '@adea-ai/ui/components/ui/checkbox'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'

import { commandError } from './resources-stop-dialog'
import { sectionExpanded, toggleSection } from './resources-preview'
import { formatAge, formatSize, listPreview } from './resources-view-model'
import {
  janitorMeasureIds,
  janitorSections,
  janitorSelectionSummary,
  JANITOR_DISPOSAL_LABELS,
  type JanitorSectionView,
} from './janitor-view-model'

export type JanitorRunner = <T>(
  operation:
    | 'dev.resources.janitorScan'
    | 'dev.resources.janitorMeasure'
    | 'dev.resources.janitorPlan'
    | 'dev.resources.janitorCommit',
  body: Record<string, unknown>,
  resource?: { kind: string; id: string; generation: number }
) => Promise<T>

function itemBytes(item: JanitorItem): number | undefined {
  if (item.bytes === undefined) return undefined
  const parsed = Number(item.bytes)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function SectionRows(props: {
  section: JanitorSectionView
  selected: ReadonlySet<string>
  busy: boolean
  onToggle(id: string, value: boolean): void
}) {
  // Massive sections collapse to the first 8 rows, like the server lists.
  const preview = () =>
    listPreview(props.section.items, sectionExpanded(`janitor:${props.section.id}`))
  return (
    <section class="dev-resources__group" aria-label={props.section.title}>
      <h3 class="dev-resources__group-header">
        <span class="dev-resources__group-title">{props.section.title}</span>
        <span class="dev-resources__row-detail">
          {props.section.items.length} {props.section.items.length === 1 ? 'item' : 'items'}
        </span>
        <span class="dev-resources__spacer" />
        <span class="dev-resources__row-detail">{formatSize(props.section.totalBytes)}</span>
      </h3>
      <ul class="dev-resources__list">
        <For each={preview().visible}>
          {(item) => (
            <li class="dev-resources__check-row">
              <Checkbox
                checked={props.selected.has(item.id)}
                disabled={props.busy}
                label={item.label}
                description={
                  item.state === 'measured' || item.state === 'stale'
                    ? item.pathLabel
                    : `${item.pathLabel} · measuring…`
                }
                onChange={(value: boolean) => props.onToggle(item.id, value)}
              />
              <span class="dev-resources__janitor-meta">
                <Show when={item.modifiedAt}>
                  {(modified) => (
                    <span class="dev-resources__row-detail">
                      changed {formatAge(Date.now() - Date.parse(modified()))} ago
                    </span>
                  )}
                </Show>
                <span class="dev-resources__server-memory">{formatSize(itemBytes(item))}</span>
                <Badge variant={item.disposal === 'trash' ? 'outline' : 'warning'} size="sm">
                  {JANITOR_DISPOSAL_LABELS[item.disposal]}
                </Badge>
              </span>
            </li>
          )}
        </For>
      </ul>
      <Show when={preview().hidden > 0}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => toggleSection(`janitor:${props.section.id}`, true)}
        >
          Show {preview().hidden} more
        </Button>
      </Show>
      <Show when={preview().expanded && props.section.items.length > 8}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => toggleSection(`janitor:${props.section.id}`, false)}
        >
          Show less
        </Button>
      </Show>
    </section>
  )
}

export function JanitorTab(props: {
  report: JanitorScanReport
  items: readonly JanitorItem[]
  run: JanitorRunner
  onMeasure(ids: readonly string[]): void
  onRefresh(): void
  onDone(message: string): void
}) {
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set())
  const [plan, setPlan] = createSignal<JanitorPlan>()
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<DevError>()

  const sections = createMemo(() => janitorSections(props.items))

  // Size the visible window asynchronously: the pane asks the host for at
  // most the first 64 undiscovered items, and the sheet never blocks.
  createEffect(
    on(
      () => props.report.observationGeneration,
      () => {
        setSelected(new Set<string>())
        props.onMeasure(janitorMeasureIds(props.items))
      }
    )
  )

  const chosen = createMemo(() => props.items.filter((item) => selected().has(item.id)))
  const summary = createMemo(() => janitorSelectionSummary(chosen()))

  function toggle(id: string, value: boolean): void {
    setSelected((current) => {
      const next = new Set(current)
      if (value) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function requestPlan(): Promise<void> {
    setError(undefined)
    setBusy(true)
    try {
      const requested = await props.run<JanitorPlan>('dev.resources.janitorPlan', {
        itemIds: [...chosen()].map((item) => item.id),
        expectedGeneration: props.report.observationGeneration,
      })
      setPlan(requested)
      setConfirming(true)
    } catch (failure) {
      setError(commandError(failure))
    } finally {
      setBusy(false)
    }
  }

  async function confirm(): Promise<void> {
    const current = plan()
    if (!current) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await props.run<JanitorCommitResult>(
        'dev.resources.janitorCommit',
        { planId: current.plan.id, planDigest: current.plan.digest },
        current.plan.resource
      )
      const moved = result.outcomes.filter(
        (outcome) =>
          outcome.outcome === 'trashed' ||
          outcome.outcome === 'emptied' ||
          outcome.outcome === 'pruned'
      )
      const skipped = result.outcomes.filter(
        (outcome) => outcome.outcome === 'skipped' || outcome.outcome === 'failed'
      )
      props.onDone(
        `Cleaned ${moved.length} of ${result.outcomes.length} ${
          result.outcomes.length === 1 ? 'item' : 'items'
        }${skipped.length > 0 ? ` · ${skipped.length} skipped or failed` : ''}.`
      )
      setPlan(undefined)
      setConfirming(false)
      setSelected(new Set<string>())
      props.onRefresh()
    } catch (failure) {
      setError(commandError(failure))
    } finally {
      setBusy(false)
    }
  }

  const planned = () => plan()?.items ?? []

  return (
    <div class="dev-resources__tab">
      <p class="dev-resources__note">
        Everything here is junk regardless of what created it. Nothing is removed until you select
        it and confirm; cleanup moves items to the Trash so they stay recoverable.
      </p>

      <Show
        when={sections().length > 0}
        fallback={<p class="dev-resources__note">No junk found in the well-known locations.</p>}
      >
        <For each={sections()}>
          {(section) => (
            <SectionRows section={section} selected={selected()} busy={busy()} onToggle={toggle} />
          )}
        </For>
      </Show>

      <Show when={error()}>
        {(failure) => (
          <Alert variant="destructive">
            <AlertDescription>
              {failure().message} <span class="dev-resources__code">({failure().code})</span>
            </AlertDescription>
          </Alert>
        )}
      </Show>

      <div class="dev-resources__footer">
        <span class="dev-resources__row-main">
          <span class="dev-resources__row-title">
            <Show
              when={summary().totalBytes !== undefined}
              fallback={`${summary().count} selected`}
            >
              Frees about {formatSize(summary().totalBytes)}
            </Show>
          </span>
          <span class="dev-resources__row-detail">
            {summary().permanent
              ? 'Includes permanent steps: emptying Trash entries or pruning Git registry entries.'
              : 'Moves to the Trash — recoverable until the Trash is emptied.'}
          </span>
        </span>
        <ActionButton
          type="button"
          variant="destructive"
          size="sm"
          busy={busy()}
          busyLabel="Planning"
          tooltip="Plans the cleanup, then asks you to confirm exactly what will be removed"
          disabled={summary().count === 0 || busy()}
          onClick={() => void requestPlan()}
        >
          <Trash2 aria-hidden="true" />
          Clean up {summary().count} {summary().count === 1 ? 'item' : 'items'}…
        </ActionButton>
      </div>

      <AlertDialog
        open={confirming()}
        onOpenChange={(open) => {
          if (!open && !busy()) {
            setConfirming(false)
            setPlan(undefined)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Clean up {planned().length} {planned().length === 1 ? 'item' : 'items'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Everything named below is removed exactly as stated. Trash moves are recoverable;
              emptying Trash entries and Git prunes are not.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul class="dev-resources__list">
            <For each={planned()}>
              {(item) => (
                <li class="dev-resources__check-row">
                  <span class="dev-resources__row-main">
                    <span class="dev-resources__row-title">
                      <span class="dev-resources__code">{item.pathLabel}</span>
                    </span>
                    <span class="dev-resources__row-detail">
                      {JANITOR_DISPOSAL_LABELS[item.disposal]}
                    </span>
                  </span>
                  <span class="dev-resources__server-memory">{formatSize(itemBytes(item))}</span>
                </li>
              )}
            </For>
          </ul>
          <p class="dev-resources__note">
            <Show
              when={plan()?.totalBytes !== undefined}
              fallback="Some sizes are not measured yet."
            >
              Total: about {formatSize(Number(plan()?.totalBytes))}
            </Show>
            . The plan is checked again right before anything moves.
          </p>
          <Show when={error()}>
            {(failure) => (
              <Alert variant="destructive">
                <AlertDescription>
                  {failure().message} <span class="dev-resources__code">({failure().code})</span>
                </AlertDescription>
              </Alert>
            )}
          </Show>
          <AlertDialogFooter>
            <AlertDialogCancel as={Button} type="button" variant="outline" disabled={busy()}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              as={ActionButton}
              type="button"
              variant="destructive"
              busy={busy()}
              busyLabel="Cleaning up"
              disabled={plan() === undefined || busy()}
              closeOnClick={false}
              onClick={(event: MouseEvent) => {
                event.preventDefault()
                void confirm()
              }}
            >
              Clean up {planned().length} {planned().length === 1 ? 'item' : 'items'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
