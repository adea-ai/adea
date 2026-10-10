import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'

import {
  registerArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
} from '../../src/artifact-reference-grants'
import { createArtifact } from '../../src/artifacts'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import { captureMigrationSnapshot } from '../../src/migration-snapshot-capture'
import { compareMigrationSnapshots } from '../../src/migration-snapshot-comparator'
import {
  artifactReferenceGrants,
  artifacts,
  runtimeNodes,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import type { UserPrincipalRef } from '@adea-ai/types'

/**
 * Fixture-backed proof for the #1219 capture domains added on top of the
 * #1231/#1208 tooling: grants, jobs, runtime mappings and retained replicas
 * are inventoried from real rows through the read-only capture, while
 * canonical native sessions — which this database does not own — stay an
 * explicit `unsupported_family`, never an empty capture.
 */

const connectionUrl = process.env.DATABASE_URL
const CHECKSUM = 'c'.repeat(64)

function identity(snapshotId: string) {
  return {
    capturedAt: new Date('2026-01-15T00:00:00.000Z'),
    rehearsalId: 'rehearsal-domains',
    snapshotId,
    source: 'integration',
  }
}

describe('migration snapshot capture domains', () => {
  let connection: DatabaseConnection
  const workspaceIds: string[] = []
  const userIds: string[] = []

  beforeAll(() => {
    if (!connectionUrl)
      throw new Error(
        'The snapshot-domain lane requires DATABASE_URL (integration runner or the restricted local Postgres).'
      )
    connection = createDatabase(connectionUrl)
  })

  afterAll(async () => {
    if (!connection) return
    if (workspaceIds.length) {
      await connection.db
        .delete(artifactReferenceGrants)
        .where(inArray(artifactReferenceGrants.sourceWorkspaceId, workspaceIds))
      await connection.db
        .delete(runtimeNodes)
        .where(inArray(runtimeNodes.workspaceId, workspaceIds))
      await connection.db.delete(artifacts).where(inArray(artifacts.workspaceId, workspaceIds))
      await connection.db
        .delete(workspaceMemberships)
        .where(inArray(workspaceMemberships.workspaceId, workspaceIds))
      await connection.db.delete(workspaces).where(inArray(workspaces.id, workspaceIds))
    }
    for (const userId of userIds) {
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, userId))
      await connection.db.delete(users).where(eq(users.id, userId))
    }
    await connection.close()
  })

  async function temporaryUser(name: string): Promise<UserPrincipalRef> {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: `snapshot-domains-${name}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    userIds.push(session.principal.userId)
    return session.principal
  }

  test('inventories grants and runtime mappings, and keeps native sessions explicitly unsupported', async () => {
    const owner = await temporaryUser('snapshot-domains-owner')
    const audienceOwner = await temporaryUser('snapshot-domains-audience')
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `snapshot-domains-source-${crypto.randomUUID()}`,
      name: 'Snapshot domains source',
      owner,
    })
    const { workspace: destination } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `snapshot-domains-destination-${crypto.randomUUID()}`,
      name: 'Snapshot domains destination',
      owner: audienceOwner,
    })
    workspaceIds.push(source.id, destination.id)
    const artifact = await createArtifact(connection.db, source.id, owner, {
      availability: 'available',
      checksumSha256: CHECKSUM,
      filename: 'result.txt',
      location: { reference: `outputs/${crypto.randomUUID()}`, type: 'object_store' },
      mediaType: 'text/plain',
      sizeBytes: 32,
      sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
      sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
    })
    const grantId = `grant-${crypto.randomUUID()}`
    await registerArtifactReferenceGrant(connection.db, source.id, owner, {
      artifactId: artifact.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId,
      version: 1,
    })
    const [node] = await connection.db
      .insert(runtimeNodes)
      .values({
        displayName: 'Snapshot node',
        kind: 'local_device',
        ownerUserId: owner.userId,
        platform: 'darwin',
        softwareVersion: '1.0.0',
        workspaceId: source.id,
      })
      .returning()

    const result = await captureMigrationSnapshot(connection.db, {
      identity: identity('snapshot-domains-before'),
      requestedDomains: [
        'artifactReferenceGrants',
        'contentReplicas',
        'leadTurnRuntime',
        'nativeSessions',
        'runtimeNodes',
        'taskSubmissions',
      ],
    })

    expect(result.document.sections.artifactReferenceGrants?.records).toContainEqual({
      artifactId: artifact.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      family: 'artifactReferenceGrants',
      grantId,
      revoked: false,
      revision: 1,
      sourceWorkspaceId: source.id,
      version: 1,
    })
    expect(result.document.sections.runtimeNodes?.records).toContainEqual({
      family: 'runtimeNodes',
      kind: 'local_device',
      pairingState: 'paired',
      platform: 'darwin',
      revoked: false,
      runtimeNodeId: node.id,
      softwareVersion: '1.0.0',
      workspaceId: source.id,
    })
    // The remaining durable domains are captured sections (declared, not
    // unknown); the shared integration database may hold unrelated rows, so
    // only presence is asserted here.
    for (const family of ['contentReplicas', 'leadTurnRuntime', 'taskSubmissions'] as const) {
      expect(result.document.sections[family]).toBeDefined()
    }
    // Native sessions are not owned by this database: explicit unknown.
    expect(result.domains).toContainEqual({
      domain: 'nativeSessions',
      status: 'unknown',
      unknownReason: 'unsupported_family',
    })
    expect(result.document.sections.nativeSessions).toBeUndefined()

    // A later revocation is a captured fact change, compared deterministically
    // by the grant's stable id. The sections are narrowed to this fixture's
    // rows: the shared database holds unrelated history and the comparator
    // refuses pairs whose full inventory would outgrow its output bound.
    await revokeArtifactReferenceGrant(connection.db, source.id, owner, grantId)
    const after = await captureMigrationSnapshot(connection.db, {
      identity: identity('snapshot-domains-after'),
      requestedDomains: ['artifactReferenceGrants'],
    })
    const onlyGrant = (document: typeof result.document) => ({
      artifactReferenceGrants: {
        records: (document.sections.artifactReferenceGrants?.records ?? []).filter(
          (record) => record.family === 'artifactReferenceGrants' && record.grantId === grantId
        ),
        truncated: false,
      },
    })
    const comparison = compareMigrationSnapshots({
      after: { identity: after.document.identity, sections: onlyGrant(after.document) },
      before: { identity: result.document.identity, sections: onlyGrant(result.document) },
    })
    expect(comparison.verdict).toBe('divergent')
    expect(comparison.findings).toContainEqual(
      expect.objectContaining({
        family: 'artifactReferenceGrants',
        findingClass: 'changed_attribute',
        stableId: grantId,
      })
    )
  })
})
