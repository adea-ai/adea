import type { AgentHqApiClient, ApiLeadTurnChild } from '@adea-ai/api-client'
import type { HandoffChildObservations, HandoffObservedChild } from '@adea-ai/dev-view/chat'
import {
  isRetainedChildFailureCode,
  isRetainedChildRole,
  retainedChildUnknownRole,
} from '@adea-ai/types'

type ChildReader = Pick<AgentHqApiClient, 'getLeadTurnChildren'>
const MAX_PAGES = 16

/**
 * The control plane owns the child's role and failure code, and its published
 * schema types both as free strings. The surface may only show a bounded
 * value, so an unbounded one is reported as an unknown role or withheld from
 * the outcome rather than rendered.
 */
function observedChild(child: ApiLeadTurnChild): HandoffObservedChild {
  const failureCode = child.outcome?.failureCode
  return {
    delegationId: child.delegationId,
    role: isRetainedChildRole(child.role) ? child.role : retainedChildUnknownRole,
    state: child.state,
    awaitingInput: child.awaitingInput,
    stopRequested: child.stopRequested,
    updatedAt: child.updatedAt,
    ...(child.outcome
      ? {
          outcome: {
            state: child.outcome.state,
            ...(failureCode && isRetainedChildFailureCode(failureCode) ? { failureCode } : {}),
            publication: child.outcome.publication.status,
          },
        }
      : {}),
  }
}

/**
 * Whether a child precedes the cursor. The control plane orders children by
 * the instant they were accepted and by delegation id within one instant, so
 * the display read must order them the same way: the same instant spelled
 * with a different precision is still the same instant, and comparing the raw
 * strings would call that page a regression.
 */
function precedes(
  child: { acceptedAt: string; delegationId: string },
  prior: { acceptedAt: string; delegationId: string }
): boolean {
  const childAt = Date.parse(child.acceptedAt)
  const priorAt = Date.parse(prior.acceptedAt)
  if (Number.isFinite(childAt) && Number.isFinite(priorAt)) {
    if (childAt !== priorAt) return childAt < priorAt
    return child.delegationId <= prior.delegationId
  }
  if (child.acceptedAt === prior.acceptedAt) return child.delegationId <= prior.delegationId
  return child.acceptedAt < prior.acceptedAt
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
      if (reply.leadTurn.intentId !== intentId)
        return { availability: 'unavailable', reasonCode: 'RUNTIME_RESPONSE_INVALID' }
      const page = reply.childObservations
      if (page.availability === 'unavailable') {
        // An unavailable read carries no child data, so the control plane's own
        // reason for it stands: a lead that was never dispatched is not an
        // invalid response.
        if (children.length === 0) return page
        return {
          availability: 'available',
          children,
          totalChildren: totalChildren!,
          complete: false,
        }
      }
      if (dispatchId !== undefined && reply.leadTurn.dispatchId !== dispatchId)
        return { availability: 'unavailable', reasonCode: 'RUNTIME_RESPONSE_INVALID' }
      if (totalChildren === undefined) totalChildren = page.totalChildren
      if (page.totalChildren !== totalChildren)
        return { availability: 'available', children, totalChildren, complete: false }
      for (const child of page.children) {
        if (seen.has(child.delegationId) || (after && precedes(child, after)))
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
