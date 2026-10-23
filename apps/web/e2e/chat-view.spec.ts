// M13 #536: Chat surface evidence against the served app.
//
// The M13 chat slices (composer, transcript, streaming, approvals, reconnect,
// Dev↔Chat switching) are driven through the development-only ChatView fixture
// (`/?view=chat&chatE2e=visual`, `import.meta.env.DEV`-gated in
// workspace-navigation.tsx) and, for the view-switch proof, the existing Dev
// View `devE2e=preserved` fixtures. Everything asserted here is user-visible
// state in the real window: the model-level counterparts of these guarantees
// live in packages/dev-view/tests/chat-conversation-model.test.ts (notably the
// "Dev↔Chat repeated switching" proof) and chat-surface.test.ts.
//
// Every journey fails on any page error or console error: the chat surface
// must render and stream without a single one.
import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import type { ComposerDecisionInputs, DecisionResolutionRequest } from '@adea-ai/dev-view/chat'

declare global {
  interface Window {
    chatViewDecisionHarness: {
      setReadiness(
        readiness: 'none' | 'request-only' | 'consumer-only' | 'ready' | 'deferred'
      ): void
      setBusy(busy: boolean): void
      setSession(session: 'initial' | 'other'): void
      setScope(scope: 'initial' | 'other'): void
      deferNextSend(): void
      failNextSend(): void
      resolvePendingSend(): Promise<void>
      rejectPendingSend(): Promise<void>
      resolvePending(): Promise<void>
      dispose(): void
      report(): {
        runtimeSessionId: string
        generation: number
        workspaceId: string
        pendingSends: number
        pendingResolutions: number
        sends: string[]
        steers: string[]
        requestInputs: Array<Pick<ComposerDecisionInputs, 'mode' | 'objective' | 'explicitPins'>>
        clientRequests: Array<
          Pick<
            DecisionResolutionRequest,
            'contractVersion' | 'workspaceId' | 'objective' | 'explicitPins'
          >
        >
        outcomes: Array<{ kind: string; status?: string; action?: string }>
        resolvedCallbacks: number
      }
    }
  }
}

const workspace = {
  id: 'workspace-chat-e2e',
  name: 'Chat Evidence',
  scene: 'work',
  accent: null,
  logo: { kind: 'monogram' as const },
  sortOrder: 0,
  version: 1,
  updatedAt: '2026-09-22T10:00:00.000Z',
}

const bootstrapReply = {
  activeWorkspace: workspace,
  principal: { temporary: true, userId: 'chat-e2e-user' },
  workspaces: [workspace],
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  return errors
}

async function mockBootstrap(page: Page) {
  await page.route('**/api/workspaces/bootstrap', (route) =>
    route.fulfill({ contentType: 'application/json', json: bootstrapReply })
  )
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({ contentType: 'application/json', json: [workspace] })
  )
  await page.route('**/api/v1/account/summary', (route) =>
    route.fulfill({ contentType: 'application/json', json: { workspaces: [] } })
  )
  // Match the workspace visual fixtures: account-wide lists supplement the
  // canonical workspace data and have no entries in this isolated harness.
  await page.route('**/api/v1/account/agents**', (route) =>
    route.fulfill({ contentType: 'application/json', json: { agents: [] } })
  )
  await page.route('**/api/v1/account/conversations**', (route) =>
    route.fulfill({ contentType: 'application/json', json: { conversations: [] } })
  )
  // The fixture surface needs no workspace data; blanket-mock the workspace
  // API namespace (as the workspace visual/flow gates do) so no unauthenticated
  // request reaches the real backend and logs a console error.
  await page.route('**/api/v1/workspaces/**', (route) => {
    const path = new URL(route.request().url()).pathname
    const isList = ['/projects', '/tasks', '/agents', '/channels', '/artifacts'].some((suffix) =>
      path.endsWith(suffix)
    )
    return route.fulfill({ contentType: 'application/json', json: isList ? [] : {} })
  })
}

async function openChatFixture(page: Page, state: string) {
  await mockBootstrap(page)
  await page.goto(`/?view=chat&chatE2e=visual&chatState=${state}`)
  const fixture = page.locator('[data-chat-visual-state]')
  await expect(fixture).toHaveAttribute('data-chat-visual-state', state, { timeout: 30_000 })
  await expect(page.locator('[data-dev-chat]')).toBeVisible()
}

