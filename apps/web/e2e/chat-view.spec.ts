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
  // The fixture surface needs no workspace data; blanket-mock the workspace
  // API namespace (as the workspace visual/flow gates do) so no unauthenticated
  // request reaches the real backend and logs a console error.
  await page.route('**/api/v1/workspaces/**', (route) =>
    route.fulfill({ contentType: 'application/json', json: {} })
  )
}

async function openChatFixture(page: Page, state: string) {
  await mockBootstrap(page)
  await page.goto(`/?view=chat&chatE2e=visual&chatState=${state}`)
  const fixture = page.locator('[data-chat-visual-state]')
  await expect(fixture).toHaveAttribute('data-chat-visual-state', state, { timeout: 30_000 })
  await expect(page.locator('section.dev-chat')).toBeVisible()
}

async function openDraftChatFixture(page: Page, fallback = false) {
  await mockBootstrap(page)
  await page.goto(
    `/?view=chat&chatE2e=visual&chatState=conversation&chatDraftTest=1${fallback ? '&chatDraftFallback=1' : ''}`
  )
  await expect(page.locator('[data-chat-visual-state="conversation"]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.locator('section.dev-chat')).toBeVisible()
}

async function openDecisionHarness(page: Page, readiness: string) {
  const path = '/__chat-view-decision-harness'
  await page.route(
    (url) => url.pathname === path,
    (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html><head></head><body><div id="harness-root"></div></body></html>',
      })
  )
  await page.goto(`${path}?readiness=${readiness}`)
  const entry = resolve(process.cwd(), 'apps/web/e2e/helpers/chat-view-decision-harness-app.tsx')
  await page.evaluate(async (moduleUrl) => {
    await import(/* @vite-ignore */ moduleUrl)
  }, '/@fs' + entry)
  await expect(page.locator('section.dev-chat')).toBeVisible()
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
  await expect(page.locator('.dev-chat__composer-location')).toHaveCount(0)
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
  await expect(page.locator('.dev-chat__composer-location')).toHaveCount(0)

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
  const chat = page.locator('section.dev-chat')
  await expect(chat).toBeVisible()
  await expect(page.locator('.dev-chat__heading h2')).toHaveText('Deployment plan review')
  await expect(page.locator('.dev-chat__heading p')).toContainText('generation 3')
  await expect(page.locator('.dev-chat__status')).toContainText('Live')
  await expect(page.getByLabel('Conversation transcript')).toHaveAttribute('aria-live', 'polite')

  // Tiered transcript rows: the user turn, two tool events, and the assistant
  // message — each rendered from bounded, known payload fields only.
  const rows = page.locator('article.dev-chat__row')
  await expect(rows).toHaveCount(5)
  await expect(page.locator('article.dev-chat__row--user')).toHaveCount(1)
  await expect(page.locator('article.dev-chat__row--tool')).toHaveCount(2)
  await expect(page.locator('article.dev-chat__row--assistant')).toHaveCount(2)
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

  const rows = page.locator('article.dev-chat__row')
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
    (node) => node.isConnected && node === document.querySelector('article.dev-chat__row')
  )
  expect(stayedMounted).toBe(true)

  // Repeated delivery keeps appending without disturbing earlier rows.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:append')))
  await expect(rows).toHaveCount(7, { timeout: 10_000 })
  await expect(page.getByText('Streaming continues to append rows.')).toBeVisible()
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
  await expect(page.locator('.dev-chat__status')).toContainText('Disconnected')
  await expect(page.locator('#dev-chat-composer-status')).toContainText(
    'Chat is unavailable while the runtime is disconnected.'
  )

  // Reconnecting re-attaches the transcript stream; the gap is still reported
  // truthfully because the fixture stream cannot recover the missing range.
  await reconnect.click()
  await expect(page.getByRole('alert').filter({ hasText: 'Transcript gap detected' })).toBeVisible()
  await expect(page.locator('.dev-chat__status')).toContainText('Disconnected')

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
  // mirrors into devProject/devSession URL params), then collapse the Product
  // group.
  const otherSession = page.getByRole('button', { name: 'Other project session' })
  await otherSession.click()
  await expect(otherSession).toHaveAttribute('aria-current', 'page')
  await expect(page).toHaveURL(/devProject=fixture-tools/)
  await expect(page).toHaveURL(/devSession=fixture-tools-session/)
  const group = page.getByRole('button', { name: 'PRODUCT' })
  await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'false')

  // Three switch cycles: the chat surface mounts and unmounts between Dev
  // visits, and every Dev-side session fact survives — the selection (store
  // and its URL mirror) and the collapsed hierarchy. Nothing relaunches or
  // resets; unknown params ride every patch.
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await page.getByRole('button', { name: 'Chat view' }).click()
    await expect(page).toHaveURL(/view=chat/)
    await expect(page).toHaveURL(/sentinel=keep/)
    await expect(page).toHaveURL(/devE2e=preserved/)
    await expect(page.locator('section.dev-chat')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-chat-visual-state="conversation"]')).toBeVisible()
    await expect(page.locator('.dev-chat__heading h2')).toHaveText('Deployment plan review')

    await page.getByRole('button', { name: 'Dev view' }).click()
    await expect(page).toHaveURL(/view=dev/)
    await expect(page).toHaveURL(/sentinel=keep/)
    await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
      timeout: 60_000,
    })
    await expect(page).toHaveURL(/devProject=fixture-tools/)
    await expect(page).toHaveURL(/devSession=fixture-tools-session/)
    const collapsedGroup = page.getByRole('button', { name: 'PRODUCT' })
    await expect(collapsedGroup).toHaveAttribute('aria-expanded', 'false')
    // Expanding the surviving collapse state reveals the surviving selection.
    await collapsedGroup.click()
    await expect(page.getByRole('button', { name: 'Other project session' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    // Re-collapse for the next cycle so every cycle starts from the same
    // state and proves the fact was re-preserved, not left mounted.
    await page.getByRole('button', { name: 'PRODUCT' }).click()
    await expect(page.getByRole('button', { name: 'PRODUCT' })).toHaveAttribute(
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
  await expect(page.locator('article.dev-chat__row')).toHaveCount(6)
  await expect.poll(distance).toBeLessThanOrEqual(2)

  // A small upward movement inside the visibility threshold still revokes
  // follow intent. The next runtime event must preserve that native offset.
  const parked = await transcript.evaluate((node) => {
    node.scrollTop -= 30
    node.dispatchEvent(new Event('scroll'))
    return node.scrollTop
  })
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:append')))
  await expect(page.locator('article.dev-chat__row')).toHaveCount(7)
  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBe(parked)
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click()
  await expect.poll(distance).toBeLessThanOrEqual(2)
  await expect(transcript).toBeFocused()
  expect(errors).toEqual([])
})
