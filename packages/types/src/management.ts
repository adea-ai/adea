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
import type { UserPrincipalRef, WorkspacePermission } from './index'

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
  /**
   * The integer `ProjectSummary.version` published by #1218: every project-row
   * mutation increments it atomically (reorder included), and promotion/restore
   * compare-and-swap on it. It is never the display `updatedAt` timestamp.
   */
  'project_revision',
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
  'project.promote',
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
  'project.promote': {
    api: { api: 'promoteProjectState', kind: 'web' },
    audit: 'workspace_event',
    capability: null,
    confirmation: 'explicit',
    domain: 'project',
    // #1218 owns the executor, restore route and lead tool that flip these lanes
    // to `cloudLanes`; the catalog shape (api/revision/confirmation/audit/
    // recovery) is the canonical exact-call contract from here on.
    lanes: { desktop: notImplemented, lead: notImplemented, web: notImplemented },
    permission: 'workspace.update',
    recovery: 'version_conflict',
    revision: 'project_revision',
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

// ---------------------------------------------------------------------------
// Exact-call bound lead authority (CP932 coordination contract)
// ---------------------------------------------------------------------------
//
// Aligned with the adea-ai/control-plane#932 owner's proposed server-only
// `assertCurrent` port: exact accepted-plan pin, original actor, workspace,
// current audience, revision and expiry, canonical tool-call action/input/
// target digests, and approval interaction/audience/expiry. Adea recomputes
// the three digests from the exact call and refuses any mismatch; plan,
// audience and approval interaction currentness remain CP-asserted, never
// caller-provided truthy authorization.

/** Version of the immutable CP-issued lead management decision. */
export const managementAuthoritySchemaVersion = 'adea-management-authority/v1' as const
/** Version of the CP-to-Adea management call envelope. */
export const managementCallSchemaVersion = 'adea-management-call/v1' as const
/** Maximum decision lifetime; currentness is rechecked on every execution. */
export const managementAuthorityMaxLifetimeMs = 300_000

/**
 * The canonical tool-call identity a decision is bound to. The three digests
 * are `sha256:` over the UTF-8 bytes of canonical JSON of `{operation}`,
 * the canonical operation input and `{targetId}` respectively; the cleartext
 * operation/target/workspace let Adea recompute and compare them.
 */
export type ManagementCallBinding = Readonly<{
  actionDigest: `sha256:${string}`
  inputDigest: `sha256:${string}`
  targetDigest: `sha256:${string}`
  operation: ManagementOperationId
  targetId: string | null
  workspaceId: string
}>

/** Durable approval interaction identity, audience and expiry. */
export type ManagementAuthorityApproval = Readonly<{
  interactionId: string
  audienceRef: string
  expiresAt: string
}>

/**
 * An immutable, current, exact-call bound authorization/approval decision.
 * The CP authority (CP932) persists and re-reads it; Adea revalidates the
 * returned decision against the call it is about to execute and never treats
 * any caller-supplied field as a grant.
 */
export type ManagementAuthorityDecision = Readonly<{
  schemaVersion: typeof managementAuthoritySchemaVersion
  /** Opaque single-use approval identity the caller presented. */
  authorityRef: string
  decision: 'allowed' | 'denied'
  decisionId: string
  leadAgentId: string
  intentId: string
  /** The original user principal whose current workspace permission applies. */
  principal: UserPrincipalRef
  binding: ManagementCallBinding
  /** Exact accepted-plan pin the approval was issued against. */
  planRef: string
  planRevision: number
  /** Current CP authority/config revision and current audience. */
  authorityRevision: number
  audienceRef: string
  approval: ManagementAuthorityApproval
  issuedAt: string
  expiresAt: string
}>

/**
 * Typed reasons a lead management decision is refused. Plan, audience and
 * approval-interaction currentness are CP-asserted; the local reasons below
 * cover every check Adea can make without re-reading CP authority.
 */
export const managementAuthorityReasonCodes = Object.freeze([
  /** The upstream authority port is absent, threw or returned nothing. */
  'authority_unavailable',
  /** The decision shape or exact-call binding is malformed. */
  'authority_malformed',
  /** The decision was issued for a different operation/workspace/target/input. */
  'authority_binding_mismatch',
  /** The canonical decision is an explicit denial. */
  'authority_denied',
  /** The decision expired before this execution. */
  'authority_expired',
  /** The decision is not yet valid or its lifetime is unusable. */
  'authority_not_yet_valid',
  /** The durable approval interaction expired before this execution. */
  'authority_approval_expired',
  /** The durable claim was left by an interrupted delivery; retry needs a fresh decision. */
  'authority_recovery_required',
  /** The single-use approval was already consumed. */
  'authority_replay',
] as const)
export type ManagementAuthorityReasonCode = (typeof managementAuthorityReasonCodes)[number]

export type ManagementAuthorityValidation =
  | Readonly<{ state: 'valid'; decision: ManagementAuthorityDecision }>
  | Readonly<{ state: 'invalid'; reason: ManagementAuthorityReasonCode }>

/**
 * The canonical Pi Durable tool-authority boundaries (control-plane PR #1038,
 * commit ed942840df125385e329f1af4d16c4699ec57fd5,
 * apps/control-api/src/pi-durable/current-tool-authority.ts). The assertion is
 * a repeatable currentness check: it returns void or throws, never consumes the
 * approval and never returns a truthy grant. The durable effect claim is the
 * single single-use owner.
 */
export const managementAuthorityBoundaries = [
  'admission',
  'approval',
  'effect',
  'publication',
] as const
export type ManagementAuthorityBoundary = (typeof managementAuthorityBoundaries)[number]

/**
 * The exact-call identity the host supplies to its canonical current-authority
 * owner. A CP host mapping projects the canonical CurrentPiDurableToolRequest
 * into this shape; it is deliberately not a wire protocol.
 */
export type ManagementCurrentAuthorityRequest = Readonly<{
  /**
   * Opaque canonical CP tool-call request supplied by the CP host mapping and
   * forwarded verbatim to the Control API current-authority route. Adea never
   * constructs or interprets it; absent, the client fails closed.
   */
  canonicalRequest?: unknown
  decisionId: string
  authorityRef: string
  authorityRevision: number
  leadAgentId: string
  intentId: string
  principal: UserPrincipalRef
  planRef: string
  planRevision: number
  audienceRef: string
  approval: ManagementAuthorityApproval
  binding: ManagementCallBinding
  now: number
}>

/**
 * Server-only current-authority seam. Resolves void or throws, exactly like
 * the canonical `assertCurrent(request, boundary)`. Repeatable: the route
 * asserts at admission and the gateway reasserts at effect; neither call
 * consumes anything.
 */
export type ManagementCurrentAuthority = (
  request: ManagementCurrentAuthorityRequest,
  boundary: ManagementAuthorityBoundary
) => Promise<void>

/**
 * Durable claim state for one delivered decision. `replayed` retains only a
 * result digest; `recovery_required` means an interrupted delivery must not be
 * retried with the same decision.
 */
export type ManagementAuthorityClaim =
  | Readonly<{ state: 'claimed' }>
  | Readonly<{ state: 'replayed'; resultDigest: string | null }>
  | Readonly<{
      state: 'recovery_required'
      priorState: 'claimed' | 'succeeded' | 'failed'
    }>

/** The retained outcome written after the effect. */
export type ManagementAuthorityCompletion =
  | Readonly<{ state: 'succeeded'; resultDigest: string | null }>
  | Readonly<{ state: 'failed'; failureCode: string }>

/** A thrown, typed refusal from `assertManagementAuthorityCurrent`. */
export class ManagementAuthorityError extends Error {
  constructor(readonly reason: ManagementAuthorityReasonCode) {
    super('Lead management authority is not current for this call')
    this.name = 'ManagementAuthorityError'
  }
}

const authorityKeys = [
  'approval',
  'audienceRef',
  'authorityRef',
  'authorityRevision',
  'binding',
  'decision',
  'decisionId',
  'expiresAt',
  'intentId',
  'issuedAt',
  'leadAgentId',
  'planRef',
  'planRevision',
  'principal',
  'schemaVersion',
] as const

const bindingKeys = [
  'actionDigest',
  'inputDigest',
  'operation',
  'targetDigest',
  'targetId',
  'workspaceId',
] as const

const approvalKeys = ['audienceRef', 'expiresAt', 'interactionId'] as const

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function digestValue(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function canonicalValue(value: unknown, depth: number): string | undefined {
  if (depth > 32) return undefined
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : undefined
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalValue(item, depth + 1))
    return items.some((item) => item === undefined) ? undefined : `[${items.join(',')}]`
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value).toSorted()
    const entries: string[] = []
    for (const key of keys) {
      const encoded = canonicalValue(value[key], depth + 1)
      if (encoded === undefined) return undefined
      entries.push(`${JSON.stringify(key)}:${encoded}`)
    }
    return `{${entries.join(',')}}`
  }
  return undefined
}

