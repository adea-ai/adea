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
    const navigation = page.getByRole('complementary', { name: 'Workspace navigation' })
    if (!(await navigation.isVisible())) {
      // Crossing below 48rem closed the shared navigation and the frame-only
      // opener is display:none in that layout, so reopen through the top-bar
      // toggle that survives the narrow breakpoint.
      const toggle = page.getByRole('button', { name: 'Expand contextual sidebar' })
      if (await toggle.isVisible()) await toggle.click()
    }
    await expect(navigation).toBeVisible()
    await navigation.getByRole('button', { name: 'Create Room', exact: true }).click()
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
  // Virtual view renders the same shared contextual sidebar as chat (main gave
  // it a separate "Virtual navigation" aside, which is why this used to assert
  // absence); the shared sidebar stays put across the view switch.
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible()
  if (await virtualRoom.count()) {
    // Scope to the room region: the shared sidebar also carries a "Product"
    // button, which would make a page-wide locator ambiguous.
    await expect(virtualRoom.getByRole('button', { name: 'Product', exact: true })).toHaveAttribute(
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

test('opens the Task panel beside the board and restores focus on dismissal', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/?view=chat&app=kanban')
  const taskTrigger = page.getByRole('button', { name: 'Launch planning', exact: true })
  await taskTrigger.click()
  const detail = page.getByRole('dialog', { name: 'Edit task', exact: true })
  await expect(detail.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
    'Launch planning'
  )
  // The panel shares the Appearance panel's shape: header, scrolling body, footer.
  const body = detail.locator('[data-slot="sheet-body"]')
  await expect(body).toHaveCSS('overflow-y', 'auto')
  // Nothing to save until something changes.
  await expect(detail.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  const rootFontSize = await page
    .locator('html')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
  expect(
    await detail.evaluate((element) => Number.parseFloat(getComputedStyle(element).width))
  ).toBeCloseTo(32 * rootFontSize, 1)
  // Docked inside the main view: below the top bar, one equal gap from the top
  // bar, the end edge and the bottom of the window.
  const topBar = await page.getByLabel('Workspace toolbar').boundingBox()
  // Measure the settled panel, not a frame of its slide-in.
  await detail.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished))
  )
  const panelBox = (await detail.boundingBox())!
  const viewport = page.viewportSize()!
  const gap = viewport.width - (panelBox.x + panelBox.width)
  expect(gap).toBeGreaterThan(0)
  expect(panelBox.y - (topBar!.y + topBar!.height)).toBeCloseTo(gap, 0)
  expect(viewport.height - (panelBox.y + panelBox.height)).toBeCloseTo(gap, 0)
  await detail.getByRole('textbox', { name: 'Title', exact: true }).focus()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await expect(page).toHaveScreenshot('workspace-task-detail.png', { animations: 'disabled' })

  await page.setViewportSize({ width: 390, height: 480 })
  expect(
    await detail.evaluate((element) => Number.parseFloat(getComputedStyle(element).width))
  ).toBeCloseTo(390 - 2 * gap, 0)
  await expect
    .poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true)
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  await page.keyboard.press('Escape')
  await expect(detail).toHaveCount(0)
  await expect(taskTrigger).toBeFocused()

  await page.setViewportSize({ width: 1280, height: 720 })
  await taskTrigger.click()
  const reopenedDetail = page.getByRole('dialog', { name: 'Edit task', exact: true })
  await reopenedDetail.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(reopenedDetail).toHaveCount(0)
  await expect(taskTrigger).toBeFocused()
})

test('creates a Task from a side panel without moving the board', async ({ page }) => {
  await mockWorkspace(page)
  const created: unknown[] = []
  const boardTasks = tasks.map((task) => ({ ...task }))
  const refetch = { released: false, waiting: new Set<() => void>() }
  await page.route('**/api/v1/workspaces/**/tasks', async (route) => {
    if (route.request().method() === 'GET') {
      if (created.length > 0 && !refetch.released)
        await new Promise<void>((resolve) => {
          refetch.waiting.add(resolve)
        })
      return route.fulfill({ contentType: 'application/json', json: boardTasks })
    }
    if (route.request().method() !== 'POST') return route.fallback()
    const body = route.request().postDataJSON() as { title: string }
    created.push(body)
    const task = { ...tasks[0]!, id: 'task-new', title: body.title, version: 1 }
    boardTasks.push(task)
    return route.fulfill({
      contentType: 'application/json',
      json: { task },
    })
  })
  await page.goto('/?view=chat&app=kanban')
  // A CSS locator: the open modal panel hides the board from role queries.
  const board = page.locator('.conventional-kanban__board')
  await expect(board).toBeVisible()
  const before = await board.boundingBox()
  await page.getByRole('button', { name: 'New task', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'New task', exact: true })
  await expect(panel).toBeVisible()
  expect(await board.boundingBox()).toEqual(before)
  // Create is offered only once the task has a title.
  const create = panel.getByRole('button', { name: 'Create task', exact: true })
  await expect(create).toBeDisabled()
  await panel.getByRole('textbox', { name: 'Title', exact: true }).fill('   ')
  await expect(create).toBeDisabled()
  await panel.getByRole('textbox', { name: 'Title', exact: true }).fill('Write release notes')
  await expect(create).toBeEnabled()
  try {
    await panel.getByRole('button', { name: 'Create task', exact: true }).click()
    await expect(panel).toHaveCount(0)
    await expect.poll(() => created.length).toBe(1)
    await expect.poll(() => refetch.waiting.size).toBeGreaterThan(0)
    // The server's create result supplies the card even while list reconciliation is held.
    await expect(
      board.getByRole('button', { name: 'Write release notes', exact: true })
    ).toBeVisible()
  } finally {
    refetch.released = true
    for (const release of refetch.waiting) release()
    refetch.waiting.clear()
  }
})

