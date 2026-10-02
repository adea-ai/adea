// Workspace visual and flow gate.
//
// Baselines are committed per platform: `-darwin` snapshots for the
// hardware-backed workstation lane (`bun run test:e2e:visual` on macOS) and
// `-linux` snapshots for the `Workspace visual lane` workflow, which runs
// inside the pinned Playwright container so the rendering stays reproducible.
// A UI change that moves pixels updates both sets with `--update-snapshots`.
// The spec mocks every workspace API response, so no database is needed.
import { createHash } from 'node:crypto'

// The visual helpers install transition suppression for every capture; see
// helpers/visual.ts for the race this closes.
import { expect, test, type Page } from './helpers/visual'

import { canonicalThemeCssTokens } from '../../../packages/ui/src/components/canonical-theme-css-data'
import { verifyRegistryArtifacts } from '../../../packages/workspace-ui/src/marketplace-catalog'

const timestamp = '2026-08-30T12:00:00.000Z'
const workspace = { id: 'workspace-e2e', name: 'Work', scene: 'work', updatedAt: timestamp }
const homeWorkspace = {
  id: 'workspace-home-e2e',
  name: 'Home',
  scene: 'home',
  updatedAt: timestamp,
}
const user = { kind: 'user' as const, userId: 'user-e2e' }
const agentPrincipal = { kind: 'agent' as const, agentId: 'agent-research' }

const marketplacePluginSpecs = [
  ['gmail', 'Gmail', 'productivity', 'connector'],
  ['github', 'GitHub', 'developer-tools', 'connector'],
  ['google-drive', 'Google Drive', 'productivity', 'connector'],
  ['google-calendar', 'Google Calendar', 'productivity', 'connector'],
  ['notion', 'Notion', 'productivity', 'connector'],
  ['slack', 'Slack', 'communication', 'connector'],
  ['asana', 'Asana', 'productivity', 'connector'],
  ['trello', 'Trello', 'productivity', 'connector'],
  ['room-summaries', 'Room Summaries', 'productivity', 'skill'],
  ['todoist', 'Todoist', 'productivity', 'connector'],
  ['calendly', 'Calendly', 'productivity', 'connector'],
  ['linear', 'Linear', 'developer-tools', 'connector'],
] as const

function marketplaceCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(marketplaceCanonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${marketplaceCanonicalJson(object[key])}`)
    .join(',')}}`
}

function marketplaceDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(marketplaceCanonicalJson(value)).digest('hex')}`
}

function marketplaceFixture() {
  const plugins = marketplacePluginSpecs.map(([name, displayName, category, kind], index) => {
    const token = (index + 1).toString(16).padStart(2, '0').repeat(32)
    const releaseId = `release:${token}`
    const release = {
      capabilities: [
        {
          metadata: {},
          name: displayName,
          paths: [],
          securityImpact: 'low',
          type: kind === 'skill' ? 'skill' : 'connector',
        },
      ],
      canonicalContentDigest: `sha256:${token}`,
      contentResolution: 'complete',
      fileIndex: [],
      pluginSubdirectory: `plugins/${name}`,
      releaseId,
      releaseMetadata: { publishedAt: timestamp },
      requiredConnectors: [],
      requiredCredentials: [],
      resolvedCommitSha: token.slice(0, 40),
      resolvedRepositoryUrl: 'https://github.com/adea-ai/plugins',
    }
    return {
      authors: ['Registry fixture'],
      availableReleases: [release],
      capabilitySummary: { [kind]: 1 },
      categories: [category],
      currentReleaseId: releaseId,
      description: `${displayName} registry fixture.`,
      displayName,
      harnessCompatibility: { codex: { status: 'portable' } },
      icons: [],
      keywords: [name, category],
      license: { name: 'Apache-2.0' },
      pluginId: `plugin:openai-official:${name}`,
      productGroupingKey: name,
      provenance: {
        repositoryUrl: 'https://github.com/openai/plugins',
        resolvedCommitSha: token.slice(0, 40),
      },
      securityClassification: { level: 'standard' },
      sourceId: 'openai-official',
    }
  })
  const body = {
    generatedAt: timestamp,
    plugins,
    schemaVersion: 1,
    sources: [{ repository: 'https://github.com/openai/plugins', sourceId: 'openai-official' }],
  }
  const catalogId = `catalog:${marketplaceDigest(body).slice('sha256:'.length)}`
  const catalog = { ...body, catalogId }
  const catalogText = JSON.stringify(catalog)
  const summaryText = JSON.stringify({
    catalogId,
    generatedAt: timestamp,
    pluginCount: plugins.length,
    schemaVersion: 1,
  })
  const categoriesText = JSON.stringify({
    categories: [...new Set(plugins.flatMap((plugin) => plugin.categories))],
    catalogId,
    schemaVersion: 1,
  })
  const compatibilityText = JSON.stringify({ catalogId, plugins: [], schemaVersion: 1 })
  const lockText = JSON.stringify({ catalogId, schemaVersion: 1, sources: [] })
  const files = {
    'catalog-summary.v1.json': summaryText,
    'catalog.v1.json': catalogText,
    'categories.v1.json': categoriesText,
    'compatibility.v1.json': compatibilityText,
    'sources.lock.json': lockText,
  }
  const integrityFiles = Object.fromEntries(
    Object.entries(files).map(([name, value]) => [name, marketplaceDigest(value)])
  )
  const artifacts = {
    'catalog-latest.v1.json': catalogText,
    'catalog-summary.v1.json': summaryText,
    'catalog.v1.json': catalogText,
    'categories.v1.json': categoriesText,
    'compatibility.v1.json': compatibilityText,
    'integrity.json': JSON.stringify({ catalogId, files: integrityFiles, schemaVersion: 1 }),
    'sources.lock.json': lockText,
  }
  return { artifacts, catalog, catalogId, plugins }
}
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
const readState = [
  {
    channelId: 'channel-product',
    lastReadSequence: 0,
    latestTopLevelSequence: 3,
    manuallyUnread: false,
    threadUnreadCount: 1,
    threads: [
      {
        lastReadSequence: 0,
        latestSequence: 4,
        manuallyUnread: false,
        threadRootMessageId: 'message-root',
        unreadCount: 1,
      },
    ],
    topLevelUnreadCount: 3,
    unread: true,
    workspaceId: workspace.id,
  },
]

async function mockWorkspace(page: Page, empty = false) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('adea:e2e-initialized')) {
      localStorage.clear()
      localStorage.setItem('theme', 'light')
      sessionStorage.setItem('adea:e2e-initialized', 'true')
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
    if (url.pathname.includes('/read-state'))
      return route.fulfill({ contentType: 'application/json', json: { readState } })
    if (
      url.pathname.includes('/agents/agent-research/') &&
      ['PATCH', 'POST'].includes(route.request().method())
    ) {
      const body = route.request().postDataJSON() as Record<string, unknown>
      const updated = {
        ...agents[0],
        ...(url.pathname.endsWith('/presentation') ? body : {}),
        ...(url.pathname.endsWith('/room') ? { roomId: body.roomId } : {}),
        ...(url.pathname.endsWith('/profile')
          ? {
              profile: {
                id: body.profileId,
                state: body.profileState ?? 'available',
                version: body.profileVersion,
              },
            }
          : {}),
      }
      return route.fulfill({ contentType: 'application/json', json: { agent: updated } })
    }
    if (url.pathname.endsWith('/agents/agent-research') && route.request().method() === 'DELETE')
      return route.fulfill({ contentType: 'application/json', json: { archived: true } })
    if (route.request().method() !== 'GET')
      return route.fulfill({ contentType: 'application/json', json: {} })
    if (url.pathname.endsWith('/search')) {
      const query = url.searchParams.get('q')?.toLocaleLowerCase() ?? ''
      const results = query.includes('brief')
        ? [
            {
              id: 'artifact-brief',
              kind: 'artifact',
              label: 'launch-brief.md',
              secondary: 'text/markdown',
              taskId: 'task-launch',
              workspaceId: workspace.id,
            },
          ]
        : query.includes('durable')
          ? [
              {
                channelId: 'channel-product',
                id: 'message-root',
                kind: 'message',
                label: 'This is durable workspace history.',
                messageId: 'message-root',
                roomId: 'room-product',
                secondary: 'Product · Message',
                workspaceId: workspace.id,
              },
            ]
          : []
      return route.fulfill({
        contentType: 'application/json',
        json: { privateResultsUnavailable: true, results },
      })
    }
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

async function mockConnectedWorkspace(page: Page) {
  const mutableRooms = rooms.map((room) => ({ ...room }))
  const mutableChannels = channels.map((channel) => ({ ...channel }))

  await page.addInitScript(() => {
    if (!sessionStorage.getItem('adea:e2e-initialized')) {
      localStorage.clear()
      localStorage.setItem('theme', 'light')
      sessionStorage.setItem('adea:e2e-initialized', 'true')
    }
  })
  await page.route('**/api/workspaces/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        activeWorkspace: workspace,
        principal: { temporary: true, userId: 'user-e2e' },
        workspaces: [workspace, homeWorkspace],
      },
    })
  )
  await page.route('**/api/v1/workspaces/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname.endsWith('/rooms')) {
      const body = request.postDataJSON() as { functionKey: string; name: string }
      const createdRoom = {
        createdAt: timestamp,
        functionKey: body.functionKey,
        id: 'room-created',
        lifecycleState: 'active' as const,
        name: body.name,
        sortOrder: mutableRooms.length,
        updatedAt: timestamp,
        workspaceId: workspace.id,
      }
      mutableRooms.push(createdRoom)
      mutableChannels.push({
        createdAt: timestamp,
        id: 'channel-created-room',
        isPrimaryRoomChannel: true,
        kind: 'room',
        lifecycleState: 'active',
        participants: [user],
        roomId: createdRoom.id,
        sortOrder: 0,
        title: createdRoom.name,
        updatedAt: timestamp,
        version: 1,
        visibility: 'workspace',
        workspaceId: workspace.id,
      })
      return route.fulfill({
        contentType: 'application/json',
        json: { room: createdRoom },
        status: 201,
      })
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/channels')) {
      const body = request.postDataJSON() as { agentId?: string; kind: string; title: string }
      if (body.kind === 'direct_agent') {
        const directChannel = mutableChannels.find(
          (channel) => channel.kind === 'direct_agent' && channel.agentId === body.agentId
        )
        return route.fulfill({
          contentType: 'application/json',
          json: { channel: directChannel },
          status: 201,
        })
      }
      const createdChannel = {
        createdAt: timestamp,
        id: 'channel-created-group',
        isPrimaryRoomChannel: false,
        kind: body.kind as 'group',
        lifecycleState: 'active' as const,
        participants: [user],
        sortOrder: mutableChannels.length,
        title: body.title,
        updatedAt: timestamp,
        version: 1,
        visibility: 'participants' as const,
        workspaceId: workspace.id,
      }
      mutableChannels.push(createdChannel)
      return route.fulfill({
        contentType: 'application/json',
        json: { channel: createdChannel },
        status: 201,
      })
    }
    if (request.method() !== 'GET')
      return route.fulfill({ contentType: 'application/json', json: {} })
    if (url.pathname.includes('/read-state'))
      return route.fulfill({ contentType: 'application/json', json: { readState } })
    if (url.pathname.endsWith('/rooms'))
      return route.fulfill({ contentType: 'application/json', json: mutableRooms })
    if (url.pathname.endsWith('/channels'))
      return route.fulfill({ contentType: 'application/json', json: mutableChannels })
    if (url.pathname.endsWith('/agents'))
      return route.fulfill({ contentType: 'application/json', json: agents })
    if (url.pathname.endsWith('/tasks'))
      return route.fulfill({ contentType: 'application/json', json: tasks })
    if (url.pathname.endsWith('/artifacts'))
      return route.fulfill({ contentType: 'application/json', json: artifacts })
    if (url.pathname.endsWith('/messages'))
      return route.fulfill({ contentType: 'application/json', json: { messages: [] } })
    return route.fulfill({ contentType: 'application/json', json: {} })
  })
}

async function captureMessageSubmissions(
  page: Page,
  failAttempts: readonly number[] = []
): Promise<Record<string, unknown>[]> {
  const submissions: Record<string, unknown>[] = []
  let attempt = 0
  await page.route('**/api/v1/workspaces/workspace-e2e/channels/*/messages', async (route) => {
    const request = route.request()
    if (request.method() !== 'POST') return route.fallback()

    attempt += 1
    const body = request.postDataJSON() as Record<string, unknown>
    const channelId = decodeURIComponent(new URL(request.url()).pathname.split('/').at(-2) ?? '')
    submissions.push({
      ...body,
      channelId,
      idempotencyKey: request.headers()['idempotency-key'],
    })
    if (failAttempts.includes(attempt)) {
      return route.fulfill({
        contentType: 'application/json',
        json: { error: 'temporary failure' },
        status: 503,
      })
    }

    const message = {
      ...messages[0],
      ...body,
      channelId,
      id: `message-composer-${attempt}`,
      sender: user,
      sequence: 20 + attempt,
    }
    return route.fulfill({
      contentType: 'application/json',
      json: { message },
      status: 201,
    })
  })
  return submissions
}

test('keeps a composition Enter from submitting a workspace message', async ({ page }) => {
  await mockWorkspace(page)
  const submissions = await captureMessageSubmissions(page)
  await page.goto('/')
  await page.getByRole('button', { name: /^Product( |$)/ }).click()

  const composer = page.getByRole('textbox', { name: 'Message' }).first()
  await composer.fill('候補')
  await composer.evaluate((element) => {
    if (!(element instanceof HTMLTextAreaElement)) throw new Error('Composer is not a textarea')
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '候補' }))
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '候補' }))
    element.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', keyCode: 229 })
    )
  })

  await expect.poll(() => submissions.length, { timeout: 1_000 }).toBe(0)
  await expect(composer).toHaveValue('候補')
})

test('submits channel messages with mentions, artifacts, and Shift+Enter newlines', async ({
  page,
}) => {
  await mockWorkspace(page)
  const submissions = await captureMessageSubmissions(page)
  await page.goto('/')
  await page.getByRole('button', { name: /^Product( |$)/ }).click()

  const composer = page.getByRole('textbox', { name: 'Message' }).first()
  const composerForm = page.locator('form[data-slot="message-composer"]').first()
  await expect(composer).toHaveAttribute('aria-describedby', 'composer-help-channel-product')
  await expect(composer).toHaveAttribute('id', 'composer-channel-product')
  await expect(page.getByRole('button', { name: 'Start dictation' })).toBeDisabled()
  await composerForm.evaluate((form) => {
    form.dataset.submitEventCount = '0'
    form.addEventListener(
      'submit',
      () => {
        form.dataset.submitEventCount = String(Number(form.dataset.submitEventCount) + 1)
      },
      { capture: true }
    )
  })
  await composer.fill('Ask @Research')
  const mentionOption = page
    .locator('.conventional-mention-menu')
    .getByRole('button', { name: 'Research Agent', exact: true })
  const mentionButtonSemantics = await mentionOption.evaluate((element) => {
    const button = element as HTMLButtonElement
    return {
      type: button.type,
      formAssociated: Boolean(button.form),
      insideComposerForm: button.closest('form[data-slot="message-composer"]') !== null,
    }
  })
  expect(mentionButtonSemantics).toEqual({
    type: 'button',
    formAssociated: true,
    insideComposerForm: true,
  })
  await mentionOption.click()
  expect(await composerForm.getAttribute('data-submit-event-count')).toBe('0')
  expect(submissions).toHaveLength(0)
  await expect(composer).toBeFocused()
  await composer.evaluate((element) => element.blur())
  await page.keyboard.press('Control+Shift+m')
  await expect(composer).toBeFocused()
  await composer.press('Shift+Enter')
  await composer.type('with attached notes')
  await page.getByRole('button', { name: 'Attach an Artifact' }).click()
  await page
    .locator('.conventional-attachment-menu label')
    .filter({ hasText: 'launch-brief.md' })
    .click()
  await expect(page.locator('.conventional-attachment-menu').getByRole('checkbox')).toBeChecked()
  await expect(
    page.getByRole('button', { name: '1 Artifact attached, add an Artifact' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Remove launch-brief.md' }).click()
  await expect(page.getByRole('button', { name: 'Attach an Artifact' })).toBeVisible()
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0)
  await page
    .locator('.conventional-attachment-menu label')
    .filter({ hasText: 'launch-brief.md' })
    .click()
  await expect(page.locator('.conventional-attachment-menu').getByRole('checkbox')).toBeChecked()
  await expect(
    page.getByRole('button', { name: '1 Artifact attached, add an Artifact' })
  ).toBeVisible()
  await composer.press('Enter')

  await expect.poll(() => submissions.length).toBe(1)
  expect(submissions[0]).toMatchObject({
    artifactIds: ['artifact-brief'],
    bodyText: 'Ask @Research Agent \nwith attached notes',
    channelId: 'channel-product',
    mentions: [{ agentId: 'agent-research', kind: 'agent' }],
  })
  expect(submissions[0]?.idempotencyKey).toEqual(expect.any(String))
  await expect(composer).toHaveValue('')
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Attach an Artifact' })).toBeVisible()
})

test('keeps the room draft and attachments after a failed send, then clears on retry', async ({
  page,
}) => {
  await mockWorkspace(page)
  const submissions = await captureMessageSubmissions(page, [1])
  await page.goto('/')
  await page.getByRole('button', { name: /^Product( |$)/ }).click()

  const composer = page.getByRole('textbox', { name: 'Message' }).first()
  const draft = 'Keep this draft when the connection fails.'
  await composer.fill(draft)
  await page.getByRole('button', { name: 'Attach an Artifact' }).click()
  await page
    .locator('.conventional-attachment-menu label')
    .filter({ hasText: 'launch-brief.md' })
    .click()
  await expect(page.locator('.conventional-attachment-menu').getByRole('checkbox')).toBeChecked()
  await page.getByRole('button', { name: 'Send message' }).first().click()

  await expect(
    page.getByText(
      'Message not sent. Your draft is still here; retry when the connection recovers.'
    )
  ).toBeVisible()
  await expect(composer).toHaveValue(draft)
  await expect(page.getByLabel('Selected attachments')).toContainText('launch-brief.md')
  await composer.press('Enter')

  await expect.poll(() => submissions.length).toBe(2)
  expect(submissions[0]).toMatchObject({ artifactIds: ['artifact-brief'], bodyText: draft })
  expect(submissions[1]).toMatchObject({ artifactIds: ['artifact-brief'], bodyText: draft })
  expect(submissions[1]?.idempotencyKey).not.toBe(submissions[0]?.idempotencyKey)
  await expect(composer).toHaveValue('')
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0)
})

test('keeps thread reply metadata separate from the room draft', async ({ page }) => {
  await mockWorkspace(page)
  const submissions = await captureMessageSubmissions(page)
  await page.goto('/')
  await page.getByRole('button', { name: /^Product( |$)/ }).click()

  const roomComposer = page.getByRole('textbox', { name: 'Message' }).first()
  await roomComposer.fill('Room draft remains here.')
  await page.getByRole('button', { name: 'Thread', exact: true }).first().click()
  const threadComposer = page.getByRole('textbox', { name: 'Message' }).nth(1)
  await expect(threadComposer).toHaveAttribute(
    'aria-describedby',
    'composer-help-thread-message-root'
  )
  await expect(page.getByText(/^Replying in thread ·/)).toBeVisible()
  await threadComposer.fill('Reply with the root identity preserved.')
  await threadComposer.press('Enter')

  await expect.poll(() => submissions.length).toBe(1)
  expect(submissions[0]).toMatchObject({
    bodyText: 'Reply with the root identity preserved.',
    channelId: 'channel-product',
    replyToMessageId: 'message-root',
    threadRootMessageId: 'message-root',
  })
  await expect(roomComposer).toHaveValue('Room draft remains here.')
  await expect(threadComposer).toHaveValue('')
})

test('renders empty and populated Room-first workspace states', async ({ page }) => {
  await mockWorkspace(page, true)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Rooms' })).toBeVisible()
  await expect(page.getByText('Create a Room to organize the work.')).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-empty-light.png', { animations: 'disabled' })

  await page.unrouteAll({ behavior: 'wait' })
  await mockWorkspace(page)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Product', exact: true })).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByText('Private content unavailable')).toBeVisible()
  await expect(page.getByLabel('Attachment launch-brief.md')).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-room-populated-light.png', {
    animations: 'disabled',
  })
})

test('centers creation dialogs in the viewport', async ({ page }) => {
  await mockConnectedWorkspace(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Rooms' })).toBeVisible()
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize(viewport)
    const openNavigation = page.getByRole('button', { name: 'Open workspace navigation' })
    if (await openNavigation.isVisible()) await openNavigation.click()
    await page
      .getByRole('complementary', { name: 'Workspace navigation' })
      .getByRole('button', { name: 'Create Room', exact: true })
      .click()
    const dialog = page.getByRole('dialog', { name: 'Create Room' })
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2)
    expect(Math.abs(box!.y + box!.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2)
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
  }
})

test('uses the published Adea Light semantic theme by default', async ({ page }) => {
  await mockConnectedWorkspace(page)
  await page.goto('/')
  const tokens = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement)
    return {
      background: styles.getPropertyValue('--background').trim(),
      primary: styles.getPropertyValue('--primary').trim(),
    }
  })
  const canonical = canonicalThemeCssTokens('adea-light')
  expect(tokens.background).toBe(canonical['--background'])
  expect(tokens.primary).toBe(canonical['--primary'])
})

test('loads chat before secure-context-only authentication APIs are requested', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    })
  })
  await mockConnectedWorkspace(page)
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Rooms' })).toBeVisible()
})

test('connects newly created Rooms and group conversations to their canonical views', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'Create Room', exact: true }).last().click()
  const roomDialog = page.getByRole('dialog', { name: 'Create Room' })
  await roomDialog.getByLabel('Room name').fill('Runtime Review')
  await roomDialog.getByLabel('Function key').fill('runtime-review')
  await roomDialog.getByRole('button', { name: 'Create Room', exact: true }).click()
  await expect(
    page.locator('#workspace-main').getByRole('heading', { name: 'Runtime Review', exact: true })
  ).toBeVisible()

  await page.getByRole('button', { name: 'Create group conversation' }).click()
  const groupDialog = page.getByRole('dialog', { name: 'New group conversation' })
  await groupDialog.getByLabel('Conversation name').fill('Connected review')
  await groupDialog.getByRole('button', { name: 'Create conversation' }).click()
  await expect(
    page.locator('#workspace-main').getByRole('heading', { name: 'Connected review', exact: true })
  ).toBeVisible()

  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'Open conversation' }).first().click()
  await expect(
    page.locator('#workspace-main').getByRole('heading', { name: 'Research Agent', exact: true })
  ).toBeVisible()
})

test('toggles chat and virtual Room views without losing shared selection or drafts', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await mockConnectedWorkspace(page)
  await page.goto('/')
  const globalNavigation = page.getByRole('navigation', { name: 'Global navigation' })
  await expect(globalNavigation).toBeVisible()
  // The global rail renders permanently collapsed, where the shared rail draws
  // no chord glyph; the chord reaches assistive technology through
  // `aria-keyshortcuts`, which is the contract that must hold in that state.
  await expect(globalNavigation.getByRole('button', { name: 'Search workspace' })).toHaveAttribute(
    'aria-keyshortcuts',
    'Meta+K Control+K'
  )
  // Notifications lives in the top bar now, not on the global rail.
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible()
  await expect(
    globalNavigation.getByRole('button', { name: 'Notifications (coming soon)' })
  ).toHaveCount(0)
  await expect(
    globalNavigation.getByRole('button', { name: 'Switch workspace, current Work' })
  ).toBeVisible()
  await expect(globalNavigation.getByRole('button', { name: 'Home workspace' })).toHaveCount(0)
  await expect(globalNavigation.getByRole('button', { name: 'Work workspace' })).toHaveCount(0)
  await expect(page.locator('#workspace-switcher')).toHaveCount(0)
  await expect(page.locator('.conventional-topbar')).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible()
  await page.getByRole('button', { name: /^Product( |$)/ }).click()
  await page.getByRole('textbox', { name: 'Message' }).fill('Keep this connected draft.')

  await globalNavigation.getByRole('button', { name: 'Switch workspace, current Work' }).click()
  // The click parks pointer and focus on the rail trigger, whose tooltip opens
  // on a 200 ms delay: a fast run captures before it appears, a loaded run
  // after — the same between-runs nondeterminism the lane forbids for
  // transitions. Park the pointer on empty canvas so the tooltip can never
  // open (and require quiescence in case it already did); a bare move cannot
  // dismiss this menu, which closes on outside pointerdown only.
  await page.mouse.move(640, 400)
  await expect(page.getByRole('tooltip')).toBeHidden()
  await expect(page).toHaveScreenshot('workspace-switcher.png', { animations: 'disabled' })
  await expect(page.getByText('Scenes', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitemradio', { name: /Home/ })).toBeVisible()
  await expect(page.getByRole('menuitemradio', { name: /Work/ })).toBeVisible()
  await page.getByRole('menuitemradio', { name: /Home/ }).click()
  await expect(
    globalNavigation.getByRole('button', { name: 'Switch workspace, current Home' })
  ).toBeVisible()
  await expect(page).toHaveURL(/scene=home/)
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('')

  await globalNavigation.getByRole('button', { name: 'Switch workspace, current Home' }).click()
  await page.getByRole('menuitemradio', { name: /Work/ }).click()
  await expect(page).toHaveURL(/scene=work/)
  await expect(
    globalNavigation.getByRole('button', { name: 'Switch workspace, current Work' })
  ).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Message' }).fill('Keep this connected draft.')

  await globalNavigation.getByRole('button', { name: 'Virtual view' }).click()
  await expect(page).toHaveURL(/view=virtual/)
  // The engine is entitled per build: a packed Agent Sim renders its own room
  // region and controls, and every other build renders the documented offline
  // fallback. Both are correct, so the gate accepts either and only checks the
  // engine's room controls when the engine is actually there.
  const virtualRoom = page.getByRole('region', { name: 'Virtual Room' })
  const engineFallback = page.getByRole('status', { name: 'Virtual view unavailable' })
  await expect(virtualRoom.or(engineFallback)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toHaveCount(0)
  if (await virtualRoom.count()) {
    await expect(page.getByRole('button', { name: 'Product', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  }

  await globalNavigation.getByRole('button', { name: 'Chat view' }).click()
  await expect(page).toHaveURL(/view=chat/)
  await expect(
    page.locator('#workspace-main').getByRole('heading', { name: 'Product', exact: true })
  ).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
    'Keep this connected draft.'
  )
})

test('keeps Plugins unavailable until workspace bootstrap completes', async ({ page }) => {
  let releaseBootstrap!: () => void
  const bootstrapBlocked = new Promise<void>((resolve) => {
    releaseBootstrap = resolve
  })
  await page.route('**/api/workspaces/bootstrap', async (route) => {
    await bootstrapBlocked
    await route.fulfill({
      contentType: 'application/json',
      json: {
        activeWorkspace: workspace,
        principal: { temporary: true, userId: 'user-e2e' },
        workspaces: [workspace, homeWorkspace],
      },
    })
  })
  await page.goto('/?view=chat')
  const globalNavigation = page.getByRole('navigation', { name: 'Global navigation' })
  const pluginsButton = globalNavigation.getByRole('button', { name: 'Plugins' })
  await expect(pluginsButton).toBeVisible()
  await expect(pluginsButton).toBeDisabled()

  releaseBootstrap()
  await expect(pluginsButton).toBeEnabled()
})

test('browses the verified registry marketplace and submits an exact install request', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  const fixture = marketplaceFixture()
  await expect(verifyRegistryArtifacts(fixture.artifacts)).resolves.toBeTruthy()
  const installRequests: unknown[] = []
  await page.route('**/api/marketplace/catalog', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        artifacts: fixture.artifacts,
        catalogId: fixture.catalogId,
        installations: [],
        releaseId: fixture.catalogId,
        state: 'ready',
      },
    })
  )
  await page.route('**/api/marketplace/install', async (route) => {
    const request = route.request().postDataJSON() as {
      canonicalContentDigest: string
      idempotencyKey: string
      pluginId: string
      releaseId: string
      requestedHarness: string
    }
    installRequests.push(request)
    await route.fulfill({
      contentType: 'application/json',
      json: {
        canonicalContentDigest: request.canonicalContentDigest,
        installationId: 'ins_e2e-marketplace',
        message: 'Authorization is required before installation.',
        pluginId: request.pluginId,
        releaseId: request.releaseId,
        state: 'pending-authorization',
      },
    })
  })
  await page.goto('/?view=chat')
  const globalNavigation = page.getByRole('navigation', { name: 'Global navigation' })
  await globalNavigation.getByRole('button', { name: 'Plugins' }).click()
  const plugins = page.getByRole('dialog', { name: 'Plugins' })
  await expect(plugins).toBeVisible()
  await expect(plugins.getByRole('status').first()).toHaveText(/^\d+ plugins$/)

  const results = plugins.getByRole('region', { name: 'Plugin results', exact: true })
  await expect(results).toHaveAttribute('tabindex', '0')
  const pluginGroups = results.getByRole('region')
  const popularPlugins = pluginGroups.first()
  await expect(popularPlugins.getByRole('heading', { name: 'Popular' })).toBeVisible()
  await expect(popularPlugins.locator('[data-catalog-entry-id]')).toHaveCount(6)
  await expect(popularPlugins.getByRole('button', { name: /Gmail/ })).toBeVisible()
  await expect(popularPlugins.getByRole('button', { name: /GitHub/ })).toBeVisible()
  expect(
    await pluginGroups.evaluateAll((groups) =>
      groups.every((group) => group.querySelectorAll('[data-catalog-entry-id]').length <= 6)
    )
  ).toBe(true)

  const productivityPlugins = pluginGroups.filter({
    has: page.getByRole('heading', { name: 'Productivity', exact: true }),
  })
  await plugins.getByRole('button', { name: 'See Room Summaries, Todoist and more' }).click()
  await expect(productivityPlugins.locator('[data-catalog-entry-id]')).toHaveCount(9)
  await productivityPlugins.getByRole('button', { name: 'Show less' }).click()
  await expect(productivityPlugins.locator('[data-catalog-entry-id]')).toHaveCount(6)

  await plugins.getByRole('searchbox', { name: 'Search plugins' }).fill('github')
  await plugins.getByRole('button', { name: /GitHub/ }).click()
  await expect(plugins.getByRole('heading', { name: 'GitHub' })).toBeVisible()
  await expect(plugins.getByText('openai-official', { exact: true })).toBeVisible()
  await expect(plugins.getByText('MCP', { exact: true })).toBeVisible()
  await plugins.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(
    plugins.getByRole('button', { name: 'Authorization pending', exact: true })
  ).toBeVisible()
  expect(installRequests).toEqual([
    {
      canonicalContentDigest: `sha256:${'02'.repeat(32)}`,
      idempotencyKey:
        'marketplace:a6f55d19184dc1c1e0f3ed5765bc0fb1ca49437a32130aee7b6f9610953a9ad6',
      installationInstanceId:
        'marketplace:37f53eb6e39f6ecffb13eba915de46666a9403f31951ab444f3e17131cb57371',
      pluginId: 'plugin:openai-official:github',
      releaseId: `release:${'02'.repeat(32)}`,
      requestedHarness: 'codex',
      workspaceIdentity: { userId: 'user-e2e', workspaceId: workspace.id },
    },
  ])
  // The verified catalog is cached for stale-while-revalidate (the global
  // snapshot plus the legacy per-workspace entry), so the assertion is about
  // what must never be persisted: installations, authorizations, and
  // credentials. Anything else plugin-shaped in storage fails this gate.
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter(
        (key) =>
          /plugin/i.test(key) &&
          key !== 'adea:plugin-catalog-cache:v1' &&
          key !== 'adea:plugin-catalog-global:v1'
      )
    )
  ).toEqual([])
  await plugins.getByRole('button', { name: 'Back to plugins' }).click()
  await expect(plugins.getByRole('button', { name: /GitHub/ })).toBeFocused()
  await plugins.getByRole('tab', { name: 'Installed' }).click()
  await expect(plugins.getByText('No plugins added yet')).toBeVisible()
})

test('navigates direct, group, and thread surfaces', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Research Agent', exact: true }).click()
  await expect(page.getByText('Direct Conversation', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-direct-agent.png', { animations: 'disabled' })

  await page.getByRole('button', { name: 'Launch group', exact: true }).click()
  await expect(
    page.locator('#workspace-main').getByText('Group conversation', { exact: true })
  ).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-group.png', { animations: 'disabled' })

  await page.getByRole('button', { name: /^Product( |$)/ }).click()
  await page.getByRole('button', { name: 'Thread', exact: true }).first().click()
  // The shared thread panel titles itself through the aside's accessible name
  // ("Thread: <label>"); its visible "Thread" caption is a span, not a heading.
  await expect(
    page.getByRole('complementary', { name: 'Thread: Focused discussion' })
  ).toBeVisible()
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
})

test('restores a channel reading position without rearming transcript follow', async ({ page }) => {
  await mockWorkspace(page)
  await page.route('**/api/v1/workspaces/workspace-e2e/channels/*/messages**', async (route) => {
    const requestUrl = new URL(route.request().url())
    const channelId = requestUrl.pathname.split('/').at(-2)
    if (route.request().method() !== 'GET' || channelId !== 'channel-product') {
      return route.fallback()
    }

    const history = Array.from({ length: 60 }, (_, index) => ({
      ...messages[0],
      bodyText: `Synthetic history row ${index + 1}. ${'Readable transcript content. '.repeat(5)}`,
      channelId,
      createdAt: new Date(Date.UTC(2026, 8, 30, 12, index)).toISOString(),
      id: `scroll-history-${index + 1}`,
      sequence: index + 1,
    }))
    return route.fulfill({
      contentType: 'application/json',
      json: { messages: history, nextAfterSequence: null },
    })
  })

  await page.goto('/')
  await page.getByRole('button', { name: /^Product( |$)/ }).click()
  const transcript = page.locator('.conventional-transcript > div:first-child')
  await expect.poll(() => transcript.evaluate((node) => node.scrollHeight)).toBeGreaterThan(1000)
  await transcript.evaluate((node) => {
    node.scrollTop = 420
    node.dispatchEvent(new Event('scroll'))
  })
  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBe(420)
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()

  await page.getByRole('button', { name: 'Research Agent', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Research Agent', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^Product( |$)/ }).click()

  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBe(420)
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
})

test('opens responsive Task detail and restores focus on dismissal', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  const taskTrigger = page.getByRole('button', { name: /Launch planning/ })
  await taskTrigger.click()
  const detail = page.getByRole('dialog', { name: 'Launch planning', exact: true })
  await expect(detail.getByRole('heading', { name: 'Launch planning' })).toBeVisible()
  await expect(detail).toHaveAttribute('data-side', 'right')
  await expect(page.locator('[class*="bg-scrim/50"]')).toHaveCount(1)
  await expect(detail.locator('.conventional-detail-panel')).toHaveCSS('overflow-y', 'auto')
  const rootFontSize = await page
    .locator('html')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
  expect(
    await detail.evaluate((element) => Number.parseFloat(getComputedStyle(element).width))
  ).toBeCloseTo(29 * rootFontSize, 1)
  await detail.getByRole('textbox', { name: 'Title', exact: true }).focus()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await expect(page).toHaveScreenshot('workspace-task-detail.png', { animations: 'disabled' })

  await page.setViewportSize({ width: 390, height: 480 })
  expect(
    await detail.evaluate((element) => Number.parseFloat(getComputedStyle(element).width))
  ).toBeCloseTo(366.6, 0)
  const detailBody = detail.locator('.conventional-detail-panel')
  await expect
    .poll(() => detailBody.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true)
  await detailBody.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(() => detailBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  await page.keyboard.press('Escape')
  await expect(detail).toHaveCount(0)
  await expect(taskTrigger).toBeFocused()

  await page.setViewportSize({ width: 1280, height: 720 })
  await taskTrigger.click()
  const reopenedDetail = page.getByRole('dialog', { name: 'Launch planning', exact: true })
  const closeDetail = reopenedDetail.getByRole('button', { name: 'Close Task detail' })
  await closeDetail.focus()
  await expect(page.getByRole('tooltip')).toHaveText('Close Task detail')
  await closeDetail.click()
  await expect(reopenedDetail).toHaveCount(0)
  await expect(taskTrigger).toBeFocused()
})

test('Task board preserves task data and moves cards with keyboard and drag', async ({
  page,
}, testInfo) => {
  await mockWorkspace(page)
  let boardTasks = tasks.map((task) => ({ ...task }))
  const taskActions: string[] = []
  const nextStateByAction = {
    cancel: 'cancelled',
    complete: 'completed',
    queue: 'queued',
    review: 'in_review',
    start: 'in_progress',
  } as const
  await page.route('**/api/v1/workspaces/**/tasks**', async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (method === 'GET' && url.pathname.endsWith('/tasks'))
      return route.fulfill({ contentType: 'application/json', json: boardTasks })

    const action = url.pathname.split('/').at(-1) ?? ''
    const taskId = url.pathname.split('/').at(-2) ?? ''
    const nextState = nextStateByAction[action as keyof typeof nextStateByAction]
    if (method === 'POST' && nextState) {
      const taskIndex = boardTasks.findIndex((task) => task.id === taskId)
      if (taskIndex < 0) return route.fulfill({ status: 404, json: { error: 'Task not found' } })
      taskActions.push(`${taskId}/${action}`)
      const task = {
        ...boardTasks[taskIndex]!,
        lifecycleState: nextState,
        version: boardTasks[taskIndex]!.version + 1,
      }
      boardTasks.splice(taskIndex, 1, task)
      return route.fulfill({ contentType: 'application/json', json: { task } })
    }
    return route.fallback()
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  const board = page.getByRole('region', { name: 'Task board' })
  const planned = board.getByRole('region', { name: 'Planned' })
  const queued = board.getByRole('region', { name: 'Queued' })
  const inProgress = board.getByRole('region', { name: 'In-Progress' })
  const completed = board.getByRole('region', { name: 'Completed' })
  const taskTrigger = planned.getByRole('button', { name: 'Launch planning', exact: true })

  await expect(taskTrigger).toBeVisible()
  await expect(planned.locator('header > span')).toHaveText('1')
  await expect(queued.locator('header > span')).toHaveText('1')
  await expect(planned.getByLabel('Priority: high')).toBeVisible()
  await expect(planned.getByText('Prepare the launch brief and confirm audience.')).toBeVisible()
  await expect(planned.getByText('Research Agent')).toBeVisible()
  await expect(planned.getByText('Product', { exact: true })).toBeVisible()
  await expect(queued.getByRole('button', { name: 'Review launch', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('task-board.png'), animations: 'disabled' })

  await taskTrigger.focus()
  await page.keyboard.press('Control+ArrowRight')
  await expect(queued.getByRole('button', { name: 'Launch planning', exact: true })).toBeVisible()
  await expect(planned.locator('header > span')).toHaveText('0')
  await expect(queued.locator('header > span')).toHaveText('2')
  await expect.poll(() => taskActions).toContain('task-launch/queue')
  const queuedCard = queued
    .getByRole('button', { name: 'Launch planning', exact: true })
    .locator('xpath=ancestor::article[@aria-roledescription="Draggable card"]')
  await expect(queuedCard).toBeFocused()
  await queuedCard.dragTo(planned)
  await expect(planned.locator('header > span')).toHaveText('0')
  await expect(queued.locator('header > span')).toHaveText('2')
  await expect.poll(() => taskActions).toEqual(['task-launch/queue'])

  await queuedCard.focus()
  await page.keyboard.press('Control+ArrowRight')
  await expect(
    inProgress.getByRole('button', { name: 'Launch planning', exact: true })
  ).toBeVisible()
  await expect(queued.locator('header > span')).toHaveText('1')
  await expect(inProgress.locator('header > span')).toHaveText('1')
  await expect.poll(() => taskActions).toContain('task-launch/start')

  const inReview = board.getByRole('region', { name: 'In-Review' })
  const launchCard = inProgress
    .getByRole('button', { name: 'Launch planning', exact: true })
    .locator('xpath=ancestor::article[@aria-roledescription="Draggable card"]')
  await inReview.scrollIntoViewIfNeeded()
  await launchCard.dragTo(inReview)
  await expect(inReview.getByRole('button', { name: 'Launch planning', exact: true })).toBeVisible()
  await expect(inProgress.locator('header > span')).toHaveText('0')
  await expect(inReview.locator('header > span')).toHaveText('1')
  await expect.poll(() => taskActions).toContain('task-launch/review')
  const inReviewCard = inReview
    .getByRole('button', { name: 'Launch planning', exact: true })
    .locator('xpath=ancestor::article[@aria-roledescription="Draggable card"]')
  await expect(inReviewCard).toBeFocused()
  await page.keyboard.press('Control+ArrowRight')
  await expect(
    completed.getByRole('button', { name: 'Launch planning', exact: true })
  ).toBeVisible()
  await expect(inReview.locator('header > span')).toHaveText('0')
  await expect(completed.locator('header > span')).toHaveText('1')
  await expect.poll(() => taskActions).toContain('task-launch/complete')
  const completedCard = completed
    .getByRole('button', { name: 'Launch planning', exact: true })
    .locator('xpath=ancestor::article[@aria-roledescription="Draggable card"]')
  await expect(completedCard).toBeFocused()
})

test('supports narrow navigation, keyboard search, and dark mode', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockWorkspace(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Expand contextual sidebar' })).toBeVisible()
  await page.getByRole('button', { name: 'Expand contextual sidebar' }).click()
  const navigation = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(navigation).toBeVisible()
  await expect(page.getByRole('button', { name: 'Collapse contextual sidebar' })).toHaveAttribute(
    'aria-expanded',
    'true'
  )
  await expect(navigation.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(navigation.getByRole('region', { name: 'Rooms' })).toBeVisible()
  await expect(navigation.getByRole('region', { name: 'Conversations' })).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-narrow-light.png', { animations: 'disabled' })
  await navigation.getByRole('button', { name: 'Close workspace navigation' }).click()

  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Search workspace' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Search workspace' })).not.toBeVisible()

  await page.evaluate(() => {
    localStorage.setItem('theme', 'dark')
    document.documentElement.classList.remove('light')
    document.documentElement.classList.add('dark')
  })
  await expect(page).toHaveScreenshot('workspace-narrow-dark.png', { animations: 'disabled' })
})

test('keeps contextual section actions visible on touch devices', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })

  try {
    const page = await context.newPage()
    await mockWorkspace(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Expand contextual sidebar' }).click()

    const navigation = page.getByRole('complementary', { name: 'Workspace navigation' })
    await expect(navigation.getByRole('button', { name: 'Create Room' })).toBeVisible()
    await expect(
      navigation.getByRole('button', { name: 'Create group conversation' })
    ).toBeVisible()
  } finally {
    await context.close()
  }
})

test('operates unread actions and deep-linked search entirely by keyboard', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/')
  await expect(page.getByLabel(/unread in Product/)).toBeVisible({ timeout: 15_000 })

  await page.keyboard.press('Control+k')
  const globalSearch = page.getByRole('dialog', { name: 'Search workspace' })
  const searchInput = globalSearch.getByRole('combobox', { name: 'Search workspace' })
  const results = globalSearch.getByRole('listbox', { name: 'Search results' })
  const options = results.getByRole('option')
  await expect(searchInput).toBeFocused()
  await expect(options).toHaveCount(13)

  const supportPrefetch = page.waitForRequest((request) =>
    request.url().includes('/channels/channel-support/messages')
  )
  await searchInput.press('ArrowDown')
  await searchInput.press('ArrowDown')
  await searchInput.press('ArrowDown')
  const supportChannel = globalSearch.getByRole('option', {
    name: /Support Room conversation/,
  })
  await expect(supportChannel).toHaveAttribute('aria-selected', 'true')
  expect(await searchInput.getAttribute('aria-controls')).toBe(await results.getAttribute('id'))
  expect(await searchInput.getAttribute('aria-activedescendant')).toBe(
    await supportChannel.getAttribute('id')
  )
  await supportPrefetch

  await searchInput.fill('launch brief')
  await expect(globalSearch.getByRole('option', { name: /launch-brief\.md/ })).toBeVisible()
  await expect(searchInput).toBeFocused()
  await expect(globalSearch.getByRole('option', { name: /launch-brief\.md/ })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'launch-brief.md' })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.keyboard.press('Control+f')
  const conversationSearch = page.getByRole('dialog', { name: 'Search this conversation' })
  await conversationSearch.getByRole('combobox', { name: 'Search workspace' }).fill('durable')
  await expect(conversationSearch.getByRole('option', { name: /durable workspace/ })).toBeVisible()
  await page.keyboard.press('Enter')
  // The shared message row signals `highlighted` with design tokens instead of
  // the app-local `conventional-message--highlighted` class, and makes the
  // jumped-to row programmatically focusable.
  const jumpedTo = page.locator('[data-message-id="message-root"]')
  await expect(jumpedTo).toHaveClass(/bg-primary-subtle shadow-\[inset_3px_0_var\(--primary\)\]/)
  await expect(jumpedTo).toHaveAttribute('tabindex', '-1')

  const unreadRequest = page.waitForRequest((request) =>
    request.url().includes('/read-state/channels/channel-product')
  )
  await page.keyboard.press('Control+Shift+u')
  expect((await unreadRequest).postDataJSON()).toEqual({ action: 'unread' })
})

test('workspace search keeps duplicate destination labels tied to their domain identity', async ({
  page,
}) => {
  await mockWorkspace(page)
  await page.goto('/')
  // Control+k pressed during the first paint lands before the workspace
  // installs its shortcut listener, so anchor on loaded chrome first.
  await expect(page.getByLabel(/unread in Product/)).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Control+k')

  const dialog = page.getByRole('dialog', { name: 'Search workspace' })
  const input = dialog.getByRole('combobox', { name: 'Search workspace' })
  const results = dialog.getByRole('listbox', { name: 'Search results' })
  const room = results.getByRole('option', { name: 'Support Room', exact: true })
  const channel = results.getByRole('option', { name: 'Support Room conversation', exact: true })
  await expect(results.getByRole('option')).toHaveCount(13)

  const channelPrefetch = page.waitForRequest((request) =>
    request.url().includes('/channels/channel-support/messages')
  )
  await channel.hover()
  await channelPrefetch
  await expect(channel).toHaveAttribute('aria-selected', 'true')
  await expect(room).toHaveAttribute('aria-selected', 'false')
  expect(await input.getAttribute('aria-activedescendant')).toBe(await channel.getAttribute('id'))
})

test('global rail opens workspace search from Virtual and Dev', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/?view=virtual')
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toBeVisible({
    timeout: 20_000,
  })

  const searchDialog = page.getByRole('dialog', { name: 'Search workspace' })
  await page.keyboard.press('Control+k')
  await expect(searchDialog).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveURL(/view=chat/)
  await page.keyboard.press('Escape')
  await expect(searchDialog).toBeHidden()

  await page.goto('/?view=dev&devE2e=preserved')
  await expect(page.getByRole('button', { name: 'Dev view', exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await page.keyboard.press('Control+k')
  await expect(searchDialog).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveURL(/view=chat/)
})

test('retains drafts across navigation and reloads at supported breakpoints', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/')
  const draft = 'Evidence to preserve while I check another conversation.'
  await page.getByRole('textbox', { name: 'Message' }).fill(draft)
  await page.getByRole('button', { name: 'Research Agent', exact: true }).click()
  await page.getByRole('button', { name: /^Product( |$)/ }).click()
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

test('the live appearance popover previews the visible workspace at wide and narrow widths', async ({
  page,
}) => {
  await mockWorkspace(page)
  const popup = page.getByRole('dialog', { name: 'Appearance', exact: true })
  const appearanceControl = page.getByRole('button', { name: 'Appearance settings', exact: true })
  // The control lazy-loads the appearance panel, and the cold-server flake can
  // strike at any point of that import: the SSR shell renders the same button
  // enabled (a click there lands on no listener), and a dev-server reload
  // drops a hydrated page back to the shell. Drive the open as a self-healing
  // loop — re-navigate to a hydrated workspace whenever the shell regressed,
  // then open through the trigger's own state.
  await expect(async () => {
    const hydrated = await page
      .getByRole('complementary', { name: 'Workspace navigation' })
      .isVisible()
      .catch(() => false)
    if (!hydrated) {
      await page.goto('/?view=chat&scene=work', { timeout: 30_000 })
    }
    await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(appearanceControl).toBeEnabled({ timeout: 30_000 })
    // Gate on the trigger's own state: isVisible lags the portal mount on a
    // loaded machine, and a blind re-click would toggle the popover closed.
    if ((await appearanceControl.getAttribute('aria-expanded')) !== 'true') {
      await appearanceControl.click()
    }
    await expect(popup).toBeVisible()
  }).toPass({ timeout: 120_000 })
  const modes = popup.getByRole('radiogroup', { name: 'Appearance mode' })
  await modes.getByText('Light', { exact: true }).click()
  await expect(page).toHaveScreenshot('workspace-appearance-popover-light.png', {
    animations: 'disabled',
  })
  await modes.getByText('Dark', { exact: true }).click()
  await expect(page).toHaveScreenshot('workspace-appearance-popover-dark.png', {
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page).toHaveScreenshot('workspace-appearance-popover-narrow.png', {
    animations: 'disabled',
  })
})

test('deep-links settings and customizes an Agent without fabricating runtime status', async ({
  page,
}) => {
  await mockWorkspace(page)
  await page.goto('/#settings/privacy-data')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('heading', { name: 'Privacy & data' })).toBeVisible()
  await expect(settings.getByText('Unavailable in this app or on this device.')).toBeVisible()

  await settings.getByRole('tab', { name: 'Input & notifications' }).click()
  await expect(settings.getByRole('button', { name: 'Check microphone' })).toBeDisabled()
  const mentionSwitch = settings.getByRole('switch', { name: 'Mention notifications' })
  const mentionSwitchControl = mentionSwitch.locator('xpath=following-sibling::*[1]')
  await mentionSwitchControl.click()
  await expect(mentionSwitch).not.toBeChecked()
  await mentionSwitch.press('Space')
  await expect(mentionSwitch).toBeChecked()
  await mentionSwitch.press('Space')
  await expect(mentionSwitch).not.toBeChecked()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem('adea:workspace-preferences:v1')
        return raw ? JSON.parse(raw).notifyMentions : undefined
      })
    )
    .toBe(false)
  await page.reload()
  const reloadedSettings = page.getByRole('dialog', { name: 'Settings' })
  await expect(reloadedSettings).toBeVisible()
  await expect(
    reloadedSettings.getByRole('switch', { name: 'Mention notifications' })
  ).not.toBeChecked()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(page).toHaveScreenshot('workspace-settings-light.png', { animations: 'disabled' })
  await page.evaluate(() => {
    localStorage.setItem('theme', 'dark')
    document.documentElement.classList.remove('light')
    document.documentElement.classList.add('dark')
  })
  await expect(page).toHaveScreenshot('workspace-settings-dark.png', { animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page).toHaveScreenshot('workspace-settings-narrow.png', { animations: 'disabled' })
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth === window.innerWidth)
  ).toBe(true)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.evaluate(() => {
    localStorage.setItem('theme', 'light')
    document.documentElement.classList.remove('dark')
    document.documentElement.classList.add('light')
  })

  await settings.getByRole('tab', { name: 'Agents' }).focus()
  await page.keyboard.press('End')
  // 'permissions' is the newest section, so it owns the End edge now.
  await expect(settings.getByRole('tab', { name: 'Permissions' })).toBeFocused()
  await page.keyboard.press('Home')
  await expect(settings.getByRole('tab', { name: 'Account & app' })).toBeFocused()
  await settings.getByRole('tab', { name: 'Agents' }).click()
  await settings.getByRole('button', { name: 'Customize Agents' }).click()

  const configured = page.getByText('Configured', { exact: true }).first()
  await expect(configured).toBeVisible()
  await expect(page.getByText('Runtime unknown', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Activity unknown', { exact: true }).first()).toBeVisible()
  expect((await page.locator('.conventional-agent-card').allTextContents()).join(' ')).not.toMatch(
    /online|working/i
  )

  await page.getByRole('button', { name: 'Customize', exact: true }).first().click()
  const form = page.locator('form.conventional-agent-customization')
  await form.getByLabel('Name').fill('Research Lead')
  await form.getByLabel('Role or persona').fill('Market evidence and customer research')
  await form.getByLabel('Room').selectOption('room-support')
  await form.getByLabel('AgentProfile version').fill('2')
  const presentation = page.waitForRequest((request) => request.url().endsWith('/presentation'))
  const room = page.waitForRequest((request) => request.url().endsWith('/room'))
  const profile = page.waitForRequest((request) => request.url().endsWith('/profile'))
  await form.getByRole('button', { name: 'Save changes' }).click()
  expect((await presentation).postDataJSON()).toMatchObject({ name: 'Research Lead' })
  expect((await room).postDataJSON()).toEqual({ roomId: 'room-support' })
  expect((await profile).postDataJSON()).toMatchObject({
    profileId: 'profile-research',
    profileVersion: '2',
  })

  await page.getByRole('button', { name: 'Customize', exact: true }).first().click()
  await expect(page.getByText('Permanent deletion is unavailable')).toBeVisible()
  await page.getByRole('button', { name: 'Archive Agent' }).click()
  await expect(page.getByRole('alertdialog', { name: 'Archive Research Agent' })).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-agent-customization.png', {
    animations: 'disabled',
  })
})

test('the settings dialog survives re-selecting its active tab and keeps its dismissal contract', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await mockWorkspace(page)
  await page.goto('/#settings/account')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()

  // Re-clicking the already-selected trigger must keep the dialog open (#601):
  // re-writing the current `#settings/…` hash re-resolved the route, whose
  // server-only entry loader then ran on the client, crashed the route, and
  // unmounted the whole workspace behind the error surface.
  await settings.getByRole('tab', { name: 'Account & app' }).click()
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('tab', { name: 'Account & app' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page.locator('.conventional-workspace')).toBeVisible()
  await expect(page).toHaveURL(/#settings\/account$/)

  // Escape dismisses per the dialog convention and leaves no inert background.
  await page.keyboard.press('Escape')
  await expect(settings).not.toBeVisible()
  await expect(page.locator('.conventional-workspace')).toBeVisible()
  expect(await page.locator('[inert]').count()).toBe(0)

  // Outside pointerdown dismisses per the same convention.
  await page.getByRole('button', { name: 'User settings' }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await expect(settings).toBeVisible()
  await page.mouse.click(24, 400)
  await expect(settings).not.toBeVisible()
  await expect(page.locator('.conventional-workspace')).toBeVisible()
  expect(await page.locator('[inert]').count()).toBe(0)
  expect(pageErrors).toEqual([])
})

for (const { width, fontSize } of [
  { width: 320, fontSize: '100%' },
  { width: 768, fontSize: '100%' },
  { width: 1440, fontSize: '100%' },
  { width: 320, fontSize: '200%' },
]) {
  test(`settings tabs keep shared vertical keyboard focus at ${width}px and ${fontSize}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await mockWorkspace(page)
    await page.goto('/#settings/account')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings).toBeVisible()
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = size
    }, fontSize)

    const tablist = settings.getByRole('tablist', { name: 'Settings sections' })
    const account = tablist.getByRole('tab', { name: 'Account & app', exact: true })
    const appearance = tablist.getByRole('tab', { name: 'Appearance', exact: true })
    const permissions = tablist.getByRole('tab', { name: 'Permissions', exact: true })
    await expect(tablist).toHaveAttribute('data-slot', 'settings-navigation')
    await expect(tablist).toHaveAttribute('aria-orientation', 'vertical')

    await account.focus()
    await page.keyboard.press('ArrowDown')
    await expect(appearance).toBeFocused()
    await expect(appearance).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(/#settings\/appearance$/)

    await page.keyboard.press('Home')
    await expect(account).toBeFocused()
    await expect(page).toHaveURL(/#settings\/account$/)

    await page.keyboard.press('End')
    await expect(permissions).toBeFocused()
    await expect(permissions).toBeInViewport({ ratio: 1 })
    await expect(
      settings.getByRole('heading', { name: 'Permissions', level: 3, exact: true })
    ).toBeInViewport({ ratio: 1 })
    await expect(page).toHaveURL(/#settings\/permissions$/)

    await page.keyboard.press('ArrowDown')
    await expect(account).toBeFocused()
    await expect(account).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(/#settings\/account$/)
  })
}

test('the appearance section keeps the ported Zeron composition', async ({ page }) => {
  await mockWorkspace(page)
  // The appearance editor is the settings section now (the rail entry is gone,
  // #425), and the settings deep link is how the lane reaches a section.
  await page.goto('/#settings/appearance')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  const panel = page.getByRole('region', { name: 'Appearance', exact: true })
  await expect(panel).toBeVisible()
  // The three live mode cards: System renders the split light/dark miniature.
  await expect(panel.locator('[data-theme-miniature]')).toHaveCount(4)
  await expect(panel).toHaveScreenshot('appearance-panel-light.png', { animations: 'disabled' })
})

test('integrated chrome keeps the global rail while Virtual navigation collapses', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=virtual')
  const toolbar = page.getByLabel('Workspace toolbar')
  await expect(toolbar).toBeVisible()
  const navigation = page.getByRole('complementary', { name: 'Virtual navigation' })
  await expect(navigation).toBeVisible()
  await expect(page.getByRole('main')).toHaveCount(1)
  await toolbar.getByRole('button', { name: 'Collapse contextual sidebar' }).click()
  await expect(navigation).toBeHidden()
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible()
  await toolbar.getByRole('button', { name: 'Expand contextual sidebar' }).click()
  await expect(navigation).toBeVisible()
  const bounds = await page.locator('.workspace-frame').evaluate((frame) => {
    const bar = frame.querySelector('[data-slot="top-bar"]')!.getBoundingClientRect()
    const rail = frame.querySelector('.global-rail')!.getBoundingClientRect()
    return {
      sameWidth: bar.width === frame.getBoundingClientRect().width,
      below: rail.top >= bar.bottom,
    }
  })
  expect(bounds).toEqual({ sameWidth: true, below: true })
})

test('Virtual room designer keeps the contextual sidebar and global rail', async ({ page }) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=virtual&roomDesigner=1')
  const sidebar = page.getByRole('complementary', { name: 'Virtual navigation' })
  await expect(page.getByRole('heading', { name: 'Virtual view lives in Agent Sim' })).toBeVisible()
  await expect(sidebar).toBeVisible()
  await expect(page.getByRole('main')).toHaveCount(1)
  const fallback = page.getByRole('status', { name: 'Virtual view unavailable' })
  expect(
    await fallback.evaluate((element) => {
      const viewport = element.closest('.workspace-scene-viewport')!
      return {
        fillsViewport:
          element.getBoundingClientRect().height === viewport.getBoundingClientRect().height,
        height: element.getBoundingClientRect().height,
      }
    })
  ).toEqual({ fillsViewport: true, height: expect.any(Number) })
  expect(
    await fallback.evaluate((element) => element.getBoundingClientRect().height)
  ).toBeGreaterThan(600)
  const toolbar = page.getByLabel('Workspace toolbar')
  await toolbar.getByRole('button', { name: 'Collapse contextual sidebar' }).click()
  await expect(sidebar).toBeHidden()
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible()
  await toolbar.getByRole('button', { name: 'Expand contextual sidebar' }).click()
  await sidebar.getByRole('button', { name: 'Open conversations' }).click()
  await expect(page.getByRole('button', { name: 'Chat view', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
})

test('collapsed Chat navigation is absent from keyboard and accessibility navigation', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 840 })
    const toolbar = page.getByLabel('Workspace toolbar')
    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    await expect(sidebar).toBeVisible()
    await toolbar.getByRole('button', { name: 'Collapse contextual sidebar' }).click()
    await expect(sidebar).toBeHidden()
    await expect(sidebar).toHaveCount(0)
    // A zero-width grid column alone clips pixels but leaves its controls in
    // the focus order and native accessibility tree.
    expect(
      await page
        .locator('.conventional-sidebar button')
        .first()
        .evaluate((button) => {
          button.focus()
          return button === document.activeElement
        })
    ).toBe(false)
    await toolbar.getByRole('button', { name: 'Expand contextual sidebar' }).click()
    await expect(sidebar).toBeVisible()
  }
})

test('App Library enables views separately from Plugins and remains reachable with all apps disabled', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  const library = page.getByRole('main', { name: 'App Library' })
  await expect(library).toBeVisible()
  const viewGroup = rail.getByRole('group', { name: 'Workspace views' })
  const selectedRailActions = viewGroup.locator('button[aria-pressed="true"]')
  await expect(selectedRailActions).toHaveCount(1)
  await expect(selectedRailActions).toHaveAttribute('aria-label', 'App Library')
  for (const name of ['Virtual', 'Chat', 'Dev']) {
    await library.getByRole('button', { name: `Disable ${name}`, exact: true }).click()
  }
  await expect(rail.getByRole('button', { name: 'Chat view', exact: true })).toHaveCount(0)
  await expect(rail.getByRole('button', { name: 'Dev view', exact: true })).toHaveCount(0)
  await expect(rail.getByRole('button', { name: 'Virtual view', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(library).toBeVisible()
  // Search left the toolbar for the rail; the rail entry still routes to the
  // Library's app search when every app is disabled.
  await rail.getByRole('button', { name: 'Search workspace', exact: true }).click()
  await expect(library.getByRole('searchbox', { name: 'Search apps', exact: true })).toBeFocused()
  await library.getByRole('button', { name: 'Enable Chat', exact: true }).click()
  await library.getByRole('button', { name: 'Open Chat', exact: true }).click()
  await expect(page.locator('.conventional-workspace')).toBeVisible()
  await expect(rail.getByRole('button', { name: 'Chat view', exact: true })).toBeVisible()
  await rail.getByRole('button', { name: 'Plugins', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Plugins', exact: true })).toBeVisible()
  await expect(page.getByRole('main', { name: 'App Library' })).toHaveCount(0)
})

test('top bar history traverses app destinations and truncates a forward branch', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  const toolbar = page.getByLabel('Workspace toolbar')
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  await expect(page.getByRole('main', { name: 'App Library' })).toBeVisible()
  await toolbar.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('.conventional-workspace')).toBeVisible()
  await expect(toolbar.getByRole('button', { name: 'Forward', exact: true })).toBeEnabled()
  await toolbar.getByRole('button', { name: 'Forward', exact: true }).click()
  await expect(page.getByRole('main', { name: 'App Library' })).toBeVisible()
  await toolbar.getByRole('button', { name: 'Back', exact: true }).click()
  await rail.getByRole('button', { name: 'Virtual view', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Virtual navigation' })).toBeVisible()
  await expect(toolbar.getByRole('button', { name: 'Forward', exact: true })).toBeDisabled()
})

test('optional apps open actual task and source control views without hiding the global rail', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  const library = page.getByRole('main', { name: 'App Library' })
  await library.getByRole('button', { name: 'Enable Kanban', exact: true }).click()
  await library.getByRole('button', { name: 'Open Kanban', exact: true }).click()
  await expect(page).toHaveURL(/app=kanban/)
  await expect(page.locator('.conventional-workspace')).toBeVisible()
  await expect(rail.getByRole('button', { name: 'Kanban', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  await library.getByRole('button', { name: 'Enable Source control', exact: true }).click()
  await library.getByRole('button', { name: 'Open Source control', exact: true }).click()
  await expect(page).toHaveURL(/app=source-control/)
  await expect(page.locator('.dev-workspace--source-control-app')).toBeVisible()
  await expect(page.locator('.dev-sidebar')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Source Control', exact: true })).toBeVisible()
  await expect(rail).toBeVisible()
  await expect(page.getByRole('button', { name: 'Restore utility pane', exact: true })).toHaveCount(
    0
  )
  await page
    .getByLabel('Workspace toolbar')
    .getByRole('button', { name: 'Collapse contextual sidebar' })
    .click()
  await expect(page.locator('.dev-sidebar')).toBeHidden()
  await expect(rail).toBeVisible()
})

test('all-off stale links remain in Library while enabling the first app', async ({ page }) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  const library = page.getByRole('main', { name: 'App Library' })
  for (const name of ['Virtual', 'Chat', 'Dev'])
    await library.getByRole('button', { name: `Disable ${name}`, exact: true }).click()
  await page.goto('/?view=dev')
  await expect(page).toHaveURL(/app=library/)
  await library.getByRole('button', { name: 'Enable Chat', exact: true }).click()
  await expect(library).toBeVisible()
  await expect(library.getByRole('button', { name: 'Open Chat', exact: true })).toBeVisible()
  await library.getByRole('button', { name: 'Open Chat', exact: true }).click()
  await expect(page.locator('.conventional-workspace')).toBeVisible()
})

test('Kanban leaves the prior Chat surface intact and rail keyboard reorders persist until reset', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  const views = rail.getByRole('group', { name: 'Workspace views' })
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
  // Alt+Arrow moves the focused rail view; the live region announces it.
  await views.getByRole('button', { name: 'Chat view', exact: true }).click()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(rail.getByRole('status')).toHaveText('Chat moved to position 1 of 3')
  await expect(views.getByRole('button').first()).toHaveAttribute('aria-label', 'Chat view')
  await page.reload()
  await expect(views.getByRole('button').first()).toHaveAttribute('aria-label', 'Chat view')
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  const library = page.getByRole('main', { name: 'App Library' })
  await library.getByRole('button', { name: 'Enable Kanban', exact: true }).click()
  await library.getByRole('button', { name: 'Open Kanban', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible()
  await rail.getByRole('button', { name: 'Chat view', exact: true }).click()
  await expect(page.locator('.conventional-workspace')).toBeVisible()
  // The Agents panel selection persists through a debounced writer, so a
  // surface that reloaded quickly after the click restores the default
  // conversation view; open the panel deliberately instead of assuming.
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  await library.getByRole('button', { name: 'Reset Navigation', exact: true }).click()
  await expect(views.getByRole('button').first()).toHaveAttribute('aria-label', 'Virtual view')
  await expect(rail.getByRole('button', { name: 'Kanban', exact: true })).toHaveCount(0)
})

test('App Library drag and keyboard ordering shares rail placements and persists hidden apps', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat&app=library')
  const library = page.getByRole('main', { name: 'App Library' })
  const views = page
    .getByRole('navigation', { name: 'Global navigation' })
    .getByRole('group', { name: 'Workspace views' })

  const appOrder = () =>
    library
      .locator('.workspace-app-library__grid > [data-app-id]')
      .evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('data-app-id')))
  const railOrder = () =>
    views.locator('[data-row-id]').evaluateAll((items) =>
      items
        .map((item) => item.getAttribute('data-row-id'))
        .filter((rowId): rowId is string => rowId?.startsWith('rail-view:') === true)
        .map((rowId) => rowId.replace('rail-view:', ''))
    )
  const enabledAppOrder = () =>
    library
      .locator('.workspace-app-library__grid > [data-app-id][data-enabled="true"]')
      .evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('data-app-id')))

  await expect.poll(appOrder).toEqual(['virtual', 'chat', 'dev', 'kanban', 'source-control'])
  // An enabled-only filter must not replace the canonical order with its
  // partial list. Move Dev with a keyboard-activated shared ActionButton.
  await library.getByRole('button', { name: 'Show enabled only', exact: true }).click()
  await expect.poll(appOrder).toEqual(['virtual', 'chat', 'dev'])
  const moveDevLeft = library.getByRole('button', { name: 'Move Dev left', exact: true })
  await moveDevLeft.focus()
  await page.keyboard.press('Enter')
  await expect.poll(appOrder).toEqual(['virtual', 'dev', 'chat'])
  await expect(library.getByRole('button', { name: 'Move Dev left', exact: true })).toBeFocused()
  await expect(library.getByRole('status')).toHaveText('Dev moved to position 2 of 5')
  await library.getByRole('button', { name: 'Show enabled only', exact: true }).click()
  await expect.poll(appOrder).toEqual(['virtual', 'dev', 'chat', 'kanban', 'source-control'])
  await expect.poll(railOrder).toEqual(['virtual', 'dev', 'chat'])

  // Drag the optional, currently hidden app before Virtual. Reordering keeps
  // it hidden until the explicit Enable action and retains the remaining apps.
  const kanbanTile = library.locator('[data-app-id="kanban"]')
  const kanbanGrip = kanbanTile.getByRole('button', { name: 'Drag Kanban to reorder', exact: true })
  await kanbanTile.hover()
  await expect(kanbanGrip).toBeVisible()
  await kanbanGrip.click({ trial: true })
  await kanbanGrip.dragTo(library.locator('[data-app-id="virtual"]'), {
    targetPosition: { x: 1, y: 24 },
  })
  await expect.poll(appOrder).toEqual(['kanban', 'virtual', 'dev', 'chat', 'source-control'])
  await expect(library.getByRole('button', { name: 'Enable Kanban', exact: true })).toBeVisible()
  await expect.poll(railOrder).toEqual(['virtual', 'dev', 'chat'])

  await library.getByRole('button', { name: 'Enable Kanban', exact: true }).click()
  await expect
    .poll(async () => ({ enabledApps: await enabledAppOrder(), rail: await railOrder() }))
    .toEqual({
      enabledApps: ['kanban', 'virtual', 'dev', 'chat'],
      rail: ['kanban', 'virtual', 'dev', 'chat'],
    })
  await page.reload()
  await expect(library).toBeVisible()
  await expect.poll(appOrder).toEqual(['kanban', 'virtual', 'dev', 'chat', 'source-control'])
  await expect(library.getByRole('button', { name: 'Disable Kanban', exact: true })).toBeVisible()
  await expect
    .poll(async () => ({ enabledApps: await enabledAppOrder(), rail: await railOrder() }))
    .toEqual({
      enabledApps: ['kanban', 'virtual', 'dev', 'chat'],
      rail: ['kanban', 'virtual', 'dev', 'chat'],
    })
})

test('App Library reorder actions are visible and operable on touch devices', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })

  try {
    const page = await context.newPage()
    await mockConnectedWorkspace(page)
    await page.goto('/?view=chat&app=library')
    const library = page.getByRole('main', { name: 'App Library' })
    expect(
      await page.evaluate(
        () => matchMedia('(hover: none)').matches || matchMedia('(pointer: coarse)').matches
      )
    ).toBe(true)
    const appOrder = () =>
      library
        .locator('.workspace-app-library__grid > [data-app-id]')
        .evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('data-app-id')))

    const devTile = library.locator('[data-app-id="dev"]')
    const moveDevLeft = devTile.getByRole('button', { name: 'Move Dev left', exact: true })
    await expect(moveDevLeft).toBeVisible()
    await expect(moveDevLeft).toHaveCSS('pointer-events', 'auto')
    await expect.poll(appOrder).toEqual(['virtual', 'chat', 'dev', 'kanban', 'source-control'])

    await moveDevLeft.tap()
    await expect.poll(appOrder).toEqual(['virtual', 'dev', 'chat', 'kanban', 'source-control'])
  } finally {
    await context.close()
  }
})

test('Rail drag-and-drop reorders views across disabled apps and persists after reload', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat&app=library')
  const library = page.getByRole('main', { name: 'App Library' })
  const views = page
    .getByRole('navigation', { name: 'Global navigation' })
    .getByRole('group', { name: 'Workspace views' })
  await expect(
    library.getByRole('button', { name: 'Move Virtual left', exact: true })
  ).toBeVisible()
  await library.getByRole('button', { name: 'Disable Chat', exact: true }).click()
  // Dropping on the upper half of a row inserts before it, the lower half after.
  await views
    .getByRole('button', { name: 'Dev view', exact: true })
    .dragTo(views.getByRole('button', { name: 'Virtual view', exact: true }), {
      targetPosition: { x: 24, y: 4 },
    })
  await expect(views.getByRole('button').first()).toHaveAttribute('aria-label', 'Dev view')
  await views
    .getByRole('button', { name: 'Dev view', exact: true })
    .dragTo(views.getByRole('button', { name: 'Virtual view', exact: true }), {
      targetPosition: { x: 24, y: 28 },
    })
  await expect(views.getByRole('button').first()).toHaveAttribute('aria-label', 'Virtual view')
  await page.reload()
  await expect(views.getByRole('button').first()).toHaveAttribute('aria-label', 'Virtual view')
  await library.getByRole('button', { name: 'Enable Chat', exact: true }).click()
  await expect(views.getByRole('button').nth(2)).toHaveAttribute('aria-label', 'Chat view')
})

test('themed shell and Library remain usable across desktop and narrow layouts', async ({
  page,
}, testInfo) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat&app=library')
  const library = page.getByRole('main', { name: 'App Library' })
  const toolbar = page.getByLabel('Workspace toolbar')
  await expect(library).toBeVisible()
  const light = await toolbar.evaluate((element) => getComputedStyle(element).backgroundColor)
  await page.screenshot({ path: testInfo.outputPath('library-light-desktop.png') })
  await page.getByRole('button', { name: 'User settings', exact: true }).click()
  // Not `exact`: the shared account item appends its `⌘,` chord glyph to the
  // accessible name, which workspace-guest.spec.ts asserts is displayed.
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('tab', { name: 'Appearance', exact: true }).click()
  const appearance = settings.getByRole('region', { name: 'Appearance', exact: true })
  await appearance
    .getByRole('radiogroup', { name: 'Appearance mode', exact: true })
    .getByText('Dark', { exact: true })
    .click()
  await appearance.getByRole('button', { name: 'Save', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await expect(page.locator('html')).toHaveClass(/dark/)
  const dark = await toolbar.evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(dark).not.toBe(light)
  await page.screenshot({ path: testInfo.outputPath('library-dark-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(library.getByRole('searchbox', { name: 'Search apps', exact: true })).toBeVisible()
  // Park the pointer off-page so no hover tooltip from the settings flow is
  // captured over the page content.
  await page.mouse.move(0, 0)
  await page.screenshot({ path: testInfo.outputPath('library-dark-mobile.png') })
  await page
    .getByRole('navigation', { name: 'Global navigation' })
    .getByRole('button', { name: 'Virtual view', exact: true })
    .click()
  await expect(page.getByRole('complementary', { name: 'Virtual navigation' })).toBeVisible()
  await toolbar.getByRole('button', { name: 'Collapse contextual sidebar', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Virtual navigation' })).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
  await page.screenshot({ path: testInfo.outputPath('virtual-dark-mobile.png') })
})

test('Chat conversation surface follows the shared light and dark theme background', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  const surface = page.locator('#workspace-main')
  await expect(surface).toBeVisible()
  for (const mode of ['Light', 'Dark']) {
    await page.getByRole('button', { name: 'User settings', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('tab', { name: 'Appearance', exact: true }).click()
    const appearance = settings.getByRole('region', { name: 'Appearance', exact: true })
    await appearance
      .getByRole('radiogroup', { name: 'Appearance mode', exact: true })
      .getByText(mode, { exact: true })
      .click()
    await appearance.getByRole('button', { name: 'Save', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-appearance-mode', mode.toLowerCase())
    const colors = await surface.evaluate((element) => ({
      conversation: getComputedStyle(element).backgroundColor,
      workspace: getComputedStyle(element.closest('.conventional-workspace')!).backgroundColor,
    }))
    expect(colors.conversation).toBe(colors.workspace)
  }
})

test('repeated Chat and Library transitions release workspace event listeners', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const tracked = new Set(['hashchange', 'online', 'offline', 'keydown'])
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
    const originalAdd = window.addEventListener.bind(window)
    const originalRemove = window.removeEventListener.bind(window)
    window.addEventListener = (type, listener, options) => {
      if (listener && tracked.has(type)) {
        const id = type + ':' + Boolean(typeof options === 'boolean' ? options : options?.capture)
        const entries = listeners.get(id) ?? new Set<EventListenerOrEventListenerObject>()
        entries.add(listener)
        listeners.set(id, entries)
        if (typeof options === 'object' && options.signal) {
          options.signal.addEventListener('abort', () => entries.delete(listener), { once: true })
        }
      }
      originalAdd(type, listener, options)
    }
    window.removeEventListener = (type, listener, options) => {
      const id = type + ':' + Boolean(typeof options === 'boolean' ? options : options?.capture)
      if (listener) listeners.get(id)?.delete(listener)
      originalRemove(type, listener, options)
    }
    Object.defineProperty(window, 'workspaceListenerCounts', {
      value: () => Object.fromEntries([...listeners].map(([id, entries]) => [id, entries.size])),
    })
  })
  await mockWorkspace(page)
  await page.goto('/?view=chat')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  const cycle = async () => {
    await rail.getByRole('button', { name: 'App Library', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'App Library', exact: true })).toBeVisible()
    await rail.getByRole('button', { name: 'Chat view', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible()
  }
  // Warm lazy destinations once before comparing retained listeners.
  await cycle()
  const counts = () =>
    page.evaluate(() => {
      const read = Reflect.get(window, 'workspaceListenerCounts')
      if (typeof read !== 'function') throw new Error('Listener instrumentation is missing')
      return read()
    })
  const baseline = await counts()
  await cycle()
  await cycle()
  await expect.poll(counts).toEqual(baseline)
})

test('App Library tiles retain readable content and actions in narrow and enlarged layouts', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  await page
    .getByRole('navigation', { name: 'Global navigation' })
    .getByRole('button', { name: 'App Library', exact: true })
    .click()
  const library = page.getByRole('main', { name: 'App Library' })
  await expect(library).toBeVisible()
  const tiles = library.locator('[class~="workspace-app-library__tile"]')
  await expect(tiles.first()).toBeVisible()
  for (const scale of [1, 2]) {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate((factor) => {
      document.documentElement.style.fontSize = `${16 * factor}px`
    }, scale)
    const bounds = await tiles.evaluateAll((elements) =>
      elements.map((element) => {
        const tile = element.getBoundingClientRect()
        const media = element
          .querySelector('[class*="workspace-app-library__tile-media"]')
          ?.getBoundingClientRect()
        const name = element
          .querySelector(
            '[class*="workspace-app-library__tile-name"], [class*="workspace-app-library__tile-open"]'
          )
          ?.getBoundingClientRect()
        const controls = Array.from(element.querySelectorAll('button')).map((button) =>
          button.getBoundingClientRect()
        )
        return {
          // The tile is a vertical stack: the name sits below the icon mark
          // and stays readable, and every control — the corner toggle and the
          // open action — remains inside the tile at both font scales.
          nameBelowMedia: !!media && !!name && name.top >= media.bottom - 1 && name.width >= 24,
          controlsContained: controls.every(
            (control) =>
              control.left >= tile.left - 1 &&
              control.right <= tile.right + 1 &&
              control.top >= tile.top - 1 &&
              control.bottom <= tile.bottom + 1
          ),
        }
      })
    )
    expect(bounds.length).toBeGreaterThan(0)
    for (const tile of bounds) {
      expect(tile.nameBelowMedia).toBe(true)
      expect(tile.controlsContained).toBe(true)
    }
  }
})
