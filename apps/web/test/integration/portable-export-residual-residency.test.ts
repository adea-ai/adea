// Residual acceptance for the authorized portable export and its residency (M18.02.2, #1226).
//
// Merged PR #1245 built the export and the restore, and merged PR #1372 proved the authenticated
// request path. Neither closes #1226: the version-1 format deliberately does not carry everything a
// workspace holds, and what it withholds has to be named honestly rather than counted silently.
// This file is the residual round-trip acceptance over the merged implementation. It changes no
// product code: it builds one disposable source workspace, exports it through the production
// response helper, restores it into disposable destination databases, and states what travelled,
// what did not, and what was refused.
//
// What it proves:
//
//   - a nonempty authorized round trip: ordered messages, mentions, replies, thread links,
//     content-ref metadata, project members, a task graph and a cloud execution attempt travel and
//     are restored, in the order the canonical reader serves them;
//   - the audience matrix: an owner, a listed member and a workspace member outside every private
//     audience each receive exactly what they may read;
//   - revocation: a revoked group audience grant removes the group and its text from the next
//     bundle, and a removed membership is refused with the same body as an unknown workspace;
//   - artifact references: the source holds two artifacts, two message artifact references and a
//     cross-workspace artifact reference grant; none of them travel, and the import names the
//     withheld domain instead of losing it silently;
//   - grants: the source's group grants and admissions are never transplanted, the restore issues
//     its own, and the source's grant ids appear in neither the bundle nor the destination;
//   - residency classifications and the actual stores: the restored workspace's rows live in an
//     enumerated set of tables, every other table of the app schema holds zero rows for it, and
//     the tables that are not workspace-scoped hold only the provisioned identities;
//   - rejections: wrong-audience and revoked callers, malicious manifests, ordering and collision
//     errors, and the secret and plaintext canaries.
//
// What it does not prove, and what it cannot, is recorded in
// docs/evidence/m18-02-2-f3-residual-acceptance.md.
//
// Boundaries: no live system is read and no production database is touched; every database here is
// a disposable instance this lane provisions; no product deletion, retention or cleanup path is
// exercised; no credential is created; no file outside this test and that evidence document is
// changed.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  PORTABLE_EXTERNAL_DOMAIN_CLASSES,
  validatePortableWorkspaceExport,
  type PortableWorkspaceExport,
} from '@adea-ai/types/portable-export'
import { eq, getTableColumns, getTableName, inArray, is, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { PgColumn, PgTable } from 'drizzle-orm/pg-core'

import * as agentHq from '@adea-ai/db'

import {
  portableImportResponse,
  portableWorkspaceExportResponse,
} from '../../src/server/portable-workspace-request'
import type { WorkspacePrincipalResolution } from '../../src/server/workspace-principal'

const sourceUrl = process.env.DATABASE_URL
const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
if (!sourceUrl || !provisioningUrl)
  throw new Error(
    'DATABASE_URL and MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL are required: this residual proof restores into disposable databases and must not skip'
  )

const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url))
const run = randomBytes(6).toString('hex')
const future = () => new Date(Date.now() + 60 * 60 * 1000)
const now = () => new Date().toISOString()

/**
 * The canaries. `plaintext` is private conversation content that only an authorized reader may
 * receive. `secret` is material that must never leave in any form: a session credential digest, an
 * invitation token, a replica ciphertext, an artifact locator, a runtime reference, a grant id.
 */
const canary = {
  artifactGrantId: `ARTIFACT-GRANT-${run}`,
  artifactLocator: `ARTIFACT-LOCATOR-${run}`,
  artifactProvenance: `ARTIFACT-PROVENANCE-${run}`,
  // A replica's ciphertext is canonical base64url of at least 16 bytes and its nonce is exactly
  // 16 base64url characters, so both canaries carry the run marker inside that shape.
  ciphertext: Buffer.from(`REPLICA-CIPHERTEXT-${run}`).toString('base64url'),
  executionRef: `EXECUTION-REF-${run}`,
  externalHarness: `EXTERNAL-HARNESS-${run}`,
  externalHarnessId: `external-harness-id-${run}`,
  inviteEmail: `invitee-${run}@example.test`,
  nonce: Buffer.from(`NONCE-${run}`).toString('base64url').slice(0, 16),
  sessionDigest: `SESSION-DIGEST-${run}`,
}
const plaintext = {
  group: `GROUP-PRIVATE-${run}`,
  members: `MEMBERS-ONLY-${run}`,
  workspace: `WORKSPACE-VISIBLE-${run}`,
}

const secretCanaries = [
  canary.artifactGrantId,
  canary.artifactLocator,
  canary.artifactProvenance,
  canary.ciphertext,
  canary.executionRef,
  canary.externalHarness,
  canary.externalHarnessId,
  canary.inviteEmail,
  canary.nonce,
  canary.sessionDigest,
]
/** The invitation's raw token is never stored; its digest is, and both must not travel. */
let inviteTokenDigest = ''

type Session = Awaited<ReturnType<typeof agentHq.createTemporaryUserSession>>
type Principal = Session['principal']

function resolutionFor(principal: Principal): WorkspacePrincipalResolution {
  return { clearTemporaryCredential: false, principal, sessionRotated: false, temporary: true }
}