test('edits a Task with first-click selects and closes on Save without reopening', async ({
  page,
}) => {
  await mockWorkspace(page)
  const updates: unknown[] = []
  const boardTasks = tasks.map((task) => ({ ...task }))
  await page.route('**/api/v1/workspaces/**/tasks**', async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (method === 'GET' && url.pathname.endsWith('/tasks'))
      return route.fulfill({ contentType: 'application/json', json: boardTasks })
    if (method !== 'PATCH' || !url.pathname.endsWith('/tasks/task-launch')) return route.fallback()
    updates.push(route.request().postDataJSON())
    const index = boardTasks.findIndex(({ id }) => id === 'task-launch')
    const task = {
      ...boardTasks[index]!,
      priority: 'urgent',
      version: boardTasks[index]!.version + 1,
    }
    boardTasks.splice(index, 1, task)
    return route.fulfill({ contentType: 'application/json', json: { task } })
  })
  await page.goto('/?view=chat&app=kanban')
  const card = page.getByRole('button', { name: 'Launch planning', exact: true })
  await card.click()
  const detail = page.getByRole('dialog', { name: 'Edit task', exact: true })
  const save = detail.getByRole('button', { name: 'Save', exact: true })
  await expect(save).toBeDisabled()

  // The Priority select opens on the first click and stays open.
  await detail.getByRole('button', { name: /^Priority/ }).click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible()
  await page.waitForTimeout(300)
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name: 'Urgent', exact: true }).click()
  await expect(detail.getByRole('button', { name: /^Priority/ })).toContainText('Urgent')
  await expect(detail.getByText('Unsaved changes', { exact: true })).toBeVisible()
  await expect(save).toBeEnabled()

  // Save closes the panel once, for good: count every dialog that mounts after it.
  await page.evaluate(() => {
    const seen = { count: 0 }
    ;(window as unknown as { kanbanDialogMounts: typeof seen }).kanbanDialogMounts = seen
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof HTMLElement && node.querySelector('[role="dialog"]')) seen.count++
    }).observe(document.body, { childList: true, subtree: true })
  })
  await save.click()
  await expect(detail).toHaveCount(0)
  await expect(page.getByLabel('Priority: Urgent')).toBeVisible()
  await expect.poll(() => updates.length).toBe(1)
  await page.waitForTimeout(500)
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { kanbanDialogMounts: { count: number } }).kanbanDialogMounts.count
    )
  ).toBe(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
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

  await page.goto('/?view=chat&app=kanban')
  const board = page.getByRole('region', { name: 'Task board' })
  const planned = board.getByRole('region', { name: 'Planned' })
  const queued = board.getByRole('region', { name: 'Queued' })
  const inProgress = board.getByRole('region', { name: 'In progress' })
  const completed = board.getByRole('region', { name: 'Completed' })
  const taskTrigger = planned.getByRole('button', { name: 'Launch planning', exact: true })

  await expect(taskTrigger).toBeVisible()
  await expect(planned.locator('[data-slot="board-column-count"]')).toHaveText('1')
  await expect(queued.locator('[data-slot="board-column-count"]')).toHaveText('1')
  await expect(planned.getByLabel('Priority: High')).toBeVisible()
  // Empty lanes fold to a sideways label; lanes holding cards stay open.
  await expect(inProgress).toHaveAttribute('data-collapsed', '')
  await expect(planned).not.toHaveAttribute('data-collapsed', '')
  await expect(planned.getByText('Prepare the launch brief and confirm audience.')).toBeVisible()
  await expect(planned.getByText('Research Agent')).toBeVisible()
  await expect(planned.getByText('Product', { exact: true })).toBeVisible()
  await expect(queued.getByRole('button', { name: 'Review launch', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('task-board.png'), animations: 'disabled' })

  await taskTrigger.focus()
  await page.keyboard.press('Control+ArrowRight')
  await expect(queued.getByRole('button', { name: 'Launch planning', exact: true })).toBeVisible()
  await expect(planned.locator('[data-slot="board-column-count"]')).toHaveText('0')
  await expect(queued.locator('[data-slot="board-column-count"]')).toHaveText('2')
  await expect.poll(() => taskActions).toContain('task-launch/queue')
  const queuedCard = queued
    .getByRole('button', { name: 'Launch planning', exact: true })
    .locator('xpath=ancestor::article[@aria-roledescription="Draggable card"]')
  await expect(queuedCard).toBeFocused()
  await queuedCard.dragTo(planned)
  await expect(planned.locator('[data-slot="board-column-count"]')).toHaveText('0')
  await expect(queued.locator('[data-slot="board-column-count"]')).toHaveText('2')
  await expect.poll(() => taskActions).toEqual(['task-launch/queue'])

  await queuedCard.focus()
  await page.keyboard.press('Control+ArrowRight')
  await expect(
    inProgress.getByRole('button', { name: 'Launch planning', exact: true })
  ).toBeVisible()
  await expect(queued.locator('[data-slot="board-column-count"]')).toHaveText('1')
  await expect(inProgress.locator('[data-slot="board-column-count"]')).toHaveText('1')
  await expect.poll(() => taskActions).toContain('task-launch/start')

  const inReview = board.getByRole('region', { name: 'In review' })
  const launchCard = inProgress
    .getByRole('button', { name: 'Launch planning', exact: true })
    .locator('xpath=ancestor::article[@aria-roledescription="Draggable card"]')
  await inReview.scrollIntoViewIfNeeded()
  await launchCard.dragTo(inReview)
  await expect(inReview.getByRole('button', { name: 'Launch planning', exact: true })).toBeVisible()
  await expect(inProgress.locator('[data-slot="board-column-count"]')).toHaveText('0')
  await expect(inReview.locator('[data-slot="board-column-count"]')).toHaveText('1')
  await expect.poll(() => taskActions).toContain('task-launch/review')
  const inReviewCard = inReview
    .getByRole('button', { name: 'Launch planning', exact: true })
    .locator('xpath=ancestor::article[@aria-roledescription="Draggable card"]')
  await expect(inReviewCard).toBeFocused()
  await page.keyboard.press('Control+ArrowRight')
  await expect(
    completed.getByRole('button', { name: 'Launch planning', exact: true })
  ).toBeVisible()
  await expect(inReview.locator('[data-slot="board-column-count"]')).toHaveText('0')
  await expect(completed.locator('[data-slot="board-column-count"]')).toHaveText('1')
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
  // The modal sheet marks the frame aria-hidden, so the toolbar toggle is
  // unreachable for role queries; match it through the DOM instead. The DOM
  // query must be scoped: the default trailing toggle also carries the
  // contextual-sidebar label while its group is display:none below 48rem.
  await expect(
    page
      .locator('.workspace-topbar__navigation-controls')
      .locator('[aria-label="Collapse contextual sidebar"]')
  ).toHaveAttribute('aria-expanded', 'true')
  await expect(navigation.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(navigation.getByRole('region', { name: 'Rooms' })).toBeVisible()
  await expect(navigation.getByRole('region', { name: 'Conversations' })).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-narrow-light.png', { animations: 'disabled' })
  await navigation.getByRole('button', { name: 'Close workspace navigation' }).click()
  const contextualToggle = page.getByRole('button', { name: 'Expand contextual sidebar' })
  // Finish the sheet's close/focus-restoration transition before opening the
  // next overlay, so Search captures a persistent opener rather than its
  // departing close button.
  await expect(navigation).not.toBeVisible()
  await expect(contextualToggle).toBeFocused()

  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Search workspace' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Search workspace' })).not.toBeVisible()
  await expect(contextualToggle).toBeFocused()
  const workspaceMain = page.locator('#workspace-main')
  await workspaceMain.focus()
  await expect(workspaceMain).toBeFocused()
  // Dismissing the sheet mounts the collapsed toggle under the parked pointer;
  // move to the empty page corner before capturing the settled dark workspace.
  await page.mouse.move(0, 0)
  await expect(page.getByRole('tooltip')).toHaveCount(0)

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
  // The row button keeps the channel name as its accessible name; the unread
  // count is an aria-hidden badge inside the row, so anchor on that.
  await expect(
    page.getByRole('button', { name: 'Product', exact: true }).locator('.conventional-unread-badge')
  ).toBeVisible({ timeout: 15_000 })

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

