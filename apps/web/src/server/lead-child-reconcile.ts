/** CP's retained terminal inbox may wake this endpoint after the browser closes. The wake
 * carries selectors only: current Adea audience, original actor, rollback and CP publication
 * authority are all rechecked by the canonical publication transaction. */
export type LeadChildReconcileScope = Readonly<{
  workspaceId: string
  intentId: string
  userId: string
}>

export type LeadChildReconcileDependencies = Readonly<{
  verify(request: Request, workspaceId: string, principalId: string): Promise<boolean>
  current(
    controlPlaneWorkspaceId: string,
    intentId: string
  ): Promise<LeadChildReconcileScope | undefined>
  publish(scope: LeadChildReconcileScope): Promise<unknown>
}>

const unavailable = (status = 404) =>
  Response.json(
    { code: 'CHILD_RECONCILIATION_UNAVAILABLE' },
    { status, headers: { 'cache-control': 'private, no-store' } }
  )

async function selectors(request: Request) {
  if (request.method !== 'POST' || request.headers.get('content-type') !== 'application/json')
    return undefined
  const reader = request.body?.getReader()
  if (!reader) return undefined
  let size = 0
  const parts: Uint8Array[] = []
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 4096) {
        await reader.cancel()
        return undefined
      }
      parts.push(chunk.value)
    }
    const parsed: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const value = parsed as Record<string, unknown>
    if (
      Object.keys(value).toSorted().join(',') !== 'intentId,principalId,workspaceId' ||
      typeof value.workspaceId !== 'string' ||
      !/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.workspaceId) ||
      typeof value.intentId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value.intentId
      ) ||
      typeof value.principalId !== 'string' ||
      !/^svc_[a-z][a-z0-9-]{0,59}$/.test(value.principalId)
    )
      return undefined
    return {
      workspaceId: value.workspaceId,
      intentId: value.intentId,
      principalId: value.principalId,
    }
  } catch {
    return undefined
  } finally {
    reader.releaseLock()
  }
}

export function createLeadChildReconcileHandler(dependencies: LeadChildReconcileDependencies) {
  return async (request: Request): Promise<Response> => {
    let input: Awaited<ReturnType<typeof selectors>>
    try {
      input = await selectors(request)
      if (!input || !(await dependencies.verify(request, input.workspaceId, input.principalId)))
        return unavailable()
    } catch {
      return unavailable()
    }
    try {
      const scope = await dependencies.current(input.workspaceId, input.intentId)
      if (
        !scope ||
        scope.intentId !== input.intentId ||
        !(await dependencies.verify(request, input.workspaceId, input.principalId))
      )
        return unavailable()
      await dependencies.publish(scope)
      return new Response(null, {
        status: 204,
        headers: { 'cache-control': 'private, no-store' },
      })
    } catch {
      // The CP inbox retains the event and retries. No private product or CP error crosses back.
      return unavailable(503)
    }
  }
}
