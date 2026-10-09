/**
 * Canonical management operation inventory (M14.03.1, adea-ai/adea#1215).
 *
 * One closed catalog names every configuration, memory, project, worktree and
 * session management operation the product exposes, the exact existing API it
 * routes through, and the authorization, revision, confirmation, audit and
 * recovery contract that the shared gateway enforces for human controls and
 * lead tools alike.
 *
 * A lane is either callable through the operation's existing API today
 * (`supported`) or carries a typed reason the shared gateway must return
 * without executing. The inventory deliberately records missing upstream
 * contracts instead of fabricating authority: device-local operations have no
 * remote lead channel yet, and no operation may be executed by claiming a
 * capability the catalog does not name.
 *
 * This module has no I/O and no dependency on `@adea-ai/db` or the web app; it
 * is the shared vocabulary, not an executor.
 */
import type { WorkspacePermission } from './index'

/** The five management domains the parent issue (adea-ai/adea#1176) unifies. */
export const managementDomains = ['config', 'memory', 'project', 'worktree', 'session'] as const
export type ManagementDomain = (typeof managementDomains)[number]

/** Who is calling: a human web/desktop control or a workspace lead tool. */
export const managementLanes = ['web', 'desktop', 'lead'] as const
export type ManagementLane = (typeof managementLanes)[number]

/** Where the operation physically runs today. */
export const managementSurfaces = ['cloud', 'device'] as const
export type ManagementSurface = (typeof managementSurfaces)[number]

/**
 * Typed reasons the gateway must return instead of executing an operation.
 * They are the only sanctioned refusal vocabulary: a missing upstream contract
 * never becomes a fabricated grant, and a caller never receives free text.
 */
export const managementUnsupportedReasons = [
  /** The operation exists only through the authorized local device host. */
  'device_required',
  /** The canonical upstream turn/approval authority is not released/installed. */
  'upstream_authority_unavailable',
  /** No shared implementation or dedicated server-confirmed flow exists yet. */
  'not_implemented',
] as const
export type ManagementUnsupportedReason = (typeof managementUnsupportedReasons)[number]

/** The optimistic-concurrency or confirmation anchor an operation checks. */
export const managementRevisionKinds = [
  'none',
  'workspace_version',
  'workspace_order',
  'memory_revision',
  'project_order',
  'connection_version',
  'worktree_generation',
  'session_generation',
  'plan_digest',
] as const
export type ManagementRevisionKind = (typeof managementRevisionKinds)[number]

/**
 * How the operation confirms intent. `explicit` means the dedicated operation
 * itself is the confirmation (a destructive action only exists at this exact
 * operation, never as a side effect of another); `plan_commit` means an
 * immutable short-lived plan must be confirmed by its digest; `none` needs no
 * confirmation.
 */
export const managementConfirmationKinds = ['none', 'explicit', 'plan_commit'] as const
export type ManagementConfirmationKind = (typeof managementConfirmationKinds)[number]

/** The existing audit surface the operation records through. */
export const managementAuditKinds = [
  'none',
  'authorization_decision',
  'workspace_event',
  'device_audit',
] as const
export type ManagementAuditKind = (typeof managementAuditKinds)[number]

/** How a stale or interrupted caller recovers without duplicate effects. */
export const managementRecoveryKinds = [
  'none',
  'idempotent',
  'version_conflict',
  'resumable',
] as const
export type ManagementRecoveryKind = (typeof managementRecoveryKinds)[number]

/** The exact existing API the operation executes through. */
export type ManagementExistingApi =
  | Readonly<{ kind: 'web'; api: string }>
  | Readonly<{ kind: 'desktop'; api: string }>
  | Readonly<{ kind: 'device'; operation: `dev.${string}` }>

export type ManagementOperationSpec = Readonly<{
  domain: ManagementDomain
  surface: ManagementSurface
  /** Workspace permission checked by the shared authorization API, if any. */
  permission: WorkspacePermission | null
  /** Dev Runtime capability for device operations; null on cloud operations. */
  capability: `dev.${string}` | null
  api: ManagementExistingApi
  revision: ManagementRevisionKind
  confirmation: ManagementConfirmationKind
  audit: ManagementAuditKind
  recovery: ManagementRecoveryKind
  /** The callable state per lane; every unsupported lane carries a typed reason. */
  lanes: Readonly<Record<ManagementLane, 'supported' | ManagementUnsupportedReason>>
}>

