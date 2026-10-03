// TEMPORARY diagnostic probe for issue #942 — not part of the suite.
// Clones the failing "mobile navigation traps focus" test with loaded-runner
// emulation (CPU throttling) and instrumentation.
// oxlint-disable unicorn/consistent-function-scoping -- init-script helpers must stay inside the serialized closure
import { expect, test, type Page } from '@playwright/test'

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
const tasks = []
const artifacts = []
const readState = [
  {
    channelId: 'channel-agent',
    lastReadSequence: 3,
    latestSequence: 4,
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

async function mockConnectedWorkspace(page: Page) {
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
    if (request.method() !== 'GET')
      return route.fulfill({ contentType: 'application/json', json: {} })
    if (url.pathname.includes('/read-state'))
      return route.fulfill({ contentType: 'application/json', json: { readState } })
    if (url.pathname.endsWith('/rooms'))
      return route.fulfill({ contentType: 'application/json', json: rooms })
    if (url.pathname.endsWith('/agents'))
      return route.fulfill({ contentType: 'application/json', json: agents })
    if (url.pathname.endsWith('/tasks'))
      return route.fulfill({ contentType: 'application/json', json: tasks })
    if (url.pathname.endsWith('/artifacts'))
      return route.fulfill({ contentType: 'application/json', json: artifacts })
    if (url.pathname.endsWith('/channels'))
      return route.fulfill({ contentType: 'application/json', json: channels })
    if (url.pathname.endsWith('/messages'))
      return route.fulfill({ contentType: 'application/json', json: { messages: [] } })
    return route.fulfill({ contentType: 'application/json', json: {} })
  })
}

async function probeLog(page: Page) {
  await page.addInitScript(() => {
    const stamp = () => `${performance.now().toFixed(1)}ms`
    const describeElement = (element: Element | null) => {
      if (!element) return 'null'
      if (element === document.body) return 'body'
      if (element === document.documentElement) return 'html'
      const label =
        (element as HTMLElement).getAttribute?.('aria-label') ??
        (element as HTMLElement).getAttribute?.('data-slot') ??
        element.tagName.toLowerCase()
      return `${element.tagName.toLowerCase()}[${label}]`
    }
    const sheetState = () => {
      const sheet = document.querySelector('.conventional-sidebar-sheet')
      return sheet ? (sheet.hasAttribute('data-expanded') ? 'expanded' : 'closed') : 'absent'
    }
    const note = (kind: string, detail: string) => {
      console.log(`[probe] ${stamp()} ${kind} ${detail} sheet=${sheetState()}`)
    }
    document.addEventListener(
      'focusin',
      (event) => note('focusin', `-> ${describeElement(event.target as Element)}`),
      true
    )
    document.addEventListener(
      'focusout',
      (event) =>
        note(
          'focusout',
          `${describeElement(event.target as Element)} -> ${describeElement(
            (event as FocusEvent).relatedTarget as Element | null
          )}`
        ),
      true
    )
    document.addEventListener(
      'keydown',
      (event) => note('keydown', `${event.key} on ${describeElement(event.target as Element)}`),
      true
    )
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === 'attributes' &&
          mutation.target === document.querySelector('.conventional-sidebar-sheet')
        ) {
          note('sheet-attr', mutation.attributeName ?? '?')
        }
        for (const removed of mutation.removedNodes) {
          if (
            removed instanceof Element &&
            (removed.matches?.('.conventional-sidebar-sheet') ||
              removed.querySelector?.('.conventional-sidebar-sheet'))
          )
            note('sheet-removed', describeElement(removed))
        }
      }
    })
    const install = () => {
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-expanded', 'data-closed'],
        childList: true,
        subtree: true,
      })
      // Also log every store mutation that touches the sidebar flag by
      // watching the toggle's aria-expanded.
      const toggleObserver = new MutationObserver(() => {
        const toggle = document.querySelector(
          '[aria-label="Expand contextual sidebar"], [aria-label="Collapse contextual sidebar"]'
        )
        note('toggle-aria', toggle?.getAttribute('aria-expanded') ?? 'missing')
      })
      toggleObserver.observe(document.body, {
        attributes: true,
        subtree: true,
        attributeFilter: ['aria-expanded'],
      })
    }
    if (document.body) install()
    else document.addEventListener('DOMContentLoaded', install, { once: true })
  })
}

for (const throttle of [1, 6]) {
  test(`probe throttled ${throttle}x: sheet survives boot churn`, async ({ page }) => {
    page.on('console', (message) => {
      const text = message.text()
      if (text.startsWith('[probe')) console.log(text)
    })
    await probeLog(page)
    await mockConnectedWorkspace(page)
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setCPUThrottlingRate', { rate: throttle })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/?view=chat')

    const toolbar = page.getByLabel('Workspace toolbar')
    const navigationToggle = toolbar.getByRole('button', {
      name: /^(Expand|Collapse) contextual sidebar$/,
    })
    await navigationToggle.press('Enter')

    const navigationDialog = page.getByRole('dialog')
    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    const sidebarButtons = sidebar.locator('button:not(:disabled)')
    await expect(navigationDialog).toHaveAttribute('data-expanded', '')
    await expect(sidebar).toBeVisible()
    await expect(sidebarButtons.first()).toBeFocused()

    // Settle: let boot responses land while the sheet is open.
    await page.waitForTimeout(4000)
    await expect(navigationDialog).toHaveAttribute('data-expanded', '')
  })
}
