// Revocation matrix for the portable export, through the real export API and database
// (M18.02.2, #1226).
//
// Every fixture channel holds 101 messages, so the export reads it in two pages (100 and 1). The
// last message carries a content reference, which only the second page brings in. An export is
// held at one point and the reader's authority is revoked through an existing domain API on another
// connection before the export resumes. The points are:
//
//   between-pages        before the second message page of the fixture channel
//   before-tasks         after the last message page, before the tasks are read
//   before-content-refs  after the tasks, before the content references are checked
//   before-final         after every read, before the final access check
//
// A revoked export answers 404 with the workspace-unavailable body and nothing else. Its body must
// not name the fixture's text, channel, project, task or content reference, so no partial document
// and no hidden reference escapes. Controls with unchanged authority serve the whole channel, and a
// member who is neither listed on the members-only project nor a group participant receives none of
// those records or references.
//
// Pre-join content (#1232) and withheld job publication (#1237) are not covered here. Their
// regressions depend on those PRs landing on main.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'

import {
  addWorkspaceMembership,
  archiveChannel,
  archiveProject,
  channelParticipants,
  channels,
  contentRefs,
  createContentRef,
  createDatabase,
  createGroupChannel,
  createMessage,
  createProject,
  createProjectChannel,
  createTask,
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
  taskDependencies,
  taskExecutionAttempts,
  tasks,
  updateChannel,
  workspaceMemberships,
  workspaces,
} from '@adea-ai/db'
import type { PortableWorkspaceExport } from '@adea-ai/types'
import { eq } from 'drizzle-orm'

import { portableWorkspaceExportResponse } from '../../src/server/portable-workspace-request'
import type { WorkspacePrincipalResolution } from '../../src/server/workspace-principal'

type Session = Awaited<ReturnType<typeof createTemporaryUserSession>>
type Participants = Awaited<ReturnType<typeof getChannelForUser>>['participants']
type Point = 'before-content-refs' | 'before-final' | 'before-tasks' | 'between-pages'
type Step = 'contentRefs' | 'final' | 'tasks'

/** A channel of MESSAGES messages whose last message carries `refId`. */
type Fixture = Readonly<{
  channelId: string
  marker: string
  refId: string
  /** Text and identifiers a denied response must not contain. */
  secrets: readonly string[]
}>

type World = Readonly<{
  group: Fixture
  members: Fixture & Readonly<{ projectId: string; taskId: string; taskRefId: string }>
  open: Fixture & Readonly<{ projectId: string }>
  owner: Session
  workspaceId: string
}>

const connectionUrl = process.env.DATABASE_URL
if (!connectionUrl) throw new Error('DATABASE_URL is required for the revocation matrix')

const run = randomBytes(6).toString('hex')
const future = () => new Date(Date.now() + 60 * 60 * 1000)
const FIRST_PAGE = 100
const MESSAGES = FIRST_PAGE + 1
const SCENARIO_TIMEOUT = 180_000
const POINTS: readonly Point[] = [
  'between-pages',
  'before-tasks',
  'before-content-refs',
  'before-final',
]
const STEP_FOR: Record<Exclude<Point, 'between-pages'>, Step> = {
  'before-content-refs': 'contentRefs',
  'before-final': 'final',
  'before-tasks': 'tasks',
}

let connection: DatabaseConnection
let world: World
const created: string[] = []

function resolutionFor(
  principal: WorkspacePrincipalResolution['principal']
): WorkspacePrincipalResolution {
  return { clearTemporaryCredential: false, principal, sessionRotated: false, temporary: true }
}

function exportRequest() {
  return new Request('http://localhost/api/v1/workspaces/x/portable-export')
}

/** Holds an export at `point` until released. Between pages, the point is the second page of `channelId`. */
function pauseAt(point: Point, channelId: string) {
  const reached = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const hooks: PortableExportHooks = {
    beforeMessagePage: async (page) => {
      if (
        point === 'between-pages' &&
        page.channelId === channelId &&
        page.afterSequence !== undefined
      ) {
        reached.resolve()
        await released.promise
      }
    },
    beforeStep: async (step) => {
      if (point !== 'between-pages' && step.name === STEP_FOR[point]) {
        reached.resolve()
        await released.promise
      }
    },
  }
  return { hooks, reached: reached.promise, release: () => released.resolve() }
}

/**
 * Starts the export through the GET handler, holds it at `point`, runs `revoke` on another
 * connection, resumes the export and returns its response.
 */
