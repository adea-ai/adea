/*
 * Clean-up review. It composes existing authorities and adds none: a selected
 * Adea server goes through the owned stop plan/commit, a selected worktree
 * through Complete-and-clean (`dev.worktree.cleanupPlan`/`cleanupCommit`,
 * quarantine first, branch kept), and each step is planned again right before
 * it runs. Worktree plans are fetched when the review opens so every blocker
 * the host reports is shown. Processes Adea did not start are listed
 * unchecked and each one opens its own confirmation; nothing here can stop
 * them in bulk.
 */
import type { DevError, MutationPlan, Worktree } from '@adea-ai/types/dev-runtime'
import { ChevronLeft, Lock, Square } from 'lucide-solid'
import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Checkbox } from '@adea-ai/ui/components/ui/checkbox'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'

import { commandError } from './resources-stop-dialog'
import { formatSize, type CleanupCandidate, type ServerRow } from './resources-view-model'

export type CleanupRunner = <T>(
  operation:
    | 'dev.resources.stopPlan'
    | 'dev.resources.stopCommit'
    | 'dev.worktree.cleanupPlan'
    | 'dev.worktree.cleanupCommit',
  body: Record<string, unknown>,
  resource: { kind: string; id: string; generation: number }
) => Promise<T>

type WorktreeCheck =
  | { state: 'checking' }
  | { state: 'ready' }
  | { state: 'blocked'; reasons: readonly string[] }
  | { state: 'failed'; error: DevError }

const WORKTREE_STEPS = ['quarantine_worktree', 'unregister_worktree'] as const

async function planWorktree(run: CleanupRunner, worktree: Worktree): Promise<MutationPlan> {
  return run<MutationPlan>(
    'dev.worktree.cleanupPlan',
    {
      worktreeId: worktree.id,
      expectedGeneration: worktree.generation,
      selectedOwnedResourceIds: [],
      allowedSteps: [...WORKTREE_STEPS],
    },
    { kind: 'worktree', id: worktree.id, generation: worktree.generation }
  )
}

