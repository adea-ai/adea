import { ApiClientError, type AgentHqApiClient } from '@adea-ai/api-client'
import type {
  ApiModelConnectionsResponse,
  ApiWorkspaceModelDefaults,
} from '@adea-ai/api-client/model-connections'
import { projectWorkspaceLeadSetup, type WorkspaceLeadSetup } from './workspace-lead-setup'

export type WorkspaceLeadClient = Pick<
  AgentHqApiClient,
  'getWorkspaceLead' | 'ensureWorkspaceLead' | 'listModelConnections' | 'getWorkspaceModelDefaults'
>

export type WorkspaceLeadLoad =
  | Readonly<{ current: true; setup: WorkspaceLeadSetup }>
  | Readonly<{ current: false }>

const STALE: WorkspaceLeadLoad = { current: false }

function failureOf(error: unknown): 'auth_required' | 'unavailable' {
  return error instanceof ApiClientError && error.status === 401 ? 'auth_required' : 'unavailable'
}

/**
 * Loads lead setup for one workspace. The lead is provisioned only when no lead
 * exists, and only while the caller's scope is still current, immediately before
 * the write. A result that lands after a scope switch is reported as stale and
 * must not be applied. Inventory or defaults read failures fail closed.
 */
export async function loadWorkspaceLeadSetup(input: {
  client: WorkspaceLeadClient
  workspaceId: string
  isCurrent(): boolean
}): Promise<WorkspaceLeadLoad> {
  const { client, workspaceId } = input
  const [leadRead, connections, defaults] = await Promise.all([
    client.getWorkspaceLead(workspaceId).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    ),
    client.listModelConnections(workspaceId).catch((): ApiModelConnectionsResponse | null => null),
    client
      .getWorkspaceModelDefaults(workspaceId)
      .then((page) => page.defaults)
      .catch((): ApiWorkspaceModelDefaults | null => null),
  ])
  if (!input.isCurrent()) return STALE
  if (!leadRead.ok)
    return {
      current: true,
      setup: projectWorkspaceLeadSetup({
        lead: null,
        failure: failureOf(leadRead.error),
        connections,
        defaults,
      }),
    }
  let lead = leadRead.value.lead
  let provisioning: 'failed' | undefined
  let failure: 'auth_required' | undefined
  if (!lead) {
    // The scope check sits immediately before the write.
    if (!input.isCurrent()) return STALE
    try {
      const written = (await client.ensureWorkspaceLead(workspaceId)).lead
      if (written?.isWorkspaceLead) lead = written
      else provisioning = 'failed'
    } catch (error) {
      if (failureOf(error) === 'auth_required') failure = 'auth_required'
      else provisioning = 'failed'
    }
    // A write that completes after a scope switch is not applied to the new scope.
    if (!input.isCurrent()) return STALE
  }
  return {
    current: true,
    setup: projectWorkspaceLeadSetup({
      lead,
      ...(failure ? { failure } : {}),
      ...(provisioning ? { provisioning } : {}),
      connections,
      defaults,
    }),
  }
}