/** The scratch name is ours to create and drop: a fixed prefix and a random suffix, nothing else. */
function scratchNameFor(label: string) {
  return `portable_residual_${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

function assertDisposableScratch(name: string) {
  if (!/^portable_residual_(owner|outsider|refusal)_[0-9a-f]{12}$/.test(name))
    throw new Error(`refusing to use ${name}`)
}

function urlForDatabase(database: string): string {
  const url = new URL(provisioningUrl!)
  url.pathname = `/${database}`
  return url.toString()
}

type WorkspaceScopedTable = PgTable & { workspaceId: PgColumn }

/**
 * A mutable view of the validated document. The contract's own types are deeply readonly, and a
 * refusal case is built by breaking a copy of a real bundle.
 */
type MutableRecord = Record<string, unknown>
type MutableBundle = {
  content: {
    channels: MutableRecord[]
    messages: (MutableRecord & {
      body: { kind: string } & MutableRecord
      channelId: string
      channelOrder: number
      messageId: string
    })[]
    taskDependencies: { dependsOnTaskId: string; taskId: string }[]
    [family: string]: unknown
  }
  [field: string]: unknown
}

function mutableCopy(bundle: PortableWorkspaceExport): MutableBundle {
  return structuredClone(bundle) as unknown as MutableBundle
}

const appTables = Object.entries(agentHq).flatMap(([exportName, value]) => {
  if (!is(value, PgTable)) return []
  return [{ exportName, name: getTableName(value), table: value }]
})
const workspaceScopedTables = appTables
  .filter((entry) => 'workspaceId' in getTableColumns(entry.table))
  .map((entry) => ({ ...entry, table: entry.table as WorkspaceScopedTable }))
const globalTables = appTables.filter((entry) => !('workspaceId' in getTableColumns(entry.table)))

async function countAll(db: agentHq.AgentHqDatabase, table: PgTable): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(table)
  return rows[0]?.n ?? 0
}

/** How many rows of every workspace-scoped table belong to one workspace. */
async function workspaceCensus(
  db: agentHq.AgentHqDatabase,
  workspaceId: string
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const entry of workspaceScopedTables) {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(entry.table)
      .where(eq(entry.table.workspaceId, workspaceId))
    counts[entry.name] = rows[0]?.n ?? 0
  }
  return counts
}

/** How many rows of every table that has no workspace column exist at all. */
async function globalCensus(db: agentHq.AgentHqDatabase): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const entry of globalTables) counts[entry.name] = await countAll(db, entry.table)
  return counts
}

/** Every row the destination holds, as one string, so a canary scan covers all of them at once. */
async function dumpStores(
  db: agentHq.AgentHqDatabase,
  workspaceId: string
): Promise<Record<string, unknown[]>> {
  const dump: Record<string, unknown[]> = {}
  for (const entry of workspaceScopedTables)
    dump[entry.name] = await db
      .select()
      .from(entry.table)
      .where(eq(entry.table.workspaceId, workspaceId))
  for (const entry of globalTables) dump[entry.name] = await db.select().from(entry.table)
  return dump
}

function assertAbsent(text: string, values: readonly string[]) {
  for (const value of values) expect(text).not.toContain(value)
}

/** Restore a bundle through the production import helper and return its raw response. */
async function importInto(
  destination: agentHq.DatabaseConnection,
  bundle: unknown,
  importer: Principal,
  mayCreateWorkspace: (principal: Principal) => Promise<boolean> = async () => true
) {
  const response = await portableImportResponse(
    new Request('http://localhost/api/v1/portable-imports', {
      body: JSON.stringify(bundle),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
    destination.db,
    resolutionFor(importer),
    mayCreateWorkspace
  )
  return { response, text: await response.text() }
}

/** A destination's identity system provisions the users a bundle names; an import never creates one. */
async function provisionUsers(
  destination: agentHq.DatabaseConnection,
  bundle: PortableWorkspaceExport,
  importer: Principal
) {
  const ids = new Set(bundle.content.users.map((user) => user.userId))
  ids.add(importer.userId)
  await destination.db.insert(agentHq.users).values(
    [...ids].map((userId) => ({
      displayName: bundle.content.users.find((user) => user.userId === userId)?.displayName ?? null,
      id: userId,
    }))
  )
}

describe('residual portable export and residency acceptance', () => {
  let connection: agentHq.DatabaseConnection
  let admin: agentHq.DatabaseConnection
  let ownerDestination: agentHq.DatabaseConnection | undefined
  let outsiderDestination: agentHq.DatabaseConnection | undefined
  let refusalDestination: agentHq.DatabaseConnection | undefined
  let ownerScratch: string | undefined
  let outsiderScratch: string | undefined
  let refusalScratch: string | undefined

  let owner: Session
  let member: Session
  let outsider: Session
  let revoked: Session
  let workspaceId: string
  let audienceWorkspaceId: string
  let groupId: string
  let visibleProjectId: string
  let membersProjectId: string
  let agentId: string
  let taskId: string
  let dependencyTaskId: string
  let artifactId: string
  let harnessArtifactId: string
  let localContentRefId: string
  let syncContentRefId: string
  let deletedContentRefId: string
  let objectiveContentRefId: string
  let inviteToken: string
  let groupGrantIds: string[] = []
  let sourceMessageIds: string[] = []

  let ownerBundle: PortableWorkspaceExport
  let memberBundle: PortableWorkspaceExport
  let outsiderBundle: PortableWorkspaceExport
  let ownerImportBody: {
    contentDigest: string
    counts: Record<string, number>
    deferred: { class: string; treatment: string }[]
    externalDomains: { authority: string; class: string; status: string; treatment: string }[]
    workspaceId: string
  }

  /** The bundle the production export helper serves to a principal, with its raw bytes. */
  async function exportAs(principal: Principal) {
    const response = await portableWorkspaceExportResponse(
      new Request(`http://localhost/api/v1/workspaces/${workspaceId}/portable-export`),
      connection.db,
      resolutionFor(principal),
      workspaceId
    )
    const text = await response.text()
    return { bundle: text ? (JSON.parse(text) as PortableWorkspaceExport) : null, response, text }
  }

  async function createScratch(label: 'owner' | 'outsider' | 'refusal') {
    const name = scratchNameFor(label)
    assertDisposableScratch(name)
    await admin.client.unsafe(`create database "${name}"`)
    const created = agentHq.createDatabase(urlForDatabase(name))
    await migrate(created.db, { migrationsFolder })
    return { created, name }
  }

  /**
   * The disposable destinations are created when the first test needs them, not all at once in
   * `beforeAll`. Each one costs a full migration of the repository's schema, and the route-flow
   * lane runs its files in parallel against one database instance; spreading that cost over the
   * file's own runtime keeps this file from starving its neighbours.
   *
   * The attempt is remembered as a promise, so a failed restore is reported the same way to every
   * later test instead of leaving a half-initialized destination behind.
   */
  let ownerDestinationPromise: Promise<agentHq.DatabaseConnection> | undefined
  let outsiderDestinationPromise: Promise<agentHq.DatabaseConnection> | undefined
  let refusalDestinationPromise: Promise<agentHq.DatabaseConnection> | undefined

  async function ensureOwnerDestination(): Promise<agentHq.DatabaseConnection> {
    ownerDestinationPromise ??= createOwnerDestination()
    return ownerDestinationPromise
  }

  async function ensureOutsiderDestination(): Promise<agentHq.DatabaseConnection> {
    outsiderDestinationPromise ??= createOutsiderDestination()
    return outsiderDestinationPromise
  }

  async function ensureRefusalDestination(): Promise<agentHq.DatabaseConnection> {
    refusalDestinationPromise ??= createRefusalDestination()
    return refusalDestinationPromise
  }

  async function createOwnerDestination(): Promise<agentHq.DatabaseConnection> {
    const scratch = await createScratch('owner')
    const destination = scratch.created
    ownerScratch = scratch.name
    ownerDestination = destination
    await provisionUsers(destination, ownerBundle, owner.principal)
    const imported = await importInto(destination, ownerBundle, owner.principal)
    expect(imported.response.status).toBe(201)
    ownerImportBody = JSON.parse(imported.text) as typeof ownerImportBody
    return destination
  }

  async function createOutsiderDestination(): Promise<agentHq.DatabaseConnection> {
    const scratch = await createScratch('outsider')
    const destination = scratch.created
    outsiderScratch = scratch.name
    outsiderDestination = destination
    await provisionUsers(destination, outsiderBundle, outsider.principal)
    const imported = await importInto(destination, outsiderBundle, outsider.principal)
    expect(imported.response.status).toBe(201)
    return destination
  }

  async function createRefusalDestination(): Promise<agentHq.DatabaseConnection> {
    const scratch = await createScratch('refusal')
    refusalScratch = scratch.name
    refusalDestination = scratch.created
    return refusalDestination
  }

  beforeAll(async () => {
    connection = agentHq.createDatabase(sourceUrl!)
    admin = agentHq.createDatabase(urlForDatabase('postgres'))

    owner = await agentHq.createTemporaryUserSession(connection.db, {
      credentialDigest: `${canary.sessionDigest}-owner`,
      displayName: 'Residual Owner',
      expiresAt: future(),
    })
    member = await agentHq.createTemporaryUserSession(connection.db, {
      credentialDigest: `residual-member-${run}`,
      displayName: 'Residual Member',
      expiresAt: future(),
    })
    outsider = await agentHq.createTemporaryUserSession(connection.db, {
      credentialDigest: `residual-outsider-${run}`,
      displayName: 'Residual Outsider',
      expiresAt: future(),
    })
    revoked = await agentHq.createTemporaryUserSession(connection.db, {
      credentialDigest: `residual-revoked-${run}`,
      displayName: 'Residual Revoked',
      expiresAt: future(),
    })

    const { workspace } = await agentHq.createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `residual-${run}`,
      name: 'Residual source',
      owner: owner.principal,
    })
    workspaceId = workspace.id
    await agentHq.addWorkspaceMembership(connection.db, workspaceId, member.principal, 'member')
    await agentHq.addWorkspaceMembership(connection.db, workspaceId, outsider.principal, 'member')
    await agentHq.addWorkspaceMembership(connection.db, workspaceId, revoked.principal, 'member')

    // A second workspace, so a cross-workspace artifact reference grant has a distinct audience.
    const audience = await agentHq.createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `residual-audience-${run}`,
      name: 'Residual audience',
      owner: owner.principal,
    })
    audienceWorkspaceId = audience.workspace.id

    const agent = await agentHq.createAgent(connection.db, workspaceId, owner.principal, {
      name: 'Residual Agent',
      profileId: 'lead',
      profileVersion: '1',
    })
    agentId = agent.id

    // A participants-only group with real grants: an audience grant for each human and an
    // enlistment grant for the Agent. The grant ids are the source's own authority records.
    groupId = randomUUID()
    groupGrantIds = [
      `residual-audience-owner-${run}`,
      `residual-audience-member-${run}`,
      `residual-enlistment-agent-${run}`,
    ]
    await agentHq.createGroupChannelWithGrants(connection.db, workspaceId, owner.principal, {
      candidates: agentHq.groupCreationCandidatesFromGrants(workspaceId, {
        audienceGrants: [
          {
            expiresAt: null,
            grantId: groupGrantIds[0]!,
            groupId,
            issuedAt: now(),
            participant: owner.principal,
            revision: 1,
            revokedAt: null,
          },
          {
            expiresAt: null,
            grantId: groupGrantIds[1]!,
            groupId,
            issuedAt: now(),
            participant: member.principal,
            revision: 1,
            revokedAt: null,
          },
        ],
        enlistmentGrants: [
          {
            agent: { agentId, workspaceId },
            expiresAt: null,
            grantId: groupGrantIds[2]!,
            groupId,
            issuedAt: now(),
            revision: 1,
            revokedAt: null,
          },
        ],
      }),
      channelId: groupId,
      idempotencyKey: `residual-group-${run}`,
      now: now(),
      title: 'Residual group',
    })

    // A workspace-visible project and a members-only project. The member is listed on both.
    const visibleProject = await agentHq.createProject(
      connection.db,
      workspaceId,
      owner.principal,
      {
        iconKey: 'folder',
        name: `Residual visible ${run}`,
      }
    )
    visibleProjectId = visibleProject.id
    await agentHq.setProjectMember(connection.db, workspaceId, visibleProjectId, owner.principal, {
      role: 'viewer',
      userId: member.principal.userId,
    })
    const visibleChannel = await agentHq.createProjectChannel(
      connection.db,
      workspaceId,
      visibleProjectId,
      owner.principal,
      { idempotencyKey: `residual-visible-channel-${run}`, title: 'Residual visible lane' }
    )

    const membersProject = await agentHq.createProject(
      connection.db,
      workspaceId,
      owner.principal,
      {
        iconKey: 'folder',
        name: `Residual members ${run}`,
      }
    )
    membersProjectId = membersProject.id
    await agentHq.setProjectVisibility(
      connection.db,
      workspaceId,
      membersProjectId,
      owner.principal,
      'members'
    )
    await agentHq.setProjectMember(connection.db, workspaceId, membersProjectId, owner.principal, {
      role: 'viewer',
      userId: member.principal.userId,
    })
    const membersChannel = await agentHq.createProjectChannel(
      connection.db,
      workspaceId,
      membersProjectId,
      owner.principal,
      { idempotencyKey: `residual-members-channel-${run}`, title: 'Residual members lane' }
    )

    // Content references: an offline local body, an E2E-synchronized body with a cloud replica, a
    // body whose local authority no longer holds it, and a task objective body.
    const makeRef = async (
      contentType: 'message_body' | 'task_objective',
      synchronizationPolicy: 'agent_hq_e2ee_sync' | 'local_only'
    ) => {
      const id = randomUUID()
      await agentHq.createContentRef(connection.db, workspaceId, owner.principal, {
        availability: 'offline',
        contentType,
        digestSha256: 'a'.repeat(64),
        id,
        keyVersion: 1,
        schemaVersion: 1,
        sensitivity: 'sensitive',
        storagePolicy: 'local_authority',
        synchronizationPolicy,
      })
      return id
    }
    localContentRefId = await makeRef('message_body', 'local_only')
    syncContentRefId = await makeRef('message_body', 'agent_hq_e2ee_sync')
    objectiveContentRefId = await makeRef('task_objective', 'local_only')
    deletedContentRefId = await makeRef('message_body', 'local_only')
    await agentHq.upsertContentReplica(
      connection.db,
      workspaceId,
      syncContentRefId,
      owner.principal,
      {
        availability: 'available',
        ciphertext: canary.ciphertext,
        digestSha256: 'b'.repeat(64),
        nonce: canary.nonce,
        replicaKind: 'self_hosted_authority',
        revision: 1,
        schemaVersion: 1,
      }
    )

    // An artifact with an object-store locator and provenance, and a second one held by an
    // external harness. Both are linked from a message and granted to a second workspace. Neither
    // travels; the import must say so.
    const artifact = await agentHq.createArtifact(connection.db, workspaceId, owner.principal, {
      checksumSha256: 'c'.repeat(64),
      executionRef: canary.executionRef,
      filename: 'residual.pdf',
      location: { reference: canary.artifactLocator, type: 'object_store' },
      mediaType: 'application/pdf',
      provenance: { origin: canary.artifactProvenance },
      sizeBytes: 12,
      sourceArtifactRef: `residual-artifact-${run}`,
      sourcePrincipal: owner.principal,
    })
    artifactId = artifact.id
    const harnessArtifact = await agentHq.createArtifact(
      connection.db,
      workspaceId,
      owner.principal,
      {
        checksumSha256: 'd'.repeat(64),
        filename: 'residual-trace.txt',
        location: {
          externalHarnessId: canary.externalHarnessId,
          reference: canary.externalHarness,
          type: 'external_harness',
        },
        mediaType: 'text/plain',
        sizeBytes: 4,
        sourceArtifactRef: `residual-harness-${run}`,
        sourcePrincipal: owner.principal,
      }
    )
    harnessArtifactId = harnessArtifact.id
    await agentHq.registerArtifactReferenceGrant(connection.db, workspaceId, owner.principal, {
      artifactId,
      audienceWorkspaceId,
      checksumSha256: artifact.checksumSha256,
      expiresAt: null,
      grantId: canary.artifactGrantId,
      version: artifact.version,
    })

    // Ordered messages. The group's three messages carry a reply, a thread root and a mention; the
    // visible lane carries the workspace-visible text; the members-only lane carries the private
    // text and the artifact reference.
    const first = await agentHq.createMessage(
      connection.db,
      workspaceId,
      groupId,
      owner.principal,
      {
        bodyText: plaintext.group,
        idempotencyKey: `residual-group-1-${run}`,
        sender: owner.principal,
      }
    )
    const reply = await agentHq.createMessage(
      connection.db,
      workspaceId,
      groupId,
      owner.principal,
      {
        bodyText: `${plaintext.group}-reply`,
        idempotencyKey: `residual-group-2-${run}`,
        replyToMessageId: first.id,
        sender: owner.principal,
      }
    )
    const threaded = await agentHq.createMessage(
      connection.db,
      workspaceId,
      groupId,
      owner.principal,
      {
        bodyText: `${plaintext.group}-thread`,
        idempotencyKey: `residual-group-3-${run}`,
        mentions: [{ kind: 'user', userId: member.principal.userId }],
        sender: owner.principal,
        threadRootMessageId: first.id,
      }
    )
    await agentHq.createMessage(connection.db, workspaceId, groupId, owner.principal, {
      bodyContentRefId: localContentRefId,
      idempotencyKey: `residual-group-4-${run}`,
      sender: owner.principal,
    })
    // A message whose body the local authority no longer holds: the reference is attached first
    // and its body is deleted afterwards, so the document carries a deleted body honestly.
    await agentHq.createMessage(connection.db, workspaceId, groupId, owner.principal, {
      bodyContentRefId: deletedContentRefId,
      idempotencyKey: `residual-group-5-${run}`,
      sender: owner.principal,
    })
    await agentHq.updateContentRef(
      connection.db,
      workspaceId,
      deletedContentRefId,
      owner.principal,
      {
        availability: 'deleted',
        digestSha256: 'a'.repeat(64),
        expectedRevision: 1,
        keyVersion: 1,
        revision: 2,
      }
    )
    await agentHq.createMessage(connection.db, workspaceId, visibleChannel.id, owner.principal, {
      bodyText: plaintext.workspace,
      idempotencyKey: `residual-visible-1-${run}`,
      sender: owner.principal,
    })
    await agentHq.createMessage(connection.db, workspaceId, visibleChannel.id, owner.principal, {
      bodyContentRefId: syncContentRefId,
      idempotencyKey: `residual-visible-2-${run}`,
      sender: owner.principal,
    })
    await agentHq.createMessage(connection.db, workspaceId, membersChannel.id, owner.principal, {
      artifactIds: [artifactId, harnessArtifactId],
      bodyText: plaintext.members,
      idempotencyKey: `residual-members-1-${run}`,
      sender: owner.principal,
    })
    sourceMessageIds = [first.id, reply.id, threaded.id]

    // A task graph: one task with an objective body that depends on a second task, and one cloud
    // execution attempt on it.
    const dependency = await agentHq.createTask(
      connection.db,
      workspaceId,
      owner.principal,
      {
        objective: `Residual dependency ${run}`,
        projectId: visibleProjectId,
        title: 'Residual base',
      },
      { idempotencyKey: `residual-task-base-${run}`, requestId: randomUUID() }
    )
    dependencyTaskId = dependency.id
    const task = await agentHq.createTask(
      connection.db,
      workspaceId,
      owner.principal,
      {
        dependencyIds: [dependencyTaskId],
        objectiveContentRefId: objectiveContentRefId,
        projectId: visibleProjectId,
        title: `Residual task ${run}`,
      },
      { idempotencyKey: `residual-task-${run}`, requestId: randomUUID() }
    )
    taskId = task.id
    await connection.db.insert(agentHq.taskExecutionAttempts).values({
      attempt: 1,
      change: 'initial',
      locationKind: 'agent_hq_cloud',
      runtimeNodeId: null,
      taskId,
      workspaceId,
    })

    // A workspace invitation: its token and email are credentials that never travel.
    inviteToken = (
      await agentHq.createWorkspaceInvitation(connection.db, workspaceId, owner.principal, {
        email: canary.inviteEmail,
        role: 'member',
      })
    ).token
    inviteTokenDigest = agentHq.digestInvitationToken(inviteToken)

    const ownerExport = await exportAs(owner.principal)
    expect(ownerExport.response.status).toBe(200)
    ownerBundle = ownerExport.bundle!
    const memberExport = await exportAs(member.principal)
    expect(memberExport.response.status).toBe(200)
    memberBundle = memberExport.bundle!
    const outsiderExport = await exportAs(outsider.principal)
    expect(outsiderExport.response.status).toBe(200)
    outsiderBundle = outsiderExport.bundle!
  }, 900_000)

  afterAll(async () => {
    const closers = [ownerDestination, outsiderDestination, refusalDestination]
    for (const destination of closers) await destination?.close()
    for (const scratch of [ownerScratch, outsiderScratch, refusalScratch]) {
      if (!scratch) continue
      assertDisposableScratch(scratch)
      await admin.client.unsafe(`drop database if exists "${scratch}" with (force)`)
    }
    await admin?.close()
    if (connection && workspaceId) {
      const db = connection.db
      await db
        .update(agentHq.messages)
        .set({ replyToMessageId: null, threadRootMessageId: null })
        .where(eq(agentHq.messages.workspaceId, workspaceId))
      await db.delete(agentHq.messages).where(eq(agentHq.messages.workspaceId, workspaceId))
      await db
        .delete(agentHq.messageMentions)
        .where(eq(agentHq.messageMentions.workspaceId, workspaceId))
      await db
        .delete(agentHq.messageArtifactReferences)
        .where(eq(agentHq.messageArtifactReferences.workspaceId, workspaceId))
      await db
        .delete(agentHq.channelParticipants)
        .where(eq(agentHq.channelParticipants.workspaceId, workspaceId))
      await db.delete(agentHq.channels).where(eq(agentHq.channels.workspaceId, workspaceId))
      await db
        .delete(agentHq.taskExecutionAttempts)
        .where(eq(agentHq.taskExecutionAttempts.workspaceId, workspaceId))
      await db
        .delete(agentHq.taskDependencies)
        .where(eq(agentHq.taskDependencies.workspaceId, workspaceId))
      await db.delete(agentHq.tasks).where(eq(agentHq.tasks.workspaceId, workspaceId))
      await db.delete(agentHq.artifacts).where(eq(agentHq.artifacts.workspaceId, workspaceId))
      await db
        .delete(agentHq.contentReplicas)
        .where(eq(agentHq.contentReplicas.workspaceId, workspaceId))
      await db.delete(agentHq.contentRefs).where(eq(agentHq.contentRefs.workspaceId, workspaceId))
      await db
        .delete(agentHq.groupAdmissions)
        .where(eq(agentHq.groupAdmissions.workspaceId, workspaceId))
      await db
        .delete(agentHq.groupAudienceGrants)
        .where(eq(agentHq.groupAudienceGrants.workspaceId, workspaceId))
      await db
        .delete(agentHq.groupEnlistmentGrants)
        .where(eq(agentHq.groupEnlistmentGrants.workspaceId, workspaceId))
      await db
        .delete(agentHq.projectMembers)
        .where(eq(agentHq.projectMembers.workspaceId, workspaceId))
      await db.delete(agentHq.projects).where(eq(agentHq.projects.workspaceId, workspaceId))
      await db
        .delete(agentHq.workspaceInvitations)
        .where(eq(agentHq.workspaceInvitations.workspaceId, workspaceId))
      await db
        .delete(agentHq.workspaceMemberships)
        .where(
          inArray(agentHq.workspaceMemberships.workspaceId, [workspaceId, audienceWorkspaceId])
        )
      await db.delete(agentHq.workspaces).where(eq(agentHq.workspaces.id, workspaceId))
      if (audienceWorkspaceId)
        await db.delete(agentHq.workspaces).where(eq(agentHq.workspaces.id, audienceWorkspaceId))
      const userIds = [owner, member, outsider, revoked].map((session) => session.principal.userId)
      await db
        .delete(agentHq.temporaryUserSessions)
        .where(inArray(agentHq.temporaryUserSessions.userId, userIds))
      await db.delete(agentHq.users).where(inArray(agentHq.users.id, userIds))
    }
    await connection?.close()
  }, 600_000)

  test('the authorized bundle is nonempty in every family the format claims to carry', () => {
    expect(validatePortableWorkspaceExport(ownerBundle).ok).toBe(true)
    const content = ownerBundle.content
    expect(content.messages.length).toBeGreaterThan(0)
    expect(content.channels.length).toBeGreaterThan(0)
    expect(content.contentRefs.length).toBeGreaterThan(0)
    expect(content.projects.length).toBeGreaterThan(0)
    expect(content.tasks.length).toBeGreaterThan(0)
    expect(content.taskDependencies.length).toBeGreaterThan(0)
    expect(content.executionAttempts.length).toBeGreaterThan(0)
    expect(content.agents.length).toBeGreaterThan(0)
    expect(content.users.length).toBeGreaterThan(0)
    expect(content.messages.some((message) => message.mentions.length > 0)).toBe(true)
    expect(content.messages.some((message) => message.replyToMessageId !== null)).toBe(true)
    expect(content.messages.some((message) => message.threadRootMessageId !== null)).toBe(true)
    expect(content.messages.some((message) => message.body.kind === 'content_ref')).toBe(true)
    expect(
      content.projects.some(
        (project) => project.members.length > 0 && project.visibility === 'members'
      )
    ).toBe(true)
  })

  test('the bundle lists the messages in the order the canonical reader serves them', async () => {
    const content = ownerBundle.content
    let previousChannel: string | undefined
    let expectedOrder = 0
    for (const message of content.messages) {
      if (message.channelId !== previousChannel) {
        expect(previousChannel === undefined || message.channelId > previousChannel).toBe(true)
        expectedOrder = 1
        previousChannel = message.channelId
      } else expectedOrder += 1
      expect(message.channelOrder).toBe(expectedOrder)
    }
    for (const channel of content.channels) {
      const served = await agentHq.listMessagesForUser(
        connection.db,
        workspaceId,
        channel.channelId,
        owner.principal
      )
      const bundled = content.messages.filter((message) => message.channelId === channel.channelId)
      expect(bundled.map((message) => message.messageId)).toEqual(
        served.messages.map((message) => message.id)
      )
    }
  })

  test('the restore reproduces the order, the links and the digest of the bundle', async () => {
    const destination = await ensureOwnerDestination()
    expect(ownerImportBody.contentDigest).toBe(ownerBundle.contentDigest.value)
    expect(ownerImportBody.workspaceId).toBe(workspaceId)
    const restored = await destination.db.transaction((transaction) =>
      agentHq.readCompletePortableContent(transaction, workspaceId)
    )
    expect(restored).not.toBeNull()
    expect(agentHq.portableContentDigest(restored!)).toBe(ownerBundle.contentDigest.value)
    for (const channel of ownerBundle.content.channels) {
      const served = await agentHq.listMessagesForUser(
        destination.db,
        workspaceId,
        channel.channelId,
        owner.principal
      )
      const bundled = ownerBundle.content.messages.filter(
        (message) => message.channelId === channel.channelId
      )
      expect(served.messages.map((message) => message.id)).toEqual(
        bundled.map((message) => message.messageId)
      )
    }
    const bundledById = new Map(
      ownerBundle.content.messages.map((message) => [message.messageId, message])
    )
    const stored = await destination.db
      .select()
      .from(agentHq.messages)
      .where(eq(agentHq.messages.workspaceId, workspaceId))
    for (const row of stored) {
      const bundled = bundledById.get(row.id)
      expect(bundled).toBeDefined()
      expect(row.replyToMessageId).toBe(bundled!.replyToMessageId)
      expect(row.threadRootMessageId).toBe(bundled!.threadRootMessageId)
    }
    for (const id of sourceMessageIds) expect(bundledById.get(id)).toBeDefined()
  })

  test('the audience matrix gives each reader exactly their own audience', () => {
    const ownerText = JSON.stringify(ownerBundle)
    const memberText = JSON.stringify(memberBundle)
    const outsiderText = JSON.stringify(outsiderBundle)
    for (const text of [ownerText, memberText]) {
      expect(text).toContain(plaintext.group)
      expect(text).toContain(plaintext.members)
      expect(text).toContain(plaintext.workspace)
    }
    expect(outsiderText).toContain(plaintext.workspace)
    assertAbsent(outsiderText, [plaintext.group, plaintext.members, groupId, membersProjectId])
    expect(outsiderBundle.content.channels.map((channel) => channel.channelId)).not.toContain(
      groupId
    )
    expect(outsiderBundle.content.projects.map((project) => project.projectId)).not.toContain(
      membersProjectId
    )
    expect(outsiderBundle.content.messages.length).toBeGreaterThan(0)
    expect(outsiderBundle.content.tasks.length).toBeGreaterThan(0)
  })

  test('a revoked group audience grant removes the group and its text from the next bundle', async () => {
    const revokedGrant = await agentHq.revokeGroupGrant(
      connection.db,
      workspaceId,
      groupId,
      owner.principal,
      { grantId: groupGrantIds[1]!, kind: 'audience', revokedAt: now() }
    )
    expect(revokedGrant.revoked).toBe(true)
    const after = await exportAs(member.principal)
    expect(after.response.status).toBe(200)
    assertAbsent(after.text, [plaintext.group, groupId])
    expect(after.bundle!.content.channels.map((channel) => channel.channelId)).not.toContain(
      groupId
    )
    expect(after.text).toContain(plaintext.members)
  })

  test('a removed membership is refused with the same body as an unknown workspace', async () => {
    expect(
      await agentHq.removeWorkspaceMembership(connection.db, workspaceId, revoked.principal)
    ).toBe(true)
    const refused = await portableWorkspaceExportResponse(
      new Request(`http://localhost/api/v1/workspaces/${workspaceId}/portable-export`),
      connection.db,
      resolutionFor(revoked.principal),
      workspaceId
    )
    const unknown = await portableWorkspaceExportResponse(
      new Request(`http://localhost/api/v1/workspaces/${randomUUID()}/portable-export`),
      connection.db,
      resolutionFor(revoked.principal),
      randomUUID()
    )
    expect(refused.status).toBe(404)
    expect(unknown.status).toBe(404)
    const refusedBody = await refused.text()
    expect(refusedBody).toBe(await unknown.text())
    assertAbsent(refusedBody, [workspaceId, plaintext.group, plaintext.members])
  })

  test('artifact references do not travel, and the withheld domain is named', async () => {
    await ensureOwnerDestination()
    const ownerText = JSON.stringify(ownerBundle)
    assertAbsent(ownerText, [
      canary.artifactLocator,
      canary.artifactProvenance,
      canary.executionRef,
      canary.externalHarness,
      canary.externalHarnessId,
      canary.artifactGrantId,
      artifactId,
      harnessArtifactId,
    ])
    const domain = ownerImportBody.externalDomains.find(
      (entry) => entry.class === 'artifact_bytes_and_locations'
    )
    expect(domain?.status).toBe('unavailable')
    expect(domain?.treatment).toBe('deferred')
    expect(domain?.authority).toBe('artifact_store (#86)')
  })

  test('the source grants are never transplanted; the restore issues its own', async () => {
    const destination = await ensureOwnerDestination()
    const sourceGrants = await connection.db
      .select()
      .from(agentHq.groupAudienceGrants)
      .where(eq(agentHq.groupAudienceGrants.workspaceId, workspaceId))
    expect(sourceGrants.length).toBeGreaterThan(0)
    const sourceGrantIds = sourceGrants.map((grant) => grant.grantId)
    for (const grantId of sourceGrantIds) assertAbsent(JSON.stringify(ownerBundle), [grantId])
    for (const grantId of groupGrantIds) assertAbsent(JSON.stringify(ownerBundle), [grantId])

    const restoredGrants = await destination.db
      .select()
      .from(agentHq.groupAudienceGrants)
      .where(eq(agentHq.groupAudienceGrants.workspaceId, workspaceId))
    expect(restoredGrants.length).toBeGreaterThan(0)
    for (const grant of restoredGrants) {
      expect(grant.grantId).toStartWith('restore:audience:')
      expect(sourceGrantIds).not.toContain(grant.grantId)
      for (const grantId of groupGrantIds) expect(grant.grantId).not.toContain(grantId)
    }
    const restoredEnlistments = await destination.db
      .select()
      .from(agentHq.groupEnlistmentGrants)
      .where(eq(agentHq.groupEnlistmentGrants.workspaceId, workspaceId))
    expect(restoredEnlistments.length).toBeGreaterThan(0)
    for (const grant of restoredEnlistments)
      expect(grant.grantId).toStartWith('restore:enlistment:')
    expect(
      await destination.db
        .select()
        .from(agentHq.groupSharingGrants)
        .where(eq(agentHq.groupSharingGrants.workspaceId, workspaceId))
    ).toEqual([])
    const memberships = await destination.db
      .select()
      .from(agentHq.workspaceMemberships)
      .where(eq(agentHq.workspaceMemberships.workspaceId, workspaceId))
    expect(memberships.map((membership) => [membership.userId, membership.role])).toEqual([
      [owner.principal.userId, 'owner'],
    ])
  })

  test('the restored workspace lives in an enumerated set of stores and nowhere else', async () => {
    const destination = await ensureOwnerDestination()
    const counts = await workspaceCensus(destination.db, workspaceId)
    const populated = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([name]) => name)
      .toSorted()
    const content = ownerBundle.content
    const groupParticipants = content.channels
      .filter((channel) => channel.kind === 'group')
      .flatMap((channel) => channel.participants)
    const expected = new Set<string>([
      'agents',
      'channel_participants',
      'channels',
      'content_refs',
      'message_mentions',
      'messages',
      'project_members',
      'projects',
      'task_dependencies',
      'task_execution_attempts',
      'tasks',
      'workspace_event_dispatches',
      'workspace_event_sequences',
      'workspace_events',
      'workspace_memberships',
    ])
    if (groupParticipants.length > 0)
      for (const family of ['group_admissions', 'group_audience_grants', 'group_enlistment_grants'])
        expected.add(family)
    expect(populated).toEqual([...expected].toSorted())

    expect(counts.messages).toBe(content.messages.length)
    expect(counts.channels).toBe(content.channels.length)
    expect(counts.content_refs).toBe(content.contentRefs.length)
    expect(counts.projects).toBe(content.projects.length)
    expect(counts.tasks).toBe(content.tasks.length)
    expect(counts.task_dependencies).toBe(content.taskDependencies.length)
    expect(counts.task_execution_attempts).toBe(content.executionAttempts.length)
    expect(counts.agents).toBe(content.agents.length)
    expect(counts.project_members).toBe(
      content.projects.reduce((total, project) => total + project.members.length, 0)
    )
    expect(counts.message_mentions).toBe(
      content.messages.reduce((total, message) => total + message.mentions.length, 0)
    )
    expect(counts.channel_participants).toBe(
      content.channels.reduce((total, channel) => total + channel.participants.length, 0)
    )
    expect(counts.group_admissions ?? 0).toBe(groupParticipants.length)
  })

  test('the stores without a workspace column hold only the provisioned identities', async () => {
    const destination = await ensureOwnerDestination()
    const counts = await globalCensus(destination.db)
    for (const [name, count] of Object.entries(counts)) {
      if (name === 'users') continue
      if (name === 'workspaces') {
        expect(count).toBe(1)
        continue
      }
      expect({ name, count }).toEqual({ name, count: 0 })
    }
    const provisioned = ownerBundle.content.users.map((user) => user.userId)
    expect(counts.users).toBe(provisioned.length)
    const rows = await destination.db.select().from(agentHq.users)
    expect(rows.map((row) => row.id).toSorted()).toEqual(provisioned.toSorted())
  })

  test('the withheld external domains are reported unavailable and the offline bodies are stated honestly', async () => {
    const destination = await ensureOwnerDestination()
    expect(ownerImportBody.externalDomains.map((domain) => domain.class).toSorted()).toEqual(
      [...PORTABLE_EXTERNAL_DOMAIN_CLASSES].toSorted()
    )
    for (const domain of ownerImportBody.externalDomains) expect(domain.status).toBe('unavailable')
    const ledger = ownerBundle.exclusions
    for (const domain of ownerImportBody.externalDomains)
      expect(ledger.some((entry) => entry.class === domain.class)).toBe(true)

    const refs = await destination.db
      .select()
      .from(agentHq.contentRefs)
      .where(eq(agentHq.contentRefs.workspaceId, workspaceId))
    expect(refs.length).toBe(ownerBundle.content.contentRefs.length)
    const bundled = new Map(
      ownerBundle.content.contentRefs.map((ref) => [ref.contentRefId, ref] as const)
    )
    for (const row of refs) {
      const exported = bundled.get(row.id)
      expect(exported).toBeDefined()
      expect(row.storagePolicy).toBe('local_authority')
      expect(row.synchronizationPolicy).toBe(exported!.synchronizationPolicy)
      expect(row.availability).toBe(exported!.bodyState === 'deleted' ? 'deleted' : 'missing')
    }
    const offline = ownerBundle.content.contentRefs.find(
      (ref) => ref.contentRefId === localContentRefId
    )
    expect(offline?.bodyState).toBe('local_authority')
    const deleted = ownerBundle.content.contentRefs.find(
      (ref) => ref.contentRefId === deletedContentRefId
    )
    expect(deleted?.bodyState).toBe('deleted')
  })

  test('a malicious manifest is refused and writes nothing', async () => {
    const destination = await ensureRefusalDestination()
    const refusals: Readonly<{ bundle: unknown; expected: string }>[] = [
      {
        bundle: { ...ownerBundle, admin: true },
        expected: 'unknown_field',
      },
      {
        bundle: { ...ownerBundle, formatVersion: 2 },
        expected: 'value',
      },
      {
        bundle: {
          ...ownerBundle,
          exclusions: [
            ...ownerBundle.exclusions,
            {
              authority: 'nowhere',
              class: `unknown-domain-${run}`,
              reason: 'not in version one',
              treatment: 'excluded',
            },
          ],
        },
        expected: 'exclusions',
      },
      {
        bundle: {
          ...ownerBundle,
          content: {
            ...ownerBundle.content,
            messages: ownerBundle.content.messages.map((message, index) =>
              index === 0 ? { ...message, isAdmin: true } : message
            ),
          },
        },
        expected: 'unknown_field',
      },
    ]
    for (const refusal of refusals) {
      const response = await importInto(destination, refusal.bundle, owner.principal)
      expect(response.response.status).toBe(422)
      const body = JSON.parse(response.text) as {
        error: string
        issues: { code: string; path: string }[]
      }
      expect(body.error).toBe('invalid_document')
      expect(body.issues.map((issue) => issue.code)).toContain(refusal.expected)
      // A refusal names the offending path, never the value it found.
      assertAbsent(response.text, [`unknown-domain-${run}`])
    }

    const tampered = mutableCopy(ownerBundle)
    const target = tampered.content.messages.find((message) => message.body.kind === 'text')
    target!.body = { kind: 'text', text: `TAMPERED-${run}` }
    const mismatch = await importInto(destination, tampered, owner.principal)
    expect(mismatch.response.status).toBe(422)
    expect((JSON.parse(mismatch.text) as { error: string }).error).toBe('digest_mismatch')
    assertAbsent(mismatch.text, [`TAMPERED-${run}`])

    const polluted = { ...ownerBundle } as Record<string, unknown>
    Object.defineProperty(polluted, '__proto__', {
      configurable: true,
      enumerable: true,
      value: { polluted: 'yes' },
      writable: true,
    })
    const pollution = await importInto(destination, polluted, owner.principal)
    expect(pollution.response.status).toBe(422)
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()

    const counts = await workspaceCensus(destination.db, workspaceId)
    for (const [name, count] of Object.entries(counts))
      expect({ name, count }).toEqual({ name, count: 0 })
    const globalCounts = await globalCensus(destination.db)
    expect(globalCounts.messages).toBeUndefined()
    expect(globalCounts.workspaces).toBe(0)
    expect(globalCounts.users).toBe(0)
  })

  test("a manifest claiming another exporter's authority does not transfer authority", async () => {
    const destination = await ensureRefusalDestination()
    const forged = mutableCopy(ownerBundle)
    forged.exportedBy = { role: 'owner', userId: member.principal.userId }
    await provisionUsers(destination, ownerBundle, owner.principal)
    const restored = await importInto(destination, forged, owner.principal)
    expect(restored.response.status).toBe(201)
    const memberships = await destination.db
      .select()
      .from(agentHq.workspaceMemberships)
      .where(eq(agentHq.workspaceMemberships.workspaceId, workspaceId))
    expect(memberships.map((membership) => [membership.userId, membership.role])).toEqual([
      [owner.principal.userId, 'owner'],
    ])
    const workspace = await destination.db
      .select()
      .from(agentHq.workspaces)
      .where(eq(agentHq.workspaces.id, workspaceId))
    expect(workspace[0]?.ownerUserId).toBe(owner.principal.userId)
  })

  test('ordering and collision errors are refused and write nothing', async () => {
    const destination = await ensureRefusalDestination()
    const base = mutableCopy(ownerBundle)
    const duplicateMessage = structuredClone(base)
    duplicateMessage.content.messages.push(structuredClone(duplicateMessage.content.messages[0]!))
    const gap = structuredClone(base)
    const second = gap.content.messages.find((message) => message.channelOrder === 2)
    if (second) second.channelOrder = 3
    const duplicateChannel = structuredClone(base)
    duplicateChannel.content.channels.push(structuredClone(duplicateChannel.content.channels[0]!))
    const dangling = structuredClone(base)
    const refMessage = dangling.content.messages.find(
      (message) => message.body.kind === 'content_ref'
    )
    if (refMessage) refMessage.body = { contentRefId: randomUUID(), kind: 'content_ref' }
    const selfDependency = structuredClone(base)
    if (selfDependency.content.taskDependencies[0])
      selfDependency.content.taskDependencies[0] = {
        dependsOnTaskId: selfDependency.content.taskDependencies[0]!.taskId,
        taskId: selfDependency.content.taskDependencies[0]!.taskId,
      }
    const brokenRun = structuredClone(base)
    const firstIndex = brokenRun.content.messages.findIndex(
      (message, index) =>
        index > 0 && message.channelId !== brokenRun.content.messages[index - 1]!.channelId
    )
    if (firstIndex > 0) {
      const moved = brokenRun.content.messages.splice(firstIndex, 1)[0]!
      brokenRun.content.messages.splice(0, 0, moved)
    }

    const cases: Readonly<{ bundle: unknown; code: string }>[] = [
      { bundle: duplicateMessage, code: 'duplicate' },
      { bundle: gap, code: 'invariant' },
      { bundle: duplicateChannel, code: 'duplicate' },
      { bundle: dangling, code: 'closure' },
      { bundle: selfDependency, code: 'invariant' },
      { bundle: brokenRun, code: 'invariant' },
    ]
    for (const testCase of cases) {
      const response = await importInto(destination, testCase.bundle, owner.principal)
      expect(response.response.status).toBe(422)
      const body = JSON.parse(response.text) as { error: string; issues: { code: string }[] }
      expect(body.error).toBe('invalid_document')
      expect(body.issues.map((issue) => issue.code)).toContain(testCase.code)
    }
  })

  test('the secret canaries are in the source and in no bundle and in no destination', async () => {
    const source = JSON.stringify({
      artifacts: await connection.db
        .select()
        .from(agentHq.artifacts)
        .where(eq(agentHq.artifacts.workspaceId, workspaceId)),
      grants: await connection.db
        .select()
        .from(agentHq.artifactReferenceGrants)
        .where(eq(agentHq.artifactReferenceGrants.sourceWorkspaceId, workspaceId)),
      invitations: await connection.db
        .select()
        .from(agentHq.workspaceInvitations)
        .where(eq(agentHq.workspaceInvitations.workspaceId, workspaceId)),
      replicas: await connection.db
        .select()
        .from(agentHq.contentReplicas)
        .where(eq(agentHq.contentReplicas.workspaceId, workspaceId)),
      sessions: await connection.db.select().from(agentHq.temporaryUserSessions),
    })
    for (const secret of [
      canary.artifactLocator,
      canary.artifactProvenance,
      canary.executionRef,
      canary.externalHarness,
      canary.externalHarnessId,
      canary.artifactGrantId,
      canary.ciphertext,
      canary.nonce,
      canary.inviteEmail,
      canary.sessionDigest,
      inviteTokenDigest,
    ])
      expect(source).toContain(secret)

    for (const bundle of [ownerBundle, memberBundle, outsiderBundle])
      assertAbsent(JSON.stringify(bundle), secretCanaries)

    const ownerTarget = await ensureOwnerDestination()
    const outsiderTarget = await ensureOutsiderDestination()
    for (const destination of [ownerTarget, outsiderTarget]) {
      const dump = JSON.stringify(await dumpStores(destination.db, workspaceId))
      assertAbsent(dump, secretCanaries)
      assertAbsent(dump, [inviteToken, inviteTokenDigest])
    }
  })

  test('the private plaintext reaches the authorized reader and no one else', async () => {
    const ownerTarget = await ensureOwnerDestination()
    const outsiderTarget = await ensureOutsiderDestination()
    const outsiderDump = JSON.stringify(await dumpStores(outsiderTarget.db, workspaceId))
    assertAbsent(outsiderDump, [plaintext.group, plaintext.members])
    expect(outsiderDump).toContain(plaintext.workspace)
    const ownerDump = JSON.stringify(await dumpStores(ownerTarget.db, workspaceId))
    expect(ownerDump).toContain(plaintext.group)
    expect(ownerDump).toContain(plaintext.members)
    const outsiderMemberships = await outsiderTarget.db
      .select()
      .from(agentHq.workspaceMemberships)
      .where(eq(agentHq.workspaceMemberships.workspaceId, workspaceId))
    expect(outsiderMemberships.map((membership) => membership.userId)).toEqual([
      outsider.principal.userId,
    ])
  })
})