export const managementOperationIds = [
  'config.workspace.update',
  'config.workspace.reopen',
  'config.workspace.reorder',
  'config.workspace.archive',
  'config.workspace.delete',
  'config.preferences.update',
  'config.connections.setGitHosting',
  'config.connections.setHarnessAccount',
  'memory.entry.create',
  'memory.entry.update',
  'memory.entry.delete',
  'memory.proposal.accept',
  'memory.proposal.reject',
  'memory.proposal.propose',
  'memory.injection.set',
  'project.create',
  'project.update',
  'project.archive',
  'project.delete',
  'project.reorder',
  'project.visibility.set',
  'project.member.set',
  'project.member.remove',
  'project.accessRoot.authorize',
  'worktree.create',
  'worktree.archive',
  'worktree.unarchive',
  'worktree.rename',
  'worktree.lease.acquire',
  'worktree.lease.release',
  'worktree.cleanup.plan',
  'worktree.cleanup.commit',
  'worktree.cleanup.resume',
  'worktree.merge.plan',
  'worktree.merge.commit',
  'session.create',
  'session.archive',
  'session.unarchive',
  'session.harness.cancel',
  'session.input.transfer',
] as const
export type ManagementOperationId = (typeof managementOperationIds)[number]

const supported = 'supported' as const
const deviceRequired = 'device_required' as const
const notImplemented = 'not_implemented' as const

const cloudLanes = Object.freeze({
  web: supported,
  desktop: supported,
  lead: supported,
})

const deviceLanes = Object.freeze({
  web: deviceRequired,
  desktop: supported,
  lead: deviceRequired,
})

const desktopLanes = Object.freeze({
  web: deviceRequired,
  desktop: supported,
  lead: deviceRequired,
})

/** Per-user workspace ordering is a personal preference, not a lead action. */
const workspaceReorderLanes = Object.freeze({
  web: supported,
  desktop: supported,
  lead: notImplemented,
})

export const managementOperations: Readonly<
  Record<ManagementOperationId, ManagementOperationSpec>
