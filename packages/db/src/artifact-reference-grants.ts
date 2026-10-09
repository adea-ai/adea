import type { ArtifactReferenceGrantState, UserPrincipalRef } from '@adea-ai/types'
import { and, eq, isNull } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { artifactReferenceGrants, artifacts, workspaceMemberships, workspaces } from './schema'

/**
 * Durable store for artifact-reference grants (M15.03 #1180).
 *
 * The policy in `artifact-reference-policy` is pure: it consumes the
 * authoritative registration state this module persists. One row per grant
 * id carries the grant's complete identity — source workspace, artifact,
 * granted version, content checksum, audience workspace and the expiry
 * string verbatim — plus a positive revision and the revocation mark.
 *
 * Authority is resolved from the DATABASE, never the request. A registration
 * or regrant is only ever persisted after the store has verified, inside its
 * own transaction, that:
 *
 * - the issuer holds an authoritative role (`owner` or `admin`) in the source
 *   workspace, per the existing membership/role model — granting
 *   cross-workspace access is not a member-level act;
 * - BOTH bound workspaces are live (`deleted_at` is null): a deleted or
 *   archived workspace cannot anchor or receive a grant;
 * - the artifact exists under the claimed source workspace and is LIVE
 *   (`deletion_state = 'active'`, not quarantined — the schema's own
 *   lifecycle semantics), and the presented version and content checksum are
 *   EQUAL to the artifact record's. A registration whose version or digest
 *   diverges from the canonical record fails closed and persists nothing.
 *
 * Durability guarantees:
 *
 * - Registration is idempotent ONLY for a live grant. Registering the
 *   identical grant (same grant id and complete identity) while it is live
 *   returns the existing registration without duplicating a row or bumping
 *   the revision; a genuinely new registration starts at revision 1.
 * - A registration retry after revocation FAILS CLOSED: it never restores
 *   access and never bumps the revision. Restoring access after revocation
 *   is an explicit, revision-checked regrant — never a registration replay.
 * - Regranting is explicit and revision-checked (CAS): the caller must
 *   present the expected current revision; a wrong or malformed expectation
 *   is refused and changes nothing, and success mints the next positive
 *   revision and clears the revocation mark. The superseded revision can
 *   never be read as current again, so a stale grant cannot regain access.
 * - A grant id can never be relabelled. Registering or regranting a known
 *   grant id with any different identity field fails closed; a changed
 *   lifetime or target requires a new grant id, mirroring the policy's
 *   per-field refusals.
 * - Revocation cannot race authorization. The transaction-scoped authorize
 *   path (`withArtifactReferenceGrantLocks`) takes row locks on the artifact
 *   row and the current grant row, then invokes the caller's authorization
 *   callback while the locks are held: a concurrent revocation commits only
 *   after the callback completes, so a grant can never be read valid and
 *   then revoked before publication lands, nor published after revocation is
 *   visible. Locks are always taken artifact-first, then grant — the same
 *   order registration and regrant use — so lock cycles are impossible.
 *
 * The reader resolves a presented grant id to its CURRENT registration and
 * hands back the full stored state; the policy performs the field-by-field
 * authentication against the presented grant. A presented revision that is
 * no longer current reads as absent (the policy's `grant_not_registered`
 * covers superseded revisions), never as the current registration.
 */

type Database = AgentHqDatabase | AgentHqTransaction
type GrantRow = typeof artifactReferenceGrants.$inferSelect

/** One grant registration as the granting workspace presents it. */
export type ArtifactReferenceGrantRegistrationInput = Readonly<{
  artifactId: string
  audienceWorkspaceId: string
  checksumSha256: string
  /** Stored verbatim: the policy compares expiry by exact string equality. */
  expiresAt: string | null
  grantId: string
  version: number
}>

export type ArtifactReferenceGrantRegistrationResult = Readonly<{
  outcome: 'registered' | 'existing'
  state: ArtifactReferenceGrantState
}>

/** The presented grant identity the current-grant reader resolves. */
export type ArtifactReferenceGrantPresentation = Readonly<{
  grantId: string
  revision: number
}>