async function openDraftChatFixture(page: Page, fallback = false) {
  await mockBootstrap(page)
  await page.goto(
    `/?view=chat&chatE2e=visual&chatState=conversation&chatDraftTest=1${fallback ? '&chatDraftFallback=1' : ''}`
  )
  await expect(page.locator('[data-chat-visual-state="conversation"]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.locator('[data-dev-chat]')).toBeVisible()
}

async function openDecisionHarness(page: Page, readiness: string) {
  // A real dev-server navigation retains Chromium's loopback address space.
  // Fulfilling the document in Playwright makes Vite's same-origin HMR socket
  // fail local-network checks before the component assertions run.
  const path =
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/chat-view-decision-harness.html')
  await page.goto(`${path}?readiness=${readiness}`)
  const entry = resolve(process.cwd(), 'apps/web/e2e/helpers/chat-view-decision-harness-app.tsx')
  await page.evaluate(async (moduleUrl) => {
    await import(/* @vite-ignore */ moduleUrl)
  }, '/@fs' + entry)
  await expect(page.locator('[data-dev-chat]')).toBeVisible()
}

test('ChatView without a decision contract hides CP selection and keeps ordinary send available', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openDecisionHarness(page, 'none')

  await expect(page.getByLabel('Mode', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Agent', { exact: true })).toHaveCount(0)
  await expect(
    page.getByText('Customize pins are submitted to the Control Plane and remain authoritative.', {
      exact: true,
    })
  ).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Resolve & launch' })).toHaveCount(0)

  const composer = page.getByRole('textbox', { name: 'Message runtime' })
  await composer.fill('Send through the ordinary Chat host seam.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().sends))
    .toEqual(['Send through the ordinary Chat host seam.'])
  await expect(composer).toHaveValue('')
  expect(errors).toEqual([])
})

test('partial decision wiring preserves authorized Send and Steer for an active session', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openDecisionHarness(page, 'none')
  await page.evaluate(() => window.chatViewDecisionHarness.setBusy(true))
  const composer = page.getByRole('textbox', { name: 'Message runtime' })
  const sends: string[] = []
  const steers: string[] = []
  for (const readiness of ['none', 'request-only', 'consumer-only'] as const) {
    await page.evaluate((value) => window.chatViewDecisionHarness.setReadiness(value), readiness)
    await expect(page.getByRole('button', { name: 'Resolve & launch' })).toHaveCount(0)
    await expect(page.getByLabel('Mode', { exact: true })).toHaveCount(0)
    const sent = `Send with ${readiness} decision wiring.`
    await composer.fill(sent)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    sends.push(sent)
    await expect
      .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().sends))
      .toEqual(sends)
    await expect(composer).toHaveValue('')
    const steered = `Steer with ${readiness} decision wiring.`
    await composer.fill(steered)
    await page.getByRole('button', { name: 'Steer', exact: true }).click()
    steers.push(steered)
    await expect
      .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().steers))
      .toEqual(steers)
    await expect(composer).toHaveValue('')
  }
  expect(errors).toEqual([])
})

test('ChatView requires both decision inputs, resets hidden Customize state, and forwards typed failures', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openDecisionHarness(page, 'ready')

  const mode = page.getByLabel('Mode', { exact: true })
  await expect(mode).toHaveValue('auto')
  await mode.selectOption('customize')
  await expect(
    page.getByText('Customize pins are submitted to the Control Plane and remain authoritative.', {
      exact: true,
    })
  ).toBeVisible()

  // A consumer without its authoritative request factory is not a usable
  // decision capability. Removing it hides the entire decision surface.
  await page.evaluate(() => window.chatViewDecisionHarness.setReadiness('consumer-only'))
  await expect(page.getByLabel('Mode', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Resolve & launch' })).toHaveCount(0)
  await expect(
    page.getByText('Customize pins are submitted to the Control Plane and remain authoritative.', {
      exact: true,
    })
  ).toHaveCount(0)

  await page.evaluate(() => window.chatViewDecisionHarness.setReadiness('request-only'))
  await expect(page.getByLabel('Mode', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Resolve & launch' })).toHaveCount(0)

  await page.evaluate(() => window.chatViewDecisionHarness.setReadiness('ready'))
  await expect(mode).toHaveValue('auto')

  const composer = page.getByRole('textbox', { name: 'Message runtime' })
  await composer.fill('Inspect the selected release candidate.')
  await page.getByRole('button', { name: 'Resolve & launch' }).click()
  await expect(page.getByRole('alert')).toContainText('Sign in to continue.')

  const decision = await page.evaluate(() => window.chatViewDecisionHarness.report())
  expect(decision.requestInputs).toEqual([
    { mode: 'auto', objective: 'Inspect the selected release candidate.', explicitPins: {} },
  ])
  expect(decision.clientRequests).toEqual([
    {
      contractVersion: { major: 1, minor: 0 },
      workspaceId: '00000000-0000-4000-8000-000000000102',
      objective: 'Inspect the selected release candidate.',
      explicitPins: {},
    },
  ])
  expect(decision.outcomes).toEqual([
    { kind: 'failure', status: 'auth_required', action: 'sign_in' },
  ])
  expect(decision.resolvedCallbacks).toBe(0)

  await composer.fill('Send normally after the typed recovery.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().sends))
    .toEqual(['Send normally after the typed recovery.'])
  expect(errors).toEqual([])
})

async function startDeferredDecision(page: Page) {
  await openDecisionHarness(page, 'deferred')
  await page.getByRole('textbox', { name: 'Message runtime' }).fill('Resolve this delayed request.')
  await page.getByRole('button', { name: 'Resolve & launch' }).click()
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().pendingResolutions))
    .toBe(1)
}

async function startDeferredSend(page: Page, text: string) {
  await openDecisionHarness(page, 'none')
  await page.evaluate(() => window.chatViewDecisionHarness.deferNextSend())
  await page.getByRole('textbox', { name: 'Message runtime' }).fill(text)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().pendingSends))
    .toBe(1)
}

