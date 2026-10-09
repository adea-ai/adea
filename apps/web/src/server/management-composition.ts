/**
 * Production composition for the shared management surface (M14.03.1,
 * adea-ai/adea#1215). Wires the inventory operation executors to the existing
 * `@adea-ai/db` functions and the shared authorization/audit APIs. HTTP routes
 * and the future lead tool host use the identical composition.
 *
 * `server-only`-clean: this module is only imported by server routes and the
 * lead tool host; unit tests inject the executor fakes instead.
 */
import {
  archiveProject,
  createProject,
  recordWorkspaceAuthorizationDecision,
  removeProjectMember,
  reopenWorkspace,
  reorderProjects,
  setProjectMember,
  setProjectVisibility,
  softDeleteProject,
  updateProject,
  updateWorkspace,
} from '@adea-ai/db'

import { applicationDatabase } from './database'
import { createManagementGateway, type ManagementCaller } from './management-gateway'
import { createManagementOperations, type ManagementOperations } from './management-operations'
import { authorizeWorkspace } from './workspace-authorization'

export function applicationManagementOperations(
  caller: ManagementCaller = { kind: 'human' }
): ManagementOperations {
  const gateway = createManagementGateway(
    {
      async authorize(input) {
        const decision = await authorizeWorkspace(
          input.principal,
          input.permission,
          input.workspaceId,
          input.includeArchived ? { includeArchived: true } : {}
        )
        return decision.allowed
      },
      async audit(record) {
        if (record.caller.kind !== 'lead') return
        // The user-principal decision is audited by `authorizeWorkspace`; this
        // second existing audit row attributes the inherited lead action to the
        // exact lead Agent, turn and consumed approval without granting it anything.
        await recordWorkspaceAuthorizationDecision(applicationDatabase(), {
          decision: record.decision,
          permission: record.permission,
          principal: { agentId: record.caller.decision.leadAgentId, kind: 'agent' },
          reason: `${record.reason}:${record.operation}:${record.caller.decision.intentId}:${record.decisionId ?? record.caller.decision.decisionId}`,
          workspaceId: record.workspaceId,
        })
      },
    },
    caller
  )
  return createManagementOperations({
    database: applicationDatabase,
    executors: {
      archiveProject,
      createProject,
      removeProjectMember,
      reopenWorkspace,
      reorderProjects,
      setProjectMember,
      setProjectVisibility,
      softDeleteProject,
      updateProject,
      updateWorkspace,
    },
    gateway,
  })
}
