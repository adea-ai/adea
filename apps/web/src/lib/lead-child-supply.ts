import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { HandoffChildObservations } from '@adea-ai/dev-view/chat'
import { createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js'
import { readLeadChildObservations } from './lead-child-observations'
import { createLeadStatusPoll } from './lead-handoff-poll'

export type LeadChildIdentity = Readonly<{
  workspaceId: string
  runtimeSessionId: string
  intentId: string
  dispatchId?: string
}>

/** The mounted child read follows exact retained identity, not conversation object
 * identity. An incidental draft update cannot restart pagination or clear evidence. */
export function createLeadChildSupply(
  reader: Pick<AgentHqApiClient, 'getLeadTurnChildren'>,
  identity: () => LeadChildIdentity | undefined,
  lifecycle: Readonly<{ current(): number; isCurrent(value: number): boolean }>
): () => HandoffChildObservations | undefined {
  const key = createMemo(() => {
    const value = identity()
    return value
      ? JSON.stringify([
          value.workspaceId,
          value.runtimeSessionId,
          value.intentId,
          value.dispatchId ?? null,
        ])
      : ''
  })
  const [supply, setSupply] = createSignal<{
    key: string
    observations?: HandoffChildObservations
  }>({ key: '' })
  let epoch = 0
  let disposed = false
  createEffect(() => {
    const currentKey = key()
    epoch += 1
    setSupply({ key: currentKey })
  })
  const read = (): void => {
    // createLeadStatusPoll calls this inside a tracked effect. Only its explicit
    // key/eligibility read may track; the conversation object and its draft do not.
    const value = untrack(identity)
    const currentKey = key()
    if (!value || !currentKey) return
    const request = lifecycle.current()
    const requestEpoch = ++epoch
    void readLeadChildObservations(
      reader,
      value.workspaceId,
      value.intentId,
      value.dispatchId
    ).then((observations) => {
      if (
        disposed ||
        !lifecycle.isCurrent(request) ||
        requestEpoch !== epoch ||
        key() !== currentKey
      )
        return
      setSupply({ key: currentKey, observations })
    })
  }
  createLeadStatusPoll(read, () => key() !== '')
  onCleanup(() => {
    disposed = true
    epoch += 1
  })
  return () => (supply().key === key() ? supply().observations : undefined)
}
