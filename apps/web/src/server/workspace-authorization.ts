import "server-only";

import { authorizeWorkspaceAction } from "@adea/auth/authorization";
import { findWorkspaceMembership, recordWorkspaceAuthorizationDecision } from "@adea/db";
import type { UserPrincipalRef, WorkspacePermission } from "@adea/types";

import { applicationDatabase } from "./database";

export async function authorizeWorkspace(
  principal: UserPrincipalRef,
  permission: WorkspacePermission,
  workspaceId: string | null,
  options: Readonly<{ includeArchived?: boolean }> = {}
) {
  const database = applicationDatabase();
  return authorizeWorkspaceAction(
    { permission, principal, workspaceId },
    {
      audit: (record) => recordWorkspaceAuthorizationDecision(database, record),
      findMembership: ({ principal: member, workspaceId: id }) =>
        findWorkspaceMembership(database, id, member, options),
    }
  );
}