/**
 * The lock scope of the transaction-scoped authorize path: which grant
 * presentation to resolve, bound to which source-workspace artifact. Both
 * rows are locked for the duration of the caller's authorization callback.
 */
export type ArtifactReferenceGrantLockScope = ArtifactReferenceGrantPresentation &
  Readonly<{
    artifactId: string
    sourceWorkspaceId: string
  }>

/** Typed refusal codes for grant-store operations. Fail-closed, by name. */
export const artifactReferenceGrantRejectionCodes = [
  'grant_artifact_deleted',
  'grant_artifact_quarantined',
  'grant_artifact_unknown',
  'grant_identity_conflict',
  'grant_identity_invalid',
  'grant_issuer_unauthorized',
  'grant_not_registered',
  'grant_registration_failed',
  'grant_revocation_failed',
  'grant_revoked_retry',
  'grant_revision_conflict',
  'grant_target_divergence',
  'grant_unavailable',
  'grant_workspace_inactive',
] as const

export type ArtifactReferenceGrantRejectionCode =
  (typeof artifactReferenceGrantRejectionCodes)[number]

const rejectionMessages: Record<ArtifactReferenceGrantRejectionCode, string> = {
  grant_artifact_deleted: 'Artifact reference grant artifact deleted',
  grant_artifact_quarantined: 'Artifact reference grant artifact quarantined',
  grant_artifact_unknown: 'Artifact reference grant artifact unknown',
  grant_identity_conflict: 'Artifact reference grant identity conflict',
  grant_identity_invalid: 'Artifact reference grant metadata invalid',
  grant_issuer_unauthorized: 'Artifact reference grant issuer unauthorized',
  grant_not_registered: 'Artifact reference grant not registered',
  grant_registration_failed: 'Artifact reference grant registration failed',
  grant_revocation_failed: 'Artifact reference grant revocation failed',
  grant_revoked_retry:
    'Artifact reference grant registration after revocation requires an explicit regrant',
  grant_revision_conflict: 'Artifact reference grant revision conflict',
  grant_target_divergence: 'Artifact reference grant target diverges from the artifact record',
  grant_unavailable: 'Artifact reference grant unavailable',
  grant_workspace_inactive: 'Artifact reference grant workspace inactive',
}