async function exportPaused(
  reader: Session,
  workspaceId: string,
  point: Point,
  channelId: string,
  revoke: () => Promise<unknown>
) {
  const pause = pauseAt(point, channelId)
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
      throw new Error(`the export finished without reaching ${point}`)
    }),
  ])
  try {
    await revoke()
  } finally {
    pause.release()
  }
  return exporting
}

/** A denied response is the unavailable body and nothing else, and it names no fixture record. */
async function expectDenied(response: Response, fixture: Fixture) {
  expect(response.status).toBe(404)
  const text = await response.text()
  expect(JSON.parse(text)).toEqual({
    code: 'workspace_unavailable',
    message: 'Workspace unavailable',
  })
  for (const secret of fixture.secrets) expect(text).not.toContain(secret)
}

async function bundleOf(response: Response) {
  expect(response.status).toBe(200)
  const text = await response.text()
  return { bundle: JSON.parse(text) as PortableWorkspaceExport, text }
}

function channelMessages(bundle: PortableWorkspaceExport, channelId: string) {
  return bundle.content.messages.filter((message) => message.channelId === channelId)
}

async function seedMessages(
  workspaceId: string,
  channelId: string,
  owner: Session,
  marker: string
): Promise<string> {
  let refId = ''
  for (let index = 0; index < MESSAGES; index += 1) {
    if (index < FIRST_PAGE) {
      await createMessage(connection.db, workspaceId, channelId, owner.principal, {
        bodyText: `${marker} message ${index}`,
        idempotencyKey: `${marker}-${index}`,
        sender: owner.principal,
      })
    } else {
      refId = await createReference(workspaceId, owner, 'message_body')
      await createMessage(connection.db, workspaceId, channelId, owner.principal, {
        bodyContentRefId: refId,
        idempotencyKey: `${marker}-${index}`,
        sender: owner.principal,
      })
    }
  }
  return refId
}

async function createReference(
  workspaceId: string,
  owner: Session,
  contentType: 'message_body' | 'task_objective'
): Promise<string> {
  const id = randomUUID()
  await createContentRef(connection.db, workspaceId, owner.principal, {
    availability: 'offline',
    contentType,
    digestSha256: 'a'.repeat(64),
    id,
    keyVersion: 1,
    schemaVersion: 1,
    sensitivity: 'sensitive',
    storagePolicy: 'local_authority',
    synchronizationPolicy: 'local_only',
  })
  return id
}

/** A workspace project with one channel of MESSAGES messages, for a fixture of its own. */
async function projectChannel(workspaceId: string, owner: Session, name: string) {
  const project = await createProject(connection.db, workspaceId, owner.principal, {
    iconKey: 'folder',
    name: `Matrix ${name} ${run}`,
  })
  const channel = await createProjectChannel(
    connection.db,
    workspaceId,
    project.id,
    owner.principal,
    { idempotencyKey: `matrix-${name}-channel-${run}`, title: `Matrix ${name}` }
  )
  const marker = `matrix-${name}-${run}`
  const refId = await seedMessages(workspaceId, channel.id, owner, marker)
  return {
    channelId: channel.id,
    marker,
    projectId: project.id,
    refId,
    secrets: [marker, channel.id, project.id, refId],
  }
}

/** A workspace member with no grant beyond the workspace. */
async function member(name: string): Promise<Session> {
  const reader = await createTemporaryUserSession(connection.db, {
    credentialDigest: `matrix-${name}-${run}`,
    displayName: 'Matrix Reader',
    expiresAt: future(),
  })
  await addWorkspaceMembership(connection.db, world.workspaceId, reader.principal, 'member')
  return reader
}

async function setParticipants(fixture: Fixture, change: (current: Participants) => Participants) {
  const channel = await getChannelForUser(
    connection.db,
    world.workspaceId,
    fixture.channelId,
    world.owner.principal
  )
  await setChannelParticipants(
    connection.db,
    world.workspaceId,
    fixture.channelId,
    world.owner.principal,
    change(channel.participants),
    channel.version
  )
}

function withoutReader(reader: Session) {
  return (current: Participants) =>
    current.filter(
      (participant) => participant.kind !== 'user' || participant.userId !== reader.principal.userId
    )
}