test('scope changes clear send errors without disabling sends in the new scope', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openDecisionHarness(page, 'none')

  await page.evaluate(() => window.chatViewDecisionHarness.failNextSend())
  await page.getByRole('textbox', { name: 'Message runtime' }).fill('Fail in the first scope.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('immediate send failed')

  const initial = await page.evaluate(() => window.chatViewDecisionHarness.report())
  const composer = page.getByRole('textbox', { name: 'Message runtime' })
  const composerHandle = await composer.elementHandle()
  if (!composerHandle) throw new Error('Chat composer textbox was not rendered.')
  await page.evaluate(() => window.chatViewDecisionHarness.setScope('other'))
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().workspaceId))
    .toBe('00000000-0000-4000-8000-000000000110')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().runtimeSessionId))
    .toBe(initial.runtimeSessionId)
  expect(await page.evaluate(() => window.chatViewDecisionHarness.report().generation)).toBe(
    initial.generation
  )
  expect(await composerHandle.evaluate((element) => element.isConnected)).toBe(true)

  await composer.fill('Send in the second scope.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().sends))
    .toEqual(['Fail in the first scope.', 'Send in the second scope.'])
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a delayed send failure is ignored after an A-to-B scope switch', async ({ page }) => {
  const errors = trackPageErrors(page)
  await startDeferredSend(page, 'Fail after the first scope is stale.')

  await page.evaluate(() => window.chatViewDecisionHarness.setScope('other'))
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().workspaceId))
    .toBe('00000000-0000-4000-8000-000000000110')
  await page.evaluate(async () => window.chatViewDecisionHarness.rejectPendingSend())
  await expect(page.getByRole('alert')).toHaveCount(0)

  await page.getByRole('textbox', { name: 'Message runtime' }).fill('Send in the active scope.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().sends))
    .toEqual(['Fail after the first scope is stale.', 'Send in the active scope.'])
  expect(errors).toEqual([])
})

test('a delayed send failure stays fenced across an A-to-B-to-A scope switch', async ({ page }) => {
  const errors = trackPageErrors(page)
  await startDeferredSend(page, 'Do not restore this stale failure.')

  await page.evaluate(() => window.chatViewDecisionHarness.setScope('other'))
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().workspaceId))
    .toBe('00000000-0000-4000-8000-000000000110')
  await page.evaluate(() => window.chatViewDecisionHarness.setScope('initial'))
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().workspaceId))
    .toBe('00000000-0000-4000-8000-000000000102')

  await page.evaluate(async () => window.chatViewDecisionHarness.rejectPendingSend())
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page
    .getByRole('textbox', { name: 'Message runtime' })
    .fill('The current scope still sends.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().sends))
    .toEqual(['Do not restore this stale failure.', 'The current scope still sends.'])
  expect(errors).toEqual([])
})

test('a delayed send failure does not write composer state after disposal', async ({ page }) => {
  const errors = trackPageErrors(page)
  await startDeferredSend(page, 'Fail after composer disposal.')

  await page.evaluate(() => window.chatViewDecisionHarness.dispose())
  await page.evaluate(async () => window.chatViewDecisionHarness.rejectPendingSend())
  const result = await page.evaluate(() => window.chatViewDecisionHarness.report())
  expect(result.pendingSends).toBe(0)
  expect(errors).toEqual([])
})

test('a delayed decision is fenced when its seam disappears and ordinary send remains available', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await startDeferredDecision(page)

  await page.evaluate(() => window.chatViewDecisionHarness.setReadiness('none'))
  await expect(page.getByRole('button', { name: 'Resolve & launch' })).toHaveCount(0)
  const composer = page.getByRole('textbox', { name: 'Message runtime' })
  await composer.fill('Send normally while the old decision is pending.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().sends))
    .toEqual(['Send normally while the old decision is pending.'])

  // Restore the same request and consumer identities before the reply lands:
  // the earlier invalidation must remain latched across an A→B→A transition.
  await page.evaluate(() => window.chatViewDecisionHarness.setReadiness('deferred'))
  await expect(page.getByLabel('Mode', { exact: true })).toBeVisible()
  await page.evaluate(async () => window.chatViewDecisionHarness.resolvePending())
  const result = await page.evaluate(() => window.chatViewDecisionHarness.report())
  expect(result.outcomes).toEqual([])
  expect(result.resolvedCallbacks).toBe(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('[data-chat-composer-location]')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a delayed decision stays fenced across an A-to-B-to-A Chat session switch', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await startDeferredDecision(page)

  await page.evaluate(() => window.chatViewDecisionHarness.setSession('other'))
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().runtimeSessionId))
    .toBe('00000000-0000-4000-8000-000000000108')
  await page.evaluate(() => window.chatViewDecisionHarness.setSession('initial'))
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().runtimeSessionId))
    .toBe('00000000-0000-4000-8000-000000000104')
  await page.evaluate(async () => window.chatViewDecisionHarness.resolvePending())
  const result = await page.evaluate(() => window.chatViewDecisionHarness.report())
  expect(result.outcomes).toEqual([])
  expect(result.resolvedCallbacks).toBe(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('[data-chat-composer-location]')).toHaveCount(0)

  await page.evaluate(() => window.chatViewDecisionHarness.setSession('other'))
  await page.getByRole('textbox', { name: 'Message runtime' }).fill('Send in the new session.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.chatViewDecisionHarness.report().sends))
    .toEqual(['Send in the new session.'])
  expect(errors).toEqual([])
})

test('a delayed decision cannot call its consumer after the Chat composer is disposed', async ({
  page,
}) => {
  await startDeferredDecision(page)

  await page.evaluate(() => window.chatViewDecisionHarness.dispose())
  await page.evaluate(async () => window.chatViewDecisionHarness.resolvePending())
  const result = await page.evaluate(() => window.chatViewDecisionHarness.report())
  expect(result.outcomes).toEqual([])
  expect(result.resolvedCallbacks).toBe(0)
})

