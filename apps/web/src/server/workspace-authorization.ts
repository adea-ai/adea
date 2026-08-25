import "server-only";

import { authorizeWorkspaceAction } from "@agent-hq/auth/authorization";
import { findWorkspaceMembership, recordWorkspaceAuthorizationDecision } from "@agent-hq/db";
import type { UserPrincipalRef, WorkspacePermission } from "@agent-hq/types";

import { applicationDatabase } from "./database";

export async function authorizeWorkspace(
  principal: UserPrincipalRef,
  permission: WorkspacePermission,
  workspaceId: string | null,
  options: Readonly<{ includeArchived?: boolean }> = {},
) {
  const database = applicationDatabase();
  return authorizeWorkspaceAction(
    { permission, principal, workspaceId },
    {
      audit: (record) => recordWorkspaceAuthorizationDecision(database, record),
      findMembership: ({ principal: member, workspaceId: id }) =>
        findWorkspaceMembership(database, id, member, options),
    },
  );
}