test('shared sidebar reports failed mark-all-read actions and preserves Virtual status', async ({
  page,
}) => {
  await mockWorkspace(page)
  await page.route('**/api/v1/workspaces/workspace-e2e/read-state', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        contentType: 'application/json',
        json: { error: 'temporary failure' },
        status: 503,
      })
      return
    }
    await route.fallback()
  })
  await page.goto('/?view=chat')

  const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(sidebar.getByRole('button', { name: 'Mark all read' })).toBeEnabled()
  await sidebar.getByRole('button', { name: 'Mark all read' }).click()
  await expect(sidebar.getByRole('alert')).toContainText(
    'Unread conversations could not be marked as read.'
  )

  const toolbar = page.getByLabel('Workspace toolbar')
  await page
    .getByRole('navigation', { name: 'Global navigation' })
    .getByRole('button', { name: 'Virtual view', exact: true })
    .click()
  const virtualSidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(virtualSidebar.getByRole('button', { name: 'Mark all read' })).toBeEnabled()
  await virtualSidebar.getByRole('button', { name: 'Mark all read' }).click()
  await expect(virtualSidebar.getByRole('alert')).toContainText(
    'Unread conversations could not be marked as read.'
  )
  await toolbar.getByRole('button', { name: 'Collapse contextual sidebar' }).click()
  await expect(virtualSidebar).toBeHidden()
  const viewportWidth = await page
    .locator('.workspace-scene-viewport')
    .evaluate((element) => element.getBoundingClientRect().width)
  const shellWidth = await page
    .locator('.workspace-shell--contextual')
    .evaluate((element) => element.getBoundingClientRect().width)
  expect(viewportWidth).toBeGreaterThanOrEqual(shellWidth - 1)
  await toolbar.getByRole('button', { name: 'Expand contextual sidebar' }).click()
  await expect(virtualSidebar).toBeVisible()
  await expect(virtualSidebar.getByRole('alert')).toContainText(
    'Unread conversations could not be marked as read.'
  )
})

