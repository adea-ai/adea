import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createGroupChannel } from '../../src/conversations'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import { completeTaskFromRequest } from '../../src/task-completion-request'
import { getTaskForUser, createTask } from '../../src/tasks'
import { taskMutations } from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

/**
 * The completion request path on real data (#1217). The HTTP route resolves the caller
 * and maps the outcome; everything that decides whether a completion takes effect is
 * here. An invalid outbound result must leave the task and its idempotency reservation
 * untouched. A valid one that cannot be published must complete nothing.
 */

const url = process.env.DATABASE_URL
const ARTIFACT = '00000000-0000-4000-8000-0000000000a1'
const CHANNEL = '00000000-0000-4000-8000-0000000000c1'

describe.skipIf(!url)('task completion through the request path, on real data', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(url!)
  })
  afterAll(() => connection.close())

  async function fixture() {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Completion workspace',
      owner: owner.principal,
    })
    const task = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      { objective: 'Completion objective', title: 'Completion task' },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
    const channel = await createGroupChannel(connection.db, workspace.id, owner.principal, {
      idempotencyKey: crypto.randomUUID(),
      title: 'Results',
    })
    return { channel, owner, task, workspace }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>

  function complete(f: Fixture, body: Record<string, unknown>, idempotencyKey: string) {
    return completeTaskFromRequest({
      body,
      command: {
        expectedVersion: f.task.version,
        idempotencyKey,
        requestId: crypto.randomUUID(),
      },
      database: connection.db,
      principal: f.owner.principal,
      taskId: f.task.id,
      workspaceId: f.workspace.id,
    })
  }

  /** The Task as stored, to prove what a refused call left unchanged. */
  async function storedTask(f: Fixture) {
    return getTaskForUser(connection.db, f.workspace.id, f.task.id, f.owner.principal)
  }

  /** Completion reservations under one key. A refused call leaves none. */
  async function reservations(f: Fixture, idempotencyKey: string) {
    return connection.db
      .select({ id: taskMutations.id })
      .from(taskMutations)
      .where(eq(taskMutations.idempotencyKey, idempotencyKey))
  }

  test('a completion without an outbound result completes the task and reports no publication', async () => {
    const f = await fixture()
    const outcome = await complete(f, {}, crypto.randomUUID())
    expect(outcome.kind).toBe('completed')
    if (outcome.kind !== 'completed') throw new Error('expected a completion')
    expect(outcome.task.lifecycleState).toBe('completed')
    expect(outcome).not.toHaveProperty('outboundPublication')
  })

  test('each malformed outbound result is refused before any effect: the task and its reservation are untouched', async () => {
    const malformed: unknown[] = [
      { channelId: CHANNEL, summary: 'Summary.', extra: true },
      { channelId: 'not-a-uuid', summary: 'Summary.' },
      { channelId: CHANNEL, summary: 42 },
      { channelId: CHANNEL, summary: 'Summary.', artifactPolicy: 'always' },
      { channelId: CHANNEL, summary: 'Summary.', artifact: { artifactId: ARTIFACT } },
      'not-an-object',
    ]
    const f = await fixture()
    const before = await storedTask(f)
    for (const outboundResult of malformed) {
      const key = crypto.randomUUID()
      expect(await complete(f, { outboundResult }, key)).toEqual({ kind: 'invalid' })
      expect(await reservations(f, key)).toEqual([])
    }
    expect(await storedTask(f)).toEqual(before)
  })

  test('a valid outbound result that names an unregistered artifact completes nothing', async () => {
    const f = await fixture()
    const before = await storedTask(f)
    const key = crypto.randomUUID()
    await expect(
      complete(
        f,
        {
          outboundResult: {
            artifact: { artifactId: ARTIFACT, grantId: 'grant-missing' },
            channelId: f.channel.id,
            summary: 'Never published.',
          },
        },
        key
      )
    ).rejects.toThrow('Artifact grant unavailable')
    expect(await reservations(f, key)).toEqual([])
    expect(await storedTask(f)).toEqual(before)
  })
})
