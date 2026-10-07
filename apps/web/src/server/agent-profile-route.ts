import type { ApiAgentProfileInput, ApiAgentResponse } from '@adea-ai/api-client'
import type { AgentSummary, UserPrincipalRef } from '@adea-ai/types'
import type { AdminRouteDependencies } from './control-plane-admin-routes'
import { ControlPlaneProxyError, adminCorrelation } from './control-plane-client'
import { resolveAgentProfilePin } from './agent-profile-pin'
import { parseAgentProfileChange } from './agent-profile-request'

type Dependencies = AdminRouteDependencies &
  Readonly<{
    read(
      workspaceId: string,
      agentId: string,
      principal: UserPrincipalRef
    ): Promise<AgentSummary | null>
    persist(
      workspaceId: string,
      agentId: string,
      principal: UserPrincipalRef,
      input: ApiAgentProfileInput
    ): Promise<AgentSummary>
  }>

export async function handleAgentProfileChange(
  request: Request,
  workspaceId: string,
  agentId: string,
  dependencies: Dependencies
): Promise<Response> {
  const refused = dependencies.guard(request)
  if (refused) return refused
  const resolution = await dependencies.resolvePrincipal(request)
  if (!resolution) return dependencies.unavailable(request, 401)
  if (!(await dependencies.authorize(resolution.principal, 'workspace.read', workspaceId)))
    return dependencies.unavailable(request)
  if (!(await dependencies.authorize(resolution.principal, 'workspace.update', workspaceId)))
    return dependencies.unavailable(request, 403)
  const agent = await dependencies.read(workspaceId, agentId, resolution.principal)
  if (!agent) return dependencies.unavailable(request)
  const declaredSize = Number(request.headers.get('content-length') ?? 0)
  if (declaredSize > 4096) return dependencies.invalid(request)
  let input: ApiAgentProfileInput | null
  try {
    const text = await request.text()
    input = text.length <= 4096 ? parseAgentProfileChange(JSON.parse(text)) : null
  } catch {
    return dependencies.invalid(request)
  }
  if (!input) return dependencies.invalid(request)
  if ((agent.profile.revision ?? 0) !== input.expectedRevision)
    return dependencies.failure(
      request,
      'AGENT_PROFILE_CONFLICT',
      'Agent profile changed; refresh and retry',
      409
    )
  try {
    await resolveAgentProfilePin(input, adminCorrelation(request), dependencies.hop(workspaceId))
    const payload: ApiAgentResponse = {
      agent: await dependencies.persist(workspaceId, agentId, resolution.principal, input),
    }
    return dependencies.json(payload, resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    if (error instanceof ControlPlaneProxyError)
      return dependencies.failure(request, error.code, error.message, error.status)
    if (error instanceof Error && error.name === 'AgentProfileConflictError')
      return dependencies.failure(
        request,
        'AGENT_PROFILE_CONFLICT',
        'Agent profile changed; refresh and retry',
        409
      )
    return dependencies.unavailable(request)
  }
}
