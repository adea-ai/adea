import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'

import {
  changeAgentProfile,
  createAgent,
  updateAgentPresentation,
} from '../../../packages/db/src/agents'
import {
  archiveChannel,
  createGroupChannel,
  createMessage,
  setChannelParticipants,
  updateChannel,
} from '../../../packages/db/src/conversations'
import { createDatabase, type DatabaseConnection } from '../../../packages/db/src/connection'
import { createTemporaryUserSession } from '../../../packages/db/src/identity'
import { createTask } from '../../../packages/db/src/tasks'
import {
  addWorkspaceMembership,
  createWorkspaceWithOwner,
} from '../../../packages/db/src/workspaces'
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
// Coverage class: actual-authentication browser coverage, UI-operating.
//
// Its sibling (account-directory-auth.spec.ts) fetches the account routes FROM
// the page, proving the cookie jar and server authorization. This spec does
// what that lane cannot: it uses the account-wide results embedded in the
// existing Agents and Conversations surfaces, checks workspace switches and
// legacy URL normalization, follows a conversation to its linked job and back,
// and watches unread state converge after reconnecting.
//
// Fixtures follow the same restricted-Postgres pattern: rows are created
// through the @adea-ai/db domain functions and deleted again in afterAll,
// which runs on success AND failure. A missing or unreachable database fails
// the lane; nothing skips. `page.route` is never used — requests are real.
// ---------------------------------------------------------------------------

// Same fallback contract as playwright.config.ts: CI provides DATABASE_URL;
// local shells fall back to the compose Postgres that `bun run test:e2e`
// starts (scripts/e2e-setup.mjs).
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable'

type Principal = { kind: 'user'; userId: string }
type SignInSession = Readonly<{ homeWorkspaceId: string; principal: Principal }>

async function openSignedInApp(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'User settings' })).toBeVisible({
    timeout: 20_000,
  })
}