/** A grant-store operation refused, with the typed reason it was refused. */
export class ArtifactReferenceGrantError extends Error {
  constructor(readonly code: ArtifactReferenceGrantRejectionCode) {
    super(rejectionMessages[code])
    this.name = 'ArtifactReferenceGrantError'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST = /^[0-9a-f]{64}$/

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isRegisteredExpiry(value: unknown): value is string | null {
  return value === null || (hasText(value) && Number.isFinite(Date.parse(value)))
}

function reject(code: ArtifactReferenceGrantRejectionCode): never {
  throw new ArtifactReferenceGrantError(code)
}

function validateRegistrationInput(
  sourceWorkspaceId: string,
  input: ArtifactReferenceGrantRegistrationInput
): void {
  if (
    !UUID.test(sourceWorkspaceId) ||
    !UUID.test(input.audienceWorkspaceId) ||
    !UUID.test(input.artifactId) ||
    !hasText(input.grantId) ||
    !DIGEST.test(input.checksumSha256) ||
    !isPositiveInteger(input.version) ||
    !isRegisteredExpiry(input.expiresAt) ||
    sourceWorkspaceId === input.audienceWorkspaceId
  )
    reject('grant_identity_invalid')
}

function grantStateOf(row: GrantRow): ArtifactReferenceGrantState {
  return Object.freeze({
    artifactId: row.artifactId,
    audienceWorkspaceIds: Object.freeze([row.audienceWorkspaceId]),
    checksumSha256: row.checksumSha256,
    expiresAt: row.expiresAt,
    grantId: row.grantId,
    revoked: row.revokedAt !== null,
    revision: row.revision,
    sourceWorkspaceId: row.sourceWorkspaceId,
    version: row.version,
  })
}

function sameIdentity(
  row: GrantRow,
  sourceWorkspaceId: string,
  input: ArtifactReferenceGrantRegistrationInput
): boolean {
  return (
    row.sourceWorkspaceId === sourceWorkspaceId &&
    row.artifactId === input.artifactId &&
    row.audienceWorkspaceId === input.audienceWorkspaceId &&
    row.checksumSha256 === input.checksumSha256 &&
    row.version === input.version &&
    row.expiresAt === input.expiresAt
  )
}

async function requireMembership(
  database: Database,
  workspaceId: string,
  principal: UserPrincipalRef
) {
  const [membership] = await database
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .limit(1)
  if (!membership) reject('grant_unavailable')
}

/**
 * The issuer of a grant (registration or regrant) must hold an authoritative
 * role in the source workspace — `owner` or `admin`, the repo's existing
 * privileged-role model — and that workspace must be live. A deleted or
 * archived workspace cannot anchor a grant.
 */
async function requireGrantIssuerAuthority(
  transaction: AgentHqTransaction,
  sourceWorkspaceId: string,
  principal: UserPrincipalRef
): Promise<void> {
  const [membership] = await transaction
    .select({ deletedAt: workspaces.deletedAt, role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaceMemberships.workspaceId, workspaces.id))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, sourceWorkspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .limit(1)
  if (!membership) reject('grant_issuer_unauthorized')
  if (membership.deletedAt !== null) reject('grant_workspace_inactive')
  if (membership.role !== 'owner' && membership.role !== 'admin')
    reject('grant_issuer_unauthorized')
}

/** A grant binds workspaces on both sides, so the audience must be live too. */
async function requireWorkspaceLive(
  transaction: AgentHqTransaction,
  workspaceId: string
): Promise<void> {
  const [workspace] = await transaction
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .limit(1)
  if (!workspace) reject('grant_workspace_inactive')
}

/**
 * Lock the artifact a grant names and refuse anything that is not LIVE under
 * the schema's own lifecycle semantics: it must exist under the claimed
 * source workspace, be `active` (not deleted) and not quarantined. The row
 * lock keeps version and checksum stable for the rest of the transaction and
 * orders artifact-before-grant with the authorize path.
 */
async function lockLivableArtifact(
  transaction: AgentHqTransaction,
  sourceWorkspaceId: string,
  artifactId: string
): Promise<typeof artifacts.$inferSelect> {
  const [artifact] = await transaction
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, sourceWorkspaceId)))
    .limit(1)
    .for('update')
  if (!artifact) reject('grant_artifact_unknown')
  if (artifact.deletionState === 'deleted') reject('grant_artifact_deleted')
  if (artifact.availability === 'quarantined') reject('grant_artifact_quarantined')
  return artifact
}

/**
 * Resolve authority from the database before anything is persisted: issuer
 * role and source liveness, audience liveness, then the canonical artifact —
 * whose version and content checksum must EQUAL the presented ones. A
 * divergence fails closed: the request never gets to relabel the granted
 * target.
 */
async function resolveRegistrationAuthority(
  transaction: AgentHqTransaction,
  sourceWorkspaceId: string,
  principal: UserPrincipalRef,
  input: ArtifactReferenceGrantRegistrationInput
): Promise<void> {
  await requireGrantIssuerAuthority(transaction, sourceWorkspaceId, principal)
  await requireWorkspaceLive(transaction, input.audienceWorkspaceId)
  const artifact = await lockLivableArtifact(transaction, sourceWorkspaceId, input.artifactId)
  if (artifact.version !== input.version || artifact.checksumSha256 !== input.checksumSha256)
    reject('grant_target_divergence')
}

async function selectByGrantId(database: Database, grantId: string): Promise<GrantRow | undefined> {
  const [row] = await database
    .select()
    .from(artifactReferenceGrants)
    .where(eq(artifactReferenceGrants.grantId, grantId))
    .limit(1)
    .for('update')
  return row
}

/**
 * Decide a registration against the locked current row. A registered grant
 * id is either replayed identically (idempotent, live only), refused for an
 * identity conflict, or — after revocation — refused as a retry: restoring
 * access is the explicit regrant's job, never a registration's. Returns null
 * when the grant id is unregistered and a row must be inserted.
 */
