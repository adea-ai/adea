import "server-only";

export {
  createDatabase,
  type AgentHqDatabase,
  type AgentHqTransaction,
  type DatabaseConnection,
} from "./connection";
export { readDatabaseUrl, type DatabaseEnvironment } from "./config";
export {
  createUserWithAuthIdentity,
  findUserPrincipalsByAuthIdentity,
  revokeAuthIdentity,
  type AuthIdentityKey,
  type NewUserIdentity,
} from "./identity";
export {
  consumeDesktopAuthorizationCode,
  createDesktopSessionRecord,
  revokeDesktopSessionRecord,
  rotateDesktopSessionRecord,
  saveDesktopAuthorizationCode,
  type StoredDesktopAuthorizationCode,
  type StoredDesktopSession,
} from "./desktop-auth";
export * from "./schema";
export { appendWorkspaceEvent, inTransaction } from "./transactions";