async function revokedFromGroup(kind: 'membership' | 'participant', point: Point) {
  const reader = await member(`${kind}-${point}`)
  await setParticipants(world.group, (current) => [
    ...current,
    { kind: 'user', userId: reader.principal.userId },
  ])
  try {
    const response = await exportPaused(
      reader,
      world.workspaceId,
      point,
      world.group.channelId,
      () =>
        kind === 'membership'
          ? removeWorkspaceMembership(connection.db, world.workspaceId, reader.principal)
          : setParticipants(world.group, withoutReader(reader))
    )
    await expectDenied(response, world.group)
    if (kind === 'membership')
      await expect(
        listChannelsForUser(connection.db, world.workspaceId, reader.principal)
      ).rejects.toThrow('Channel unavailable')
    else
      await expect(
        listMessagesForUser(
          connection.db,
          world.workspaceId,
          world.group.channelId,
          reader.principal
        )
      ).rejects.toThrow('Channel unavailable')
  } finally {
    // The group keeps only current members, so the next scenario joins a valid list.
    await setParticipants(world.group, withoutReader(reader))
  }
}

async function revokedFromMembersProject(point: Point) {
  const reader = await member(`grant-${point}`)
  const { members, owner, workspaceId } = world
  await setProjectMember(connection.db, workspaceId, members.projectId, owner.principal, {
    role: 'viewer',
    userId: reader.principal.userId,
  })
  const response = await exportPaused(reader, workspaceId, point, members.channelId, () =>
    removeProjectMember(
      connection.db,
      workspaceId,
      members.projectId,
      owner.principal,
      reader.principal.userId
    )
  )
  await expectDenied(response, members)
  await expect(
    listMessagesForUser(connection.db, workspaceId, members.channelId, reader.principal)
  ).rejects.toThrow('Channel unavailable')
  const visible = await listChannelsForUser(connection.db, workspaceId, reader.principal)
  expect(visible.map((channel) => channel.id)).not.toContain(members.channelId)
}

/** Hides the shared open project from a member it does not list, then restores its visibility. */
async function hiddenProject(point: Point) {
  const reader = await member(`hidden-${point}`)
  const { open, owner, workspaceId } = world
  try {
    const response = await exportPaused(reader, workspaceId, point, open.channelId, () =>
      setProjectVisibility(connection.db, workspaceId, open.projectId, owner.principal, 'members')
    )
    await expectDenied(response, open)
    await expect(
      listMessagesForUser(connection.db, workspaceId, open.channelId, reader.principal)
    ).rejects.toThrow('Channel unavailable')
  } finally {
    await setProjectVisibility(
      connection.db,
      workspaceId,
      open.projectId,
      owner.principal,
      'workspace'
    )
  }
}

/** Hides a channel of its own from a member it does not list: its visibility becomes participants-only. */
async function hiddenChannel(point: Point) {
  const { owner, workspaceId } = world
  const fixture = await projectChannel(workspaceId, owner, `hidden-channel-${point}`)
  const reader = await member(`hidden-channel-${point}`)
  const response = await exportPaused(reader, workspaceId, point, fixture.channelId, async () => {
    const channel = await getChannelForUser(
      connection.db,
      workspaceId,
      fixture.channelId,
      owner.principal
    )
    await updateChannel(
      connection.db,
      workspaceId,
      fixture.channelId,
      owner.principal,
      { visibility: 'participants' },
      channel.version
    )
  })
  await expectDenied(response, fixture)
  await expect(
    listMessagesForUser(connection.db, workspaceId, fixture.channelId, reader.principal)
  ).rejects.toThrow('Channel unavailable')
}

async function archivedChannel(point: Point) {
  const { owner, workspaceId } = world
  const fixture = await projectChannel(workspaceId, owner, `archived-channel-${point}`)
  const reader = await member(`archived-channel-${point}`)
  const response = await exportPaused(reader, workspaceId, point, fixture.channelId, async () => {
    const channel = await getChannelForUser(
      connection.db,
      workspaceId,
      fixture.channelId,
      owner.principal
    )
    await archiveChannel(
      connection.db,
      workspaceId,
      fixture.channelId,
      owner.principal,
      channel.version
    )
  })
  await expectDenied(response, fixture)
  const visible = await listChannelsForUser(connection.db, workspaceId, reader.principal)
  expect(visible.map((channel) => channel.id)).not.toContain(fixture.channelId)
}

