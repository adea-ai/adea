/** Durable delivery intent, separate from Task lifecycle and runtime acceptance. */
export type TaskSubmissionSummary = Readonly<{
  id: string
  workspaceId: string
  taskId: string
  requestId: string
  runtimeNodeId: string
  locationKind: 'local_device' | 'remote_host'
  state: 'pending_delivery' | 'queued_for_node' | 'expired'
  profile: Readonly<{ id: string; version: string; revision: number }>
  taskVersion: number
  createdAt: string
  expiresAt: string
}>
