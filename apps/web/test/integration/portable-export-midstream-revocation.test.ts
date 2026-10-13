// Mid-export revocation through the real export API and database (M18.02.2, #1226).
//
// Each scenario starts a paged export through the GET handler and pauses it before the second
// message page of one channel. While it is paused, the test revokes the reader's authority
// through an existing domain API on another connection, then resumes the export. The export must
// be denied with the same 404 as no access, and the canonical readers must already report the
// revocation. Two controls with unchanged authority, one group channel and one project channel,
// export every message of their channel across the same pause.
//
// The reader serves 100 messages a page, so 101 messages make a second page of one: message 100.
// Pre-join and publication withholding regressions depend on #1232 and #1237 and are not here.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'

import {
  addWorkspaceMembership,
  channelParticipants,
  channels,
  createDatabase,
  createGroupChannel,
  createMessage,
  createProject,
  createProjectChannel,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  type DatabaseConnection,
  getChannelForUser,
  listChannelsForUser,
  listMessagesForUser,
  messages,
  type PortableExportHooks,
  projectMembers,
  projects,
  removeProjectMember,
  removeWorkspaceMembership,
  setChannelParticipants,
  setProjectMember,
  setProjectVisibility,
  workspaceMemberships,
  workspaces,
} from '@adea-ai/db'
import type { PortableWorkspaceExport } from '@adea-ai/types'
import { eq } from 'drizzle-orm'

import { portableWorkspaceExportResponse } from '../../src/server/portable-workspace-request'
import type { WorkspacePrincipalResolution } from '../../src/server/workspace-principal'

type Session = Awaited<ReturnType<typeof createTemporaryUserSession>>

const connectionUrl = process.env.DATABASE_URL
if (!connectionUrl) throw new Error('DATABASE_URL is required for the mid-export revocation flows')

const run = randomBytes(6).toString('hex')
const future = () => new Date(Date.now() + 60 * 60 * 1000)
const FIRST_PAGE = 100
const MESSAGES = FIRST_PAGE + 1

function resolutionFor(
  principal: WorkspacePrincipalResolution['principal']
): WorkspacePrincipalResolution {
  return { clearTemporaryCredential: false, principal, sessionRotated: false, temporary: true }
}

function exportRequest() {
  return new Request('http://localhost/api/v1/workspaces/x/portable-export')
}

/** Pauses an export before the second message page of one channel until `release` is called. */
function pauseBeforeSecondPage(channelId: string) {
  const reached = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const hooks: PortableExportHooks = {
    beforeMessagePage: async (page) => {
      if (page.channelId === channelId && page.afterSequence !== undefined) {
        reached.resolve()
        await released.promise
      }
    },
  }
  return { hooks, release: () => released.resolve(), reached: reached.promise }
}

/** Every body a fixture writes into its channel, sorted. */
function fixtureBodies(marker: string) {
  return Array.from({ length: MESSAGES }, (_, index) => `${marker} message ${index}`).toSorted()
}

/** The message bodies of one channel in a served export, in no particular order. */
async function servedBodies(response: Response, channelId: string): Promise<string[]> {
  expect(response.status).toBe(200)
  const bundle = (await response.json()) as PortableWorkspaceExport
  return bundle.content.messages
    .filter((message) => message.channelId === channelId)
    .map((message) => (message.body.kind === 'text' ? message.body.text : message.body.kind))
}

