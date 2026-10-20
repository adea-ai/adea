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
  reader: () => Pick<AgentHqApiClient, 'getLeadTurnChildren'> &
    Partial<Pick<AgentHqApiClient, 'publishLeadTurnChildren'>>,
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
    reader?: Pick<AgentHqApiClient, 'getLeadTurnChildren'> &
      Partial<Pick<AgentHqApiClient, 'publishLeadTurnChildren'>>
    observations?: HandoffChildObservations
  }>({ key: '' })
  let epoch = 0
  let disposed = false
  createEffect(() => {
    const currentKey = key()
    const currentReader = reader()
    epoch += 1
    setSupply({ key: currentKey, reader: currentReader })
  })
  const read = (): void => {
    // createLeadStatusPoll calls this inside a tracked effect. Only its explicit
    // key/eligibility read may track; the conversation object and its draft do not.
    const value = untrack(identity)
    const currentKey = key()
    const currentReader = reader()
    if (!value || !currentKey) return
    const request = lifecycle.current()
    const requestEpoch = ++epoch
    void readLeadChildObservations(
      currentReader,
      value.workspaceId,
      value.intentId,
      value.dispatchId
    ).then(async (observations) => {
      // This is an explicit publication command. GET children remains a pure observation.
      // A failed/old SDK path retries on reconnect or the next visible poll.
      if (
        observations.availability === 'available' &&
        observations.children.some((child) => child.outcome?.publication === 'published') &&
        currentReader.publishLeadTurnChildren
      ) {
        await currentReader
          .publishLeadTurnChildren(value.workspaceId, value.intentId)
          .catch(() => undefined)
      }
      if (
        disposed ||
        !lifecycle.isCurrent(request) ||
        requestEpoch !== epoch ||
        key() !== currentKey ||
        reader() !== currentReader
      )
        return
      setSupply({ key: currentKey, reader: currentReader, observations })
    })
  }
  createLeadStatusPoll(read, () => {
    reader()
    return key() !== ''
  })
  onCleanup(() => {
    disposed = true
    epoch += 1
  })
  return () =>
    supply().key === key() && supply().reader === reader() ? supply().observations : undefined
}
