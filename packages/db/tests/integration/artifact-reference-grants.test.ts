import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'

import {
  readCurrentArtifactReferenceGrant,
  registerArtifactReferenceGrant,
  regrantArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
  withArtifactReferenceGrantLocks,
  type ArtifactReferenceGrantRegistrationInput,
} from '../../src/artifact-reference-grants'
import {
  authorizeArtifactReferencePublication,
  authorizeArtifactReferenceRetrieval,
  readArtifactReferenceEvidence,
} from '../../src/artifact-reference-policy'
import { createArtifact } from '../../src/artifacts'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  artifactReferenceGrants,
  artifacts,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { inTransaction } from '../../src/transactions'
import {
  addWorkspaceMembership,
  archiveWorkspace,
  createWorkspaceWithOwner,
} from '../../src/workspaces'
import type {
  ArtifactReferenceGrant,
  ArtifactReferenceTarget,
  UserPrincipalRef,
} from '@adea-ai/types'

/**
 * PostgreSQL grant-store lane for the artifact-reference policy
 * (M15.03 #1180). The durable store is what makes the policy's grant checks
 * authoritative: idempotent registration, store-owned positive revisions,
 * revoke/regrant isolation, and a transaction-scoped current-grant reader —
 * proven against the disposable database the repo's integration lane
 * provides, with the policy gates consuming what the store returns.
 */

const connectionUrl = process.env.DATABASE_URL

const CHECKSUM = 'b'.repeat(64)
/** Deliberately non-normalized: the store must preserve it verbatim. */
const EXPIRES_AT = '2030-06-15T12:00:00Z'

function inputFor(
  source: { id: string },
  audience: { id: string },
  artifactId: string,
  overrides: Partial<ArtifactReferenceGrantRegistrationInput> = {}
): ArtifactReferenceGrantRegistrationInput {
  return {
    artifactId,
    audienceWorkspaceId: audience.id,
    checksumSha256: CHECKSUM,
    expiresAt: null,
    grantId: `grant-${crypto.randomUUID()}`,
    version: 1,
    ...overrides,
  }
}

type ArtifactReferenceGrantStateValue = NonNullable<
  Awaited<ReturnType<typeof readCurrentArtifactReferenceGrant>>
>

/** The presentable grant the registered state authorizes. */
function grantFrom(
  state: ArtifactReferenceGrantStateValue,
  revokedAt: string | null = null
): ArtifactReferenceGrant {
  return {
    artifactId: state.artifactId,
    audienceWorkspaceId: state.audienceWorkspaceIds[0]!,
    checksumSha256: state.checksumSha256,
    expiresAt: state.expiresAt,
    grantId: state.grantId,
    revokedAt,
    revision: state.revision,
    sourceWorkspaceId: state.sourceWorkspaceId,
    version: state.version,
  }
}

