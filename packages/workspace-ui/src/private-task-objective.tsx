import type { TaskSummary } from '@adea-ai/types'
import { createEffect, createSignal, onCleanup, Show } from 'solid-js'

import type { PrivateContentResolver } from './platform'

type PrivateContentIdentity = Readonly<{
  contentRefId: string
  resolver: PrivateContentResolver
  workspaceId: string
}>

type PrivateContentResolution = PrivateContentIdentity &
  Readonly<{ status: 'loading' | 'failed' } | { plaintext: string; status: 'resolved' }>

function samePrivateContentIdentity(left: PrivateContentIdentity, right: PrivateContentIdentity) {
  return (
    left.resolver === right.resolver &&
    left.workspaceId === right.workspaceId &&
    left.contentRefId === right.contentRefId
  )
}

export function TaskObjective(props: {
  privateContent?: PrivateContentResolver
  task: TaskSummary
}) {
  const [resolution, setResolution] = createSignal<PrivateContentResolution>()
  const currentIdentity = (): PrivateContentIdentity | undefined => {
    const contentRefId = props.task.objectiveContentRefId
    const resolver = props.privateContent
    if (!contentRefId || props.task.objective || !resolver) return
    return { contentRefId, resolver, workspaceId: props.task.workspaceId }
  }
  const currentResolution = () => {
    const identity = currentIdentity()
    const value = resolution()
    return identity && value && samePrivateContentIdentity(identity, value) ? value : undefined
  }
  const resolved = () => {
    const value = currentResolution()
    return value?.status === 'resolved' ? value.plaintext : null
  }
  const failed = () => currentResolution()?.status === 'failed'

  createEffect(() => {
    let active = true
    onCleanup(() => {
      active = false
    })
    const identity = currentIdentity()
    if (!identity) {
      setResolution(undefined)
      return
    }
    setResolution({ ...identity, status: 'loading' })
    void identity.resolver
      .read({ contentId: identity.contentRefId, workspaceId: identity.workspaceId })
      .then(({ plaintext }) => {
        if (active) setResolution({ ...identity, plaintext, status: 'resolved' })
      })
      .catch(() => {
        if (active) setResolution({ ...identity, status: 'failed' })
      })
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
