import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import {
  readCurrentArtifactReferenceGrant,
  registerArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
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
import { createWorkspaceWithOwner } from '../../src/workspaces'
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
    ).rejects.toThrow('Artifact reference grant unavailable')

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

    // The audience renounces its own access; a stranger to both cannot.
    const regranted = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(regranted.outcome).toBe('registered')
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

    // Regranting the equivalent grant mints the next revision.
    const second = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
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
})