test.describe('the account directory and inbox driven through their UI', () => {
  // The lane runs with one worker (playwright.config.ts); these tests share
  // one database connection and one tracked fixture set.
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
        'The account directory UI lane requires the restricted local Postgres: run it through `bun run test:e2e` (which starts the compose Postgres or requires DATABASE_URL). It never skips.'
      )
    }
  })

  test.afterAll(async () => {
    // Mirror the auth spec's FK-ordered teardown. Tasks delete before their
    // agents and projects (set null there, cascade on the task's own children
    // — taskMutations, taskDependencies, taskExecutionAttempts); messages and
    // channels go first because they reference both.
    const db = connection.db
    if (workspaceIds.length) {
      await db
        .delete(authorizationAuditRecords)
        .where(inArray(authorizationAuditRecords.workspaceId, workspaceIds))
      await db.delete(threadReadStates).where(inArray(threadReadStates.workspaceId, workspaceIds))
      await db.delete(channelReadStates).where(inArray(channelReadStates.workspaceId, workspaceIds))
      await db.delete(messageMentions).where(inArray(messageMentions.workspaceId, workspaceIds))
      // Replies reference their roots; drop them first.
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
      // project_members cascade with their projects.
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

  /**
   * Real sign-in through the app's own bootstrap: the server mints the
   * temporary session row and HttpOnly cookie, and answers with the personal
   * "Home" workspace every fresh account starts in. Fixtures seed into that
   * workspace so opening one of their rows never depends on a mid-flight
   * workspace switch — the surface stays the thing under test.
   */
  async function signIn(context: BrowserContext): Promise<SignInSession> {
    const response = await context.request.post('/api/workspaces/bootstrap')
    expect(response.status()).toBe(200)
    const payload = (await response.json()) as {
      principal: { temporary: boolean; userId: string }
      sessionRotated: boolean
      workspaces: { id: string }[]
    }
    expect(payload.principal.temporary).toBe(true)
    expect(payload.sessionRotated).toBe(false)
    const homeWorkspaceId = payload.workspaces[0]?.id
    if (!homeWorkspaceId)
      throw new Error('The account bootstrap returned no workspace for the new account')
    for (const workspace of payload.workspaces) workspaceIds.push(workspace.id)
    const cookies = await context.cookies()
    expect(
      cookies.some((cookie) => cookie.httpOnly && cookie.name === 'agent_hq_temporary_session')
    ).toBe(true)
    const principal: Principal = { kind: 'user', userId: payload.principal.userId }
    userIds.push(principal.userId)
    return { homeWorkspaceId, principal }
  }

  /** A participant that never signs in; used to generate unread activity. */
  async function backgroundUser(label: string): Promise<Principal> {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: `browser-ui-${label}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 300_000),
    })
    userIds.push(session.principal.userId)
    return session.principal
  }

  async function seedAgent(workspaceId: string, owner: Principal, name: string) {
    return createAgent(connection.db, workspaceId, owner, {
      name,
      profileId: `prf_${'0'.repeat(25)}1`,
      profileVersion: `pfv_${'0'.repeat(25)}1`,
    })
  }

  async function seedWorkspace(owner: Principal, name: string): Promise<string> {
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `browser-${crypto.randomUUID()}`,
      name,
      owner,
    })
    workspaceIds.push(workspace.id)
    return workspace.id
  }

  async function seedConversation(
    workspaceId: string,
    owner: Principal,
    title: string,
    participants: readonly Principal[] = []
  ) {
    const channel = await createGroupChannel(connection.db, workspaceId, owner, {
      idempotencyKey: `browser-ui-${crypto.randomUUID()}`,
      title,
    })
    if (participants.length)
      await setChannelParticipants(
        connection.db,
        workspaceId,
        channel.id,
        owner,
        participants.map((participant) => ({ kind: 'user' as const, userId: participant.userId })),
        channel.version
      )
    return channel
  }

  async function seedMessage(
    workspaceId: string,
    channelId: string,
    sender: Principal,
    bodyText = 'browser fixture',
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

  /** Archive the group channel at its CURRENT version (posting does not bump it). */
  async function archiveConversation(workspaceId: string, channelId: string, owner: Principal) {
    const [current] = await connection.db
      .select({ version: channels.version })
      .from(channels)
      .where(eq(channels.id, channelId))
    expect(current).toBeDefined()
    await archiveChannel(connection.db, workspaceId, channelId, owner, current!.version)
  }

  test('search is answered by the server and the archive toggle scopes the lists', async ({
    page,
    context,
  }) => {
    test.slow()
    const { homeWorkspaceId, principal: owner } = await signIn(context)
    const teamWorkspaceId = await seedWorkspace(owner, 'Browser UI Team Workspace')
    await seedAgent(teamWorkspaceId, owner, 'Browser UI Studio Alpha')
    await seedAgent(teamWorkspaceId, owner, 'Browser UI Studio Beta')
    await seedAgent(teamWorkspaceId, owner, 'Browser UI Garden Helper')
    await seedAgent(homeWorkspaceId, owner, 'Browser UI Studio Home Agent')
    await seedAgent(homeWorkspaceId, owner, 'Browser UI Home Garden Agent')
    const studioLane = await seedConversation(teamWorkspaceId, owner, 'Browser UI Studio Sync')
    const gardenLane = await seedConversation(teamWorkspaceId, owner, 'Browser UI Garden Club')
    const retiredLane = await seedConversation(teamWorkspaceId, owner, 'Browser UI Retired Lane')
    const homeStudioLane = await seedConversation(homeWorkspaceId, owner, 'Browser UI Studio Home')
    const homeRetiredLane = await seedConversation(
      homeWorkspaceId,
      owner,
      'Browser UI Home Retired Lane'
    )
    const localLane = await seedConversation(homeWorkspaceId, owner, 'Browser UI Local Filter Lane')
    await seedMessage(teamWorkspaceId, studioLane.id, owner)
    await seedMessage(teamWorkspaceId, gardenLane.id, owner)
    await seedMessage(teamWorkspaceId, retiredLane.id, owner)
    await seedMessage(homeWorkspaceId, homeStudioLane.id, owner)
    await seedMessage(homeWorkspaceId, homeRetiredLane.id, owner)
    await seedMessage(homeWorkspaceId, localLane.id, owner)
    await archiveConversation(teamWorkspaceId, retiredLane.id, owner)
    await archiveConversation(homeWorkspaceId, homeRetiredLane.id, owner)

    await openSignedInApp(page)

    await expect(page.getByRole('button', { name: 'Global Agents directory' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Global conversation inbox' })).toHaveCount(0)
    const conversationsSection = page.getByRole('region', { name: 'Conversations' })
    await expect(conversationsSection).toBeVisible()
    await expect(
      conversationsSection.getByRole('button', {
        name: 'Browser UI Local Filter Lane',
        exact: true,
      })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: /Browser UI Studio Sync/ })).toBeVisible()

    await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
    await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible()

    // One server-searched list includes current and other workspaces. Current
    // active identities keep their existing editable Agent cards.
    const agentSearch = page.getByRole('searchbox', { name: 'Search Agents across workspaces' })
    const studioAnswers = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/account/agents') && response.url().includes('q=studio')
    )
    await agentSearch.fill('studio')
    await studioAnswers
    await expect(
      page.getByRole('button', {
        name: /Open Browser UI Studio Alpha in Browser UI Team Workspace/,
      })
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: /Open Browser UI Studio Beta in Browser UI Team Workspace/ })
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { level: 2, name: 'Browser UI Studio Home Agent' })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: /Open Browser UI Garden Helper/ })).toHaveCount(0)
    await expect(
      page.getByRole('heading', { level: 2, name: 'Browser UI Home Garden Agent' })
    ).toHaveCount(0)

    // Clearing the box restores the full walk; a term nothing matches lands
    // on the search empty state, not on a stale list.
    await agentSearch.fill('')
    await expect(page.getByRole('button', { name: /Open Browser UI Garden Helper/ })).toBeVisible()
    const emptyAgentAnswers = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/account/agents') &&
        response.url().includes('q=no-such-agent-zzz')
    )
    await agentSearch.fill('no-such-agent-zzz')
    await emptyAgentAnswers
    await expect(agentSearch).toHaveValue('no-such-agent-zzz')
    await expect(page.getByText('No authorized Agent name matches this search.')).toBeVisible()
    await agentSearch.fill('')

    // The same account query drives current and other workspace rows.
    const studioRow = page.getByRole('button', { name: /Browser UI Studio Sync/ })
    await expect(studioRow).toBeVisible()
    await expect(
      conversationsSection.getByRole('button', {
        name: 'Browser UI Studio Home',
        exact: true,
      })
    ).toBeVisible()
    await expect(
      conversationsSection.getByRole('button', {
        name: 'Browser UI Local Filter Lane',
        exact: true,
      })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: /Browser UI Retired Lane/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Browser UI Home Retired Lane/ })).toHaveCount(0)

    const archivedAnswers = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/account/conversations') &&
        response.url().includes('includeArchived=true')
    )
    const includeArchived = conversationsSection.getByRole('button', {
      name: 'Archived',
      exact: true,
    })
    await includeArchived.click()
    await archivedAnswers
    await expect(includeArchived).toHaveAttribute('aria-pressed', 'true')
    const retiredRow = page.getByRole('button', { name: /Browser UI Retired Lane/ })
    await expect(retiredRow).toBeVisible()
    await expect(retiredRow).toHaveAccessibleName(/archived/)
    await expect(retiredRow.getByText('Archived')).toBeVisible()
    const homeRetiredRow = page.getByRole('button', { name: /Browser UI Home Retired Lane/ })
    await expect(homeRetiredRow).toBeVisible()
    await expect(homeRetiredRow).toHaveAccessibleName(/archived/)

    // Searching while the archive scope is on still goes to the server.
    const inboxSearch = conversationsSection.getByRole('searchbox', {
      name: 'Search conversations across workspaces',
    })
    const titleAnswers = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/account/conversations') &&
        response.url().includes('q=studio')
    )
    await inboxSearch.fill('studio')
    await titleAnswers
    await expect(studioRow).toBeVisible()
    await expect(
      conversationsSection.getByRole('button', {
        name: 'Browser UI Studio Home',
        exact: true,
      })
    ).toBeVisible()
    await expect(
      conversationsSection.getByRole('button', {
        name: 'Browser UI Local Filter Lane',
        exact: true,
      })
    ).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Browser UI Garden Club/ })).toHaveCount(0)
    await inboxSearch.fill('')
    await expect(page.getByRole('button', { name: /Browser UI Garden Club/ })).toBeVisible()
    await expect(retiredRow).toBeVisible()

    // A legacy link opens the same canonical Agents surface and is replaced;
    // it can no longer mount the removed standalone page.
    await page.goto('/?directory=agents')
    await expect(page).not.toHaveURL(/directory=/)
    await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible()
  })

  test('account lists preserve loaded pages, focus, and same-ID local updates', async ({
    page,
    context,
  }) => {
    test.slow()
    const { homeWorkspaceId, principal: owner } = await signIn(context)
    const agentFixtures = []
    const conversationFixtures = []
    for (let index = 0; index < 26; index += 1) {
      const suffix = String(index).padStart(2, '0')
      agentFixtures.push(
        await seedAgent(homeWorkspaceId, owner, `Browser UI Reactivity Agent ${suffix}`)
      )
      conversationFixtures.push(
        await seedConversation(homeWorkspaceId, owner, `Browser UI Reactivity Group ${suffix}`)
      )
    }

    await openSignedInApp(page)

    const conversationsSection = page.getByRole('region', { name: 'Conversations' })
    await expect(conversationsSection.getByText('Across your workspaces')).toBeVisible()
    const inboxSearch = conversationsSection.getByRole('searchbox', {
      name: 'Search conversations across workspaces',
    })
    const loadMoreConversations = conversationsSection.getByRole('button', {
      name: 'Load more conversations',
    })
    await expect(loadMoreConversations).toBeVisible()
    const inboxPageTwoResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/v1/account/conversations' && url.searchParams.has('after')
    })
    await loadMoreConversations.click()
    const inboxPageTwo = (await (await inboxPageTwoResponse).json()) as {
      conversations: { id: string; title: string }[]
    }
    expect(inboxPageTwo.conversations).toHaveLength(1)
    const pageTwoConversation = inboxPageTwo.conversations[0]!
    await expect(
      conversationsSection.getByRole('button', { name: pageTwoConversation.title, exact: true })
    ).toBeVisible()

    await inboxSearch.focus()
    const channelToUpdate = conversationFixtures.at(-1)!
    const updatedChannel = await updateChannel(
      connection.db,
      homeWorkspaceId,
      channelToUpdate.id,
      owner,
      { title: 'Browser UI Reactivity Group Updated' },
      channelToUpdate.version
    )
    await expect(
      conversationsSection.getByRole('button', { name: updatedChannel.title, exact: true })
    ).toBeVisible()
    await expect(inboxSearch).toBeFocused()
    await expect(
      conversationsSection.getByRole('button', { name: pageTwoConversation.title, exact: true })
    ).toBeVisible()

    await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
    const agentSearch = page.getByRole('searchbox', { name: 'Search Agents across workspaces' })
    const loadMoreAgents = page.getByRole('button', { name: 'Load more Agents' })
    await expect(loadMoreAgents).toBeVisible()
    const agentPageTwoResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/v1/account/agents' && url.searchParams.has('after')
    })
    await loadMoreAgents.click()
    const initialAgentPageTwoResponse = await agentPageTwoResponse
    const initialAgentPageTwoUrl = new URL(initialAgentPageTwoResponse.url())
    const initialAgentPageTwo = (await initialAgentPageTwoResponse.json()) as {
      agents: { id: string; name: string }[]
    }
    const initialPageTwoCursor = initialAgentPageTwoUrl.searchParams.get('after')
    const pageTwoAgent = initialAgentPageTwo.agents.find(
      ({ name }) => name === agentFixtures.at(-1)!.name
    )!
    expect(pageTwoAgent).toBeDefined()
    await expect(page.getByRole('heading', { level: 2, name: pageTwoAgent.name })).toBeVisible()

    await agentSearch.focus()
    const agentToUpdate = agentFixtures[0]!
    const profileId = `prf_${'0'.repeat(25)}2`
    const profileVersion = `pfv_${'0'.repeat(25)}2`
    await changeAgentProfile(connection.db, homeWorkspaceId, agentToUpdate.id, owner, {
      expectedRevision: agentToUpdate.profile.revision,
      profileId,
      profileVersion,
    })
    const updatedAgent = await updateAgentPresentation(
      connection.db,
      homeWorkspaceId,
      agentToUpdate.id,
      owner,
      {
        expectedRevision: agentToUpdate.revision,
        roleSummary: 'Local same-ID update reached the mounted roster.',
      }
    )
    await expect(page.getByText('Local same-ID update reached the mounted roster.')).toBeVisible()
    await expect(page.getByText(`${profileId} · ${profileVersion}`, { exact: true })).toBeVisible()
    await expect(agentSearch).toBeFocused()
    await expect(page.getByRole('heading', { level: 2, name: pageTwoAgent.name })).toBeVisible()

    const updatedAgentCard = page
      .locator('article')
      .filter({
        has: page.getByRole('heading', { level: 2, name: agentToUpdate.name, exact: true }),
      })
      .first()
    await updatedAgentCard.getByRole('button', { name: 'Customize', exact: true }).click()
    const customization = page.locator('form.conventional-agent-customization')
    await expect(customization.getByLabel('Profile version ID')).toHaveValue(profileVersion)
    await customization
      .getByLabel('Role or persona')
      .fill('Customize submits the refreshed Agent revision.')
    const presentationUpdate = page.waitForRequest(
      (request) => request.method() === 'PATCH' && request.url().endsWith('/presentation')
    )
    await customization.getByRole('button', { name: 'Save changes' }).click()
    expect((await presentationUpdate).postDataJSON()).toMatchObject({
      expectedRevision: updatedAgent.revision,
      roleSummary: 'Customize submits the refreshed Agent revision.',
    })

    // Renaming the last Agent on page one of the next 25 into the first 25
    // shifts the keyset boundary. The refreshed page two must be requested
    // after its predecessor's new cursor, retaining the focused search control.
    const boundaryAgent = agentFixtures.at(-1)!
    const boundaryName = 'Browser UI Reactivity Agent 00 boundary'
    await agentSearch.focus()
    const rebasedPageTwoResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        url.pathname === '/api/v1/account/agents' &&
        url.searchParams.has('after') &&
        url.searchParams.get('after') !== initialPageTwoCursor
      )
    })
    await updateAgentPresentation(connection.db, homeWorkspaceId, boundaryAgent.id, owner, {
      expectedRevision: boundaryAgent.revision,
      name: boundaryName,
    })
    const rebasedPageTwo = (await (await rebasedPageTwoResponse).json()) as {
      agents: { id: string; name: string }[]
    }
    expect(rebasedPageTwo.agents.map(({ name }) => name)).toEqual([
      'Browser UI Reactivity Agent 24',
      'Workspace lead',
    ])
    await expect(page.getByRole('heading', { level: 2, name: boundaryName })).toBeVisible()
    await expect(
      page.getByRole('heading', { level: 2, name: 'Browser UI Reactivity Agent 24', exact: true })
    ).toBeVisible()
    await expect(agentSearch).toBeFocused()
  })

  test('a linked job opens the board and returns to the same conversation with its draft', async ({
    page,
    context,
  }) => {
    test.slow()
    const { homeWorkspaceId, principal: owner } = await signIn(context)
    const teamWorkspaceId = await seedWorkspace(owner, 'Browser UI Journey Workspace')
    const conversation = await seedConversation(teamWorkspaceId, owner, 'Browser UI Journey Lane')
    await seedMessage(teamWorkspaceId, conversation.id, owner, 'The linked job anchor message.')
    const task = await seedTask(teamWorkspaceId, owner, 'Browser UI Ship the release')
    await seedMessage(
      teamWorkspaceId,
      conversation.id,
      owner,
      'Job work continues in this conversation.',
      task.id
    )

    await openSignedInApp(page)

    // The account search stays in force while its result switches to the owner
    // workspace and opens the same durable conversation id.
    const conversationsSection = page.getByRole('region', { name: 'Conversations' })
    const inboxSearch = conversationsSection.getByRole('searchbox', {
      name: 'Search conversations across workspaces',
    })
    const journeyAnswers = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/account/conversations') &&
        response.url().includes('q=journey')
    )
    await inboxSearch.fill('journey')
    await journeyAnswers
    const row = conversationsSection.getByRole('button', {
      name: /Browser UI Journey Lane.*in Browser UI Journey Workspace/,
    })
    await expect(row).toBeVisible()
    await row.click()
    const composer = page.getByRole('textbox', { name: 'Message' }).first()
    await expect(composer).toBeVisible()
    await expect(page).not.toHaveURL(/directory=inbox/)
    // The deep-link params are consumed once the surface applies them, so the
    // proof that the row's channel landed is the conversation's own header and
    // history, not the query string.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Browser UI Journey Lane' })
    ).toBeVisible()
    await expect(page.getByText('The linked job anchor message.')).toBeVisible()
    await expect(inboxSearch).toHaveValue('journey')
    await expect(
      conversationsSection.getByRole('button', {
        name: 'Browser UI Journey Lane',
        exact: true,
      })
    ).toHaveCount(1)

    // Switching back restores the same account-wide row in the Conversations
    // section, with the one local copy left in its owner's workspace.
    await page.goto(`/?workspace=${encodeURIComponent(homeWorkspaceId)}`)
    const globalConversationRow = page
      .getByRole('region', { name: 'Conversations' })
      .getByRole('button', {
        name: /Browser UI Journey Lane/,
        exact: true,
      })
    await expect(globalConversationRow).toBeVisible()
    await globalConversationRow.click()
    await expect(page.getByRole('textbox', { name: 'Message' }).first()).toBeVisible()

    // A composition-in-progress must survive the round trip.
    const draft = 'Holding this draft until the linked job lands.'
    await composer.fill(draft)
    await expect(composer).toHaveValue(draft)

    // The message's linked job button switches to the Kanban app with that
    // very task open on top of the board: the app param moves, the board
    // renders, and the task sheet carries the linked title.
    await page.getByRole('button', { name: 'Task · Browser UI Ship the release' }).click()
    await expect(page).toHaveURL(/app=kanban/)
    await expect(page.locator('.conventional-workspace--board')).toBeVisible()
    const taskSheet = page.getByRole('dialog', { name: 'Edit task' })
    await expect(taskSheet).toBeVisible()
    await expect(taskSheet.getByRole('textbox', { name: 'Title' })).toHaveValue(
      'Browser UI Ship the release'
    )

    // Dismissing the sheet lands on the board itself, still as the active
    // rail app.
    await taskSheet.getByRole('button', { name: 'Close task' }).click()
    await expect(taskSheet).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Task board', exact: true })).toBeVisible()
    const rail = page.getByRole('navigation', { name: 'Global navigation' })
    await expect(rail.getByRole('button', { name: 'Kanban', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    // …and the rail's Chat view returns to the very same conversation: still
    // the linked channel, still the draft that was never sent. The rail labels
    // the chat app "Chat view" (VIEW_LABELS in global-workspace-rail).
    await rail.getByRole('button', { name: 'Chat view', exact: true }).click()
    await expect(page).not.toHaveURL(/app=kanban/)
    await expect(composer).toBeVisible()
    await expect(composer).toHaveValue(draft)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Browser UI Journey Lane' })
    ).toBeVisible()
    await expect(page.getByText('The linked job anchor message.')).toBeVisible()
  })

  test('the inbox shows its offline state and converges after reconnecting', async ({
    page,
    context,
  }) => {
    test.slow()
    const { principal: owner } = await signIn(context)
    // The poster is a workspace member and channel participant, like the auth
    // spec's reader: only participants can post into the lane.
    const poster = await backgroundUser('ui-poster')
    const teamWorkspaceId = await seedWorkspace(owner, 'Browser UI Reconnect Workspace')
    await addWorkspaceMembership(connection.db, teamWorkspaceId, poster, 'member')
    const conversation = await seedConversation(
      teamWorkspaceId,
      owner,
      'Browser UI Reconnect Lane',
      [owner, poster]
    )

    await openSignedInApp(page)
    const row = page.getByRole('button', { name: /Browser UI Reconnect Lane/ })
    await expect(row).toBeVisible()
    await expect(page.getByRole('button', { name: /1 unread/ })).toHaveCount(0)

    // The connection drops: the surface says so in place, above the section
    // that keeps showing the pages it already loaded.
    await context.setOffline(true)
    const offlineNotice = page.getByRole('status').filter({ hasText: 'Offline. Results refresh' })
    await expect(offlineNotice).toBeVisible()
    await expect(row).toBeVisible()

    // While disconnected, activity lands (written straight through the
    // restricted Postgres fixture, exactly like the auth spec).
    await seedMessage(teamWorkspaceId, conversation.id, poster)

    // Reconnect: the notice clears itself from the browser's own online
    // event, and a refresh converges the visible row onto the new unread.
    await context.setOffline(false)
    await expect(offlineNotice).toHaveCount(0)
    await page.getByRole('button', { name: 'Refresh conversations across workspaces' }).click()
    await expect(
      page.getByRole('button', { name: /Browser UI Reconnect Lane, 1 unread/ })
    ).toBeVisible()
  })

  test('the account inbox stays in the shared Conversations section across Chat, Virtual, and Dev', async ({
    page,
    context,
  }) => {
    const { principal: owner } = await signIn(context)
    const teamWorkspaceId = await seedWorkspace(owner, 'Browser UI Shared Nav Workspace')
    const conversation = await seedConversation(
      teamWorkspaceId,
      owner,
      'Browser UI Shared Nav Conversation'
    )
    await seedMessage(teamWorkspaceId, conversation.id, owner)

    await openSignedInApp(page)
    const conversations = page.getByRole('region', { name: 'Conversations' })
    await expect(
      conversations.getByRole('button', { name: /Browser UI Shared Nav Conversation/ })
    ).toBeVisible()

    await page.goto('/?view=virtual')
    await expect(page.getByRole('button', { name: 'Virtual view', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    const virtualConversations = page.getByRole('region', { name: 'Conversations' })
    await expect(
      virtualConversations.getByRole('button', {
        name: /Browser UI Shared Nav Conversation/,
      })
    ).toBeVisible()

    await page.goto('/?view=dev&devE2e=preserved')
    await expect(page.getByRole('button', { name: 'Dev view', exact: true })).toBeVisible()
    const devConversations = page.getByRole('region', { name: 'Conversations' })
    await expect(
      devConversations.getByRole('button', { name: /Browser UI Shared Nav Conversation/ })
    ).toBeVisible()
  })
})