test('workspace search keeps duplicate destination labels tied to their domain identity', async ({
  page,
}) => {
  await mockWorkspace(page)
  await page.goto('/')
  // Control+k pressed during the first paint lands before the workspace
  // installs its shortcut listener, so anchor on loaded chrome first.
  // The row button keeps the channel name as its accessible name; the unread
  // count is an aria-hidden badge inside the row, so anchor on that.
  await expect(
    page.getByRole('button', { name: 'Product', exact: true }).locator('.conventional-unread-badge')
  ).toBeVisible({ timeout: 15_000 })
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
  // Crossing below 48rem closes the shared navigation; that path must not
  // dismiss the dialog the test is capturing.
  await expect(reloadedSettings).toBeVisible()
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
    const workspaceTab = tablist.getByRole('tab', { name: 'Workspace', exact: true })
    const permissions = tablist.getByRole('tab', { name: 'Permissions', exact: true })
    await expect(tablist).toHaveAttribute('data-slot', 'settings-navigation')
    await expect(tablist).toHaveAttribute('aria-orientation', 'vertical')

    await account.focus()
    await page.keyboard.press('ArrowDown')
    await expect(appearance).toBeFocused()
    await expect(appearance).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(/#settings\/appearance$/)

    await page.keyboard.press('ArrowDown')
    await expect(workspaceTab).toBeFocused()
    await expect(workspaceTab).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(/#settings\/workspace$/)

    await page.keyboard.press('Home')
    await expect(account).toBeFocused()
    await expect(page).toHaveURL(/#settings\/account$/)

    await page.keyboard.press('End')
    await expect(permissions).toBeFocused()
    // Font metrics shift fractional line heights at the narrow widths, so the
    // scrolled-in tab can sit a sub-pixel outside the viewport; require the
    // focus target to be visible, not pixel-exact.
    await expect(permissions).toBeInViewport({ ratio: 0.99 })
    await expect(
      settings.getByRole('heading', { name: 'Permissions', level: 3, exact: true })
    ).toBeInViewport({ ratio: 0.99 })
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
  const navigation = page.getByRole('complementary', { name: 'Workspace navigation' })
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

for (const designer of ['roomDesigner', 'characterDesigner'] as const) {
  test(`Virtual ${designer} keeps the global rail without contextual sidebars`, async ({
    page,
  }) => {
    await mockConnectedWorkspace(page)
    await page.goto(`/?view=chat&${designer}=1`)
    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    await expect(
      page.getByRole('heading', { name: 'Virtual view lives in Agent Sim' })
    ).toBeVisible()
    // Edit mode drops the contextual sidebar on purpose: the designer fills the
    // viewport, and the top bar plus the designer's own close are the way back.
    await expect(sidebar).toHaveCount(0)
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
    const rail = page.getByRole('navigation', { name: 'Global navigation' })
    await expect(rail).toBeVisible()
    await expect(
      page.getByRole('complementary', { name: 'Shared developer utilities' })
    ).toHaveCount(0)
    const toolbar = page.getByLabel('Workspace toolbar')
    await expect(
      toolbar.getByRole('button', { name: /(?:Collapse|Expand) (?:contextual|utility) sidebar/ })
    ).toHaveCount(0)
    const bounds = await page.locator('.workspace-frame').evaluate((frame) => {
      const railBounds = frame.querySelector('.global-rail')!.getBoundingClientRect()
      const surface = frame.querySelector('.workspace-frame__surface')!.getBoundingClientRect()
      return { railWidth: railBounds.width, gap: Math.abs(surface.left - railBounds.right) }
    })
    expect(bounds.railWidth).toBeGreaterThan(0)
    expect(bounds.gap).toBeLessThanOrEqual(1)
    await rail.getByRole('button', { name: 'Chat view', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible()
    await expect(rail).toBeVisible()
    await expect(page).not.toHaveURL(/(?:roomDesigner|characterDesigner)=1/)
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`${designer}=1`))
    await expect(
      page.getByRole('heading', { name: 'Virtual view lives in Agent Sim' })
    ).toBeVisible()
    await expect(sidebar).toHaveCount(0)
    await expect(rail).toBeVisible()
    await expect(
      toolbar.getByRole('button', { name: /(?:Collapse|Expand) (?:contextual|utility) sidebar/ })
    ).toHaveCount(0)
  })
}

test('Chat and Virtual use the same resizable sidebar and preserve selection and thread state', async ({
  page,
}) => {
  await mockWorkspace(page)
  await page.setViewportSize({ width: 1280, height: 840 })
  await page.goto('/?view=chat')

  const toolbar = page.getByLabel('Workspace toolbar')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  const chatSidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  const expectAlignedDivider = async () => {
    for (const width of [1024, 1280]) {
      await page.setViewportSize({ width, height: 840 })
      await expect
        .poll(async () => {
          const sidebar = await chatSidebar.boundingBox()
          const divider = await toolbar.locator('.workspace-topbar__view-divider').boundingBox()
          if (!sidebar || !divider) return Number.POSITIVE_INFINITY
          return Math.abs(divider.x - (sidebar.x + sidebar.width))
        })
        .toBeLessThanOrEqual(1)
    }
  }
  await expect(
    chatSidebar.getByRole('button', { name: 'Research Agent', exact: true })
  ).toBeVisible()
  await expect(chatSidebar.getByRole('button', { name: 'Launch group', exact: true })).toBeVisible()
  await expectAlignedDivider()
  await expect(
    chatSidebar
      .getByRole('button', { name: 'Product', exact: true })
      .locator('.conventional-unread-badge')
  ).toBeVisible()

  await chatSidebar.getByRole('button', { name: 'Research Agent', exact: true }).click()
  await expect(page.getByText('Direct Conversation', { exact: true })).toBeVisible()
  const resizeHandle = page.getByRole('separator', { name: 'Resize workspace navigation' })
  const initialWidth = await chatSidebar.evaluate(
    (element) => element.getBoundingClientRect().width
  )
  await resizeHandle.focus()
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(() => chatSidebar.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(initialWidth)
  const resizedWidth = await chatSidebar.evaluate(
    (element) => element.getBoundingClientRect().width
  )
  await expectAlignedDivider()

  // The keyboard resize leaves :focus-visible on the handle, which is
  // interaction state rather than rendering identity; drop it so the capture
  // compares the sidebar itself.
  await resizeHandle.evaluate((element) => element.blur())
  // Capture each sidebar immediately after its own view switch: a freshly
  // mounted view rasterizes identically, while capturing chat straight after
  // the keyboard reflow can round the unread pill's antialiasing differently.
  await rail.getByRole('button', { name: 'Virtual view', exact: true }).click()
  const virtualSidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(virtualSidebar).toBeVisible()
  await expectAlignedDivider()
  await expect(
    virtualSidebar.getByRole('button', { name: 'Research Agent', exact: true })
  ).toHaveAttribute('aria-current', 'page')
  expect(await virtualSidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(
    resizedWidth
  )
  // The pointer is still parked on whichever control the previous step clicked,
  // and hover paint — row highlights, rail tooltips that overhang the sidebar's
  // edge — is interaction state rather than rendering identity. Park it on the
  // non-interactive top-bar title before every capture.
  await page.mouse.move(600, 24)
  await page.waitForTimeout(250)
  const virtualSidebarShot = await virtualSidebar.screenshot({ animations: 'disabled' })

  await rail.getByRole('button', { name: 'Chat view', exact: true }).click()
  await expect(page.getByText('Direct Conversation', { exact: true })).toBeVisible()
  expect(await chatSidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(
    resizedWidth
  )
  await page.mouse.move(600, 24)
  await page.waitForTimeout(250)
  const wideChatSidebar = await chatSidebar.screenshot({ animations: 'disabled' })
  expect(virtualSidebarShot).toEqual(wideChatSidebar)

  await page.getByRole('button', { name: /^Product( |$)/ }).click()
  await page.getByRole('button', { name: 'Thread', exact: true }).first().click()
  // The shared thread panel titles itself through the aside's accessible name
  // ("Thread: <label>"); its visible "Thread" caption is a span, not a heading.
  await expect(
    page.getByRole('complementary', { name: 'Thread: Focused discussion' })
  ).toBeVisible()
  await rail.getByRole('button', { name: 'Virtual view', exact: true }).click()
  await expect(virtualSidebar.getByRole('button', { name: /^Product( |$)/ })).toHaveAttribute(
    'aria-current',
    'page'
  )
  await rail.getByRole('button', { name: 'Chat view', exact: true }).click()
  await expect(
    page.getByRole('complementary', { name: 'Thread: Focused discussion' })
  ).toBeVisible()

  await page.setViewportSize({ width: 390, height: 840 })
  // Narrow layouts start with the contextual sidebar collapsed, so the collapse
  // control is already gone; only click it if the sidebar survived the resize.
  if (await chatSidebar.isVisible()) {
    await toolbar.getByRole('button', { name: 'Collapse contextual sidebar' }).click()
  }
  await expect(chatSidebar).toBeHidden()
  await toolbar.getByRole('button', { name: 'Expand contextual sidebar' }).click()
  await expect(chatSidebar).toBeVisible()
  await page.mouse.move(600, 24)
  await page.waitForTimeout(250)
  const narrowChatSidebar = await chatSidebar.screenshot({ animations: 'disabled' })
  // At this width the expanded sidebar is a modal sheet that hides the rest of
  // the app (aria-hidden), so dismiss it before touching the rail.
  await page.keyboard.press('Escape')
  await expect(chatSidebar).toBeHidden()
  await rail.getByRole('button', { name: 'Virtual view', exact: true }).click()
  if (!(await virtualSidebar.isVisible())) {
    await toolbar.getByRole('button', { name: 'Expand contextual sidebar' }).click()
  }
  await expect(virtualSidebar).toBeVisible()
  await page.mouse.move(600, 24)
  await page.waitForTimeout(250)
  expect(await virtualSidebar.screenshot({ animations: 'disabled' })).toEqual(narrowChatSidebar)
})

test('Virtual sidebar actions create a room and group conversation through workspace services', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=virtual')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(sidebar.getByRole('button', { name: 'Create Room' })).toBeVisible()

  await sidebar.getByRole('button', { name: 'Create Room' }).click()
  await page.getByRole('button', { name: 'Engineering', exact: true }).click()
  await expect(rail.getByRole('button', { name: 'Chat view', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.getByRole('button', { name: 'Engineering', exact: true })).toBeVisible()

  await rail.getByRole('button', { name: 'Virtual view', exact: true }).click()
  await expect(sidebar).toBeVisible()
  await sidebar.getByRole('button', { name: 'Create group conversation' }).click()
  const groupDialog = page.getByRole('dialog', { name: 'New group conversation' })
  await groupDialog.getByLabel('Conversation name').fill('Virtual group')
  await groupDialog.getByRole('button', { name: 'Create conversation' }).click()
  await expect(page.getByRole('button', { name: 'Virtual group', exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  )
  await expect(page.getByText('Group conversation', { exact: true })).toBeVisible()
})

test.describe('touch workspace sidebar actions', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  })

  test('exposes row actions without hover and opens the room menu by touch', async ({ page }) => {
    await mockConnectedWorkspace(page)
    await page.goto('/?view=chat')

    // The frame-only opener is display:none in this layout, so open the
    // navigation through the top-bar toggle instead.
    const openNavigation = page.getByRole('button', { name: 'Expand contextual sidebar' })
    await expect(openNavigation).toBeVisible()
    await openNavigation.tap()

    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    const roomOptions = sidebar.getByRole('button', { name: 'Room options for Product' })
    const conversationOptions = sidebar.getByRole('button', {
      name: 'Conversation options for Research Agent',
    })
    await expect(roomOptions).toBeVisible()
    await expect(conversationOptions).toBeVisible()

    const roomActions = roomOptions.locator(
      'xpath=ancestor::*[@data-slot="sidebar-nav-row-actions"]'
    )
    const conversationActions = conversationOptions.locator(
      'xpath=ancestor::*[@data-slot="sidebar-nav-row-actions"]'
    )
    await expect
      .poll(() => roomActions.evaluate((node) => getComputedStyle(node).opacity))
      .toBe('1')
    await expect
      .poll(() => conversationActions.evaluate((node) => getComputedStyle(node).opacity))
      .toBe('1')

    await roomOptions.tap()
    // The row menu portals to the document body, outside the navigation aside.
    await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeVisible()
  })

  test('keeps a navigation opened during boot open when the sidebar mounts', async ({ page }) => {
    await mockConnectedWorkspace(page)
    // Hold the bootstrap response so the workspace shell stays on the loading
    // skeleton: on loaded runners the sidebar tests press the toggle while
    // the shell is still mounting, and the press below can then only arm the
    // store's open flag before the sidebar (and its Sheet) exists.
    let releaseBootstrap: (() => void) | undefined
    const bootGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve
    })
    // Registered last, so this gate shadows mockConnectedWorkspace's
    // bootstrap fulfilment while every other route falls through to it.
    await page.route('**/api/workspaces/bootstrap', async (route) => {
      await bootGate
      return route.fallback()
    })

    await page.goto('/?view=chat')
    const toolbar = page.getByLabel('Workspace toolbar')
    const navigationToggle = toolbar.getByRole('button', {
      name: /^(Expand|Collapse) contextual sidebar$/,
    })
    await expect(navigationToggle).toBeVisible()
    await expect(page.locator('.conventional-workspace--loading')).toBeVisible()

    await navigationToggle.press('Enter')

    // Boot lands; the sidebar mounts with the open flag armed. The viewport
    // guard used to misread that mount as a desktop-to-narrow crossing and
    // force-close the flag, so the Sheet never appeared at all.
    releaseBootstrap!()
    const navigationDialog = page.getByRole('dialog')
    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    await expect(navigationDialog).toHaveAttribute('data-expanded', '')
    await expect(sidebar).toBeVisible()
    await expect(sidebar.locator('button:not(:disabled)').first()).toBeFocused()

    // Give any late boot churn time to land, then re-assert: the Sheet must
    // not flip closed on its own.
    await page.waitForTimeout(1000)
    await expect(navigationDialog).toHaveAttribute('data-expanded', '')
    await expect(sidebar).toBeVisible()
  })

  test('keeps Chat and Virtual navigation controls inside a 320px viewport at 200% root size', async ({
    page,
  }) => {
    await mockConnectedWorkspace(page)
    await page.setViewportSize({ width: 320, height: 800 })
    await page.goto('/?view=chat')
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%'
    })

    const toolbar = page.getByLabel('Workspace toolbar')
    const navigationToggle = toolbar.getByRole('button', {
      name: /^(Expand|Collapse) contextual sidebar$/,
    })
    await expect(navigationToggle).toBeVisible()
    const toggleBounds = await navigationToggle.boundingBox()
    expect(toggleBounds).not.toBeNull()
    expect(toggleBounds!.x).toBeGreaterThanOrEqual(0)
    expect(toggleBounds!.x + toggleBounds!.width).toBeLessThanOrEqual(320)

    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    const assertSidebarFits = async () => {
      const layout = await sidebar.evaluate((element) => {
        const panel = element.getBoundingClientRect()
        const title = element.querySelector('h1')
        const titleBounds = title?.getBoundingClientRect()
        const close = element.querySelector('.conventional-sidebar__close')
        const closeBounds = close?.getBoundingClientRect()
        const actionButtons = Array.from(
          element.querySelectorAll('[data-slot="sidebar-nav-row-actions"] button')
        )
        const labels = Array.from(
          element.querySelectorAll('[data-slot="sidebar-nav-label"]')
        ).filter((label) => label.closest('button'))
        const withinPanel = (bounds: DOMRect) =>
          bounds.left >= panel.left - 1 && bounds.right <= panel.right + 1

        return {
          actionBounds: actionButtons.map((button) => {
            // The sheet content scrolls at this size; bring each control into
            // view so the hit test measures the control, not the pinned
            // footer band or the viewport edge covering it off-screen.
            button.scrollIntoView({ block: 'center' })
            const bounds = button.getBoundingClientRect()
            const hitTarget = document.elementFromPoint(
              bounds.left + bounds.width / 2,
              bounds.top + bounds.height / 2
            )
            return {
              fits: withinPanel(bounds),
              receivesHit: hitTarget === button || button.contains(hitTarget),
            }
          }),
          closeFits: closeBounds ? withinPanel(closeBounds) : false,
          titleFits: titleBounds ? withinPanel(titleBounds) : false,
          labelBounds: labels.map((label) => {
            const bounds = label.getBoundingClientRect()
            const style = getComputedStyle(label)
            return {
              fits: withinPanel(bounds),
              minWidth: style.minWidth,
              textOverflow: style.textOverflow,
              width: bounds.width,
              whiteSpace: style.whiteSpace,
            }
          }),
          panel: { left: panel.left, right: panel.right, width: panel.width },
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        }
      })

      expect(layout.documentWidth).toBe(layout.viewportWidth)
      expect(layout.panel.left).toBeGreaterThanOrEqual(0)
      expect(layout.panel.right).toBeLessThanOrEqual(layout.viewportWidth + 1)
      expect(layout.closeFits).toBe(true)
      expect(layout.titleFits).toBe(true)
      expect(layout.actionBounds.length).toBeGreaterThan(0)
      expect(layout.actionBounds.every(({ fits, receivesHit }) => fits && receivesHit)).toBe(true)
      expect(layout.labelBounds.length).toBeGreaterThan(0)
      expect(
        layout.labelBounds.every(
          ({ fits, minWidth, textOverflow, width, whiteSpace }) =>
            fits &&
            width > 0 &&
            minWidth === '0px' &&
            textOverflow === 'ellipsis' &&
            whiteSpace === 'nowrap'
        )
      ).toBe(true)
      return layout
    }

    await navigationToggle.tap()
    await expect(sidebar).toBeVisible()
    await expect(sidebar.getByRole('button', { name: /^Product( |$)/ })).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Room options for Product' })).toBeVisible()
    await expect
      .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().left))
      .toBeGreaterThanOrEqual(0)
    const chatLayout = await assertSidebarFits()

    await sidebar.getByRole('button', { name: 'Close workspace navigation' }).tap()
    await page
      .getByRole('navigation', { name: 'Global navigation' })
      .getByRole('button', { name: 'Virtual view', exact: true })
      .tap()
    const expandVirtualNavigation = toolbar.getByRole('button', {
      name: 'Expand contextual sidebar',
    })
    await expect(expandVirtualNavigation).toBeVisible()
    await expandVirtualNavigation.tap()
    await expect(sidebar).toBeVisible()
    await expect
      .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().left))
      .toBeGreaterThanOrEqual(0)
    const virtualLayout = await assertSidebarFits()
    expect(virtualLayout.panel).toEqual(chatLayout.panel)
    expect(virtualLayout.actionBounds.length).toBe(chatLayout.actionBounds.length)
    expect(virtualLayout.labelBounds.map(({ width }) => width)).toEqual(
      chatLayout.labelBounds.map(({ width }) => width)
    )
  })

  test('mobile navigation traps focus, closes with Escape, and restores focus', async ({
    page,
  }) => {
    await mockConnectedWorkspace(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/?view=chat')

    const toolbar = page.getByLabel('Workspace toolbar')
    const navigationToggle = toolbar.getByRole('button', {
      name: /^(Expand|Collapse) contextual sidebar$/,
    })
    // Keyboard activation through the locator, not focus + a raw keypress:
    // the toolbar re-renders as boot responses land, a focus captured earlier
    // can be dropped before the keypress fires, and on loaded runners the
    // Enter then hits nothing and the sheet never opens. press() resolves the
    // button again under actionability right before pressing.
    await navigationToggle.press('Enter')

    const navigationDialog = page.getByRole('dialog')
    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    const sidebarButtons = sidebar.locator('button:not(:disabled)')
    // Kobalte marks the open dialog with data-expanded rather than aria-modal;
    // the Tab-wrap assertions below prove the modality behaviorally.
    await expect(navigationDialog).toHaveAttribute('data-expanded', '')
    await expect(sidebar).toBeVisible()
    await expect(sidebarButtons.first()).toBeFocused()

    await page.keyboard.press('Shift+Tab')
    await expect(sidebarButtons.last()).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(sidebarButtons.first()).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(sidebar).not.toBeVisible()
    await expect(navigationToggle).toBeFocused()

    await navigationToggle.press('Enter')
    await expect(sidebar).toBeVisible()

    const createRoom = sidebar.getByRole('button', { name: 'Create Room' })
    await createRoom.click()
    const roomDialog = page.getByRole('dialog', { name: 'Create Room' })
    await expect(roomDialog.locator(':focus')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(roomDialog).not.toBeVisible()
    await expect(sidebar).toBeVisible()
    await expect(createRoom).toBeFocused()
    // The open sheet hides the toolbar from role queries, so query the DOM
    // directly; locator resolution would keep failing on the hidden element.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const toggle = document.querySelector(
            '[aria-label="Expand contextual sidebar"], [aria-label="Collapse contextual sidebar"]'
          )
          return Boolean(toggle) && toggle !== document.activeElement
        })
      )
      .toBe(true)

    const createGroup = sidebar.getByRole('button', { name: 'Create group conversation' })
    await createGroup.click()
    const groupDialog = page.getByRole('dialog', { name: 'New group conversation' })
    await expect(groupDialog.getByLabel('Conversation name')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(groupDialog).not.toBeVisible()
    await expect(sidebar).toBeVisible()
    await expect(createGroup).toBeFocused()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const toggle = document.querySelector(
            '[aria-label="Expand contextual sidebar"], [aria-label="Collapse contextual sidebar"]'
          )
          return Boolean(toggle) && toggle !== document.activeElement
        })
      )
      .toBe(true)

    await sidebar.getByRole('button', { name: 'Research Agent', exact: true }).click()
    await expect(sidebar).not.toBeVisible()
    await expect(navigationToggle).toBeFocused()
    await expect(page.locator('#workspace-main')).toContainText('Research Agent')
  })

  test('selecting navigation closes the shared mobile sheet in Chat and Virtual', async ({
    page,
  }) => {
    await mockConnectedWorkspace(page)
    await page.setViewportSize({ width: 390, height: 844 })

    for (const view of ['chat', 'virtual'] as const) {
      await page.goto(`/?view=${view}`)
      const toolbar = page.getByLabel('Workspace toolbar')
      const navigationToggle = toolbar.getByRole('button', {
        name: /^(Expand|Collapse) contextual sidebar$/,
      })
      await navigationToggle.press('Enter')

      const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
      await expect(sidebar).toBeVisible()
      await sidebar.getByRole('button', { name: 'Research Agent', exact: true }).click()
      await expect(sidebar).not.toBeVisible()
      await expect(navigationToggle).toHaveAttribute('aria-expanded', 'false')
      await expect(navigationToggle).toBeFocused()
    }
  })

  test('mobile Sheet reparenting preserves the persisted inline sidebar width', async ({
    page,
  }) => {
    await mockConnectedWorkspace(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript(() => {
      localStorage.setItem('adea:workspace-sidebar-width', '320')
    })
    await page.goto('/?view=chat')

    const toolbar = page.getByLabel('Workspace toolbar')
    const navigationToggle = toolbar.getByRole('button', {
      name: /^(Expand|Collapse) contextual sidebar$/,
    })
    await navigationToggle.press('Enter')
    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    await expect(sidebar).toBeVisible()

    await page.setViewportSize({ width: 1280, height: 844 })
    await expect(sidebar).toBeVisible()
    await expect(
      page.getByRole('separator', { name: 'Resize workspace navigation' })
    ).toBeAttached()
    await expect
      .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width))
      .toBe(320)
  })
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
    const toggle = toolbar.getByRole('button', { name: /^(Expand|Collapse) contextual sidebar$/ })
    if (width < 768) {
      // Crossing below 48rem closes the sheet-backed navigation, so settle
      // that contract, reopen it, then collapse through the dialog's own
      // dismissal — the modal sheet hides the toolbar from role queries.
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      await expect(sidebar).toBeVisible()
      await page.keyboard.press('Escape')
    } else {
      await expect(sidebar).toBeVisible()
      await toggle.click()
    }
    await expect(sidebar).toBeHidden()
    await expect(sidebar).toHaveCount(0)
    // A zero-width grid column alone clips pixels but leaves its controls in
    // the focus order and native accessibility tree. Below 48rem the panel
    // unmounts entirely; both cases must leave nothing focusable behind.
    expect(
      await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>('.conventional-sidebar button')
        if (!button) return false
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
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible()
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
  // Kanban is on by default: it is the only place tasks are listed.
  await expect(library.getByRole('button', { name: 'Disable Kanban', exact: true })).toBeVisible()
  await library.getByRole('button', { name: 'Open Kanban', exact: true }).click()
  await expect(page).toHaveURL(/app=kanban/)
  await expect(page.locator('.conventional-workspace--board')).toBeVisible()
  // The board is a full-width app: no workspace sidebar beside it.
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Task board', exact: true })).toBeVisible()
  await expect(rail.getByRole('button', { name: 'Kanban', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  await library.getByRole('button', { name: 'Enable Source control', exact: true }).click()
  await library.getByRole('button', { name: 'Open Source control', exact: true }).click()
  await expect(page).toHaveURL(/app=source-control/)
  // The source control app needs the desktop runtime; the web build says so
  // instead of rendering an empty inbox.
  const sourceControl = page.getByRole('main', { name: 'Source control' })
  await expect(sourceControl).toBeVisible()
  await expect(sourceControl).toContainText('Source control needs the Adea desktop runtime')
  await expect(rail.getByRole('button', { name: 'Source control', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.getByRole('button', { name: 'Restore utility pane', exact: true })).toHaveCount(
    0
  )
})

test('all-off stale links remain in Library while enabling the first app', async ({ page }) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  const library = page.getByRole('main', { name: 'App Library' })
  for (const name of ['Virtual', 'Chat', 'Dev', 'Kanban'])
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
  await expect(rail.getByRole('status')).toHaveText('Chat moved to position 1 of 4')
  await expect(views.getByRole('button').first()).toHaveAttribute('aria-label', 'Chat view')
  await page.reload()
  await expect(views.getByRole('button').first()).toHaveAttribute('aria-label', 'Chat view')
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  const library = page.getByRole('main', { name: 'App Library' })
  await library.getByRole('button', { name: 'Open Kanban', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Kanban', exact: true })).toBeVisible()
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
  // Reset restores the defaults, and Kanban is one of them.
  await expect(rail.getByRole('button', { name: 'Kanban', exact: true })).toHaveCount(1)
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
  await expect.poll(appOrder).toEqual(['virtual', 'chat', 'dev', 'kanban'])
  const moveDevLeft = library.getByRole('button', { name: 'Move Dev left', exact: true })
  await moveDevLeft.focus()
  await page.keyboard.press('Enter')
  await expect.poll(appOrder).toEqual(['virtual', 'dev', 'chat', 'kanban'])
  await expect(library.getByRole('button', { name: 'Move Dev left', exact: true })).toBeFocused()
  await expect(library.getByRole('status')).toHaveText('Dev moved to position 2 of 5')
  await library.getByRole('button', { name: 'Show enabled only', exact: true }).click()
  await expect.poll(appOrder).toEqual(['virtual', 'dev', 'chat', 'kanban', 'source-control'])
  await expect.poll(railOrder).toEqual(['virtual', 'dev', 'chat', 'kanban'])

  // Drag the optional, currently hidden app before Virtual. Reordering keeps
  // it hidden until the explicit Enable action and retains the remaining apps.
  const sourceTile = library.locator('[data-app-id="source-control"]')
  const sourceGrip = sourceTile.getByRole('button', {
    name: 'Drag Source control to reorder',
    exact: true,
  })
  await sourceTile.hover()
  await expect(sourceGrip).toBeVisible()
  await sourceGrip.click({ trial: true })
  await sourceGrip.dragTo(library.locator('[data-app-id="virtual"]'), {
    targetPosition: { x: 1, y: 24 },
  })
  await expect.poll(appOrder).toEqual(['source-control', 'virtual', 'dev', 'chat', 'kanban'])
  await expect(
    library.getByRole('button', { name: 'Enable Source control', exact: true })
  ).toBeVisible()
  await expect.poll(railOrder).toEqual(['virtual', 'dev', 'chat', 'kanban'])

  await library.getByRole('button', { name: 'Enable Source control', exact: true }).click()
  await expect
    .poll(async () => ({ enabledApps: await enabledAppOrder(), rail: await railOrder() }))
    .toEqual({
      enabledApps: ['source-control', 'virtual', 'dev', 'chat', 'kanban'],
      rail: ['source-control', 'virtual', 'dev', 'chat', 'kanban'],
    })
  await page.reload()
  await expect(library).toBeVisible()
  await expect.poll(appOrder).toEqual(['source-control', 'virtual', 'dev', 'chat', 'kanban'])
  await expect(
    library.getByRole('button', { name: 'Disable Source control', exact: true })
  ).toBeVisible()
  await expect
    .poll(async () => ({ enabledApps: await enabledAppOrder(), rail: await railOrder() }))
    .toEqual({
      enabledApps: ['source-control', 'virtual', 'dev', 'chat', 'kanban'],
      rail: ['source-control', 'virtual', 'dev', 'chat', 'kanban'],
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
  // The shared navigation stays closed across view switches below 48rem —
  // reopen it through the top-bar toggle, then check the modal dismissal
  // contract before measuring the horizontal overflow.
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeHidden()
  await toolbar.getByRole('button', { name: 'Expand contextual sidebar', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
  await page.screenshot({ path: testInfo.outputPath('virtual-dark-mobile.png') })
})

test('integrated chrome stays keyboard-operable under reduced motion and transparency', async ({
  page,
}, testInfo) => {
  await mockConnectedWorkspace(page)
  // Reduced settings are OS-level choices. Emulate both before the app mounts
  // so every stylesheet resolves under them, then operate the integrated bar
  // and the Library by keyboard alone. The captures are evidence artifacts,
  // not pixel baselines: the visual lane owns regression baselines.
  await page.emulateMedia({ reducedMotion: 'reduce', reducedTransparency: 'reduce' })
  await page.goto('/?view=chat')
  const toolbar = page.getByLabel('Workspace toolbar')
  await expect(toolbar).toBeVisible()
  // The OS backstops hold: frost clamps to an opaque surface and the
  // workspace surface collapses its motion to the near-zero duration the
  // reduced-motion rule imposes.
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--surface-alpha').trim()
    )
  ).toBe('1')
  const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(sidebar).toBeVisible()
  // Chromium serializes 0.01ms as "1e-05s"; compare the duration, not the
  // engine's string form.
  const transitionSeconds = await sidebar.evaluate(
    (element) => Number.parseFloat(getComputedStyle(element).transitionDuration) || Number.NaN
  )
  expect(transitionSeconds).toBeCloseTo(0.00001, 6)

  // Keyboard-only chrome operation: collapse and reopen the contextual
  // sidebar from the integrated bar without touching the pointer.
  const collapse = toolbar.getByRole('button', { name: 'Collapse contextual sidebar' })
  await collapse.focus()
  await page.keyboard.press('Enter')
  await expect(sidebar).toBeHidden()
  const expand = toolbar.getByRole('button', { name: 'Expand contextual sidebar' })
  await expect(expand).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(sidebar).toBeVisible()
  await page.mouse.move(0, 0)
  await page.screenshot({ path: testInfo.outputPath('chat-reduced-settings-desktop.png') })

  // The Library opens from the rail by keyboard and stays operable.
  const libraryButton = page
    .getByRole('navigation', { name: 'Global navigation' })
    .getByRole('button', { name: 'App Library', exact: true })
  await libraryButton.focus()
  await page.keyboard.press('Enter')
  const library = page.getByRole('main', { name: 'App Library' })
  await expect(library).toBeVisible()
  await expect(library.getByRole('searchbox', { name: 'Search apps', exact: true })).toBeVisible()
  await page.mouse.move(0, 0)
  await page.screenshot({ path: testInfo.outputPath('library-reduced-settings-desktop.png') })
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

test('workspace navigation captures full-height pointer resizing and persists the width', async ({
  page,
}) => {
  await mockWorkspace(page)
  await page.setViewportSize({ width: 1280, height: 840 })
  await page.goto('/?view=chat')
  const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  const handle = page.getByRole('separator', { name: 'Resize workspace navigation' })
  await expect(sidebar).toBeVisible()
  const before = await sidebar.evaluate((element) => element.getBoundingClientRect().width)
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 3
  await page.mouse.move(x, y)
  await page.mouse.down()
  await expect(handle).toHaveAttribute('data-dragging', '')
  await page.mouse.move(x + 80, y, { steps: 6 })
  await expect
    .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(before + 60)
  await page.mouse.up()
  await expect(handle).not.toHaveAttribute('data-dragging', '')
  const resized = await sidebar.evaluate((element) => element.getBoundingClientRect().width)
  await page.reload()
  await expect(sidebar).toBeVisible()
  await expect
    .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(resized)
})