export function CleanupReview(props: {
  candidates: readonly CleanupCandidate[]
  run: CleanupRunner
  mode: 'off' | 'ask' | 'automatic'
  onBack(): void
  onStopForeign(row: ServerRow): void
  onFinished(message: string): void
  onOpenSettings(): void
}) {
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set())
  const [checks, setChecks] = createSignal<ReadonlyMap<string, WorktreeCheck>>(new Map())
  const [running, setRunning] = createSignal(false)
  const [failures, setFailures] = createSignal<readonly string[]>([])

  createEffect(
    on(
      () => props.candidates.map((candidate) => candidate.id).join('|'),
      () => {
        setSelected(new Set(props.candidates.filter((c) => c.preselected).map((c) => c.id)))
        const worktrees = props.candidates.filter(
          (candidate): candidate is Extract<CleanupCandidate, { kind: 'worktree' }> =>
            candidate.kind === 'worktree'
        )
        setChecks(
          new Map(worktrees.map((candidate) => [candidate.id, { state: 'checking' } as const]))
        )
        for (const candidate of worktrees.slice(0, 20)) {
          void planWorktree(props.run, candidate.worktree).then(
            (plan) => {
              const check: WorktreeCheck =
                plan.blockers.length === 0
                  ? { state: 'ready' }
                  : { state: 'blocked', reasons: plan.blockers.map((blocker) => blocker.message) }
              setChecks((current) => new Map(current).set(candidate.id, check))
              if (check.state !== 'ready') {
                setSelected((current) => {
                  const next = new Set(current)
                  next.delete(candidate.id)
                  return next
                })
              }
            },
            (error) => {
              setChecks((current) =>
                new Map(current).set(candidate.id, { state: 'failed', error: commandError(error) })
              )
              setSelected((current) => {
                const next = new Set(current)
                next.delete(candidate.id)
                return next
              })
            }
          )
        }
      }
    )
  )

  const actionable = createMemo(() =>
    props.candidates.filter((candidate) => {
      if (candidate.kind === 'foreign') return false
      if (candidate.kind === 'worktree') return checks().get(candidate.id)?.state === 'ready'
      return true
    })
  )
  const blocked = createMemo(() =>
    props.candidates.filter(
      (candidate): candidate is Extract<CleanupCandidate, { kind: 'worktree' }> => {
        if (candidate.kind !== 'worktree') return false
        const state = checks().get(candidate.id)?.state
        return state === 'blocked' || state === 'failed'
      }
    )
  )
  const foreign = () => props.candidates.filter((candidate) => candidate.kind === 'foreign')
  const chosen = () => actionable().filter((candidate) => selected().has(candidate.id))
  const freedDisk = () =>
    chosen().reduce(
      (sum, candidate) => sum + (candidate.kind === 'worktree' ? (candidate.diskBytes ?? 0) : 0),
      0
    )
  const freedMemory = () =>
    chosen().reduce(
      (sum, candidate) => sum + (candidate.kind === 'server' ? (candidate.memoryBytes ?? 0) : 0),
      0
    )

  function toggle(id: string, value: boolean): void {
    setSelected((current) => {
      const next = new Set(current)
      if (value) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function runSelected(): Promise<void> {
    setRunning(true)
    const failed: string[] = []
    let done = 0
    for (const candidate of chosen()) {
      try {
        if (candidate.kind === 'server') {
          const record = candidate.row.record
          const resource = { kind: 'process', id: record.id, generation: record.generation }
          const plan = await props.run<MutationPlan>(
            'dev.resources.stopPlan',
            {
              processRecordId: record.id,
              expectedGeneration: record.generation,
              reason: `Clean up: ${candidate.reason}`,
            },
            resource
          )
          await props.run(
            'dev.resources.stopCommit',
            { planId: plan.id, planDigest: plan.digest },
            { ...resource, generation: plan.resource.generation }
          )
        } else if (candidate.kind === 'worktree') {
          // Planned again right before it runs: facts may have changed.
          const plan = await planWorktree(props.run, candidate.worktree)
          if (plan.blockers.length > 0) throw new Error(plan.blockers[0]?.message ?? 'blocked')
          await props.run(
            'dev.worktree.cleanupCommit',
            { planId: plan.id, planDigest: plan.digest },
            { kind: 'worktree', id: candidate.worktree.id, generation: plan.resource.generation }
          )
        }
        done += 1
      } catch (error) {
        const title = candidate.kind === 'worktree' ? candidate.title : candidate.row.title
        failed.push(`${title}: ${commandError(error).message}`)
      }
    }
    setRunning(false)
    setFailures(failed)
    if (failed.length === 0)
      props.onFinished(`Cleaned up ${done} ${done === 1 ? 'item' : 'items'}.`)
  }

  const worktreeState = (id: string) => checks().get(id)

  return (
    <section class="dev-resources__view" aria-label="Clean up">
      <div class="dev-resources__view-header">
        <ActionButton
          type="button"
          variant="ghost"
          size="icon-sm"
          tooltip="Back"
          aria-label="Back to runtime resources"
          onClick={props.onBack}
        >
          <ChevronLeft aria-hidden="true" />
        </ActionButton>
        <div class="dev-resources__row-main">
          <span class="dev-resources__row-title">Clean up</span>
          <span class="dev-resources__row-detail">
            Nothing is stopped or deleted until you confirm. Each item is checked again right before
            it runs.
          </span>
        </div>
      </div>

      <Show
        when={actionable().length > 0 || foreign().length > 0 || blocked().length > 0}
        fallback={<p class="dev-resources__note">Nothing needs cleaning up right now.</p>}
      >
        <Show when={actionable().length > 0}>
          <ul class="dev-resources__list">
            <For each={actionable()}>
              {(candidate) => (
                <li class="dev-resources__check-row">
                  <Checkbox
                    checked={selected().has(candidate.id)}
                    disabled={running()}
                    onChange={(value: boolean) => toggle(candidate.id, value)}
                    label={candidate.kind === 'worktree' ? candidate.title : candidate.row.title}
                    description={
                      candidate.kind === 'worktree'
                        ? `${candidate.reason} · moved to quarantine, branch kept`
                        : `${candidate.reason} · stopped gracefully`
                    }
                  />
                  <span class="dev-resources__server-memory">
                    {candidate.kind === 'worktree'
                      ? formatSize(candidate.diskBytes)
                      : formatSize(candidate.kind === 'server' ? candidate.memoryBytes : undefined)}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show
          when={props.candidates.some(
            (c) => c.kind === 'worktree' && worktreeState(c.id)?.state === 'checking'
          )}
        >
          <p class="dev-resources__note">Checking archived worktrees…</p>
        </Show>

        <Show when={foreign().length > 0}>
          <section class="dev-resources__group" aria-label="Not started by Adea">
            <h3 class="dev-resources__group-header">
              <span class="dev-resources__group-title">Not started by Adea</span>
              <span class="dev-resources__row-detail">Each one asks first</span>
            </h3>
            <ul class="dev-resources__list">
              <For each={foreign()}>
                {(candidate) => (
                  <Show when={candidate.kind === 'foreign' ? candidate : undefined}>
                    {(item) => (
                      <li class="dev-resources__check-row">
                        <span class="dev-resources__row-main">
                          <span class="dev-resources__row-title">
                            {item().row.title}
                            <Show when={item().row.attributionLabel}>
                              {(label) => (
                                <Badge variant="info" size="sm">
                                  {label()}
                                </Badge>
                              )}
                            </Show>
                          </span>
                          <span class="dev-resources__row-detail">{item().reason}</span>
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={running()}
                          onClick={() => props.onStopForeign(item().row)}
                        >
                          <Square aria-hidden="true" />
                          Stop…
                        </Button>
                      </li>
                    )}
                  </Show>
                )}
              </For>
            </ul>
          </section>
        </Show>

        <Show when={blocked().length > 0}>
          <section class="dev-resources__group" aria-label="Can't be cleaned up">
            <h3 class="dev-resources__group-header">
              <Lock class="dev-resources__icon" aria-hidden="true" />
              <span class="dev-resources__group-title">Can’t be cleaned up</span>
            </h3>
            <ul class="dev-resources__list">
              <For each={blocked()}>
                {(candidate) => (
                  <li class="dev-resources__blocked-row">
                    <span class="dev-resources__row-title">
                      <span class="dev-resources__code">{candidate.title}</span>
                    </span>
                    <span class="dev-resources__row-detail">
                      {(() => {
                        const check = worktreeState(candidate.id)
                        if (check?.state === 'blocked') return check.reasons.join(' · ')
                        if (check?.state === 'failed') return check.error.message
                        return ''
                      })()}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </Show>

      <Show when={failures().length > 0}>
        <Alert variant="destructive">
          <AlertDescription>
            <For each={failures()}>
              {(failure) => <span class="dev-resources__failure">{failure}</span>}
            </For>
          </AlertDescription>
        </Alert>
      </Show>

      <div class="dev-resources__setting-line">
        <span class="dev-resources__row-main">
          <span class="dev-resources__row-title">When something qualifies</span>
          <span class="dev-resources__row-detail">
            {props.mode === 'off'
              ? 'Clean-up suggestions are off.'
              : 'Adea asks first. Processes Adea did not start are never stopped automatically.'}
          </span>
        </span>
        <Button type="button" variant="outline" size="sm" onClick={props.onOpenSettings}>
          Settings
        </Button>
      </div>

      <div class="dev-resources__footer">
        <span class="dev-resources__row-main">
          <span class="dev-resources__row-title">
            {freedDisk() > 0 && freedMemory() > 0
              ? `Frees about ${formatSize(freedDisk())} of disk and ${formatSize(freedMemory())} of memory`
              : freedDisk() > 0
                ? `Frees about ${formatSize(freedDisk())} of disk`
                : freedMemory() > 0
                  ? `Frees about ${formatSize(freedMemory())} of memory`
                  : 'Select what to clean up'}
          </span>
          <span class="dev-resources__row-detail">{chosen().length} selected</span>
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={running()}
          onClick={props.onBack}
        >
          Cancel
        </Button>
        <ActionButton
          type="button"
          variant="destructive"
          size="sm"
          busy={running()}
          busyLabel="Cleaning up"
          tooltip="Runs each selected item after checking it again"
          disabled={chosen().length === 0 || running()}
          onClick={() => void runSelected()}
        >
          Clean up {chosen().length} {chosen().length === 1 ? 'item' : 'items'}
        </ActionButton>
      </div>
    </section>
  )
}
