import { WorkspaceIdentityMark } from '@adea-ai/app-ui/components/workspace-identity-mark'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Show, createEffect, createSignal, createUniqueId, on, onMount } from 'solid-js'

/**
 * Inline workspace creation: Enter creates, Escape cancels, and leaving the
 * field creates when a name was typed and cancels when it is empty. The mark
 * previews the initials the new workspace will get. A host-controlled draft
 * stays mounted after Enter: a failure shows beside the kept name, Enter
 * retries, and leaving the field no longer resubmits until the name changes.
 */
export function WorkspaceDraftRow(props: {
  controlled: boolean
  error?: string
  pending?: boolean
  onCreate: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = createSignal('')
  const errorId = `workspace-nav-draft-error-${createUniqueId()}`
  let input: HTMLInputElement | undefined
  let settled = false
  let submittedName: string | undefined
  // A reported failure re-arms the row so the user can retry.
  createEffect(
    on(
      () => props.error,
      (error) => {
        if (error) settled = false
      },
      { defer: true }
    )
  )
  const finish = (create: boolean, fromBlur = false) => {
    if (settled || props.pending) return
    const value = name().trim()
    if (create && value === '') return
    // Leaving the field after a failure keeps the draft instead of retrying.
    if (create && fromBlur && submittedName === value) return
    settled = true
    if (create) {
      submittedName = value
      props.onCreate(value)
    } else props.onCancel()
  }

  onMount(() => input?.focus())

  return (
    <div class="flex min-w-0 flex-col gap-1 px-2 py-1" data-slot="workspace-nav-draft">
      <div class="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" class="flex shrink-0">
          <WorkspaceIdentityMark
            accent={null}
            logo={{ kind: 'monogram' }}
            name={name().trim()}
            size="xs"
          />
        </span>
        <Input
          ref={(element) => {
            input = element
          }}
          aria-label="New workspace name"
          aria-invalid={props.error ? true : undefined}
          aria-describedby={props.error ? errorId : undefined}
          aria-busy={props.pending ? true : undefined}
          placeholder="New workspace name"
          value={name()}
          onInput={(event) => {
            setName(event.currentTarget.value)
            if (props.controlled) settled = false
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              finish(true)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              settled = false
              finish(false)
            }
          }}
          onBlur={() => finish(name().trim() !== '', true)}
        />
      </div>
      <Show when={props.error}>
        {(message) => (
          <Alert variant="destructive" id={errorId}>
            <AlertDescription>{message()}</AlertDescription>
          </Alert>
        )}
      </Show>
    </div>
  )
}