test('renders the canonical conversation surface: transcript rows, live status, and a working composer', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openChatFixture(page, 'conversation')

  // The header names the canonical runtime session and its generation, and
  // the transcript stream is announced as a live region.
  const chat = page.locator('[data-dev-chat]')
  await expect(chat).toBeVisible()
  await expect(page.locator('[data-chat-title]')).toHaveText('Deployment plan review')
  await expect(page.locator('[data-chat-subtitle]')).toContainText('generation 3')
  await expect(page.locator('[data-chat-status]')).toContainText('Live')
  await expect(page.getByLabel('Conversation transcript')).toHaveAttribute('aria-live', 'polite')

  // Tiered transcript rows: the user turn, two tool events, and the assistant
  // message — each rendered from bounded, known payload fields only.
  const rows = page.locator('[data-entry-id]')
  await expect(rows).toHaveCount(5)
  await expect(page.locator('[data-slot="message"][data-role="user"]')).toHaveCount(1)
  await expect(page.locator('[data-slot="message"][data-role="assistant"]')).toHaveCount(1)
  await expect(page.locator('[data-kind^="tool."]')).toHaveCount(2)
  await expect(page.locator('[data-source]')).toHaveCount(2)
  await expect(rows.first()).toContainText('Review the deployment plan and summarize the risks.')
  await expect(page.getByText('Found 4 relevant notes.')).toBeVisible()
  // The streamed delta and the completed message share the sentence, so the
  // assertion scopes to the first rendering.
  await expect(
    page.getByText('The plan is ready. I found two risks worth addressing before approval.').first()
  ).toBeVisible()

  // The composer is authoritative for an active, connected chat conversation:
  // sending clears the draft, and the busy surface offers Stop and Steer.
  const composer = page.getByRole('textbox', { name: 'Message runtime' })
  await expect(composer).toBeEnabled()
  await expect(page.locator('#dev-chat-composer-status')).toContainText(
    'Input is sent with the current runtime generation.'
  )
  await composer.fill('Watch the staging rollout while I review.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(composer).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Steer', exact: true })).toBeDisabled()

  expect(errors).toEqual([])
})

test('keeps earlier transcript rows mounted while a streamed event appends', async ({ page }) => {
  const errors = trackPageErrors(page)
  await openChatFixture(page, 'streaming')

  const rows = page.locator('[data-entry-id]')
  await expect(rows).toHaveCount(5)
  const firstRow = await rows.first().elementHandle()
  expect(firstRow).not.toBeNull()

  // The live transcript stream appends exactly when the spec dispatches the
  // fixture's `chat-visual:append` event — no wall-clock race. The row that
  // was already on screen must remain the same mounted node (the "#588
  // preserve live transcript rows during streaming" regression).
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:append')))
  await expect(rows).toHaveCount(6, { timeout: 10_000 })
  await expect(page.getByText('A later stream update arrived.')).toBeVisible()
  const stayedMounted = await firstRow?.evaluate(
    (node) => node.isConnected && node === document.querySelector('[data-entry-id]')
  )
  expect(stayedMounted).toBe(true)

  // A second fragment of the same run joins the block it continues: the block
  // keeps its node, and the new text arrives inside it.
  const streamed = page.locator('[data-source="delta"]').last()
  const streamedNode = await streamed.elementHandle()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:append')))
  await expect(streamed).toContainText('Streaming continues to append rows.', { timeout: 10_000 })
  await expect(streamed).toContainText('A later stream update arrived.')
  await expect(rows).toHaveCount(6)
  expect(await streamedNode?.evaluate((node) => node.isConnected)).toBe(true)
  await expect(rows.first()).toContainText('Review the deployment plan')

  expect(errors).toEqual([])
})

test('persists typed drafts through remount and generation changes while fencing late sends', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openDraftChatFixture(page)

  const composer = page.getByRole('textbox', { name: 'Message runtime' })
  await composer.fill('first draft')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()

  // Unmount the sending composer, type a newer draft in its replacement, then
  // complete the old request. The late success must not clear the new draft.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:remount')))
  await expect(composer).toBeVisible()
  await composer.fill('newer draft survives')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:resolve-send')))
  await expect(composer).toHaveValue('newer draft survives')
  await expect(page.locator('[data-chat-visual-state]')).toHaveAttribute(
    'data-chat-draft',
    'newer draft survives'
  )

  // A generation replacement also fences an old success even when no newer
  // input event races it: the new composer still owns the canonical draft.
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:next-generation')))
  await expect(page.locator('[data-chat-visual-state]')).toHaveAttribute(
    'data-chat-generation',
    '4'
  )
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:resolve-send')))
  await expect(composer).toHaveValue('newer draft survives')
  await expect(page.locator('[data-chat-visual-state]')).toHaveAttribute(
    'data-chat-draft',
    'newer draft survives'
  )

  // A failed deferred send preserves the canonical draft and reports the
  // failure without an unhandled page error.
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:reject-send')))
  await expect(page.getByRole('alert')).toContainText('visual send failed')
  await expect(composer).toHaveValue('newer draft survives')
  await expect(page.locator('[data-chat-visual-state]')).toHaveAttribute(
    'data-chat-draft',
    'newer draft survives'
  )

  // Resuming creates a new generation under the same canonical session; the
  // scoped host draft remains available to the newly keyed composer.
  expect(errors).toEqual([])
})

