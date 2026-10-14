// A one-slot channel that carries "show this event" from the History pane to
// whichever surface renders the conversation (#716). The pane only asks; the
// transcript, when one is mounted, scrolls to the event and marks it. A host
// without a transcript (Dev, where the center is the terminal) has no consumer,
// and the pane then reveals the event in its own Turns list instead.
import { createSignal } from 'solid-js'

export type EventRevealRequest = Readonly<{
  token: number
  runtimeSessionId: string
  eventId: string
}>

const [request, setRequest] = createSignal<EventRevealRequest | undefined>()
let nextToken = 0
let consumers = 0

export const eventRevealRequest = request

export function requestEventReveal(runtimeSessionId: string, eventId: string): number {
  nextToken += 1
  setRequest({ token: nextToken, runtimeSessionId, eventId })
  return nextToken
}

/** Clear the request once it was shown or given up; a newer request stays. */
export function settleEventReveal(token: number): void {
  if (request()?.token === token) setRequest(undefined)
}

export function hasEventRevealConsumer(): boolean {
  return consumers > 0
}

/** A transcript registers while mounted so the pane knows it can be asked. */
export function registerEventRevealConsumer(): () => void {
  consumers += 1
  let active = true
  return () => {
    if (!active) return
    active = false
    consumers -= 1
  }
}
