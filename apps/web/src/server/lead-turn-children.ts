import { ControlApiOperations } from '@adea-ai/sdk'
import type { ApiLeadTurnChildrenPage, ApiLeadTurnChildrenQuery } from '@adea-ai/api-client'

const contract = ControlApiOperations.getPiDurableLeadChildren
const pageSchema = contract.requestSchema.shape.parameters.omit({ dispatchId: true })

/** The published SDK owns paging and child schemas; no endpoint or schema fallback. */
export function leadTurnChildrenQuery(value: unknown): ApiLeadTurnChildrenQuery {
  return pageSchema.parse(value)
}

/** Reject incomplete, duplicate and unknown query parameters before any product read. */
export function parseLeadTurnChildrenQuery(
  query: URLSearchParams
): ApiLeadTurnChildrenQuery | null {
  const allowed = new Set(['limit', 'afterAcceptedAt', 'afterDelegationId'])
  if ([...query.keys()].some((key) => !allowed.has(key) || query.getAll(key).length !== 1))
    return null
  const limit = query.get('limit')
  const acceptedAt = query.get('afterAcceptedAt')
  const delegationId = query.get('afterDelegationId')
  if (
    (acceptedAt === null) !== (delegationId === null) ||
    (limit !== null && !/^[1-9]\d{0,2}$/.test(limit))
  )
    return null
  try {
    return leadTurnChildrenQuery({
      ...(limit === null ? {} : { limit: Number(limit) }),
      ...(acceptedAt === null ? {} : { after: { acceptedAt, delegationId } }),
    })
  } catch {
    return null
  }
}

function invalidPage(): never {
  throw new Error('RUNTIME_RESPONSE_INVALID')
}

/** A detached, allowlisted snapshot. Retained publication is not an Adea timeline receipt. */
export function projectLeadTurnChildrenPage(value: unknown, page: ApiLeadTurnChildrenQuery) {
  const data = contract.responseSchema.shape.data.parse(value)
  if (data.children.length > (page.limit ?? 256)) invalidPage()
  const seen = new Set<string>()
  let previous = page.after
  for (const child of data.children) {
    if (seen.has(child.delegationId)) invalidPage()
    seen.add(child.delegationId)
    if (
      previous &&
      (Date.parse(child.acceptedAt) < Date.parse(previous.acceptedAt) ||
        (Date.parse(child.acceptedAt) === Date.parse(previous.acceptedAt) &&
          child.delegationId <= previous.delegationId))
    )
      invalidPage()
    previous = child
  }
  if (
    data.next &&
    (!data.children.length ||
      data.next.acceptedAt !== previous?.acceptedAt ||
      data.next.delegationId !== previous?.delegationId)
  )
    invalidPage()
  if (
    !page.after &&
    (data.complete
      ? data.totalChildren !== data.children.length
      : data.totalChildren <= data.children.length)
  )
    invalidPage()
  const result: ApiLeadTurnChildrenPage = {
    children: data.children.map((child) => ({
      delegationId: child.delegationId,
      childExecutionId: child.childExecutionId,
      ...(child.childAttemptId ? { childAttemptId: child.childAttemptId } : {}),
      role: child.role,
      state: child.state,
      awaitingInput: child.awaitingInput,
      stopRequested: child.stopRequested,
      acceptedAt: child.acceptedAt,
      updatedAt: child.updatedAt,
      revision: child.revision,
      ...(child.outcome
        ? {
            outcome: {
              state: child.outcome.state,
              ...(child.outcome.resultRef ? { resultRef: child.outcome.resultRef } : {}),
              ...(child.outcome.failureCode ? { failureCode: child.outcome.failureCode } : {}),
              publication: {
                status: child.outcome.publication.status,
                ...(child.outcome.publication.resolution
                  ? { resolution: child.outcome.publication.resolution }
                  : {}),
              },
            },
          }
        : {}),
    })),
    totalChildren: data.totalChildren,
    complete: data.complete,
    ...(data.next
      ? { next: { acceptedAt: data.next.acceptedAt, delegationId: data.next.delegationId } }
      : {}),
  }
  return { binding: data, page: result }
}