async function archivedProject(point: Point) {
  const { owner, workspaceId } = world
  const fixture = await projectChannel(workspaceId, owner, `archived-project-${point}`)
  const reader = await member(`archived-project-${point}`)
  const response = await exportPaused(reader, workspaceId, point, fixture.channelId, () =>
    archiveProject(connection.db, workspaceId, fixture.projectId, owner.principal)
  )
  await expectDenied(response, fixture)
  const visible = await listChannelsForUser(connection.db, workspaceId, reader.principal)
  expect(visible.map((channel) => channel.id)).not.toContain(fixture.channelId)
}

beforeAll(async () => {
  connection = createDatabase(connectionUrl!)
  const owner = await createTemporaryUserSession(connection.db, {
    credentialDigest: `matrix-owner-${run}`,
    displayName: 'Matrix Owner',
    expiresAt: future(),
  })
  const { workspace } = await createWorkspaceWithOwner(connection.db, {
    idempotencyKey: `matrix-${run}`,
    name: 'Revocation matrix',
    owner: owner.principal,
  })
  created.push(workspace.id)
  const workspaceId = workspace.id

  const group = await createGroupChannel(connection.db, workspaceId, owner.principal, {
    idempotencyKey: `matrix-group-${run}`,
    title: 'Matrix group',
  })
  await setChannelParticipants(
    connection.db,
    workspaceId,
    group.id,
    owner.principal,
    [{ kind: 'user', userId: owner.principal.userId }],
    group.version
  )
  const groupMarker = `matrix-group-${run}`
  const groupRef = await seedMessages(workspaceId, group.id, owner, groupMarker)

  const members = await createProject(connection.db, workspaceId, owner.principal, {
    iconKey: 'folder',
    name: `Matrix members ${run}`,
  })
  await setProjectVisibility(connection.db, workspaceId, members.id, owner.principal, 'members')
  const membersChannel = await createProjectChannel(
    connection.db,
    workspaceId,
    members.id,
    owner.principal,
    { idempotencyKey: `matrix-members-channel-${run}`, title: 'Matrix members lane' }
  )
  const membersMarker = `matrix-members-${run}`
  const membersRef = await seedMessages(workspaceId, membersChannel.id, owner, membersMarker)
  const taskRefId = await createReference(workspaceId, owner, 'task_objective')
  const task = await createTask(
    connection.db,
    workspaceId,
    owner.principal,
    { objectiveContentRefId: taskRefId, projectId: members.id, title: `Matrix task ${run}` },
    { idempotencyKey: `matrix-task-${run}`, requestId: randomUUID() }
  )

  const open = await createProject(connection.db, workspaceId, owner.principal, {
    iconKey: 'folder',
    name: `Matrix open ${run}`,
  })
  await setProjectVisibility(connection.db, workspaceId, open.id, owner.principal, 'workspace')
  const openChannel = await createProjectChannel(
    connection.db,
    workspaceId,
    open.id,
    owner.principal,
    { idempotencyKey: `matrix-open-channel-${run}`, title: 'Matrix open lane' }
  )
  const openMarker = `matrix-open-${run}`
  const openRef = await seedMessages(workspaceId, openChannel.id, owner, openMarker)

  world = {
    group: {
      channelId: group.id,
      marker: groupMarker,
      refId: groupRef,
      secrets: [groupMarker, group.id, groupRef],
    },
    members: {
      channelId: membersChannel.id,
      marker: membersMarker,
      projectId: members.id,
      refId: membersRef,
      secrets: [membersMarker, membersChannel.id, members.id, membersRef, task.id, taskRefId],
      taskId: task.id,
      taskRefId,
    },
    open: {
      channelId: openChannel.id,
      marker: openMarker,
      projectId: open.id,
      refId: openRef,
      secrets: [openMarker, openChannel.id, open.id, openRef],
    },
    owner,
    workspaceId,
  }
}, 900_000)

afterAll(async () => {
  for (const workspaceId of created) {
    // Thread links and task rows go first, as in the database export tests.
    await connection.db
      .update(messages)
      .set({ replyToMessageId: null, threadRootMessageId: null })
      .where(eq(messages.workspaceId, workspaceId))
    await connection.db.delete(messages).where(eq(messages.workspaceId, workspaceId))
    await connection.db
      .delete(channelParticipants)
      .where(eq(channelParticipants.workspaceId, workspaceId))
    await connection.db.delete(channels).where(eq(channels.workspaceId, workspaceId))
    await connection.db
      .delete(taskExecutionAttempts)
      .where(eq(taskExecutionAttempts.workspaceId, workspaceId))
    await connection.db
      .delete(taskDependencies)
      .where(eq(taskDependencies.workspaceId, workspaceId))
    await connection.db.delete(tasks).where(eq(tasks.workspaceId, workspaceId))
    await connection.db.delete(contentRefs).where(eq(contentRefs.workspaceId, workspaceId))
    await connection.db.delete(projectMembers).where(eq(projectMembers.workspaceId, workspaceId))
    await connection.db.delete(projects).where(eq(projects.workspaceId, workspaceId))
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspaceId))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId))
  }
  await connection.close()
}, 300_000)

