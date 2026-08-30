import { expect, test, type Page } from '@playwright/test'

const timestamp = '2026-08-30T12:00:00.000Z'
const workspace = { id: 'workspace-e2e', name: 'Acme Studio', scene: 'work', updatedAt: timestamp }
const user = { kind: 'user' as const, userId: 'user-e2e' }
const agentPrincipal = { kind: 'agent' as const, agentId: 'agent-research' }
const rooms = [
  {
    createdAt: timestamp,
    functionKey: 'product',
    id: 'room-product',
    lifecycleState: 'active',
    name: 'Product',
    sortOrder: 0,
    updatedAt: timestamp,
    workspaceId: workspace.id,
  },
  {
    createdAt: timestamp,
    functionKey: 'support',
    id: 'room-support',
    lifecycleState: 'active',
    name: 'Support',
    sortOrder: 1,
    updatedAt: timestamp,
    workspaceId: workspace.id,
  },
]
const agents = [
  {
    createdAt: timestamp,
    id: 'agent-research',
    lifecycleState: 'active',
    name: 'Research Agent',
    presentationMetadata: {},
    profile: { id: 'profile-research', state: 'available', version: '1' },
    roleSummary: 'Customer and market research',
    roomId: 'room-product',
    updatedAt: timestamp,
    workspaceId: workspace.id,
  },
  {
    createdAt: timestamp,
    id: 'agent-writer',
    lifecycleState: 'active',
    name: 'Writer Agent',
    presentationMetadata: {},
    profile: { id: 'profile-writer', state: 'missing', version: '1' },
    roleSummary: 'Product copy',
    updatedAt: timestamp,
    workspaceId: workspace.id,
  },
]
const channels = [
  {
    createdAt: timestamp,
    id: 'channel-product',
    isPrimaryRoomChannel: true,
    kind: 'room',
    lifecycleState: 'active',
    participants: [user],
    roomId: 'room-product',
    sortOrder: 0,
    title: 'Product',
    updatedAt: timestamp,
    version: 1,
    visibility: 'workspace',
    workspaceId: workspace.id,
  },
  {
    createdAt: timestamp,
    id: 'channel-support',
    isPrimaryRoomChannel: true,
    kind: 'room',
    lifecycleState: 'active',
    participants: [user],
    roomId: 'room-support',
    sortOrder: 0,
    title: 'Support',
    updatedAt: timestamp,
    version: 1,
    visibility: 'workspace',
    workspaceId: workspace.id,
  },
  {
    agentId: 'agent-research',
    createdAt: timestamp,
    id: 'channel-agent',
    isPrimaryRoomChannel: false,
    kind: 'direct_agent',
    lifecycleState: 'active',
    participants: [user, agentPrincipal],
    sortOrder: 2,
    title: 'Research Agent',
    updatedAt: timestamp,
    version: 1,
    visibility: 'participants',
    workspaceId: workspace.id,
  },
  {
    createdAt: timestamp,
    id: 'channel-group',
    isPrimaryRoomChannel: false,
    kind: 'group',
    lifecycleState: 'active',
    participants: [user, agentPrincipal],
    sortOrder: 3,
    title: 'Launch group',
    updatedAt: timestamp,
    version: 1,
    visibility: 'participants',
    workspaceId: workspace.id,
  },
]
const tasks = [
  {
    agentId: 'agent-research',
    artifactRefs: ['artifact-brief'],
    conversation: { channelId: 'channel-product', messageId: 'message-task' },
    createdAt: timestamp,
    creator: user,
    dependencyIds: [],
    id: 'task-launch',
    lifecycleState: 'created',
    objective: 'Prepare the launch brief and confirm audience.',
    priority: 'high',
    roomId: 'room-product',
    title: 'Launch planning',
    updatedAt: timestamp,
    version: 1,
    workspaceId: workspace.id,
  },
  {
    artifactRefs: [],
    conversation: {},
    createdAt: timestamp,
    creator: user,
    dependencyIds: ['task-launch'],
    id: 'task-review',
    lifecycleState: 'queued',
    objective: 'Review the customer-facing plan.',
    priority: 'normal',
    title: 'Review launch',
    updatedAt: timestamp,
    version: 2,
    workspaceId: workspace.id,
  },
]
const artifacts = [
  {
    availability: 'available',
    checksumSha256: 'a'.repeat(64),
    createdAt: timestamp,
    deletionState: 'active',
    filename: 'launch-brief.md',
    id: 'artifact-brief',
    location: { reference: 'artifact://launch-brief', type: 'object_store' },
    mediaType: 'text/markdown',
    owner: user,
    provenance: { source: 'e2e' },
    retentionPolicy: 'standard',
    sensitivity: 'workspace',
    sizeBytes: 2048,
    sourceArtifactRef: 'artifact://launch-brief',
    sourcePrincipal: user,
    taskId: 'task-launch',
    updatedAt: timestamp,
    version: 1,
    workspaceId: workspace.id,
  },
]
const messages = [
  {
    artifactIds: [],
    bodyText: 'Welcome to the Product Room. This is durable workspace history.',
    channelId: 'channel-product',
    createdAt: timestamp,
    deleted: false,
    id: 'message-root',
    mentions: [],
    sender: { kind: 'system', systemId: 'agent-hq' },
    sequence: 1,
    updatedAt: timestamp,
    version: 1,
    workspaceId: workspace.id,
  },
  {
    artifactIds: ['artifact-brief'],
    bodyText: 'The launch brief is ready for review. @Research Agent',
    channelId: 'channel-product',
    createdAt: timestamp,
    deleted: false,
    id: 'message-task',
    mentions: [agentPrincipal],
    sender: user,
    sequence: 2,
    taskId: 'task-launch',
    updatedAt: timestamp,
    version: 1,
    workspaceId: workspace.id,
  },
  {
    artifactIds: [],
    bodyContentRefId: 'content-private',
    channelId: 'channel-product',
    createdAt: timestamp,
    deleted: false,
    id: 'message-private',
    mentions: [],
    sender: agentPrincipal,
    sequence: 3,
    updatedAt: timestamp,
    version: 1,
    workspaceId: workspace.id,
  },
]
const reply = {
  artifactIds: [],
  bodyText: 'I will add competitor evidence here.',
  channelId: 'channel-product',
  createdAt: timestamp,
  deleted: false,
  id: 'message-reply',
  mentions: [],
  replyToMessageId: 'message-root',
  sender: agentPrincipal,
  sequence: 4,
  threadRootMessageId: 'message-root',
  updatedAt: timestamp,
  version: 1,
  workspaceId: workspace.id,
}