async function decideRegistration(
  transaction: AgentHqTransaction,
  sourceWorkspaceId: string,
  input: ArtifactReferenceGrantRegistrationInput
): Promise<ArtifactReferenceGrantRegistrationResult | null> {
  const existing = await selectByGrantId(transaction, input.grantId)
  if (!existing) return null
  if (!sameIdentity(existing, sourceWorkspaceId, input)) reject('grant_identity_conflict')
  if (existing.revokedAt !== null) reject('grant_revoked_retry')
  return { outcome: 'existing', state: grantStateOf(existing) }
}

/**
 * Register one artifact-reference grant on behalf of its granting (source)
 * workspace. Authority and canonicality are resolved from the database first
 * (`resolveRegistrationAuthority`). Idempotent ONLY for an identical live
 * registration; a retry after revocation fails closed and never restores
 * access. Any other reuse of a registered grant id fails closed.
 */
export async function registerArtifactReferenceGrant(
  database: AgentHqDatabase,
  sourceWorkspaceId: string,
  principal: UserPrincipalRef,
  input: ArtifactReferenceGrantRegistrationInput
): Promise<ArtifactReferenceGrantRegistrationResult> {
  validateRegistrationInput(sourceWorkspaceId, input)
  return database.transaction(async (transaction) => {
    const decided = await decideRegistration(transaction, sourceWorkspaceId, input)
    if (decided) return decided

    // A new registration persists nothing until authority and canonicality
    // hold; the row's version and checksum are the artifact record's own.
    await resolveRegistrationAuthority(transaction, sourceWorkspaceId, principal, input)

    const [inserted] = await transaction
      .insert(artifactReferenceGrants)
      .values({
        artifactId: input.artifactId,
        audienceWorkspaceId: input.audienceWorkspaceId,
        checksumSha256: input.checksumSha256,
        ...(input.expiresAt === null ? {} : { expiresAt: input.expiresAt }),
        grantId: input.grantId,
        revision: 1,
        sourceWorkspaceId,
        version: input.version,
      })
      .onConflictDoNothing()
      .returning()
    if (inserted) return { outcome: 'registered', state: grantStateOf(inserted) }

    // A concurrent registration won the unique grant id; resolve against the
    // committed row under the same rules instead of duplicating it.
    const replayed = await decideRegistration(transaction, sourceWorkspaceId, input)
    if (!replayed) reject('grant_registration_failed')
    return replayed
  })
}

/**
 * Explicitly regrant an artifact-reference grant after revocation. This is
 * the ONLY way a revoked grant's access is restored, and it is
 * revision-checked (CAS): the caller must present the grant's expected
 * current revision, a wrong, stale, or malformed expectation is refused and
 * changes nothing, and success mints the next positive revision and clears
 * the revocation mark — leaving the superseded revision unreadable as
 * current, so a stale grant can never regain access. Authority and
 * canonicality are re-resolved from the database first; an identical live
 * grant presented at its current revision replays without change.
 */
export async function regrantArtifactReferenceGrant(
  database: AgentHqDatabase,
  sourceWorkspaceId: string,
  principal: UserPrincipalRef,
  input: ArtifactReferenceGrantRegistrationInput,
  expectedRevision: number
): Promise<ArtifactReferenceGrantRegistrationResult> {
  validateRegistrationInput(sourceWorkspaceId, input)
  if (!isPositiveInteger(expectedRevision)) reject('grant_revision_conflict')
  return database.transaction(async (transaction) => {
    const existing = await selectByGrantId(transaction, input.grantId)
    if (!existing) reject('grant_not_registered')
    if (!sameIdentity(existing, sourceWorkspaceId, input)) reject('grant_identity_conflict')
    if (existing.revision !== expectedRevision) reject('grant_revision_conflict')

    await resolveRegistrationAuthority(transaction, sourceWorkspaceId, principal, input)

    if (existing.revokedAt === null) return { outcome: 'existing', state: grantStateOf(existing) }
    const [regranted] = await transaction
      .update(artifactReferenceGrants)
      .set({ revision: existing.revision + 1, revokedAt: null })
      .where(eq(artifactReferenceGrants.id, existing.id))
      .returning()
    if (!regranted) reject('grant_registration_failed')
    return { outcome: 'registered', state: grantStateOf(regranted) }
  })
}