describe.skipIf(!connectionUrl)('Artifact reference grant store', () => {
  let connection: DatabaseConnection
  const workspaceIds: string[] = []
  const userIds: string[] = []

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => {
    await cleanup()
    await connection.close()
  })

  async function cleanup() {
    for (const workspaceId of workspaceIds) {
      await connection.db
        .delete(artifactReferenceGrants)
        .where(eq(artifactReferenceGrants.sourceWorkspaceId, workspaceId))
      await connection.db.delete(artifacts).where(eq(artifacts.workspaceId, workspaceId))
      await connection.db
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspaceId))
      await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    }
    for (const userId of userIds) {
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, userId))
      await connection.db.delete(users).where(eq(users.id, userId))
    }
    workspaceIds.length = 0
    userIds.length = 0
  }

  async function temporaryUser(name: string): Promise<UserPrincipalRef> {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: `artifact-grant-${name}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    userIds.push(session.principal.userId)
    return session.principal
  }

  /** A granting (source) workspace, its audience, and a stranger to both. */
  async function fixture(name: string) {
    const owner = await temporaryUser(`${name}-owner`)
    const audienceOwner = await temporaryUser(`${name}-audience`)
    const outsider = await temporaryUser(`${name}-outsider`)
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `artifact-grant-${name}-source-${crypto.randomUUID()}`,
      name: `${name} source`,
      owner,
    })
    const { workspace: audience } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `artifact-grant-${name}-audience-${crypto.randomUUID()}`,
      name: `${name} audience`,
      owner: audienceOwner,
    })
    workspaceIds.push(source.id, audience.id)
    return { audience, audienceOwner, outsider, owner, source }
  }

  async function createAvailableArtifact(sourceWorkspaceId: string, owner: UserPrincipalRef) {
    return createArtifact(connection.db, sourceWorkspaceId, owner, {
      availability: 'available',
      checksumSha256: CHECKSUM,
      filename: 'result.txt',
      location: { reference: `outputs/${crypto.randomUUID()}`, type: 'object_store' },
      mediaType: 'text/plain',
      sizeBytes: 32,
      sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
      sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
    })
  }

  async function storedRows(grantId: string) {
    return connection.db
      .select()
      .from(artifactReferenceGrants)
      .where(eq(artifactReferenceGrants.grantId, grantId))
  }

  test('registration is idempotent for an identical grant: one row, unchanged revision', async () => {
    const { audience, owner, source } = await fixture('idempotent')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)

    const first = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(first.outcome).toBe('registered')
    expect(first.state.revision).toBe(1)
    expect(first.state.revoked).toBe(false)

    const replay = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(replay.outcome).toBe('existing')
    expect(replay.state).toEqual(first.state)
    expect(await storedRows(input.grantId)).toHaveLength(1)

    // A replay with a divergent expiry is not the identical grant: it fails
    // closed instead of silently reusing or rewriting the registration.
    expect(
      registerArtifactReferenceGrant(connection.db, source.id, owner, {
        ...input,
        expiresAt: EXPIRES_AT,
      })
    ).rejects.toThrow('Artifact reference grant identity conflict')
    expect(
      registerArtifactReferenceGrant(connection.db, source.id, owner, {
        ...input,
        artifactId: crypto.randomUUID(),
      })
    ).rejects.toThrow('Artifact reference grant identity conflict')
    expect(await storedRows(input.grantId)).toHaveLength(1)
  })

  test('a non-member cannot register or revoke, and both bound parties may revoke', async () => {
    const { audience, audienceOwner, outsider, owner, source } = await fixture('authority')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)

    expect(
      registerArtifactReferenceGrant(connection.db, source.id, outsider, input)
    ).rejects.toThrow('Artifact reference grant issuer unauthorized')

    const registered = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(registered.outcome).toBe('registered')

    // The granting workspace revokes.
    const revokedBySource = await revokeArtifactReferenceGrant(
      connection.db,
      source.id,
      owner,
      input.grantId
    )
    expect(revokedBySource?.revoked).toBe(true)

    // Revocation is idempotent and never bumps the revision.
    const revokedAgain = await revokeArtifactReferenceGrant(
      connection.db,
      source.id,
      owner,
      input.grantId
    )
    expect(revokedAgain).toEqual(revokedBySource)

    // Restoring access is the explicit regrant's job, not a registration
    // replay; the audience renounces its own access and a stranger to both
    // cannot revoke at all.
    const regranted = await regrantArtifactReferenceGrant(connection.db, source.id, owner, input, 1)
    expect(regranted.outcome).toBe('registered')
    expect(regranted.state.revision).toBe(2)
    expect(
      revokeArtifactReferenceGrant(connection.db, audience.id, outsider, input.grantId)
    ).rejects.toThrow('Artifact reference grant unavailable')
    const revokedByAudience = await revokeArtifactReferenceGrant(
      connection.db,
      audience.id,
      audienceOwner,
      input.grantId
    )
    expect(revokedByAudience?.revoked).toBe(true)
    expect(await storedRows(input.grantId)).toHaveLength(1)
  })

  test('revisions are store-owned and positive: none below one can exist or read as current', async () => {
    const { audience, owner, source } = await fixture('positive-revisions')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)

    const registered = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(registered.state.revision).toBe(1)

    // The durable check constraint refuses non-positive revisions even for a
    // direct write, so no zero or negative revision can ever be stored.
    for (const revision of [0, -2]) {
      let rejected = false
      try {
        await connection.db
          .update(artifactReferenceGrants)
          .set({ revision })
          .where(eq(artifactReferenceGrants.grantId, input.grantId))
      } catch {
        rejected = true
      }
      expect(rejected).toBe(true)
    }

    // Malformed or non-positive presentations never read as current.
    for (const revision of [0, -1, 2.5, Number.NaN]) {
      expect(
        await readCurrentArtifactReferenceGrant(connection.db, {
          grantId: input.grantId,
          revision,
        })
      ).toBeNull()
    }
    expect(
      await readCurrentArtifactReferenceGrant(connection.db, {
        grantId: input.grantId,
        revision: 1,
      })
    ).toEqual(registered.state)
  })

  test('a revoked grant cannot authorize, and a regrant yields a new revision the old one cannot regain', async () => {
    const { audience, audienceOwner, owner, source } = await fixture('regrant-isolation')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)

    const first = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(first.state.revision).toBe(1)

    // The audience revokes; the stale revision reads revoked and the gate
    // refuses delivery by name.
    await revokeArtifactReferenceGrant(connection.db, audience.id, audienceOwner, input.grantId)
    const revokedState = await readCurrentArtifactReferenceGrant(connection.db, {
      grantId: input.grantId,
      revision: 1,
    })
    expect(revokedState?.revoked).toBe(true)

    // Regranting explicitly at the current revision mints the next revision.
    const second = await regrantArtifactReferenceGrant(connection.db, source.id, owner, input, 1)
    expect(second.outcome).toBe('registered')
    expect(second.state.revision).toBe(2)
    expect(second.state.revoked).toBe(false)
    expect(await storedRows(input.grantId)).toHaveLength(1)

    // The old revision is stale forever: it reads absent — never as the
    // current registration — and the gate denies it on that alone.
    expect(
      await readCurrentArtifactReferenceGrant(connection.db, {
        grantId: input.grantId,
        revision: 1,
      })
    ).toBeNull()
    const evidence = await readArtifactReferenceEvidence(
      connection.db,
      source.id,
      created.id,
      owner
    )
    expect(evidence).not.toBeNull()
    const staleTarget: ArtifactReferenceTarget = {
      artifactId: created.id,
      audienceWorkspaceId: audience.id,
      checksumSha256: CHECKSUM,
      sourceWorkspaceId: source.id,
      version: created.version,
    }
    const staleDenial = authorizeArtifactReferenceRetrieval({
      authority: { kind: 'workspace_grant' },
      evidence,
      grant: { ...grantFrom(first.state), revokedAt: new Date().toISOString() },
      grantState: null,
      now: new Date().toISOString(),
      requestingWorkspaceId: audience.id,
      target: staleTarget,
    })
    expect(staleDenial).toEqual({
      action: 'deny',
      ok: false,
      reason: 'grant_not_registered',
      stage: 'retrieval',
    })

    // Only the new revision reads current.
    const currentState = await readCurrentArtifactReferenceGrant(connection.db, {
      grantId: input.grantId,
      revision: 2,
    })
    expect(currentState).toEqual(second.state)
  })

  test('the complete identity survives storage and authorizes the exact presented grant', async () => {
    const { audience, audienceOwner, owner, source } = await fixture('complete-identity')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id, { expiresAt: EXPIRES_AT })

    const registered = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    const state = await readCurrentArtifactReferenceGrant(connection.db, {
      grantId: input.grantId,
      revision: registered.state.revision,
    })
    expect(state).not.toBeNull()
    // Every identity field is preserved, and the expiry string round-trips
    // verbatim — the policy compares expiry by exact string equality.
    expect(state).toEqual({
      artifactId: created.id,
      audienceWorkspaceIds: [audience.id],
      checksumSha256: CHECKSUM,
      expiresAt: EXPIRES_AT,
      grantId: input.grantId,
      revoked: false,
      revision: 1,
      sourceWorkspaceId: source.id,
      version: 1,
    })

    // The registered state authorizes the presented grant end to end against
    // live evidence: publication admits, retrieval delivers to the audience.
    const evidence = await readArtifactReferenceEvidence(
      connection.db,
      source.id,
      created.id,
      owner
    )
    expect(evidence).not.toBeNull()
    const target: ArtifactReferenceTarget = {
      artifactId: created.id,
      audienceWorkspaceId: audience.id,
      checksumSha256: CHECKSUM,
      sourceWorkspaceId: source.id,
      version: created.version,
    }
    const presented = grantFrom(state!)
    const now = new Date().toISOString()
    expect(
      authorizeArtifactReferencePublication({
        authority: { kind: 'workspace_grant' },
        evidence,
        grant: presented,
        grantState: state!,
        now,
        target,
      })
    ).toEqual({ action: 'publish', ok: true, stage: 'publication', target })
    expect(
      authorizeArtifactReferenceRetrieval({
        authority: { kind: 'workspace_grant' },
        evidence,
        grant: presented,
        grantState: state!,
        now,
        requestingWorkspaceId: audience.id,
        target,
      })
    ).toEqual({ action: 'deliver', ok: true, stage: 'retrieval', target })

    // A forged presentation borrowing the registered grant id but relabelling
    // its content digest no longer binds the presented target and fails
    // closed under the policy's typed refusal.
    const forged = authorizeArtifactReferenceRetrieval({
      authority: { kind: 'workspace_grant' },
      evidence,
      grant: { ...presented, checksumSha256: 'a'.repeat(64) },
      grantState: state!,
      now,
      requestingWorkspaceId: audience.id,
      target,
    })
    expect(forged).toEqual({
      action: 'deny',
      ok: false,
      reason: 'target_mismatch',
      stage: 'retrieval',
    })

    // Revocation flips the stored state, and the gate refuses by name.
    await revokeArtifactReferenceGrant(connection.db, audience.id, audienceOwner, input.grantId)
    const revoked = await readCurrentArtifactReferenceGrant(connection.db, {
      grantId: input.grantId,
      revision: 1,
    })
    expect(revoked?.revoked).toBe(true)
    const denied = authorizeArtifactReferenceRetrieval({
      authority: { kind: 'workspace_grant' },
      evidence,
      grant: { ...presented, revokedAt: now },
      grantState: revoked!,
      now,
      requestingWorkspaceId: audience.id,
      target,
    })
    expect(denied).toEqual({
      action: 'deny',
      ok: false,
      reason: 'grant_revoked',
      stage: 'retrieval',
    })
  })

  test('the current-grant reader is transaction scoped', async () => {
    const { audience, owner, source } = await fixture('transaction-scope')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)
    await registerArtifactReferenceGrant(connection.db, source.id, owner, input)

    await inTransaction(connection.db, async (transaction) => {
      // The reader resolves through the caller's transaction handle.
      const committed = await readCurrentArtifactReferenceGrant(transaction, {
        grantId: input.grantId,
        revision: 1,
      })
      expect(committed?.grantId).toBe(input.grantId)

      // An uncommitted registration is visible inside, never outside.
      const uncommitted = inputFor(source, audience, created.id)
      await transaction.insert(artifactReferenceGrants).values({
        artifactId: uncommitted.artifactId,
        audienceWorkspaceId: uncommitted.audienceWorkspaceId,
        checksumSha256: uncommitted.checksumSha256,
        grantId: uncommitted.grantId,
        revision: 1,
        sourceWorkspaceId: source.id,
        version: 1,
      })
      const inside = await readCurrentArtifactReferenceGrant(transaction, {
        grantId: uncommitted.grantId,
        revision: 1,
      })
      expect(inside?.grantId).toBe(uncommitted.grantId)
      const outside = await readCurrentArtifactReferenceGrant(connection.db, {
        grantId: uncommitted.grantId,
        revision: 1,
      })
      expect(outside).toBeNull()
      throw new Error('rollback marker')
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== 'rollback marker') throw error
    })

    // The rolled-back registration never became durable.
    expect(
      await connection.db
        .select()
        .from(artifactReferenceGrants)
        .where(
          and(
            eq(artifactReferenceGrants.grantId, input.grantId),
            eq(artifactReferenceGrants.revision, 1)
          )
        )
    ).toHaveLength(1)
  })

  test('registration resolves the canonical artifact record: divergent version or checksum is refused and nothing persists', async () => {
    const { audience, owner, source } = await fixture('canonical')
    const created = await createAvailableArtifact(source.id, owner)

    // A version the artifact record does not carry is refused; nothing is
    // persisted: the caller never gets to relabel the granted version.
    const staleVersion = inputFor(source, audience, created.id, { version: created.version + 1 })
    await expect(
      registerArtifactReferenceGrant(connection.db, source.id, owner, staleVersion)
    ).rejects.toThrow('Artifact reference grant target diverges from the artifact record')
    expect(await storedRows(staleVersion.grantId)).toHaveLength(0)

    // Likewise a checksum that is not the artifact's content identity.
    const foreignDigest = inputFor(source, audience, created.id, { checksumSha256: 'c'.repeat(64) })
    await expect(
      registerArtifactReferenceGrant(connection.db, source.id, owner, foreignDigest)
    ).rejects.toThrow('Artifact reference grant target diverges from the artifact record')
    expect(await storedRows(foreignDigest.grantId)).toHaveLength(0)

    // Matching values persist bound to the canonical record.
    const canonical = inputFor(source, audience, created.id)
    const registered = await registerArtifactReferenceGrant(
      connection.db,
      source.id,
      owner,
      canonical
    )
    expect(registered.state.version).toBe(created.version)
    expect(registered.state.checksumSha256).toBe(created.checksumSha256)
    expect(await storedRows(canonical.grantId)).toHaveLength(1)
  })

  test('grant registration requires an authoritative issuer and live workspaces on both sides', async () => {
    const { audience, owner, source } = await fixture('issuer-authority')
    const created = await createAvailableArtifact(source.id, owner)
    const member = await temporaryUser('issuer-authority-member')
    await addWorkspaceMembership(connection.db, source.id, member, 'member')
    const input = inputFor(source, audience, created.id)

    // A mere member is not an issuer: granting cross-workspace access is an
    // authoritative act reserved to owner/admin roles.
    await expect(
      registerArtifactReferenceGrant(connection.db, source.id, member, input)
    ).rejects.toThrow('Artifact reference grant issuer unauthorized')
    expect(await storedRows(input.grantId)).toHaveLength(0)

    // A dead (archived) source workspace cannot anchor a grant.
    await archiveWorkspace(connection.db, source.id, owner)
    await expect(
      registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    ).rejects.toThrow('Artifact reference grant workspace inactive')
    expect(await storedRows(input.grantId)).toHaveLength(0)

    // ... and neither can a dead audience workspace.
    const second = await fixture('issuer-authority-audience')
    const secondArtifact = await createAvailableArtifact(second.source.id, second.owner)
    await archiveWorkspace(connection.db, second.audience.id, second.audienceOwner)
    const secondInput = inputFor(second.source, second.audience, secondArtifact.id)
    await expect(
      registerArtifactReferenceGrant(connection.db, second.source.id, second.owner, secondInput)
    ).rejects.toThrow('Artifact reference grant workspace inactive')
    expect(await storedRows(secondInput.grantId)).toHaveLength(0)
  })

  test('a registration retry after revocation fails closed and never restores access', async () => {
    const { audience, owner, source } = await fixture('retry-after-revocation')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)

    const first = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(first.state.revision).toBe(1)
    await revokeArtifactReferenceGrant(connection.db, source.id, owner, input.grantId)

    // Retrying the ORIGINAL registration after revocation must fail closed:
    // it never restores access and never bumps the revision. Restoring access
    // is an explicit, revision-checked regrant — never a registration replay.
    await expect(
      registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    ).rejects.toThrow(
      'Artifact reference grant registration after revocation requires an explicit regrant'
    )

    // The refusal changed nothing: same revision, still revoked, no new state.
    const [row] = await storedRows(input.grantId)
    expect(row?.revision).toBe(1)
    expect(row?.revokedAt).not.toBeNull()
    const current = await readCurrentArtifactReferenceGrant(connection.db, {
      grantId: input.grantId,
      revision: 1,
    })
    expect(current?.revoked).toBe(true)
    expect(
      await readCurrentArtifactReferenceGrant(connection.db, {
        grantId: input.grantId,
        revision: 2,
      })
    ).toBeNull()
  })

  test('explicit regrant is revision-checked: wrong expectations are refused, the correct one mints the next revision', async () => {
    const { audience, owner, source } = await fixture('explicit-regrant')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)

    const first = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(first.state.revision).toBe(1)
    await revokeArtifactReferenceGrant(connection.db, source.id, owner, input.grantId)

    // A malformed, stale, or ahead-of-store expected revision is refused and
    // changes nothing: the row stays revoked at its current revision.
    for (const expectedRevision of [0, -1, 2.5, Number.NaN, 2]) {
      await expect(
        regrantArtifactReferenceGrant(connection.db, source.id, owner, input, expectedRevision)
      ).rejects.toThrow('Artifact reference grant revision conflict')
    }
    const unchanged = await storedRows(input.grantId)
    expect(unchanged).toHaveLength(1)
    expect(unchanged[0]?.revision).toBe(1)
    expect(unchanged[0]?.revokedAt).not.toBeNull()

    // Regranting an id that was never registered is refused too.
    await expect(
      regrantArtifactReferenceGrant(
        connection.db,
        source.id,
        owner,
        inputFor(source, audience, created.id),
        1
      )
    ).rejects.toThrow('Artifact reference grant not registered')

    // The correct expectation mints the next positive revision and access.
    const second = await regrantArtifactReferenceGrant(connection.db, source.id, owner, input, 1)
    expect(second.outcome).toBe('registered')
    expect(second.state.revision).toBe(2)
    expect(second.state.revoked).toBe(false)

    // The old revision stays denied forever; only the new one reads current.
    expect(
      await readCurrentArtifactReferenceGrant(connection.db, {
        grantId: input.grantId,
        revision: 1,
      })
    ).toBeNull()
    expect(
      await readCurrentArtifactReferenceGrant(connection.db, {
        grantId: input.grantId,
        revision: 2,
      })
    ).toEqual(second.state)

    // A retry of the completed regrant presents the superseded revision: refused.
    await expect(
      regrantArtifactReferenceGrant(connection.db, source.id, owner, input, 1)
    ).rejects.toThrow('Artifact reference grant revision conflict')

    // The live grant presented at its current revision replays unchanged.
    const replay = await regrantArtifactReferenceGrant(connection.db, source.id, owner, input, 2)
    expect(replay.outcome).toBe('existing')
    expect(replay.state).toEqual(second.state)
    expect(await storedRows(input.grantId)).toHaveLength(1)
  })

  test('revocation cannot race the locked authorization callback', async () => {
    const { audience, audienceOwner, owner, source } = await fixture('lock-race')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)
    await registerArtifactReferenceGrant(connection.db, source.id, owner, input)

    const scope = {
      artifactId: created.id,
      grantId: input.grantId,
      revision: 1,
      sourceWorkspaceId: source.id,
    }
    const events: string[] = []
    const callbackEntered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()

    // The authorize path holds the artifact and grant row locks across the
    // callback; a slow callback parks the transaction inside them.
    const authorized = withArtifactReferenceGrantLocks(connection.db, scope, async (_t, state) => {
      events.push('callback-entered')
      callbackEntered.resolve()
      await release.promise
      events.push('callback-completed')
      return state
    })
    await callbackEntered.promise

    let revocationSettled = false
    const revocation = revokeArtifactReferenceGrant(
      connection.db,
      audience.id,
      audienceOwner,
      input.grantId
    ).then((state) => {
      events.push('revocation-committed')
      revocationSettled = true
      return state
    })

    // Observe the real lock wait before releasing it; no fixed sleep guesses
    // the schedule (the runtime-node-delivery lane's pattern).
    let blocked = false
    for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
      const rows = await connection.db.execute(
        sql`select pid from pg_stat_activity
            where wait_event_type = 'Lock' and datname = current_database()
              and query ilike '%artifact_reference_grants%'`
      )
      blocked = rows.length > 0
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    let diagnostic = ''
    try {
      expect(blocked).toBe(true)
      expect(revocationSettled).toBe(false)
    } catch (error) {
      const activity = await connection.db.execute(
        sql`select state, wait_event_type, wait_event, left(query, 70) as q
            from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`
      )
      diagnostic = `settled=${revocationSettled} events=${JSON.stringify(events)} activity=${JSON.stringify(activity)}`
      throw new Error(`race poll failed: ${diagnostic}`, { cause: error })
    } finally {
      // Never leave the authorize transaction parked: a failure here would
      // hold its row locks and block cleanup behind it.
      release.resolve()
    }

    const authorizedState = await authorized
    await revocation

    // The callback observed a consistent live grant; the revocation could
    // only commit after the callback completed and the locks were released.
    expect(authorizedState?.revoked).toBe(false)
    expect(events).toEqual(['callback-entered', 'callback-completed', 'revocation-committed'])

    // Once revocation is visible, a fresh authorization attempt reads the
    // locked current grant as revoked.
    const afterRevocation = await withArtifactReferenceGrantLocks(
      connection.db,
      scope,
      (_t, state) => Promise.resolve(state)
    )
    expect(afterRevocation?.revoked).toBe(true)
  })
})
