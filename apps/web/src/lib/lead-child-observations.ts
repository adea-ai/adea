import type { AgentHqApiClient, ApiLeadTurnChild } from '@adea-ai/api-client'
import type { HandoffChildObservations, HandoffObservedChild } from '@adea-ai/dev-view/chat'

type ChildReader = Pick<AgentHqApiClient, 'getLeadTurnChildren'>
const MAX_PAGES = 16

function observedChild(child: ApiLeadTurnChild): HandoffObservedChild {
  return {
    delegationId: child.delegationId,
    role: child.role,
    state: child.state,
    awaitingInput: child.awaitingInput,
    stopRequested: child.stopRequested,
    updatedAt: child.updatedAt,
    ...(child.outcome
      ? {
          outcome: {
            state: child.outcome.state,
            ...(child.outcome.failureCode ? { failureCode: child.outcome.failureCode } : {}),
            publication: child.outcome.publication.status,
          },
        }
      : {}),
  }
}

/** Follow bounded retained child pages for display. Pages are separate snapshots: a changing
 * count or repeated/out-of-order child leaves a visibly partial read for the next poll. */
export async function readLeadChildObservations(
  reader: ChildReader,
  workspaceId: string,
  intentId: string,
  dispatchId?: string
): Promise<HandoffChildObservations> {
  const children: HandoffObservedChild[] = []
  const seen = new Set<string>()
  let after: { acceptedAt: string; delegationId: string } | undefined
  let totalChildren: number | undefined
  try {
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
      const reply = await reader.getLeadTurnChildren(workspaceId, intentId, after ? { after } : {})
      if (
        reply.leadTurn.intentId !== intentId ||
        (dispatchId !== undefined && reply.leadTurn.dispatchId !== dispatchId)
      )
        return { availability: 'unavailable', reasonCode: 'RUNTIME_RESPONSE_INVALID' }
      const page = reply.childObservations
      if (page.availability === 'unavailable') {
        if (children.length === 0) return page
        return {
          availability: 'available',
          children,
          totalChildren: totalChildren!,
          complete: false,
        }
      }
      if (totalChildren === undefined) totalChildren = page.totalChildren
      if (page.totalChildren !== totalChildren)
        return { availability: 'available', children, totalChildren, complete: false }
      for (const child of page.children) {
        if (
          seen.has(child.delegationId) ||
          (after &&
            (child.acceptedAt < after.acceptedAt ||
              (child.acceptedAt === after.acceptedAt && child.delegationId <= after.delegationId)))
        )
          return { availability: 'available', children, totalChildren, complete: false }
        seen.add(child.delegationId)
        after = { acceptedAt: child.acceptedAt, delegationId: child.delegationId }
        children.push(observedChild(child))
      }
      if (page.complete)
        return {
          availability: 'available',
          children,
          totalChildren,
          complete: children.length === totalChildren,
        }
      if (
        !page.next ||
        !after ||
        page.next.acceptedAt !== after.acceptedAt ||
        page.next.delegationId !== after.delegationId
      )
        return { availability: 'available', children, totalChildren, complete: false }
    }
    return {
      availability: 'available',
      children,
      totalChildren: totalChildren ?? 0,
      complete: false,
    }
  } catch {
    if (totalChildren !== undefined)
      return { availability: 'available', children, totalChildren, complete: false }
    return { availability: 'unavailable', reasonCode: 'ADMISSION_SERVICE_UNAVAILABLE' }
  }
}