/**
 * Revoke the current registration of a grant. Either party bound by the
 * grant may revoke: the granting (source) workspace that issued it, or the
 * audience workspace renouncing its own access. Revoking an unknown grant
 * resolves to null; revoking an already-revoked grant is idempotent and
 * never bumps the revision.
 */
export async function revokeArtifactReferenceGrant(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  grantId: string
): Promise<ArtifactReferenceGrantState | null> {
  if (!UUID.test(workspaceId) || !hasText(grantId)) reject('grant_identity_invalid')
  return database.transaction(async (transaction) => {
    const row = await selectByGrantId(transaction, grantId)
    if (!row) return null
    if (workspaceId !== row.sourceWorkspaceId && workspaceId !== row.audienceWorkspaceId)
      reject('grant_unavailable')
    await requireMembership(transaction, workspaceId, principal)
    if (row.revokedAt !== null) return grantStateOf(row)

    const [revoked] = await transaction
      .update(artifactReferenceGrants)
      .set({ revokedAt: new Date() })
      .where(eq(artifactReferenceGrants.id, row.id))
      .returning()
    if (!revoked) reject('grant_revocation_failed')
    return grantStateOf(revoked)
  })
}

/**
 * The transaction-scoped authorize path: locks the artifact row and the
 * current grant row (artifact first, then grant — the same order every
 * mutation uses), then invokes the caller's authorization callback WHILE THE
 * LOCKS ARE HELD. A concurrent revocation blocks until this transaction
 * commits, so a grant can never be read valid and then revoked before
 * publication lands, nor published after revocation is visible. The callback
 * receives the locked current state — revoked included, so the policy can
 * name revocation — or null when the grant id is unknown or the presented
 * revision is stale. The transaction commits (releasing the locks) only when
 * the callback completes.
 */
export async function withArtifactReferenceGrantLocks<T>(
  database: AgentHqDatabase,
  scope: ArtifactReferenceGrantLockScope,
  authorize: (
    transaction: AgentHqTransaction,
    grantState: ArtifactReferenceGrantState | null
  ) => Promise<T>
): Promise<T> {
  if (
    !UUID.test(scope.sourceWorkspaceId) ||
    !UUID.test(scope.artifactId) ||
    !hasText(scope.grantId) ||
    !isPositiveInteger(scope.revision)
  )
    reject('grant_identity_invalid')
  return database.transaction(async (transaction) => {
    // Artifact first: an unknown artifact has nothing to authorize against.
    await lockLivableArtifact(transaction, scope.sourceWorkspaceId, scope.artifactId)

    const row = await selectByGrantId(transaction, scope.grantId)
    if (
      row &&
      (row.sourceWorkspaceId !== scope.sourceWorkspaceId || row.artifactId !== scope.artifactId)
    )
      reject('grant_identity_conflict')
    const grantState = row && row.revision === scope.revision ? grantStateOf(row) : null
    return authorize(transaction, grantState)
  })
}

/**
 * Read the current authoritative registration for a presented grant
 * identity through the caller's connection or transaction. Resolves to the
 * complete stored state while the presented revision is current — including
 * a revoked state, so the policy can name revocation — and to null when the
 * grant id is unknown or the presented revision is stale, malformed, or not
 * positive: a stale revision never reads as the current registration.
 */
export async function readCurrentArtifactReferenceGrant(
  database: Database,
  presented: ArtifactReferenceGrantPresentation
): Promise<ArtifactReferenceGrantState | null> {
  if (!hasText(presented.grantId) || !isPositiveInteger(presented.revision)) return null
  const [row] = await database
    .select()
    .from(artifactReferenceGrants)
    .where(eq(artifactReferenceGrants.grantId, presented.grantId))
    .limit(1)
  if (!row || row.revision !== presented.revision) return null
  return grantStateOf(row)
}
