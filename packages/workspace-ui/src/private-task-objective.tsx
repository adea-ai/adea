import type { TaskSummary } from '@adea-ai/types'
import { createEffect, createSignal, Show } from 'solid-js'

import type { PrivateContentResolver } from './platform'

export function TaskObjective(props: {
  privateContent?: PrivateContentResolver
  task: TaskSummary
}) {
  const [resolved, setResolved] = createSignal<string | null>(null)
  const [failed, setFailed] = createSignal(false)

  createEffect(() => {
    let active = true
    setResolved(null)
    setFailed(false)
    const contentRefId = props.task.objectiveContentRefId
    if (!contentRefId || props.task.objective || !props.privateContent) return
    void props.privateContent
      .read({ contentId: contentRefId, workspaceId: props.task.workspaceId })
      .then(({ plaintext }) => {
        if (active) setResolved(plaintext)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  })

  return (
    <Show when={!props.task.objective} fallback={<>{props.task.objective}</>}>
      <Show when={props.task.objectiveContentRefId} fallback={<>Objective unavailable</>}>
        <Show
          when={resolved()}
          fallback={
            <Show
              when={failed()}
              fallback={
                <>
                  {props.privateContent
                    ? 'Opening private objective…'
                    : 'Private objective unavailable on this device'}
                </>
              }
            >
              <>Private objective unavailable on this authorized device</>
            </Show>
          }
        >
          <>{resolved()}</>
        </Show>
      </Show>
    </Show>
  )
}