test('fences late sends when ChatView writes through the model fallback', async ({ page }) => {
  await openDraftChatFixture(page, true)

  const composer = page.getByRole('textbox', { name: 'Message runtime' })
  await composer.fill('old generation draft')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()

  // Replace the conversation generation while the old send is pending. The
  // fallback model must reject the old identity even before revision checking.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:next-generation')))
  await expect(page.locator('[data-chat-visual-state]')).toHaveAttribute(
    'data-chat-generation',
    '4'
  )
  await composer.fill('new generation draft')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:resolve-send')))
  await expect(composer).toHaveValue('new generation draft')

  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:reject-send')))
  await expect(page.getByRole('alert')).toContainText('visual send failed')
  await expect(composer).toHaveValue('new generation draft')
})

test('gates the composer and renders approval and question resolution while attention is pending', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openChatFixture(page, 'attention')

  // Input authority is held by the pending approval: the composer states the
  // exact reason and refuses input instead of accepting a doomed send.
  const composer = page.getByRole('textbox', { name: 'Message runtime' })
  await expect(composer).toBeDisabled()
  await expect(page.locator('#dev-chat-composer-status')).toContainText(
    'Waiting for approval before sending input.'
  )

  // The approval row offers a real resolution path and renders its bounded
  // payload text; the question row requires a non-empty answer before its
  // submit control enables.
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeEnabled()
  await expect(
    page.getByText('The runtime is waiting for approval to apply the reviewed changes.')
  ).toBeVisible()
  const questionInput = page.getByLabel('Answer question')
  const submitAnswer = page.getByRole('button', { name: 'Submit answer' })
  await expect(submitAnswer).toBeDisabled()
  await questionInput.fill('Staging first, then production.')
  await expect(submitAnswer).toBeEnabled()
  await submitAnswer.click()

  // Resolving must not throw and must not silently unmount the pending rows.
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()

  expect(errors).toEqual([])
})

test('surfaces a transcript sequence gap and offers the reconnect recovery affordance', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openChatFixture(page, 'reconnect')

  await expect(page.getByRole('alert').filter({ hasText: 'Transcript gap detected' })).toBeVisible()
  const reconnect = page.getByRole('button', { name: 'Reconnect transcript' })
  await expect(reconnect).toBeEnabled()
  await expect(page.locator('[data-chat-status]')).toContainText('Disconnected')
  await expect(page.locator('#dev-chat-composer-status')).toContainText(
    'Chat is unavailable while the runtime is disconnected.'
  )

  // Reconnecting re-attaches the transcript stream; the gap is still reported
  // truthfully because the fixture stream cannot recover the missing range.
  await reconnect.click()
  await expect(page.getByRole('alert').filter({ hasText: 'Transcript gap detected' })).toBeVisible()
  await expect(page.locator('[data-chat-status]')).toContainText('Disconnected')

  expect(errors).toEqual([])
})

test('repeated Dev↔Chat switches preserve the session state in the real window', async ({
  page,
}) => {
  test.slow()
  const errors = trackPageErrors(page)
  // The Dev surface carries the preserved E2E fixtures; `chatE2e=visual`
  // routes the Chat side of the switch to the M13 ChatView fixture, so the
  // journey crosses the exact boundary the model-layer proof exercises
  // (chat-conversation-model.test.ts, "Dev↔Chat repeated switching").
  await page.setViewportSize({ width: 1280, height: 900 })
  await mockBootstrap(page)
  await page.goto('/?view=dev&devE2e=preserved&chatE2e=visual&sentinel=keep')
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 60_000,
  })

  // The fixture terminal's attached scrollback proves the Dev surface mounted
  // with its authenticated transport before any switching begins.
  await expect(page.getByLabel('Terminal output')).toContainText(
    /fixture terminal (re)?connected/,
    { timeout: 30_000 }
  )

  // Make session-scoped state: select the second project's session (which
  // mirrors into devProject/devSession URL params), then collapse its project.
  const otherSession = page.getByRole('treeitem', { name: /feature\/runtime Needs you/ })
  await otherSession.click()
  await expect(otherSession).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(/devProject=fixture-tools/)
  await expect(page).toHaveURL(/devSession=fixture-tools-session/)
  const project = page.getByRole('treeitem', { name: 'Runtime tools' })
  await project.click()
  await expect(project).toHaveAttribute('aria-expanded', 'false')

  // Three switch cycles: the chat surface mounts and unmounts between Dev
  // visits, and every Dev-side session fact survives — the selection (store
  // and its URL mirror) and the collapsed hierarchy. Nothing relaunches or
  // resets; unknown params ride every patch.
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await page.getByRole('button', { name: 'Chat view' }).click()
    await expect(page).toHaveURL(/view=chat/)
    await expect(page).toHaveURL(/sentinel=keep/)
    await expect(page).toHaveURL(/devE2e=preserved/)
    await expect(page.locator('[data-dev-chat]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-chat-visual-state="conversation"]')).toBeVisible()
    await expect(page.locator('[data-chat-title]')).toHaveText('Deployment plan review')

    await page.getByRole('button', { name: 'Dev view' }).click()
    await expect(page).toHaveURL(/view=dev/)
    await expect(page).toHaveURL(/sentinel=keep/)
    await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
      timeout: 60_000,
    })
    await expect(page).toHaveURL(/devProject=fixture-tools/)
    await expect(page).toHaveURL(/devSession=fixture-tools-session/)
    const collapsedProject = page.getByRole('treeitem', { name: 'Runtime tools' })
    await expect(collapsedProject).toHaveAttribute('aria-expanded', 'false')
    // Expanding the surviving collapse state reveals the surviving selection.
    await collapsedProject.click()
    await expect(
      page.getByRole('treeitem', { name: /feature\/runtime Needs you/ })
    ).toHaveAttribute('aria-selected', 'true')
    // Re-collapse for the next cycle so every cycle starts from the same
    // state and proves the fact was re-preserved, not left mounted.
    await page.getByRole('treeitem', { name: 'Runtime tools' }).click()
    await expect(page.getByRole('treeitem', { name: 'Runtime tools' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  }

  expect(errors).toEqual([])
})