/**
 * Canonical JSON for the exact-call digests. Returns null for any value that
 * is not JSON-safe (undefined, bigint, functions, non-finite numbers, class
 * instances) so the caller fails closed instead of hashing a guess.
 */
export function managementCanonicalInput(input: unknown): string | null {
  return canonicalValue(input, 0) ?? null
}

/** `sha256:<lowercase hex>` over the canonical input, or null when invalid. */
export async function managementInputDigest(input: unknown): Promise<`sha256:${string}` | null> {
  const canonical = managementCanonicalInput(input)
  if (canonical === null) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`
}

/** Builds the exact-call binding; null when any identity field is unusable. */
export async function managementCallBinding(input: {
  workspaceId: string
  operation: ManagementOperationId
  targetId: string | null
  input: unknown
}): Promise<ManagementCallBinding | null> {
  if (
    !isManagementOperationId(input.operation) ||
    !boundedString(input.workspaceId, 128) ||
    (input.targetId !== null && !boundedString(input.targetId, 128))
  )
    return null
  const [actionDigest, inputDigest, targetDigest] = await Promise.all([
    managementInputDigest({ operation: input.operation }),
    managementInputDigest(input.input),
    managementInputDigest({ targetId: input.targetId }),
  ])
  if (!actionDigest || !inputDigest || !targetDigest) return null
  return Object.freeze({
    actionDigest,
    inputDigest,
    operation: input.operation,
    targetDigest,
    targetId: input.targetId,
    workspaceId: input.workspaceId,
  })
}

export function managementBindingsEqual(
  left: ManagementCallBinding,
  right: ManagementCallBinding
): boolean {
  return (
    left.actionDigest === right.actionDigest &&
    left.inputDigest === right.inputDigest &&
    left.targetDigest === right.targetDigest &&
    left.operation === right.operation &&
    left.targetId === right.targetId &&
    left.workspaceId === right.workspaceId
  )
}

/** Strict, unknown-key-rejecting parse of a CP-issued decision. */
export function parseManagementAuthorityDecision(
  value: unknown
): ManagementAuthorityDecision | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, authorityKeys)) return null
  if (value.schemaVersion !== managementAuthoritySchemaVersion) return null
  if (!boundedString(value.authorityRef, 128)) return null
  if (value.decision !== 'allowed' && value.decision !== 'denied') return null
  if (!boundedString(value.decisionId, 128)) return null
  if (!boundedString(value.leadAgentId, 128)) return null
  if (!boundedString(value.intentId, 128)) return null
  if (!boundedString(value.planRef, 128)) return null
  if (!Number.isSafeInteger(value.planRevision) || (value.planRevision as number) < 1) return null
  const principal = value.principal
  if (
    !isPlainRecord(principal) ||
    Object.keys(principal).length !== 2 ||
    principal.kind !== 'user' ||
    !boundedString(principal.userId, 128)
  )
    return null
  const binding = value.binding
  if (
    !isPlainRecord(binding) ||
    !hasExactKeys(binding, bindingKeys) ||
    !boundedString(binding.workspaceId, 128) ||
    !isManagementOperationId(binding.operation) ||
    (binding.targetId !== null && !boundedString(binding.targetId, 128)) ||
    !digestValue(binding.actionDigest) ||
    !digestValue(binding.inputDigest) ||
    !digestValue(binding.targetDigest)
  )
    return null
  if (!Number.isSafeInteger(value.authorityRevision) || (value.authorityRevision as number) < 1)
    return null
  if (!boundedString(value.audienceRef, 256)) return null
  const approval = value.approval
  if (
    !isPlainRecord(approval) ||
    !hasExactKeys(approval, approvalKeys) ||
    !boundedString(approval.interactionId, 128) ||
    !boundedString(approval.audienceRef, 256) ||
    !boundedString(approval.expiresAt, 64)
  )
    return null
  if (!boundedString(value.issuedAt, 64) || !boundedString(value.expiresAt, 64)) return null
  return Object.freeze({
    approval: Object.freeze({
      audienceRef: approval.audienceRef,
      expiresAt: approval.expiresAt,
      interactionId: approval.interactionId,
    }),
    audienceRef: value.audienceRef,
    authorityRef: value.authorityRef,
    authorityRevision: value.authorityRevision as number,
    binding: Object.freeze({
      actionDigest: binding.actionDigest,
      inputDigest: binding.inputDigest,
      operation: binding.operation,
      targetDigest: binding.targetDigest,
      targetId: binding.targetId as string | null,
      workspaceId: binding.workspaceId,
    }),
    decision: value.decision,
    decisionId: value.decisionId,
    expiresAt: value.expiresAt,
    intentId: value.intentId,
    issuedAt: value.issuedAt,
    leadAgentId: value.leadAgentId,
    planRef: value.planRef,
    planRevision: value.planRevision as number,
    principal: Object.freeze({ kind: 'user' as const, userId: principal.userId }),
    schemaVersion: managementAuthoritySchemaVersion,
  })
}

/**
 * Revalidates a parsed decision against the exact call about to execute.
 * Returns a typed reason, or null when the decision authorizes this call now.
 * Plan/audience currentness is CP-asserted; this checks every fact Adea can
 * recompute or read from the signed envelope.
 */
export function validateManagementAuthorityDecision(
  decision: ManagementAuthorityDecision,
  expected: Readonly<{
    binding: ManagementCallBinding
    authorityRef: string
    intentId: string
    leadAgentId: string
    now: number
  }>
): ManagementAuthorityReasonCode | null {
  if (
    decision.authorityRef !== expected.authorityRef ||
    decision.intentId !== expected.intentId ||
    decision.leadAgentId !== expected.leadAgentId
  )
    return 'authority_binding_mismatch'
  if (!managementBindingsEqual(decision.binding, expected.binding))
    return 'authority_binding_mismatch'
  if (decision.decision !== 'allowed') return 'authority_denied'
  const issued = Date.parse(decision.issuedAt)
  const expires = Date.parse(decision.expiresAt)
  const approvalExpires = Date.parse(decision.approval.expiresAt)
  const now = expected.now
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    !Number.isFinite(approvalExpires) ||
    !Number.isSafeInteger(now) ||
    issued > now
  )
    return 'authority_not_yet_valid'
  if (expires <= now || expires <= issued || expires - issued > managementAuthorityMaxLifetimeMs)
    return 'authority_expired'
  if (approvalExpires <= now) return 'authority_approval_expired'
  return null
}

/**
 * Server-only fail-closed assertion matching the CP932 `assertCurrent` port:
 * returns void when the exact call is currently authorized, throws a typed
 * `ManagementAuthorityError` otherwise. Never returns a truthy grant.
 */
export function assertManagementAuthorityCurrent(
  decision: ManagementAuthorityDecision,
  expected: Readonly<{
    binding: ManagementCallBinding
    authorityRef: string
    intentId: string
    leadAgentId: string
    now: number
  }>
): void {
  const reason = validateManagementAuthorityDecision(decision, expected)
  if (reason) throw new ManagementAuthorityError(reason)
}
