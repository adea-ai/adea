import type { ArtifactReferenceGrantState, UserPrincipalRef } from '@adea-ai/types'
import { and, eq } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { artifactReferenceGrants, workspaceMemberships } from './schema'

/**
 * Durable store for artifact-reference grants (M15.03 #1180).
 *
 * The policy in `artifact-reference-policy` is pure: it consumes the
 * authoritative registration state this module persists. One row per grant
 * id carries the grant's complete identity — source workspace, artifact,
 * granted version, content checksum, audience workspace and the expiry
 * string verbatim — plus a positive revision and the revocation mark.
 *
 * Durability guarantees:
 *
 * - Registration is idempotent. Registering the identical grant (same grant
 *   id and complete identity) returns the existing registration without
 *   duplicating a row or bumping the revision; a genuinely new registration
 *   starts at revision 1.
 * - Revision is store-owned and positive. Callers never choose it. A
 *   regrant of an equivalent grant after revocation yields a NEW revision;
 *   the superseded revision can never be read as current again, so a stale
 *   grant cannot regain access.
 * - A grant id can never be relabelled. Registering a known grant id with
 *   any different identity field fails closed; a changed lifetime or target
 *   requires a new grant id, mirroring the policy's per-field refusals.
 * - Reads are transaction-scoped. The current-grant reader accepts the same
 *   connection or transaction handle the caller's other checks use, so a
 *   gate decision sees one consistent snapshot of registration truth.
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
    throw new Error('Artifact reference grant metadata invalid')
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
  if (!membership) throw new Error('Artifact reference grant unavailable')
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
 * Decide a registration against the locked current row: idempotent replay,
 * regrant-after-revocation as a new revision, or a fail-closed identity
 * conflict. Returns null when the grant id is unregistered and a row must
 * be inserted.
 */
async function decideRegistration(
  transaction: AgentHqTransaction,
  sourceWorkspaceId: string,
  input: ArtifactReferenceGrantRegistrationInput
): Promise<ArtifactReferenceGrantRegistrationResult | null> {
  const existing = await selectByGrantId(transaction, input.grantId)
  if (!existing) return null
  if (!sameIdentity(existing, sourceWorkspaceId, input))
    throw new Error('Artifact reference grant identity conflict')
  if (existing.revokedAt === null) return { outcome: 'existing', state: grantStateOf(existing) }

  const [regranted] = await transaction
    .update(artifactReferenceGrants)
    .set({ revision: existing.revision + 1, revokedAt: null })
    .where(eq(artifactReferenceGrants.id, existing.id))
    .returning()
  if (!regranted) throw new Error('Artifact reference grant registration failed')
  return { outcome: 'registered', state: grantStateOf(regranted) }
}

/**
 * Register one artifact-reference grant on behalf of its granting (source)
 * workspace. Idempotent for an identical live registration; after
 * revocation, an equivalent registration mints the next positive revision
 * and clears the revocation mark. Any other reuse of a registered grant id
 * fails closed.
 */
export async function registerArtifactReferenceGrant(
  database: AgentHqDatabase,
  sourceWorkspaceId: string,
  principal: UserPrincipalRef,
  input: ArtifactReferenceGrantRegistrationInput
): Promise<ArtifactReferenceGrantRegistrationResult> {
  validateRegistrationInput(sourceWorkspaceId, input)
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, sourceWorkspaceId, principal)

    const decided = await decideRegistration(transaction, sourceWorkspaceId, input)
    if (decided) return decided

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
    if (!replayed) throw new Error('Artifact reference grant registration failed')
    return replayed
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
  if (!UUID.test(workspaceId) || !hasText(grantId))
    throw new Error('Artifact reference grant metadata invalid')
  return database.transaction(async (transaction) => {
    const row = await selectByGrantId(transaction, grantId)
    if (!row) return null
    if (workspaceId !== row.sourceWorkspaceId && workspaceId !== row.audienceWorkspaceId)
      throw new Error('Artifact reference grant unavailable')
    await requireMembership(transaction, workspaceId, principal)
    if (row.revokedAt !== null) return grantStateOf(row)

    const [revoked] = await transaction
      .update(artifactReferenceGrants)
      .set({ revokedAt: new Date() })
      .where(eq(artifactReferenceGrants.id, row.id))
      .returning()
    if (!revoked) throw new Error('Artifact reference grant revocation failed')
    return grantStateOf(revoked)
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