async function mockWorkspace(page: Page, empty = false) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('agent-hq:e2e-initialized')) {
      localStorage.clear()
      localStorage.setItem('theme', 'light')
      sessionStorage.setItem('agent-hq:e2e-initialized', 'true')
    }
  })
  await page.route('**/api/workspaces/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: { activeWorkspace: workspace, principal: { temporary: true }, workspaces: [workspace] },
    })
  )
  await page.route('**/api/v1/workspaces/**', async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET')
      return route.fulfill({ contentType: 'application/json', json: {} })
    if (url.pathname.endsWith('/rooms'))
      return route.fulfill({ contentType: 'application/json', json: empty ? [] : rooms })
    if (url.pathname.endsWith('/agents'))
      return route.fulfill({ contentType: 'application/json', json: empty ? [] : agents })
    if (url.pathname.endsWith('/tasks'))
      return route.fulfill({ contentType: 'application/json', json: empty ? [] : tasks })
    if (url.pathname.endsWith('/artifacts'))
      return route.fulfill({ contentType: 'application/json', json: empty ? [] : artifacts })
    if (url.pathname.endsWith('/channels'))
      return route.fulfill({ contentType: 'application/json', json: empty ? [] : channels })
    if (url.pathname.endsWith('/messages')) {
      const channelId = url.pathname.split('/').at(-2)
      const threadRoot = url.searchParams.get('threadRootMessageId')
      const channelMessages = empty
        ? []
        : channelId === 'channel-product'
          ? messages
          : [
              {
                ...messages[0],
                bodyText:
                  channelId === 'channel-agent'
                    ? 'Private planning with Research Agent.'
                    : 'Launch group coordination.',
                channelId,
                id: `message-${channelId}`,
              },
            ]
      return route.fulfill({
        contentType: 'application/json',
        json: { messages: threadRoot ? [reply] : channelMessages, nextAfterSequence: null },
      })
    }
    return route.fulfill({ contentType: 'application/json', json: {} })
  })
}