describe('revocation matrix: group membership and participation', () => {
  for (const point of POINTS) {
    test(
      `a workspace membership revoked ${point} denies the export`,
      async () => {
        await revokedFromGroup('membership', point)
      },
      SCENARIO_TIMEOUT
    )

    test(
      `a channel participant removed ${point} denies the export`,
      async () => {
        await revokedFromGroup('participant', point)
      },
      SCENARIO_TIMEOUT
    )
  }
})

describe('revocation matrix: members-only project grants', () => {
  for (const point of POINTS) {
    test(
      `a project grant removed ${point} denies the export`,
      async () => {
        await revokedFromMembersProject(point)
      },
      SCENARIO_TIMEOUT
    )
  }
})

describe('revocation matrix: project and channel visibility and lifecycle', () => {
  for (const point of ['between-pages', 'before-content-refs', 'before-final'] as const) {
    test(
      `a project hidden ${point} denies the export`,
      async () => {
        await hiddenProject(point)
      },
      SCENARIO_TIMEOUT
    )
  }
  for (const point of ['between-pages', 'before-final'] as const) {
    test(
      `a channel made participants-only ${point} denies the export`,
      async () => {
        await hiddenChannel(point)
      },
      SCENARIO_TIMEOUT
    )
    test(
      `a channel archived ${point} denies the export`,
      async () => {
        await archivedChannel(point)
      },
      SCENARIO_TIMEOUT
    )
  }
  for (const point of ['between-pages', 'before-content-refs'] as const) {
    test(
      `a project archived ${point} denies the export and its content references`,
      async () => {
        await archivedProject(point)
      },
      SCENARIO_TIMEOUT
    )
  }
})

describe('revocation matrix: controls and hidden references', () => {
  test(
    'control: unchanged group participation serves every message and the content reference',
    async () => {
      const reader = await member('control-group')
      await setParticipants(world.group, (current) => [
        ...current,
        { kind: 'user', userId: reader.principal.userId },
      ])
      try {
        const { bundle, text } = await bundleOf(
          await exportPaused(
            reader,
            world.workspaceId,
            'between-pages',
            world.group.channelId,
            async () => {}
          )
        )
        expect(channelMessages(bundle, world.group.channelId)).toHaveLength(MESSAGES)
        expect(text).toContain(world.group.refId)
      } finally {
        await setParticipants(world.group, withoutReader(reader))
      }
    },
    SCENARIO_TIMEOUT
  )

  test(
    'control: unchanged project grant serves every message, task and reference of the project',
    async () => {
      const reader = await member('control-grant')
      await setProjectMember(
        connection.db,
        world.workspaceId,
        world.members.projectId,
        world.owner.principal,
        {
          role: 'viewer',
          userId: reader.principal.userId,
        }
      )
      const { bundle, text } = await bundleOf(
        await exportPaused(
          reader,
          world.workspaceId,
          'between-pages',
          world.members.channelId,
          async () => {}
        )
      )
      expect(channelMessages(bundle, world.members.channelId)).toHaveLength(MESSAGES)
      for (const secret of world.members.secrets) expect(text).toContain(secret)
    },
    SCENARIO_TIMEOUT
  )

  test(
    'a member neither listed on the members-only project nor a participant receives none of their records or references',
    async () => {
      const outsider = await member('outsider')
      const response = await portableWorkspaceExportResponse(
        exportRequest(),
        connection.db,
        resolutionFor(outsider.principal),
        world.workspaceId
      )
      const { bundle, text } = await bundleOf(response)
      expect(channelMessages(bundle, world.open.channelId)).toHaveLength(MESSAGES)
      expect(text).toContain(world.open.refId)
      for (const secret of [...world.members.secrets, ...world.group.secrets])
        expect(text).not.toContain(secret)
    },
    SCENARIO_TIMEOUT
  )
})
