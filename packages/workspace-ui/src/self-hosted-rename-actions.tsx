// The rename side of the host detail (#188), on its own.
//
// The full `HostActions` component carries the rename row and the revocation row. This build
// connects rename and nothing else, so the mounted actions are a rename-only component: pairing and
// revocation stay unavailable, and a caller cannot switch them on by handing this component a
// revocation operation. The revocation contract is unchanged and still in `self-hosted-host-actions`.
import type { ApiRuntimeNode } from '@adea-ai/api-client'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { createSignal, Show } from 'solid-js'

import {
  classifyFailure,
  hostNameProblem,
  type FailureGuidance,
} from './self-hosted-connection-model'
import type { Notice, SelfHostedOperations } from './self-hosted-connection-panel'
import { applyHostRename } from './self-hosted-host-operations'

export type RenameHostActionsProps = Readonly<{
  node: ApiRuntimeNode
  hosts: readonly ApiRuntimeNode[]
  operations: SelfHostedOperations
  /** Runs work for the scope that started it; a late result for another scope is dropped. */
  guarded: <T>(work: () => Promise<T>) => Promise<{ value: T } | { stale: true }>
  focusHeading: () => void
  refreshHosts: () => void | Promise<void>
  notify: (notice: Notice) => void
  onFailure: (failure: FailureGuidance, retry?: () => void) => void
}>

/**
 * The rename row on its own. The name is a product label: it changes how the host is shown in this
 * workspace and nothing about the host itself.
 */
export function RenameHostActions(props: RenameHostActionsProps) {
  const [renaming, setRenaming] = createSignal(false)
  const [nameDraft, setNameDraft] = createSignal('')
  const [nameProblem, setNameProblem] = createSignal<string>()
  const [renameBusy, setRenameBusy] = createSignal(false)
  let renameTrigger: HTMLButtonElement | undefined
  let renameInput: HTMLInputElement | undefined

  const rename = async (name: string) => {
    await applyHostRename({
      renameHost: props.operations.renameHost,
      hostId: props.node.id,
      displayName: name,
      refreshHosts: props.refreshHosts,
      notify: props.notify,
    })
  }

  const beginRename = () => {
    setNameDraft(props.node.displayName)
    setNameProblem(undefined)
    setRenaming(true)
    queueMicrotask(() => renameInput?.focus())
  }
  const endRename = () => {
    setRenaming(false)
    queueMicrotask(() => renameTrigger?.focus())
  }
  const submitRename = async () => {
    if (renameBusy()) return
    const problem = hostNameProblem(nameDraft(), props.hosts, props.node.id)
    if (problem) {
      setNameProblem(problem)
      renameInput?.focus()
      return
    }
    setNameProblem(undefined)
    setRenameBusy(true)
    const name = nameDraft().trim()
    try {
      const result = await props.guarded(() => rename(name))
      if ('stale' in result) return
      endRename()
    } catch (error) {
      // The draft stays exactly as typed, and focus stays in the field.
      props.onFailure(classifyFailure(error, 'rename'), () => void submitRename())
      queueMicrotask(() => renameInput?.focus())
    } finally {
      setRenameBusy(false)
    }
  }

  return (
    <>
      <SettingsRow label="Name" description="Names must stay distinct so hosts are never confused.">
        <Show
          when={renaming()}
          fallback={
            <Button
              ref={(element) => (renameTrigger = element)}
              type="button"
              variant="outline"
              disabled={!props.operations.renameHost}
              aria-describedby="rename-reason"
              onClick={beginRename}
            >
              Rename…
            </Button>
          }
        >
          <form
            class="flex flex-col gap-2"
            aria-label="Rename host"
            onSubmit={(event) => {
              event.preventDefault()
              void submitRename()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                endRename()
              }
            }}
          >
            <Input
              ref={(element) => (renameInput = element)}
              aria-label="Host name"
              aria-invalid={nameProblem() ? true : undefined}
              aria-describedby={nameProblem() ? 'rename-problem' : undefined}
              maxLength={200}
              autocomplete="off"
              value={nameDraft()}
              onInput={(event) => setNameDraft(event.currentTarget.value)}
            />
            <Show when={nameProblem()}>
              <p id="rename-problem" class="text-destructive text-sm" role="alert">
                {nameProblem()}
              </p>
            </Show>
            <div class="flex gap-2">
              <Button type="submit" size="sm" aria-disabled={renameBusy() || undefined}>
                {renameBusy() ? 'Saving…' : 'Save name'}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={endRename}>
                Cancel
              </Button>
            </div>
          </form>
        </Show>
      </SettingsRow>
      <Show when={!props.operations.renameHost}>
        <p id="rename-reason" class="text-muted-foreground text-sm text-pretty">
          Not available yet: the server has no rename operation. The name is set by the host when it
          registers.
        </p>
      </Show>
    </>
  )
}