test('renders empty and populated Room-first workspace states', async ({ page }) => {
  await mockWorkspace(page, true)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Rooms' })).toBeVisible()
  await expect(page.getByText('Create a Room to organize the work.')).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-empty-light.png', { animations: 'disabled' })

  await page.unrouteAll({ behavior: 'wait' })
  await mockWorkspace(page)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Product' })).toBeVisible()
  await expect(page.getByText('Private content unavailable')).toBeVisible()
  await expect(page.getByText('launch-brief.md')).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-room-populated-light.png', {
    animations: 'disabled',
  })
})

test('navigates direct, group, thread, and Task detail surfaces', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Research Agent', exact: true }).click()
  await expect(page.getByText('Direct Agent', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-direct-agent.png', { animations: 'disabled' })

  await page.getByRole('button', { name: 'Launch group', exact: true }).click()
  await expect(
    page.locator('#workspace-main').getByText('Group conversation', { exact: true })
  ).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-group.png', { animations: 'disabled' })

  await page.getByRole('button', { name: 'Product Room', exact: true }).click()
  await page.getByRole('button', { name: 'Thread', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Thread' })).toBeVisible()
  await expect(page.getByText('I will add competitor evidence here.')).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => ({
        documentScroll: document.documentElement.scrollLeft,
        workspaceScroll: document.querySelector('.conventional-workspace')?.scrollLeft ?? -1,
      }))
    )
    .toEqual({ documentScroll: 0, workspaceScroll: 0 })
  await expect(page).toHaveScreenshot('workspace-thread.png', { animations: 'disabled' })
  await page.getByRole('button', { name: 'Close thread' }).click()

  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.getByRole('button', { name: /Launch planning/ }).click()
  await expect(page.getByRole('heading', { name: 'Launch planning' })).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-task-detail.png', { animations: 'disabled' })
})

test('supports narrow navigation, keyboard search, and dark mode', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockWorkspace(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Open workspace navigation' })).toBeVisible()
  await page.getByRole('button', { name: 'Open workspace navigation' }).click()
  const navigation = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(navigation).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-narrow-light.png', { animations: 'disabled' })
  await navigation.getByRole('button', { name: 'Close workspace navigation' }).click()

  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Search loaded workspace' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Search loaded workspace' })).not.toBeVisible()

  await page.evaluate(() => {
    localStorage.setItem('theme', 'dark')
    document.documentElement.classList.remove('light')
    document.documentElement.classList.add('dark')
  })
  await expect(page).toHaveScreenshot('workspace-narrow-dark.png', { animations: 'disabled' })
})

test('retains drafts across navigation and reloads at supported breakpoints', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/')
  const draft = 'Evidence to preserve while I check another conversation.'
  await page.getByRole('textbox', { name: 'Message' }).fill(draft)
  await page.getByRole('button', { name: 'Research Agent', exact: true }).click()
  await page.getByRole('button', { name: 'Product Room', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(draft)
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(draft)

  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(page.locator('.conventional-workspace')).toBeVisible()
    const viewport = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }))
    expect(viewport.documentWidth).toBe(viewport.viewportWidth)
  }
})
