import { isUserPrincipalRef, type PrincipalRef, type WorkspacePermission } from '@adea-ai/types'

export type WorkspaceRole = 'admin' | 'member' | 'owner'

export const workspaceRolePermissions = Object.freeze({
  owner: Object.freeze([
    'workspace.read',
    'workspace.update',
    'workspace.archive',
    'workspace.delete',
    'workspace.events.read',
    'membership.read',
    'membership.manage',
    'runtime.invoke',
    'billing.manage',
  ] satisfies WorkspacePermission[]),
  admin: Object.freeze([
    'workspace.read',
    'workspace.update',
    'workspace.events.read',
    'membership.read',
    'membership.manage',
    'runtime.invoke',
  ] satisfies WorkspacePermission[]),
  member: Object.freeze([
    'workspace.read',
    'workspace.events.read',
    'membership.read',
  ] satisfies WorkspacePermission[]),
})

export type WorkspaceAuthorizationRequest = Readonly<{
  permission: WorkspacePermission
  principal: PrincipalRef
  workspaceId: string | null
}>

export type WorkspaceAuthorizationResult =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: 'workspace_unavailable' }>

export type WorkspaceAuthorizationAuditRecord = Readonly<{
  decision: 'allowed' | 'denied'
  permission: WorkspacePermission
  principal: PrincipalRef
  reason: 'permission_granted' | 'permission_missing'
  workspaceId: string
}>

export type WorkspaceAuthorizationDependencies = Readonly<{
  audit?(record: WorkspaceAuthorizationAuditRecord): Promise<void>
  findMembership(
    input: Readonly<{
      principal: Extract<PrincipalRef, { kind: 'user' }>
      workspaceId: string
    }>
  ): Promise<Readonly<{ role: WorkspaceRole; deletionPending?: boolean }> | null>
}>

const privilegedPermissions = new Set<WorkspacePermission>([
  'billing.manage',
  'membership.manage',
  'runtime.invoke',
  'workspace.archive',
  'workspace.delete',
])

export async function authorizeWorkspaceAction(
  request: WorkspaceAuthorizationRequest,
  dependencies: WorkspaceAuthorizationDependencies
): Promise<WorkspaceAuthorizationResult> {
  if (!isUserPrincipalRef(request.principal)) {
    return Object.freeze({ allowed: false, reason: 'workspace_unavailable' })
  }

  if (request.permission === 'workspace.create' && request.workspaceId === null) {
    return Object.freeze({ allowed: true })
  }
  if (!request.workspaceId) {
    return Object.freeze({ allowed: false, reason: 'workspace_unavailable' })
  }

  const membership = await dependencies.findMembership({
    principal: request.principal,
    workspaceId: request.workspaceId,
  })
  const allowed = Boolean(
    membership &&
    (!membership.deletionPending ||
      ['workspace.read', 'workspace.events.read', 'membership.read', 'workspace.delete'].includes(
        request.permission
      )) &&
    new Set<WorkspacePermission>(workspaceRolePermissions[membership.role]).has(request.permission)
  )

  if (dependencies.audit && (!allowed || privilegedPermissions.has(request.permission))) {
    await dependencies.audit({
      decision: allowed ? 'allowed' : 'denied',
      permission: request.permission,
      principal: request.principal,
      reason: allowed ? 'permission_granted' : 'permission_missing',
      workspaceId: request.workspaceId,
    })
  }

  return allowed
    ? Object.freeze({ allowed: true })
    : Object.freeze({ allowed: false, reason: 'workspace_unavailable' })
}