> = Object.freeze({
  'config.workspace.update': {
    api: { api: 'updateWorkspace', kind: 'web' },
    audit: 'authorization_decision',
    capability: null,
    confirmation: 'none',
    domain: 'config',
    lanes: cloudLanes,
    permission: 'workspace.update',
    recovery: 'version_conflict',
    revision: 'workspace_version',
    surface: 'cloud',
  },
  'config.workspace.reopen': {
    api: { api: 'reopenWorkspace', kind: 'web' },
    audit: 'workspace_event',
    capability: null,
    confirmation: 'none',
    domain: 'config',
    lanes: cloudLanes,
    permission: 'workspace.update',
    recovery: 'idempotent',
    revision: 'none',
    surface: 'cloud',
  },
  'config.workspace.reorder': {
    api: { api: 'reorderWorkspaces', kind: 'web' },
    audit: 'none',
    capability: null,
    confirmation: 'none',
    domain: 'config',
    lanes: workspaceReorderLanes,
    permission: 'workspace.read',
    recovery: 'version_conflict',
    revision: 'workspace_order',
    surface: 'cloud',
  },
  'config.workspace.archive': {
    api: { api: 'archiveWorkspace', kind: 'web' },
    audit: 'workspace_event',
    capability: null,
    confirmation: 'explicit',
    domain: 'config',
    lanes: { web: notImplemented, desktop: notImplemented, lead: notImplemented },
    permission: 'workspace.archive',
    recovery: 'idempotent',
    revision: 'none',
    surface: 'cloud',
  },
  'config.workspace.delete': {
    api: { api: 'beginWorkspaceDeletion+deleteWorkspace', kind: 'web' },
    audit: 'workspace_event',
    capability: null,
    confirmation: 'explicit',
    domain: 'config',
    lanes: { web: deviceRequired, desktop: supported, lead: deviceRequired },
    permission: 'workspace.delete',
    recovery: 'resumable',
    revision: 'workspace_version',
    surface: 'cloud',
  },
  'config.preferences.update': {
    api: { api: 'settings.save', kind: 'desktop' },
    audit: 'none',
    capability: null,
    confirmation: 'none',
    domain: 'config',
    lanes: desktopLanes,
    permission: null,
    recovery: 'none',
    revision: 'none',
    surface: 'device',
  },
  'config.connections.setGitHosting': {
    api: { kind: 'device', operation: 'dev.connections.setGitHosting' },
    audit: 'device_audit',
    capability: 'dev.repo.manage',
    confirmation: 'none',
    domain: 'config',
    lanes: deviceLanes,
    permission: null,
    recovery: 'version_conflict',
    revision: 'connection_version',
    surface: 'device',
  },
  'config.connections.setHarnessAccount': {
    api: { kind: 'device', operation: 'dev.connections.setHarnessAccount' },
    audit: 'device_audit',
    capability: 'dev.harness.manage',
    confirmation: 'none',
    domain: 'config',
    lanes: deviceLanes,
    permission: null,
    recovery: 'version_conflict',
    revision: 'connection_version',
    surface: 'device',
  },
  'memory.entry.create': {
    api: { api: 'memory.create', kind: 'desktop' },
    audit: 'device_audit',
    capability: null,
    confirmation: 'none',
    domain: 'memory',
    lanes: desktopLanes,
    permission: null,
    recovery: 'none',
    revision: 'none',
    surface: 'device',
  },
  'memory.entry.update': {
    api: { api: 'memory.update', kind: 'desktop' },
    audit: 'device_audit',
    capability: null,
    confirmation: 'none',
    domain: 'memory',
    lanes: desktopLanes,
    permission: null,
    recovery: 'version_conflict',
    revision: 'memory_revision',
    surface: 'device',
  },
  'memory.entry.delete': {
    api: { api: 'memory.delete', kind: 'desktop' },
    audit: 'device_audit',
    capability: null,
    confirmation: 'explicit',
    domain: 'memory',
    lanes: desktopLanes,
    permission: null,
    recovery: 'version_conflict',
    revision: 'memory_revision',
    surface: 'device',
  },
  'memory.proposal.accept': {
    api: { api: 'memory.acceptProposal', kind: 'desktop' },
    audit: 'device_audit',
    capability: null,
    confirmation: 'explicit',
    domain: 'memory',
    lanes: desktopLanes,
    permission: null,
    recovery: 'version_conflict',
    revision: 'memory_revision',
    surface: 'device',
  },
  'memory.proposal.reject': {
    api: { api: 'memory.rejectProposal', kind: 'desktop' },
    audit: 'device_audit',
    capability: null,
    confirmation: 'explicit',
    domain: 'memory',
    lanes: desktopLanes,
    permission: null,
    recovery: 'version_conflict',
    revision: 'memory_revision',
    surface: 'device',
  },
  'memory.proposal.propose': {
    api: { kind: 'device', operation: 'dev.memory.propose' },
    audit: 'device_audit',
    capability: 'dev.memory.propose',
    confirmation: 'none',
    domain: 'memory',
    lanes: deviceLanes,
    permission: null,
    recovery: 'none',
    revision: 'session_generation',
    surface: 'device',
  },
  'memory.injection.set': {
    api: { api: 'memory.setInjectionEnabled', kind: 'desktop' },
    audit: 'none',
    capability: null,
    confirmation: 'none',
    domain: 'memory',
    lanes: desktopLanes,
    permission: null,
    recovery: 'idempotent',
    revision: 'none',
    surface: 'device',
  },
  'project.create': {
    api: { api: 'createProject', kind: 'web' },
    audit: 'authorization_decision',
    capability: null,
    confirmation: 'none',
    domain: 'project',
    lanes: cloudLanes,
    permission: 'workspace.update',
    recovery: 'none',
    revision: 'none',
    surface: 'cloud',
  },
  'project.update': {
    api: { api: 'updateProject', kind: 'web' },
    audit: 'workspace_event',
    capability: null,
    confirmation: 'none',
    domain: 'project',
    lanes: cloudLanes,
    permission: 'workspace.update',
    recovery: 'none',
    revision: 'none',
    surface: 'cloud',
  },
  'project.archive': {
    api: { api: 'archiveProject', kind: 'web' },
    audit: 'workspace_event',
    capability: null,
    confirmation: 'explicit',
    domain: 'project',
    lanes: cloudLanes,
    permission: 'workspace.update',
    recovery: 'idempotent',
    revision: 'none',
    surface: 'cloud',
  },
  'project.delete': {
    api: { api: 'softDeleteProject', kind: 'web' },
    audit: 'workspace_event',
    capability: null,
    confirmation: 'explicit',
    domain: 'project',
    lanes: cloudLanes,
    permission: 'workspace.update',
    recovery: 'idempotent',
    revision: 'none',
    surface: 'cloud',
  },
  'project.reorder': {
    api: { api: 'reorderProjects', kind: 'web' },
    audit: 'authorization_decision',
    capability: null,
    confirmation: 'none',
    domain: 'project',
    lanes: cloudLanes,
    permission: 'workspace.update',
    recovery: 'version_conflict',
    revision: 'project_order',
    surface: 'cloud',
  },
  'project.visibility.set': {
    api: { api: 'setProjectVisibility', kind: 'web' },
    audit: 'workspace_event',
    capability: null,
    confirmation: 'none',
    domain: 'project',
    lanes: cloudLanes,
    permission: 'membership.manage',
    recovery: 'none',
    revision: 'none',
    surface: 'cloud',
  },
  'project.member.set': {
    api: { api: 'setProjectMember', kind: 'web' },
    audit: 'workspace_event',
    capability: null,
    confirmation: 'none',
    domain: 'project',
    lanes: cloudLanes,
    permission: 'membership.manage',
    recovery: 'idempotent',
    revision: 'none',
    surface: 'cloud',
  },
  'project.member.remove': {
    api: { api: 'removeProjectMember', kind: 'web' },
    audit: 'workspace_event',
    capability: null,
    confirmation: 'explicit',
    domain: 'project',
    lanes: cloudLanes,
    permission: 'membership.manage',
    recovery: 'idempotent',
    revision: 'none',
    surface: 'cloud',
  },
  'project.accessRoot.authorize': {
    api: { kind: 'device', operation: 'dev.project.authorizeRoot' },
    audit: 'device_audit',
    capability: 'dev.project.manage',
    confirmation: 'explicit',
    domain: 'project',
    lanes: deviceLanes,
    permission: null,
    recovery: 'none',
    revision: 'none',
    surface: 'device',
  },
  'worktree.create': {
    api: { kind: 'device', operation: 'dev.worktree.create' },
    audit: 'device_audit',
    capability: 'dev.worktree.manage',
    confirmation: 'none',
    domain: 'worktree',
    lanes: deviceLanes,
    permission: null,
    recovery: 'idempotent',
    revision: 'none',
    surface: 'device',
  },
  'worktree.archive': {
    api: { kind: 'device', operation: 'dev.worktree.archive' },
    audit: 'device_audit',
    capability: 'dev.worktree.manage',
    confirmation: 'explicit',
    domain: 'worktree',
    lanes: deviceLanes,
    permission: null,
    recovery: 'idempotent',
    revision: 'worktree_generation',
    surface: 'device',
  },
  'worktree.unarchive': {
    api: { kind: 'device', operation: 'dev.worktree.unarchive' },
    audit: 'device_audit',
    capability: 'dev.worktree.manage',
    confirmation: 'none',
    domain: 'worktree',
    lanes: deviceLanes,
    permission: null,
    recovery: 'idempotent',
    revision: 'worktree_generation',
    surface: 'device',
  },
  'worktree.rename': {
    api: { kind: 'device', operation: 'dev.worktree.rename' },
    audit: 'device_audit',
    capability: 'dev.worktree.manage',
    confirmation: 'none',
    domain: 'worktree',
    lanes: deviceLanes,
    permission: null,
    recovery: 'version_conflict',
    revision: 'worktree_generation',
    surface: 'device',
  },
  'worktree.lease.acquire': {
    api: { kind: 'device', operation: 'dev.worktree.lease' },
    audit: 'device_audit',
    capability: 'dev.worktree.manage',
    confirmation: 'none',
    domain: 'worktree',
    lanes: deviceLanes,
    permission: null,
    recovery: 'idempotent',
    revision: 'worktree_generation',
    surface: 'device',
  },
  'worktree.lease.release': {
    api: { kind: 'device', operation: 'dev.worktree.releaseLease' },
    audit: 'device_audit',
    capability: 'dev.worktree.manage',
    confirmation: 'none',
    domain: 'worktree',
    lanes: deviceLanes,
    permission: null,
    recovery: 'idempotent',
    revision: 'worktree_generation',
    surface: 'device',
  },
  'worktree.cleanup.plan': {
    api: { kind: 'device', operation: 'dev.worktree.cleanupPlan' },
    audit: 'device_audit',
    capability: 'dev.cleanup.approve',
    confirmation: 'plan_commit',
    domain: 'worktree',
    lanes: deviceLanes,
    permission: null,
    recovery: 'resumable',
    revision: 'worktree_generation',
    surface: 'device',
  },
  'worktree.cleanup.commit': {
    api: { kind: 'device', operation: 'dev.worktree.cleanupCommit' },
    audit: 'device_audit',
    capability: 'dev.cleanup.approve',
    confirmation: 'plan_commit',
    domain: 'worktree',
    lanes: deviceLanes,
    permission: null,
    recovery: 'resumable',
    revision: 'plan_digest',
    surface: 'device',
  },
  'worktree.cleanup.resume': {
    api: { kind: 'device', operation: 'dev.worktree.cleanupResume' },
    audit: 'device_audit',
    capability: 'dev.cleanup.approve',
    confirmation: 'none',
    domain: 'worktree',
    lanes: deviceLanes,
    permission: null,
    recovery: 'resumable',
    revision: 'worktree_generation',
    surface: 'device',
  },
  'worktree.merge.plan': {
    api: { kind: 'device', operation: 'dev.worktree.mergePlan' },
    audit: 'device_audit',
    capability: 'dev.worktree.manage',
    confirmation: 'plan_commit',
    domain: 'worktree',
    lanes: deviceLanes,
    permission: null,
    recovery: 'resumable',
    revision: 'worktree_generation',
    surface: 'device',
  },
  'worktree.merge.commit': {
    api: { kind: 'device', operation: 'dev.worktree.mergeCommit' },
    audit: 'device_audit',
    capability: 'dev.worktree.manage',
    confirmation: 'plan_commit',
    domain: 'worktree',
    lanes: deviceLanes,
    permission: null,
    recovery: 'resumable',
    revision: 'plan_digest',
    surface: 'device',
  },
  'session.create': {
    api: { kind: 'device', operation: 'dev.session.create' },
    audit: 'device_audit',
    capability: 'dev.session.manage',
    confirmation: 'none',
    domain: 'session',
    lanes: deviceLanes,
    permission: null,
    recovery: 'idempotent',
    revision: 'none',
    surface: 'device',
  },
  'session.archive': {
    api: { kind: 'device', operation: 'dev.session.archive' },
    audit: 'device_audit',
    capability: 'dev.session.manage',
    confirmation: 'explicit',
    domain: 'session',
    lanes: deviceLanes,
    permission: null,
    recovery: 'idempotent',
    revision: 'session_generation',
    surface: 'device',
  },
  'session.unarchive': {
    api: { kind: 'device', operation: 'dev.session.unarchive' },
    audit: 'device_audit',
    capability: 'dev.session.manage',
    confirmation: 'none',
    domain: 'session',
    lanes: deviceLanes,
    permission: null,
    recovery: 'idempotent',
    revision: 'session_generation',
    surface: 'device',
  },
  'session.harness.cancel': {
    api: { kind: 'device', operation: 'dev.session.cancelHarness' },
    audit: 'device_audit',
    capability: 'dev.session.manage',
    confirmation: 'explicit',
    domain: 'session',
    lanes: deviceLanes,
    permission: null,
    recovery: 'resumable',
    revision: 'session_generation',
    surface: 'device',
  },
  'session.input.transfer': {
    api: { kind: 'device', operation: 'dev.session.transferInput' },
    audit: 'device_audit',
    capability: 'dev.session.manage',
    confirmation: 'explicit',
    domain: 'session',
    lanes: deviceLanes,
    permission: null,
    recovery: 'idempotent',
    revision: 'session_generation',
    surface: 'device',
  },
})

export function isManagementOperationId(value: unknown): value is ManagementOperationId {
  return typeof value === 'string' && Object.hasOwn(managementOperations, value)
}

export function managementOperation(id: ManagementOperationId): ManagementOperationSpec {
  return managementOperations[id]
}

export type ManagementSupport =
  | Readonly<{ state: 'supported' }>
  | Readonly<{ state: 'unsupported'; reason: ManagementUnsupportedReason }>

/** The lane's callable state; never a fabricated grant. */
export function managementOperationSupport(
  id: ManagementOperationId,
  lane: ManagementLane
): ManagementSupport {
  const state = managementOperations[id].lanes[lane]
  return state === 'supported'
    ? Object.freeze({ state: 'supported' as const })
    : Object.freeze({ state: 'unsupported' as const, reason: state })
}

/** The lanes that carry a copy of an operation (used by parity checks). */
export function managementOperationLanes(id: ManagementOperationId): readonly ManagementLane[] {
  return Object.freeze(
    managementLanes.filter((lane) => managementOperations[id].lanes[lane] === 'supported')
  )
}
