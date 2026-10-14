import { expect, test } from '@playwright/test'
import { eq, inArray, sql } from 'drizzle-orm'

import { createAgent } from '../../../packages/db/src/agents'
import { createDatabase, type DatabaseConnection } from '../../../packages/db/src/connection'
import {
  agents,
  authorizationAuditRecords,
  channelParticipants,
  channels,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
  temporaryUserSessions,
  users,
} from '../../../packages/db/src/schema'

// ---------------------------------------------------------------------------
// Coverage class: actual-authentication browser coverage (no route mocks).
//
// Pi Durable REQ 060: two deliberate "New conversation" actions with the same
// Agent produce two distinct, independently listed conversations, next to the
// Agent's default lane. Fixtures are created through @adea-ai/db and deleted in
// afterAll; a missing database fails the lane.
// ---------------------------------------------------------------------------

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable'

test.describe('several conversations with one Agent', () => {
  let connection: DatabaseConnection
  const workspaceIds: string[] = []
  const userIds: string[] = []

  test.beforeAll(async () => {
    connection = createDatabase(databaseUrl)
    try {
      await connection.db.execute(sql`select 1`)
    } catch {
      await connection.close().catch(() => undefined)
      throw new Error(
        'The agent topics lane requires the restricted local Postgres: run it through `bun run test:e2e` (which starts the compose Postgres or requires DATABASE_URL). It never skips.'
      )
    }
  })

  test.afterAll(async () => {
    const db = connection.db
    if (workspaceIds.length) {
      await db
        .delete(authorizationAuditRecords)
        .where(inArray(authorizationAuditRecords.workspaceId, workspaceIds))
      await db
        .delete(channelParticipants)
        .where(inArray(channelParticipants.workspaceId, workspaceIds))
      await db.delete(channels).where(inArray(channels.workspaceId, workspaceIds))
      await db.delete(agents).where(inArray(agents.workspaceId, workspaceIds))
      await db.delete(workspaceEvents).where(inArray(workspaceEvents.workspaceId, workspaceIds))
      await db
        .delete(workspaceMemberships)
        .where(inArray(workspaceMemberships.workspaceId, workspaceIds))
      await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds))
    }
    for (const userId of userIds) {
      await db.delete(temporaryUserSessions).where(eq(temporaryUserSessions.userId, userId))
      await db.delete(users).where(eq(users.id, userId))
    }
    await connection.close()
  })

  test('New conversation starts a distinct named topic beside the default lane', async ({
    page,
    context,
  }) => {
    test.slow()
    const response = await context.request.post('/api/workspaces/bootstrap')
    expect(response.status()).toBe(200)
    const payload = (await response.json()) as {
      principal: { userId: string }
      workspaces: { id: string }[]
    }
    const homeWorkspaceId = payload.workspaces[0]?.id
    if (!homeWorkspaceId) throw new Error('The bootstrap returned no workspace')
    for (const workspace of payload.workspaces) workspaceIds.push(workspace.id)
    userIds.push(payload.principal.userId)
    await createAgent(
      connection.db,
      homeWorkspaceId,
      { kind: 'user', userId: payload.principal.userId },
      {
        name: 'Topic Research Agent',
        profileId: `prf_${'0'.repeat(25)}1`,
        profileVersion: `pfv_${'0'.repeat(25)}1`,
      }
    )

    await page.goto('/')
    await expect(page.getByRole('button', { name: 'User settings' })).toBeVisible({
      timeout: 20_000,
    })
    await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
    const card = page
      .locator('article')
      .filter({
        has: page.getByRole('heading', { level: 2, name: 'Topic Research Agent', exact: true }),
      })
      .first()
    const conversations = page.getByRole('region', { name: 'Conversations' })

    // The default lane is a separate shortcut and keeps the Agent's plain name.
    await card.getByRole('button', { name: 'Open conversation' }).click()
    await expect(
      conversations.getByRole('button', { name: 'Topic Research Agent', exact: true })
    ).toBeVisible()

    // Two deliberate actions, two conversations, each labelled by its topic.
    for (const topic of ['Q4 planning', 'Launch review']) {
      await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
      await card.getByRole('button', { name: 'New conversation' }).click()
      await card.getByLabel('Topic for Topic Research Agent').fill(topic)
      await card.getByRole('button', { name: 'Start conversation' }).click()
      await expect(
        conversations.getByRole('button', { name: `Topic Research Agent · ${topic}`, exact: true })
      ).toBeVisible()
    }
    await expect(
      conversations.getByRole('button', { name: 'Topic Research Agent', exact: true })
    ).toBeVisible()
  })
})
