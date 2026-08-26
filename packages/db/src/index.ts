import "server-only";

export {
  createDatabase,
  type AgentHqDatabase,
  type AgentHqTransaction,
  type DatabaseConnection,
} from "./connection";
export { readDatabaseUrl, type DatabaseEnvironment } from "./config";
export {
  claimTemporaryUserSession,
  claimTemporaryUserSessionForUser,
  createUserWithAuthIdentity,
  findUserPrincipalsByAuthIdentity,
  revokeAuthIdentity,
  type AuthIdentityKey,
  createTemporaryUserSession,
  getUserDisplayName,
  setUserDisplayNameIfMissing,
  type NewUserIdentity,
  resolveTemporaryUserSession,
  type TemporaryUserSessionInput,
  type TemporaryUserSessionRecord,
} from "./identity";
export {
  consumeDesktopAuthorizationCode,
  createDesktopSessionRecord,
  revokeDesktopSessionRecord,
  resolveDesktopSessionRecord,
  rotateDesktopSessionRecord,
  saveDesktopAuthorizationCode,
  type StoredDesktopAuthorizationCode,
  type StoredDesktopSession,
} from "./desktop-auth";
export * from "./schema";
export { appendWorkspaceEvent, inTransaction } from "./transactions";
export {
  addWorkspaceMembership,
  archiveWorkspace,
  createWorkspaceWithOwner,
  findWorkspaceMembership,
  getWorkspaceForUser,
  listWorkspacesForUser,
  recordWorkspaceAuthorizationDecision,
  removeWorkspaceMembership,
  reopenWorkspace,
  type WorkspaceMembershipRecord,
  type WorkspaceRole,
} from "./workspaces";