test('does not offer a steer action without an authorized host operation', async ({ page }) => {
  await openChatFixture(page, 'conversation')
  await expect(page.getByRole('button', { name: 'Steer', exact: true })).toBeDisabled()
  await expect(page.getByText('Steer is unavailable on this host.', { exact: true })).toBeVisible()
})

test('restores an earlier reading position when the canonical Chat surface remounts', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 420 })
  await openDraftChatFixture(page)
  // Exact pixel restoration needs settled font metrics; a font swap can
  // legitimately resize the transcript while this test remounts it.
  await page.evaluate(() => document.fonts.ready)
  const transcript = page.getByLabel('Conversation transcript')
  await expect
    .poll(() => transcript.evaluate((node) => node.scrollHeight - node.clientHeight))
    .toBeGreaterThan(100)
  await transcript.evaluate((node) => {
    node.scrollTop = 90
    node.dispatchEvent(new Event('scroll'))
  })
  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBe(90)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:remount')))
  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBe(90)
})

test('follows appended runtime rows only while the reader keeps follow intent', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await page.setViewportSize({ width: 900, height: 420 })
  await openChatFixture(page, 'streaming')
  const transcript = page.getByLabel('Conversation transcript')
  const distance = () =>
    transcript.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)
  await expect
    .poll(() => transcript.evaluate((node) => node.scrollHeight - node.clientHeight))
    .toBeGreaterThan(100)
  await expect.poll(distance).toBeLessThanOrEqual(2)

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:append')))
  await expect(page.locator('[data-entry-id]')).toHaveCount(6)
  await expect.poll(distance).toBeLessThanOrEqual(2)

  // A small upward movement inside the visibility threshold still revokes
  // follow intent. The next runtime event must preserve that native offset.
  const parked = await transcript.evaluate((node) => {
    node.scrollTop -= 30
    node.dispatchEvent(new Event('scroll'))
    return node.scrollTop
  })
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:append')))
  await expect(page.getByText('Streaming continues to append rows.')).toBeVisible()
  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBe(parked)

  // The canvas is compact and streamed text joins one block, so 30px can still be
  // inside the threshold where the control is not offered. Reading further back
  // is what offers the way to the latest.
  await transcript.evaluate((node) => {
    node.scrollTop = 0
    node.dispatchEvent(new Event('scroll'))
  })
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click()
  await expect.poll(distance).toBeLessThanOrEqual(2)
  await expect(transcript).toBeFocused()
  expect(errors).toEqual([])
})

