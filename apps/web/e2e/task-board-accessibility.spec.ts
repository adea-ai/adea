import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'

import { createGroupChannel, createMessage } from '../../../packages/db/src/conversations'
import { createDatabase, type DatabaseConnection } from '../../../packages/db/src/connection'
import { createTask } from '../../../packages/db/src/tasks'
import {
  agents,
  authorizationAuditRecords,
  channelParticipants,
  channelReadStates,
  channels,
  messageMentions,
  messages,
  projects,
  tasks,
  temporaryUserSessions,
  threadReadStates,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../../packages/db/src/schema'

// ---------------------------------------------------------------------------
// Coverage class: modal-close accessibility state. The task sheet is a modal
// dialog: while it is open the workspace frame is aria-hidden, and closing it
// must restore the frame before the panel unmounts. The captured failure trace
// for the intermittent missing "Task board" region showed the board present in
// the DOM (role="region", aria-label="Task board") while the workspace frame
// still carried aria-hidden="true" and the body kept pointer-events:none — so
// the role query found nothing even though the board was visually rendered.
// This lane repeats the open/close cycle and asserts the route, portal
// cleanup, ancestor aria state and the accessible snapshot after every close.
// ---------------------------------------------------------------------------

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable'

type Principal = { kind: 'user'; userId: string }
type SignInSession = Readonly<{ homeWorkspaceId: string; principal: Principal }>

const TASK_TITLE = 'Browser UI Accessibility Keep Visible'

async function openSignedInApp(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'User settings' })).toBeVisible({
    timeout: 20_000,
  })
}

