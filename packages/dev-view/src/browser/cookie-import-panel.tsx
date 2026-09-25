/*
 * Cookie import surface (#646): sources → preview → confirm over
 * `dev.browser.cookieSources`, `dev.browser.cookieImportPlan` and
 * `dev.browser.cookieImportCommit`. The panel owns no authority: the pane
 * supplies the lane binding and runs the commands under the workspace scope,
 * and every value it renders comes from a value-free plan fact.
 */
import type { DevError, DevOperation, MutationPlan } from '@adea-ai/types/dev-runtime'
import { createResource, createSignal, For, Show } from 'solid-js'

import {
  canCommit,
  cookieSourceLabel,
  cookieSourceState,
  importOutcomeMessage,
  previewFromPlan,
  previewSummary,
  type CookieImportPreview,
  type CookieSource,
} from './cookie-import-model'

export type CookieImportPanelProps = Readonly<{
  laneId: string
  generation: number
  run: (
    operation: DevOperation,
    body: Record<string, unknown>,
    resource?: { kind: string; id: string; generation: number }
  ) => Promise<unknown>
  onClose(): void
}>

type CookieImportResult = Readonly<{
  imported: number
  skipped: number
  rolledBack: boolean
}>

function errorMessage(error: unknown): string {
  const typed = (error as { error?: DevError })?.error
  if (typed) return typed.message
  return error instanceof Error ? error.message : 'the import failed'
}

export function CookieImportPanel(props: CookieImportPanelProps) {
  const lane = () => ({
    generation: props.generation,
    id: props.laneId,
    kind: 'browser_lane',
  })
  const [preview, setPreview] = createSignal<CookieImportPreview | undefined>(undefined)
  const [outcome, setOutcome] = createSignal<string | undefined>(undefined)
  const [failure, setFailure] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)

  const [sources, { refetch }] = createResource(async () => {
    const page = (await props.run('dev.browser.cookieSources', {})) as {
      items: readonly CookieSource[]
    }
    return page.items
  })

  async function planFor(source: CookieSource): Promise<void> {
    setBusy(true)
    setFailure(undefined)
    setOutcome(undefined)
    try {
      const plan = (await props.run(
        'dev.browser.cookieImportPlan',
        {
          browserLaneId: props.laneId,
          domains: [],
          expectedGeneration: props.generation,
          sourceProfileId: source.id,
        },
        lane()
      )) as MutationPlan
      setPreview(previewFromPlan(plan))
    } catch (error) {
      setPreview(undefined)
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function commit(): Promise<void> {
    const current = preview()
    if (!current) return
    setBusy(true)
    setFailure(undefined)
    try {
      const result = (await props.run(
        'dev.browser.cookieImportCommit',
        { planDigest: current.planDigest, planId: current.planId },
        lane()
      )) as CookieImportResult
      setPreview(undefined)
      setOutcome(importOutcomeMessage(result))
    } catch (error) {
      // A refused commit (expired digest, moved generation) leaves the plan on
      // screen so the reader can preview it again rather than guess what moved.
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="dev-browser__cookies">
      <div class="dev-browser__row">
        <p class="dev-browser__section-title">Import cookies</p>
        <div class="dev-browser__actions">
          <button type="button" class="dev-icon-button" onClick={() => void refetch()}>
            Reload sources
          </button>
          <button type="button" class="dev-icon-button" onClick={() => props.onClose()}>
            Close
          </button>
        </div>
      </div>

      <Show when={failure()}>
        {(message) => (
          <p class="dev-browser__row" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={outcome()}>{(message) => <p class="dev-browser__row">{message()}</p>}</Show>

      <Show
        when={!preview()}
        fallback={
          <Preview
            preview={preview()!}
            busy={busy()}
            onCommit={commit}
            onDiscard={() => setPreview(undefined)}
          />
        }
      >
        <Show when={sources.error}>
          {(error) => (
            <p class="dev-browser__row" role="alert">
              {errorMessage(error())}
            </p>
          )}
        </Show>
        <Show when={sources.loading}>
          <span class="dev-terminal-muted">Reading browser profiles…</span>
        </Show>
        <For each={sources() ?? []}>
          {(source) => {
            const state = () => cookieSourceState(source)
            return (
              <div class="dev-browser__diagnostic">
                <span class="dev-browser__row-meta">{source.kind}</span>
                <span>{cookieSourceLabel(source)}</span>
                <Show when={state().note}>
                  {(note) => <span class="dev-browser__row-meta">{note()}</span>}
                </Show>
                <button
                  type="button"
                  class="dev-icon-button"
                  disabled={!state().selectable || busy()}
                  onClick={() => void planFor(source)}
                >
                  Preview import
                </button>
              </div>
            )
          }}
        </For>
        <Show when={(sources() ?? []).length === 0 && !sources.loading && !sources.error}>
          <span class="dev-terminal-muted">
            No browser profiles with a readable cookie store were detected on this machine.
          </span>
        </Show>
      </Show>
    </div>
  )
}

function Preview(props: {
  preview: CookieImportPreview
  busy: boolean
  onCommit(): void
  onDiscard(): void
}) {
  return (
    <div class="dev-browser__cookies-preview">
      <p>{previewSummary(props.preview)}</p>
      <p class="dev-browser__row-meta">{props.preview.domains.join(', ')}</p>
      <For each={props.preview.blockers}>
        {(blocker) => (
          <p class="dev-browser__row" role="alert">
            {blocker}
          </p>
        )}
      </For>
      <div class="dev-browser__actions">
        <button
          type="button"
          class="dev-icon-button"
          disabled={props.busy || !canCommit(props.preview, new Date().toISOString())}
          onClick={() => props.onCommit()}
        >
          Import to this lane
        </button>
        <button
          type="button"
          class="dev-icon-button"
          disabled={props.busy}
          onClick={props.onDiscard}
        >
          Discard
        </button>
      </div>
    </div>
  )
}
