import 'server-only'

import { controlPlaneScopeIds, markWorkspaceControlPlaneUsed } from '@adea-ai/db'

import type { ControlPlaneScopeIds } from './control-plane-credential'
import { applicationDatabase } from './database'

/**
 * A resolver for the Control Plane scope mapped to an Adea workspace (and
 * optionally one of its projects), ADR 0013. Callers authorize the Adea
 * workspace first; this only translates identifiers, lazily, so a request
 * that fails before signing never touches the database.
 */
export function controlPlaneScopeResolver(
  workspaceId: string,
  projectId?: string
): () => Promise<ControlPlaneScopeIds | null> {
  return async () => {
    const scope = await controlPlaneScopeIds(applicationDatabase(), {
      workspaceId,
      ...(projectId === undefined ? {} : { projectId }),
    })
    return (
      scope && {
        ...scope,
        beforeMutation: () => markWorkspaceControlPlaneUsed(applicationDatabase(), workspaceId),
      }
    )
  }
}