describe('mid-export revocation through the export API', () => {
  let connection: DatabaseConnection
  const created: string[] = []

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    for (const workspaceId of created) {
      await connection.db.delete(messages).where(eq(messages.workspaceId, workspaceId))
      await connection.db
        .delete(channelParticipants)
        .where(eq(channelParticipants.workspaceId, workspaceId))
      await connection.db.delete(channels).where(eq(channels.workspaceId, workspaceId))
      await connection.db.delete(projectMembers).where(eq(projectMembers.workspaceId, workspaceId))
      await connection.db.delete(projects).where(eq(projects.workspaceId, workspaceId))
      await connection.db
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspaceId))
      await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    }
    await connection.close()
  })

  async function seedWorkspace(name: string) {
    const db = connection.db
    const owner = await createTemporaryUserSession(db, {
      credentialDigest: `midstream-owner-${name}-${run}`,
      displayName: 'Midstream Owner',
      expiresAt: future(),
    })
    const reader = await createTemporaryUserSession(db, {
      credentialDigest: `midstream-reader-${name}-${run}`,
      displayName: 'Midstream Reader',
      expiresAt: future(),
    })
    const { workspace } = await createWorkspaceWithOwner(db, {
      idempotencyKey: `midstream-${name}-${run}`,
      name: `Midstream ${name}`,
      owner: owner.principal,
    })
    created.push(workspace.id)
    await addWorkspaceMembership(db, workspace.id, reader.principal, 'member')
    return { owner, reader, workspaceId: workspace.id }
  }

  /** Fills a channel with MESSAGES messages from the owner, each body naming its index. */
  async function fillChannel(
    workspaceId: string,
    channelId: string,
    owner: Session,
    marker: string
  ) {
    for (let index = 0; index < MESSAGES; index += 1)
      await createMessage(connection.db, workspaceId, channelId, owner.principal, {
        bodyText: `${marker} message ${index}`,
        idempotencyKey: `${marker}-${index}`,
        sender: owner.principal,
      })
  }

  /** A group channel whose participants are the owner and the reader. */
  async function groupFixture(name: string) {
    const { owner, reader, workspaceId } = await seedWorkspace(name)
    const channel = await createGroupChannel(connection.db, workspaceId, owner.principal, {
      idempotencyKey: `midstream-channel-${name}-${run}`,
      title: 'Midstream lane',
    })
    await setChannelParticipants(
      connection.db,
      workspaceId,
      channel.id,
      owner.principal,
      [
        { kind: 'user', userId: owner.principal.userId },
        { kind: 'user', userId: reader.principal.userId },
      ],
      (await getChannelForUser(connection.db, workspaceId, channel.id, owner.principal)).version
    )
    const marker = `${name}-${run}`
    await fillChannel(workspaceId, channel.id, owner, marker)
    return { channelId: channel.id, marker, owner, reader, workspaceId }
  }

  /** A workspace-visible channel in a members-only project that lists the reader as a viewer. */
  async function projectFixture(name: string) {
    const { owner, reader, workspaceId } = await seedWorkspace(name)
    const project = await createProject(connection.db, workspaceId, owner.principal, {
      iconKey: 'folder',
      name: `Midstream project ${name}`,
    })
    await setProjectVisibility(connection.db, workspaceId, project.id, owner.principal, 'members')
    await setProjectMember(connection.db, workspaceId, project.id, owner.principal, {
      role: 'viewer',
      userId: reader.principal.userId,
    })
    const channel = await createProjectChannel(
      connection.db,
      workspaceId,
      project.id,
      owner.principal,
      {
        idempotencyKey: `midstream-project-channel-${name}-${run}`,
        title: 'Project lane',
      }
    )
    const marker = `${name}-${run}`
    await fillChannel(workspaceId, channel.id, owner, marker)
    return { channelId: channel.id, marker, owner, projectId: project.id, reader, workspaceId }
  }

  /**
   * Starts the export, waits until it is paused before its second page, runs `revoke` on
   * another connection, then resumes the export and returns its response.
   */
  async function exportAcrossPause(
    reader: Session,
    workspaceId: string,
    channelId: string,
    revoke?: () => Promise<unknown>
  ) {
    const pause = pauseBeforeSecondPage(channelId)
    const exporting = portableWorkspaceExportResponse(
      exportRequest(),
      connection.db,
      resolutionFor(reader.principal),
      workspaceId,
      { hooks: pause.hooks }
    )
    await Promise.race([
      pause.reached,
      exporting.then(() => {
        throw new Error('the export finished before its second message page')
      }),
    ])
    try {
      if (revoke) await revoke()
    } finally {
      pause.release()
    }
    return exporting
  }

  test('a workspace membership revoked between pages denies the export and withholds the later page', async () => {
    const fixture = await groupFixture('membership')
    const response = await exportAcrossPause(
      fixture.reader,
      fixture.workspaceId,
      fixture.channelId,
      () => removeWorkspaceMembership(connection.db, fixture.workspaceId, fixture.reader.principal)
    )
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain(fixture.marker)
    await expect(
      listChannelsForUser(connection.db, fixture.workspaceId, fixture.reader.principal)
    ).rejects.toThrow('Channel unavailable')
  }, 180_000)

  test('a channel participant removed between pages denies the export and withholds the later page', async () => {
    const fixture = await groupFixture('participant')
    const response = await exportAcrossPause(
      fixture.reader,
      fixture.workspaceId,
      fixture.channelId,
      async () =>
        setChannelParticipants(
          connection.db,
          fixture.workspaceId,
          fixture.channelId,
          fixture.owner.principal,
          [{ kind: 'user', userId: fixture.owner.principal.userId }],
          (
            await getChannelForUser(
              connection.db,
              fixture.workspaceId,
              fixture.channelId,
              fixture.owner.principal
            )
          ).version
        )
    )
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain(fixture.marker)
    await expect(
      listMessagesForUser(
        connection.db,
        fixture.workspaceId,
        fixture.channelId,
        fixture.reader.principal
      )
    ).rejects.toThrow('Channel unavailable')
  }, 180_000)

  test('a project grant removed between pages denies the export and withholds the later page', async () => {
    const fixture = await projectFixture('project')
    const response = await exportAcrossPause(
      fixture.reader,
      fixture.workspaceId,
      fixture.channelId,
      () =>
        removeProjectMember(
          connection.db,
          fixture.workspaceId,
          fixture.projectId,
          fixture.owner.principal,
          fixture.reader.principal.userId
        )
    )
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain(fixture.marker)
    const visible = await listChannelsForUser(
      connection.db,
      fixture.workspaceId,
      fixture.reader.principal
    )
    expect(visible.map((channel) => channel.id)).not.toContain(fixture.channelId)
    await expect(
      listMessagesForUser(
        connection.db,
        fixture.workspaceId,
        fixture.channelId,
        fixture.reader.principal
      )
    ).rejects.toThrow('Channel unavailable')
  }, 180_000)

  test('control: unchanged participation serves every message of the channel across the same pause', async () => {
    const fixture = await groupFixture('control')
    const response = await exportAcrossPause(fixture.reader, fixture.workspaceId, fixture.channelId)
    expect((await servedBodies(response, fixture.channelId)).toSorted()).toEqual(
      fixtureBodies(fixture.marker)
    )
  }, 180_000)

  test('control: unchanged project grant serves every message of the channel across the same pause', async () => {
    const fixture = await projectFixture('project-control')
    const response = await exportAcrossPause(fixture.reader, fixture.workspaceId, fixture.channelId)
    expect((await servedBodies(response, fixture.channelId)).toSorted()).toEqual(
      fixtureBodies(fixture.marker)
    )
  }, 180_000)
})