test.describe('the task board stays in the accessibility tree across sheet closes', () => {
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
        'The task board accessibility lane requires the restricted local Postgres: run it through `bun run test:e2e` (which starts the compose Postgres or requires DATABASE_URL). It never skips.'
      )
    }
  })

  test.afterAll(async () => {
    const db = connection.db
    if (workspaceIds.length) {
      await db
        .delete(authorizationAuditRecords)
        .where(inArray(authorizationAuditRecords.workspaceId, workspaceIds))
      await db.delete(threadReadStates).where(inArray(threadReadStates.workspaceId, workspaceIds))
      await db.delete(channelReadStates).where(inArray(channelReadStates.workspaceId, workspaceIds))
      await db.delete(messageMentions).where(inArray(messageMentions.workspaceId, workspaceIds))
      await db
        .delete(messages)
        .where(
          and(inArray(messages.workspaceId, workspaceIds), isNotNull(messages.threadRootMessageId))
        )
      await db.delete(messages).where(inArray(messages.workspaceId, workspaceIds))
      await db
        .delete(channelParticipants)
        .where(inArray(channelParticipants.workspaceId, workspaceIds))
      await db.delete(channels).where(inArray(channels.workspaceId, workspaceIds))
      await db.delete(tasks).where(inArray(tasks.workspaceId, workspaceIds))
      await db.delete(agents).where(inArray(agents.workspaceId, workspaceIds))
      await db.delete(projects).where(inArray(projects.workspaceId, workspaceIds))
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

  async function signIn(context: BrowserContext): Promise<SignInSession> {
    const response = await context.request.post('/api/workspaces/bootstrap')
    expect(response.status()).toBe(200)
    const payload = (await response.json()) as {
      principal: { temporary: boolean; userId: string }
      workspaces: { id: string }[]
    }
    const homeWorkspaceId = payload.workspaces[0]?.id
    if (!homeWorkspaceId)
      throw new Error('The account bootstrap returned no workspace for the new account')
    for (const workspace of payload.workspaces) workspaceIds.push(workspace.id)
    userIds.push(payload.principal.userId)
    return { homeWorkspaceId, principal: { kind: 'user', userId: payload.principal.userId } }
  }

  async function seedConversation(workspaceId: string, owner: Principal, title: string) {
    return createGroupChannel(connection.db, workspaceId, owner, {
      idempotencyKey: `board-accessibility-${crypto.randomUUID()}`,
      title,
    })
  }

  async function seedMessage(
    workspaceId: string,
    channelId: string,
    sender: Principal,
    bodyText: string,
    taskId?: string
  ): Promise<void> {
    await createMessage(connection.db, workspaceId, channelId, sender, {
      bodyText,
      idempotencyKey: crypto.randomUUID(),
      sender,
      ...(taskId ? { taskId } : {}),
    })
  }

  async function seedTask(workspaceId: string, owner: Principal, title: string) {
    return createTask(
      connection.db,
      workspaceId,
      owner,
      { objective: `Objective for ${title}`, title },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
  }

  test('every sheet close restores the board to the accessibility tree', async ({
    page,
    context,
  }) => {
    test.slow()
    const { homeWorkspaceId, principal: owner } = await signIn(context)
    const conversation = await seedConversation(homeWorkspaceId, owner, 'Board Accessibility Lane')
    const task = await seedTask(homeWorkspaceId, owner, TASK_TITLE)
    await seedMessage(homeWorkspaceId, conversation.id, owner, 'Accessibility anchor.', task.id)

    await openSignedInApp(page)
    await page.getByRole('button', { name: 'Global conversation inbox' }).click()
    const row = page.getByRole('button', { name: /Board Accessibility Lane/ })
    await expect(row).toBeVisible()
    await row.click()
    await expect(page.getByRole('textbox', { name: 'Message' }).first()).toBeVisible()

    await page.getByRole('button', { name: `Task · ${TASK_TITLE}` }).click()
    await expect(page).toHaveURL(/app=kanban/)
    const board = page.locator('.conventional-workspace--board')
    await expect(board).toBeVisible()
    const taskSheet = page.getByRole('dialog', { name: 'Edit task' })
    await expect(taskSheet).toBeVisible()
    const railKanban = page
      .getByRole('navigation', { name: 'Global navigation' })
      .getByRole('button', { name: 'Kanban', exact: true })
    // Modal state: while the sheet is open the frame is intentionally out of
    // the accessibility tree, so only CSS locators can see the board. The
    // close must restore it — that is what assertAccessibleBoard pins below.
    await expect
      .poll(async () => page.locator('.workspace-frame').getAttribute('aria-hidden'))
      .toBe('true')

    const assertAccessibleBoard = async () => {
      // The exact accessible lookup the linked-job flow uses: never weakened.
      await expect(page.getByRole('region', { name: 'Task board', exact: true })).toBeVisible()
      await expect(board).toBeVisible()

      const state = await page.evaluate(() => {
        const frame = document.querySelector('.workspace-frame')
        const boardElement = document.querySelector('.conventional-workspace--board')
        const hiddenAncestor = boardElement?.closest('[aria-hidden="true"], [inert]') ?? null
        return {
          frameAriaHidden: frame?.getAttribute('aria-hidden') ?? null,
          frameInert: frame ? frame.hasAttribute('inert') : null,
          hiddenAncestor: hiddenAncestor
            ? `${hiddenAncestor.tagName}.${hiddenAncestor.className}`.slice(0, 120)
            : null,
          bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
          dialogs: document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length,
          url: location.href,
        }
      })
      expect(state.frameAriaHidden).toBeNull()
      expect(state.frameInert).toBe(false)
      expect(state.hiddenAncestor).toBeNull()
      expect(state.bodyPointerEvents).not.toBe('none')
      expect(state.dialogs).toBe(0)
      expect(state.url).toContain('app=kanban')
      await expect(railKanban).toHaveAttribute('aria-pressed', 'true')

      // The accessible tree (not just the CSS) must expose the region.
      const snapshot = await page.locator('.workspace-frame').ariaSnapshot()
      expect(snapshot).toContain('region "Task board"')
    }

    await expect(taskSheet).toBeVisible()
    await taskSheet.getByRole('button', { name: 'Close task' }).click()
    await expect(taskSheet).toHaveCount(0)
    await assertAccessibleBoard()

    // Stress the close lifecycle: each reopen/close cycle must restore the
    // frame before the panel unmounts.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await page.getByRole('button', { name: TASK_TITLE }).click()
      await expect(taskSheet).toBeVisible()
      await taskSheet.getByRole('button', { name: 'Close task' }).click()
      await expect(taskSheet).toHaveCount(0)
      await assertAccessibleBoard()
    }
  })
})
