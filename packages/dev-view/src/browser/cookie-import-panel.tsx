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
import { Button } from '@adea-ai/ui/components/ui/button'
import { Text } from '@adea-ai/ui/components/ui/typography'
import { isDevUtilityContextChanged } from '../utility-context'

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
    // The read is caught here, not left to the resource: a rejected fetcher
    // makes every JSX read of the resource re-throw, which tears the panel
    // down before its typed error can render. A failed read is surface state.
    try {
      const page = (await props.run('dev.browser.cookieSources', {})) as {
        items: readonly CookieSource[]
      }
      return { items: page.items, failure: undefined }
    } catch (error) {
      return { items: [] as readonly CookieSource[], failure: errorMessage(error) }
    }
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
      if (isDevUtilityContextChanged(error)) return
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
      if (isDevUtilityContextChanged(error)) return
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
        <Text variant="overline" class="mt-1.5 mx-2 block">
          Import cookies
        </Text>
        <div class="dev-browser__actions">
          <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
            Reload sources
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => props.onClose()}>
            Close
          </Button>
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
        <Show when={sources()?.failure}>
          {(message) => (
            <p class="dev-browser__row" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <Show when={sources.loading}>
          <span class="dev-terminal-muted">Reading browser profiles…</span>
        </Show>
        <For each={sources()?.items ?? []}>
          {(source) => {
            const state = () => cookieSourceState(source)
            return (
              <div class="dev-browser__diagnostic">
                <span class="dev-browser__row-meta">{source.kind}</span>
                <span>{cookieSourceLabel(source)}</span>
                <Show when={state().note}>
                  {(note) => <span class="dev-browser__row-meta">{note()}</span>}
                </Show>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!state().selectable || busy()}
                  onClick={() => void planFor(source)}
                >
                  Preview import
                </Button>
              </div>
            )
          }}
        </For>
        <Show
          when={!sources.loading && !sources()?.failure && (sources()?.items?.length ?? 0) === 0}
        >
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.busy || !canCommit(props.preview, new Date().toISOString())}
          onClick={() => props.onCommit()}
        >
          Import to this lane
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.busy}
          onClick={props.onDiscard}
        >
          Discard
        </Button>
      </div>
    </div>
  )
}