// Queued follow-ups (#1393, #1383): the person queues messages while the agent works. The
// fixture stands in for the host's `dev.session.followUps` queue; what is asserted is what the
// surface says about it, including what it must not claim.
async function openQueueFixture(page: Page, mode: 'busy' | 'ready' | 'ambiguous' | 'unavailable') {
  await mockBootstrap(page)
  await page.goto(`/?view=chat&chatE2e=visual&chatState=conversation&chatQueue=${mode}`)
  await expect(page.locator('[data-chat-visual-state="conversation"]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.locator('[data-dev-chat]')).toBeVisible()
}

test('queues a message while the agent is busy and lets the person withdraw it', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openQueueFixture(page, 'busy')
  const composer = page.getByRole('textbox', { name: 'Message runtime' })
  const queue = page.getByRole('button', { name: 'Queue', exact: true })
  await expect(queue).toBeVisible()
  await expect(queue).toBeDisabled()

  await composer.fill('After that, summarize the risks.')
  await queue.click()
  await expect(composer).toHaveValue('')

  const list = page.getByRole('list', { name: 'Queued follow-ups' })
  await expect(list).toBeVisible()
  await expect(list.getByText('After that, summarize the risks.')).toBeVisible()
  // Busy: nothing is delivered, and nothing is promised.
  await expect(page.locator('[data-chat-follow-up-status]')).toContainText(
    'Nothing is sent automatically'
  )
  await expect(page.getByRole('button', { name: 'Send next', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: /^Remove queued message: After that/ }).click()
  await expect(page.getByText('After that, summarize the risks.')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('delivers queued messages one at a time, only when the person chooses', async ({ page }) => {
  const errors = trackPageErrors(page)
  await openQueueFixture(page, 'ready')
  const composer = page.getByRole('textbox', { name: 'Message runtime' })
  for (const text of ['First follow-up.', 'Second follow-up.']) {
    await composer.fill(text)
    await page.getByRole('button', { name: 'Queue', exact: true }).click()
    await expect(page.getByText(text, { exact: true })).toBeVisible()
  }
  // Ready is not a promise to send: both messages wait for the person.
  await expect(page.locator('[data-chat-follow-up-status]')).toContainText('when you choose')
  await page.getByRole('button', { name: 'Send next', exact: true }).click()
  await expect(page.getByText('First follow-up.', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Second follow-up.', { exact: true })).toBeVisible()
  // Accepted is the transport's word, not proof the agent read it.
  await expect(page.locator('[data-chat-follow-up-last]')).toContainText(
    'does not confirm the agent has read it'
  )
  expect(errors).toEqual([])
})

test('an unconfirmed delivery is explained, cannot be sent again and can be removed', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openQueueFixture(page, 'ambiguous')
  await expect(page.getByText('Also run the migration dry run.')).toBeVisible()
  await expect(page.locator('[data-chat-follow-up-status]')).toContainText(
    'not retried automatically'
  )
  await expect(page.getByRole('button', { name: 'Send next', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: /^Remove queued message: Also run/ }).click()
  await expect(page.getByText('Also run the migration dry run.')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('offers no queue when the host does not provide one', async ({ page }) => {
  const errors = trackPageErrors(page)
  await openQueueFixture(page, 'unavailable')
  await expect(page.getByRole('button', { name: 'Steer', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Queue', exact: true })).toHaveCount(0)
  await expect(page.locator('[data-chat-follow-ups]')).toHaveCount(0)
  expect(errors).toEqual([])
})

// Checkpoint restore (part of #1383): a checkpoint offers Restore only when the host marked it
// restorable and gave the canvas a restore operation, asks first, and reports only the host's
// typed outcome. The fixture stands in for the host.
async function openRestoreFixture(page: Page, mode?: 'ok' | 'fail') {
  await mockBootstrap(page)
  await page.goto(
    `/?view=chat&chatE2e=visual&chatState=results${mode ? `&chatRestore=${mode}` : ''}`
  )
  await expect(page.locator('[data-chat-visual-state="results"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-dev-chat]')).toBeVisible()
}

test('a checkpoint the host did not mark restorable is only a marker', async ({ page }) => {
  const errors = trackPageErrors(page)
  await openRestoreFixture(page)
  await expect(page.getByText('Before the journal fix')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('restoring asks first and the conversation continues as the host’s new generation', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openRestoreFixture(page, 'ok')
  const fixture = page.locator('[data-chat-visual-state="results"]')
  await expect(fixture).toHaveAttribute('data-chat-generation', '3')
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByText('Restore to “Before the journal fix”?')).toBeVisible()
  // Declining changes nothing.
  await dialog.getByRole('button', { name: 'Do not restore' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(fixture).toHaveAttribute('data-chat-generation', '3')
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(fixture).toHaveAttribute('data-chat-generation', '4')
  expect(errors).toEqual([])
})

test('a restore the host failed is reported as failed, not as a restore', async ({ page }) => {
  const errors = trackPageErrors(page)
  await openRestoreFixture(page, 'fail')
  const fixture = page.locator('[data-chat-visual-state="results"]')
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(
    page.getByText(
      'Restore failed: The host no longer holds this checkpoint, so it cannot be restored.'
    )
  ).toBeVisible()
  await expect(fixture).toHaveAttribute('data-chat-generation', '3')
  expect(errors).toEqual([])
})

type AttachMode = 'ok' | 'lost' | 'remove-fail' | 'commit-stale' | 'remove-lost' | 'held'

async function openAttachFixture(page: Page, mode?: AttachMode) {
  await mockBootstrap(page)
  await page.goto(
    `/?view=chat&chatE2e=visual&chatState=conversation${mode ? `&chatAttach=${mode}` : ''}`
  )
  await expect(page.locator('[data-chat-visual-state="conversation"]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.locator('[data-chat-composer]')).toBeVisible()
}

const textFile = (name: string, content: string) => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from(content),
})

test('without a host attachment store there is no picker', async ({ page }) => {
  const errors = trackPageErrors(page)
  await openAttachFixture(page)
  await expect(page.getByRole('button', { name: 'Attach a text file' })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a text file is stored and the surface does not claim the assistant received it', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openAttachFixture(page, 'ok')
  const picker = page.getByRole('button', { name: 'Attach a text file' })
  await expect(picker).toBeVisible()
  await expect(
    page.getByText('Text files only (.txt, .log, .md, .json), up to 128 KiB.')
  ).toHaveCount(1)
  await page.locator('[data-chat-attach-input]').setInputFiles(textFile('notes.txt', 'hello'))
  const list = page.getByRole('list', { name: 'Attached files' })
  await expect(list.getByText('notes.txt')).toBeVisible()
  await expect(list.getByText('5 B')).toBeVisible()
  await expect(page.locator('[data-chat-attachments-status]')).toHaveText(
    'Stored on this device only. The assistant does not receive attachments yet.'
  )
  await page.getByRole('button', { name: 'Remove notes.txt' }).click()
  await expect(list).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a file the host cannot take is refused in words and never staged', async ({ page }) => {
  const errors = trackPageErrors(page)
  await openAttachFixture(page, 'ok')
  await page.locator('[data-chat-attach-input]').setInputFiles({
    name: 'photo.png',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  })
  await expect(page.locator('[data-chat-attach-refusal]')).toContainText(
    'photo.png: Only text files can be attached.'
  )
  await expect(page.getByRole('list', { name: 'Attached files' })).toHaveCount(0)
  expect(errors).toEqual([])
})

const nextGeneration = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:next-generation')))

test('a lost upload answer is not confirmed, and trying again stores it once', async ({ page }) => {
  const errors = trackPageErrors(page)
  await openAttachFixture(page, 'lost')
  await page.locator('[data-chat-attach-input]').setInputFiles(textFile('notes.txt', 'hello'))
  const list = page.getByRole('list', { name: 'Attached files' })
  await expect(list.getByText('Not confirmed')).toBeVisible()
  await expect(list.getByText('Not stored')).toHaveCount(0)
  await expect(page.getByText('trying again will not store it twice.')).toBeVisible()
  // Dismissing would drop the key that finds the file.
  await expect(page.getByRole('button', { name: 'Dismiss notes.txt' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove notes.txt' })).toHaveCount(0)
  await expect(page.locator('[data-chat-attachments-status]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.locator('[data-chat-attachments-status]')).toBeVisible()
  await expect(list.getByText('notes.txt')).toHaveCount(1)
  expect(errors).toEqual([])
})

test('a host that fails after it committed is unreconciled: no retry, no "not stored"', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openAttachFixture(page, 'commit-stale')
  await page.locator('[data-chat-attach-input]').setInputFiles(textFile('notes.txt', 'hello'))
  const list = page.getByRole('list', { name: 'Attached files' })
  await expect(list.getByText('Not confirmed')).toBeVisible()
  await expect(page.getByText('We cannot confirm whether the host stored this file')).toBeVisible()
  await expect(page.getByText('It may still be stored on this device.')).toBeVisible()
  await expect(list.getByText('Not stored')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await expect(page.locator('[data-chat-attachments-status]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Dismiss notes.txt' }).click()
  await expect(list).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a lost removal answer is not "not removed", and removing again settles it', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openAttachFixture(page, 'remove-lost')
  await page.locator('[data-chat-attach-input]').setInputFiles(textFile('notes.txt', 'hello'))
  const list = page.getByRole('list', { name: 'Attached files' })
  await page.getByRole('button', { name: 'Remove notes.txt' }).click()
  await expect(page.getByText('We could not confirm whether the file was removed.')).toBeVisible()
  await expect(page.getByText('The file was not removed.')).toHaveCount(0)
  await expect(list.getByText('notes.txt')).toBeVisible()
  await page.getByRole('button', { name: 'Remove notes.txt' }).click()
  await expect(list).toHaveCount(0)
  expect(errors).toEqual([])
})

test('an unconfirmed upload is shown as unreconciled by the next generation, not dropped', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openAttachFixture(page, 'lost')
  const fixture = page.locator('[data-chat-visual-state="conversation"]')
  await expect(fixture).toHaveAttribute('data-chat-generation', '3')
  await page.locator('[data-chat-attach-input]').setInputFiles(textFile('notes.txt', 'hello'))
  const list = page.getByRole('list', { name: 'Attached files' })
  await expect(list.getByText('Not confirmed')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()

  await nextGeneration(page)
  await expect(fixture).toHaveAttribute('data-chat-generation', '4')
  await expect(list.getByText('notes.txt')).toBeVisible()
  await expect(list.getByText('Not confirmed')).toBeVisible()
  await expect(page.getByText('We cannot confirm whether the host stored this file')).toBeVisible()
  // The old generation can no longer be asked, so a retry is not offered.
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await expect(page.locator('[data-chat-attachments-status]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Dismiss notes.txt' }).click()
  await expect(list).toHaveCount(0)
  // A dismissed outcome is not carried into the generation after.
  await nextGeneration(page)
  await expect(fixture).toHaveAttribute('data-chat-generation', '5')
  await expect(list).toHaveCount(0)
  expect(errors).toEqual([])
})

test('an answer that arrives after the generation switched changes nothing and throws nothing', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openAttachFixture(page, 'held')
  const fixture = page.locator('[data-chat-visual-state="conversation"]')
  await page.locator('[data-chat-attach-input]').setInputFiles(textFile('notes.txt', 'hello'))
  const list = page.getByRole('list', { name: 'Attached files' })
  await expect(list.getByText('notes.txt')).toBeVisible()
  await nextGeneration(page)
  await expect(fixture).toHaveAttribute('data-chat-generation', '4')
  await expect(list.getByText('Not confirmed')).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('chat-visual:release-attachments')))
  await expect(list.getByText('Not confirmed')).toBeVisible()
  await expect(page.locator('[data-chat-attachments-status]')).toHaveCount(0)
  await expect(list.getByText('notes.txt')).toHaveCount(1)
  expect(errors).toEqual([])
})

test('a file that cannot be read is refused in words and the rest of the selection is attached', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openAttachFixture(page, 'ok')
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer
    File.prototype.arrayBuffer = function (this: File) {
      return this.name === 'gone.txt'
        ? Promise.reject(new DOMException('secret-contents', 'NotReadableError'))
        : read.call(this)
    }
  })
  await page
    .locator('[data-chat-attach-input]')
    .setInputFiles([textFile('gone.txt', 'secret'), textFile('ok.txt', 'hello')])
  const list = page.getByRole('list', { name: 'Attached files' })
  await expect(list.getByText('ok.txt')).toBeVisible()
  await expect(list.getByText('gone.txt')).toHaveCount(0)
  const refusal = page.locator('[data-chat-attach-refusal]')
  await expect(refusal).toContainText('gone.txt: This file could not be read.')
  await expect(refusal).not.toContainText('secret')
  expect(errors).toEqual([])
})

test('a removal the host refuses keeps the file and says so', async ({ page }) => {
  const errors = trackPageErrors(page)
  await openAttachFixture(page, 'remove-fail')
  await page.locator('[data-chat-attach-input]').setInputFiles(textFile('notes.txt', 'hello'))
  await page.getByRole('button', { name: 'Remove notes.txt' }).click()
  await expect(page.getByText('The file was not removed.')).toBeVisible()
  await expect(
    page.getByRole('list', { name: 'Attached files' }).getByText('notes.txt')
  ).toBeVisible()
  expect(errors).toEqual([])
})
