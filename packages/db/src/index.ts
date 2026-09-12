import 'server-only'

export {
  createArtifact,
  deleteArtifact,
  getArtifactForUser,
  listArtifactsForUser,
  setArtifactAvailability,
  type ArtifactCreateInput,
} from './artifacts'
export {
  createDatabase,
  type AgentHqDatabase,
  type AgentHqTransaction,
  type DatabaseConnection,
} from './connection'
export { readDatabaseUrl, type DatabaseEnvironment } from './config'
export {
  createContentRef,
  getContentRefForUser,
  updateContentRef,
  type ContentRefCreateInput,
  type ContentRefUpdateInput,
} from './content-refs'
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
} from './identity'
export {
  consumeDesktopAuthorizationCode,
  createDesktopSessionRecord,
  revokeDesktopSessionRecord,
  resolveDesktopSessionRecord,
  rotateDesktopSessionRecord,
  saveDesktopAuthorizationCode,
  type StoredDesktopAuthorizationCode,
  type StoredDesktopSession,
} from './desktop-auth'
export * from './schema'
export {
  appendWorkspaceEvent,
  inTransaction,
  type WorkspaceEventInput,
  type WorkspaceEventRecord,
} from './transactions'
export {
  assertCloudSafeEventPayload,
  FORBIDDEN_EVENT_PAYLOAD_KEYS,
  isWorkspaceEventType,
  MAX_EVENT_PAYLOAD_BYTES,
  resolveWorkspaceEventContract,
  WORKSPACE_EVENT_CONTRACTS,
  WORKSPACE_EVENT_TYPES,
  WorkspaceEventContractError,
  type WorkspaceEventActorKind,
  type WorkspaceEventAggregateType,
  type WorkspaceEventType,
} from './event-contract'
export {
  countWorkspaceEvents,
  latestWorkspaceEvents,
  listWorkspaceEventsAfter,
  markEventDispatchesNotified,
  pendingEventDispatches,
  pruneWorkspaceEventsBefore,
  workspaceEventWindow,
  WORKSPACE_EVENT_PAGE_LIMIT,
  type WorkspaceEventView,
} from './event-log'
export {
  listReadStateForUser,
  markAllChannelsRead,
  markChannelReadState,
  markThreadReadState,
} from './read-state'
export { searchWorkspaceForUser } from './search'
export {
  addWorkspaceMembership,
  archiveWorkspace,
  createWorkspaceWithOwner,
  ensureBootstrapWorkspaces,
  findWorkspaceMembership,
  getWorkspaceForUser,
  listWorkspacesForUser,
  recordWorkspaceAuthorizationDecision,
  removeWorkspaceMembership,
  reopenWorkspace,
  type WorkspaceMembershipRecord,
  type WorkspaceRole,
} from './workspaces'
export {
  archiveRoom,
  createRoom,
  getRoomForUser,
  listRoomsForUser,
  reorderRooms,
  updateRoom,
} from './rooms'
export {
  archiveAgent,
  assignAgentToRoom,
  changeAgentProfile,
  createAgent,
  getAgentForUser,
  listAgentsForUser,
  updateAgentPresentation,
} from './agents'
export {
  archiveTask,
  assignTask,
  cancelTask,
  completeTask,
  createTask,
  getTaskForUser,
  listTasksForUser,
  moveTaskToRoom,
  queueTask,
  reviewTask,
  setTaskArtifactReferences,
  setTaskConversationReferences,
  setTaskDependencies,
  startTask,
  updateTask,
  type TaskCommand,
  type TaskCreateInput,
  type TaskUpdateInput,
} from './tasks'
export {
  archiveChannel,
  createDirectAgentChannel,
  createGroupChannel,
  createMessage,
  createRoomChannel,
  deleteMessage,
  editMessage,
  getChannelForUser,
  getMessageForUser,
  listChannelsForUser,
  listMessagesForUser,
  provisionPrimaryRoomChannel,
  setChannelParticipants,
  updateChannel,
} from './conversations'
