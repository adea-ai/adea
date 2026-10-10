import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import solid from 'vite-plugin-solid'
import { startConnectedFixtureChild } from './helpers/lead-role-choices-connected-client.mjs'

const safeCode = (value: unknown) =>
  typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/u.test(value) ? value : undefined

let server: ViteDevServer | undefined
let fixture: Awaited<ReturnType<typeof startConnectedFixtureChild>> | undefined
let url = ''

test.beforeAll(async () => {
  test.skip(
    process.env.PI_ROLE_CONNECTED_PROOF !== '1',
    'Use the hash-verified local candidate wrapper for this opt-in PostgreSQL/CP journey.'
  )
  const bun = process.env.PI_FACTORY_BUN
  const cpRoot = process.env.PI_FACTORY_CP_ROOT
  if (!bun || !cpRoot) throw new Error('CONNECTED_FIXTURE_PROCESS_CONFIGURATION_REQUIRED')
  fixture = await startConnectedFixtureChild({ bun, cwd: cpRoot, env: process.env })
  const root = resolve(process.cwd(), 'apps/web')
  const harness = '/@fs' + resolve(root, 'e2e/helpers/lead-role-choices-connected-harness-app.tsx')
  server = await createServer({
    configFile: false,
    root,
    publicDir: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: 'error',
    plugins: [
      solid(),
      {
        name: 'lead-role-connected-fixture',
        configureServer(vite) {
          vite.middlewares.use('/__lead-roles-connected', (_request, response) => {
            response.setHeader('Content-Type', 'text/html')
            response.end(
              `<html><body><div id="harness-root"></div><script type="module" src="${harness}"></script></body></html>`
            )
          })
        },
      },
    ],
    resolve: { dedupe: ['solid-js'], conditions: ['solid', 'browser', 'development'] },
    server: { watch: null, host: '127.0.0.1', port: 0, strictPort: true },
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('LEAD_ROLE_FIXTURE_NOT_BOUND')
  url = `http://127.0.0.1:${address.port}/__lead-roles-connected?workspace=${encodeURIComponent(fixture.workspaceId)}&channel=${encodeURIComponent(fixture.channelId)}`
})

test.afterAll(async () => {
  await server?.close()
  await fixture?.close()
})

test('mounted lead choice is disclosed before inference and matches the real admitted and dispatched selection', async ({
  page,
}) => {
  test.skip(process.env.PI_ROLE_CONNECTED_PROOF !== '1')
  const connected = fixture!
  const modelMetadataResponses: Array<{ code?: string; path: string; status: number }> = []
  const apiForwardFailures: Array<{ causeCode?: string; code?: string; errorClass: string }> = []
  await page.route('**/api/**', async (route) => {
    const incoming = new URL(route.request().url())
    const headers = new Headers(route.request().headers())
    headers.set('authorization', `Temporary ${connected.credential}`)
    headers.delete('host')
    headers.delete('content-length')
    headers.delete('connection')
    const method = route.request().method()
    let response: Response
    try {
      response = await fetch(`${connected.baseUrl}${incoming.pathname}${incoming.search}`, {
        method,
        headers,
        ...(method === 'GET' || method === 'HEAD'
          ? {}
          : { body: route.request().postDataBuffer() ?? undefined }),
      })
      const responseText = await response.text()
      if (incoming.pathname.endsWith('/model-connections')) {
        let code: string | undefined
        try {
          const payload: unknown = JSON.parse(responseText)
          if (
            payload &&
            typeof payload === 'object' &&
            'code' in payload &&
            typeof payload.code === 'string' &&
            /^[A-Z][A-Z0-9_]{2,63}$|^[a-z][a-z0-9_]{2,63}$/u.test(payload.code)
          )
            code = payload.code
        } catch {}
        modelMetadataResponses.push({ path: incoming.pathname, status: response.status, code })
      }
      await route.fulfill({
        status: response.status,
        headers: {
          'content-type': response.headers.get('content-type') ?? 'application/json',
          'cache-control': response.headers.get('cache-control') ?? 'private, no-store',
        },
        body: responseText,
      })
    } catch (error) {
      const errorClass =
        error &&
        typeof error === 'object' &&
        'name' in error &&
        typeof error.name === 'string' &&
        /^[A-Za-z][A-Za-z0-9]{0,48}$/u.test(error.name)
          ? error.name
          : 'Error'
      const errorRecord = error && typeof error === 'object' ? error : undefined
      const cause =
        errorRecord &&
        'cause' in errorRecord &&
        errorRecord.cause &&
        typeof errorRecord.cause === 'object'
          ? errorRecord.cause
          : undefined
      const causeCode = cause && 'code' in cause ? safeCode(cause.code) : undefined
      const code = errorRecord && 'code' in errorRecord ? safeCode(errorRecord.code) : undefined
      apiForwardFailures.push({
        errorClass,
        ...(code ? { code } : {}),
        ...(causeCode ? { causeCode } : {}),
      })
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'fixture_unavailable' }),
      })
    }
  })
  await page.goto(url)

  const leadModelChoice = page
    .getByLabel('Lead model choice', { exact: true })
    .getByRole('button', { name: 'openai / gpt-5-mini (account:production-factory)', exact: true })
  try {
    await leadModelChoice.waitFor({ state: 'visible', timeout: 15_000 })
  } catch {
    const fixtureSnapshot = await connected.snapshot()
    throw new Error(
      `CONNECTED_MODEL_CHOOSER_UNAVAILABLE:${JSON.stringify({
        modelMetadataResponses,
        apiForwardFailures,
        modelMetadataFailures: fixtureSnapshot.modelMetadataFailures,
      })}`
    )
  }
  await leadModelChoice.click()
  await page
    .getByLabel('Delegated agent model choice', { exact: true })
    .getByRole('button', { name: 'openai / gpt-5 (account:production-factory)', exact: true })
    .click()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()

  const requestedLabel = page.getByLabel('Requested role selections')
  await expect(requestedLabel).toContainText('"lead"', { timeout: 10_000 })
  const requested = JSON.parse((await requestedLabel.textContent()) ?? 'null')
  expect(requested.lead.selectionRef).toMatch(/^msel_[a-f0-9]{32}$/u)
  expect(requested.child.selectionRef).toMatch(/^msel_[a-f0-9]{32}$/u)
  expect(requested.lead.selectionRevision).toBeGreaterThan(0)
  expect(requested.child.selectionRevision).toBeGreaterThan(0)
  expect(requested.lead.selectionRef).not.toBe(requested.child.selectionRef)
  const intentId = await page.getByLabel('Intent ID').textContent()
  expect(intentId).toMatch(/^[0-9a-f-]{36}$/u)
  const beforePrepare = await connected.snapshot(intentId!)
  expect(beforePrepare.requestedModelSelections).toEqual(requested)

  await page.getByRole('button', { name: 'Review model and payer', exact: true }).click()
  const disclosure = page.getByLabel('Current model and payer')
  try {
    await expect(disclosure).toContainText('Provider: openai · Model: gpt-5-mini', {
      timeout: 10_000,
    })
  } catch {
    const preparationSnapshot = await connected.snapshot(intentId!)
    throw new Error(
      `CONNECTED_PREPARATION_NOT_READY:${JSON.stringify({
        preparation: preparationSnapshot.preparationProjection
          ? {
              state: preparationSnapshot.preparationProjection.state,
              availability: preparationSnapshot.preparationProjection.availability,
              reasonCode: preparationSnapshot.preparationProjection.reasonCode,
              selectedLeadMatches:
                preparationSnapshot.preparationProjection.selectionRef ===
                  requested.lead.selectionRef &&
                preparationSnapshot.preparationProjection.selectionRevision ===
                  requested.lead.selectionRevision,
            }
          : null,
        controlPlaneWire: preparationSnapshot.controlPlaneWire,
        productReaderRequests: preparationSnapshot.readerRequests,
        databaseEnvironment: preparationSnapshot.databaseEnvironment,
      })}`
    )
  }
  await expect(disclosure).toContainText(
    'Account: account:production-factory · Authentication: api_key'
  )
  await expect(disclosure).toContainText(
    'Funding: byo_api · Payer: Synthetic explicit payer (provider_account, payer:production-fixture)'
  )
  await expect(page.getByRole('button', { name: 'Start lead turn', exact: true })).toBeDisabled()
  const beforeInference = await connected.evidence()
  expect(beforeInference.physicalSends).toBe(0)
  expect(beforeInference.providerModels).toEqual([])
  const preparedSnapshot = await connected.snapshot(intentId!)
  expect(preparedSnapshot.preparationProjection?.selectionRef).toBe(requested.lead.selectionRef)
  expect(
    preparedSnapshot.fundingBindings.some(
      (binding) =>
        binding.selectionRef === requested.lead.selectionRef &&
        binding.selectionRevision === requested.lead.selectionRevision
    )
  ).toBe(true)

  await page.getByRole('button', { name: 'Confirm this model and payer', exact: true }).click()
  await page.getByRole('button', { name: 'Start lead turn', exact: true }).click()
  const dispatchAfterClientDeadline = new Promise((complete) => {
    const timer = setTimeout(() => {
      void connected.snapshot(intentId!).then(
        (snapshot) => complete(snapshot),
        () => complete(null)
      )
    }, 5_500)
    timer.unref?.()
  })
  try {
    await expect(page.getByLabel('Conversation timeline')).toContainText(
      'Actual production factory answer\\n',
      { timeout: 45_000 }
    )
    const postDispatchSnapshot = await connected.snapshot(intentId!)
    const dispatchOperation = postDispatchSnapshot.productOperationDiagnostics?.find(
      (entry: { operation?: string }) => entry.operation === 'dispatch'
    )
    console.log(
      `CONNECTED_DISPATCH_TIMING:${JSON.stringify({
        dispatch: dispatchOperation ?? null,
        productOperationDiagnostics: postDispatchSnapshot.productOperationDiagnostics ?? null,
        drainDiagnostics: postDispatchSnapshot.drainDiagnostics ?? null,
        slowWire: (postDispatchSnapshot.controlPlaneWire ?? []).filter(
          (entry: { elapsedMs?: number }) => (entry.elapsedMs ?? 0) > 1_000
        ),
      })}`
    )
    // A later terminal publication must never mask a dispatch that hit the
    // client deadline: the mounted flow has to observe the dispatch return.
    expect(dispatchOperation?.outcome).toBe('returned')
    expect(dispatchOperation?.elapsedMs).toBeLessThan(5_000)
  } catch {
    const runtimeEvidence = await connected.evidence()
    const dispatchSnapshot = await connected.snapshot(intentId!)
    const deadlineSnapshot = await dispatchAfterClientDeadline
    throw new Error(
      `CONNECTED_TIMELINE_NOT_PUBLISHED:${JSON.stringify({
        physicalSends: runtimeEvidence.physicalSends,
        providerModelCount: runtimeEvidence.providerModels?.length ?? null,
        publicationChecks: runtimeEvidence.publicationChecks ?? null,
        productReads: runtimeEvidence.productReads ?? null,
        canonical: runtimeEvidence.canonical,
        dispatchState: dispatchSnapshot.dispatchProjection?.state ?? null,
        dispatchProjection: dispatchSnapshot.dispatchProjection,
        dispatchAfterClientDeadline: deadlineSnapshot,
        hasPublishedMessage: Boolean(dispatchSnapshot.dispatchProjection?.publishedMessageId),
        drainFailure: dispatchSnapshot.drainFailure,
        drainDiagnostics: dispatchSnapshot.drainDiagnostics,
        productOperationDiagnostics: dispatchSnapshot.productOperationDiagnostics,
        readerRequests: dispatchSnapshot.readerRequests,
        runtimeReadCounts: dispatchSnapshot.runtimeReadCounts,
        publicationGate: dispatchSnapshot.publicationGate,
        controlPlaneWire: dispatchSnapshot.controlPlaneWire,
        databaseEnvironment: dispatchSnapshot.databaseEnvironment,
        statusState: dispatchSnapshot.statusProjection?.state ?? null,
        statusReason: dispatchSnapshot.statusProjection?.reasonCode ?? null,
        progress: dispatchSnapshot.progressProjection,
        persistedRuntime: dispatchSnapshot.runtimeRow,
      })}`
    )
  }
  await expect(page.getByLabel('Conversation timeline')).toContainText(
    'Connected role selection question'
  )

  const afterInference = await connected.evidence()
  expect(afterInference.physicalSends).toBe(1)
  expect(afterInference.providerModels).toEqual(['gpt-5-mini'])
  expect(afterInference.canonical.executions).toBe(1)
  expect(afterInference.canonical.attempts).toBe(1)
  expect(afterInference.canonical.budgets).toBe(1)
  const finalSnapshot = await connected.snapshot(intentId!)
  expect(finalSnapshot.drainFailure).toBe(false)
  expect(finalSnapshot.statusProjection?.state).toBe('completed')
  expect(finalSnapshot.statusProjection?.publishedMessageId).toMatch(/^[0-9a-f-]{36}$/u)
  expect(finalSnapshot.runtimeRow?.state).toBe('completed')
  expect(finalSnapshot.runtimeRow?.publishedMessageId).toBe(
    finalSnapshot.statusProjection?.publishedMessageId
  )
  expect(finalSnapshot.publicationGate.calls).toBeGreaterThan(0)
  expect(finalSnapshot.publicationGate.successes).toBe(finalSnapshot.publicationGate.calls)
  expect(finalSnapshot.publicationGate.failures).toEqual([])
  const publicationWire = finalSnapshot.controlPlaneWire.filter(
    (entry: { operation: string }) => entry.operation === 'pi-durable.lead.publication.current'
  )
  expect(publicationWire.length).toBeGreaterThan(0)
  expect(
    publicationWire.every(
      (entry: { requestIdMatches: boolean; traceIdMatches: boolean }) =>
        entry.requestIdMatches && entry.traceIdMatches
    )
  ).toBe(true)
  expect(finalSnapshot.publicationGate.responses.length).toBe(publicationWire.length)
  expect(
    finalSnapshot.publicationGate.responses.every(
      (entry: {
        schemaVersion: boolean
        mismatchedFields: string[]
        workspaceMatches: boolean
        actorMatches: boolean
        authorityRevisionValid: boolean
        expiryValid: boolean
      }) =>
        entry.schemaVersion &&
        entry.mismatchedFields.length === 0 &&
        entry.workspaceMatches &&
        entry.actorMatches &&
        entry.authorityRevisionValid &&
        entry.expiryValid
    )
  ).toBe(true)
  expect(afterInference.productReads).toBe(finalSnapshot.readerRequests)
  const preparation = finalSnapshot.preparationProjection
  const dispatch = finalSnapshot.dispatchProjection
  expect(preparation?.selectionRef).toBe(requested.lead.selectionRef)
  expect(preparation?.selectionRevision).toBe(requested.lead.selectionRevision)
  expect(dispatch?.selectionRef).toBe(requested.lead.selectionRef)
  expect(dispatch?.selectionRevision).toBe(requested.lead.selectionRevision)
  expect(dispatch?.dispatchId).toMatch(/^dispatch_[a-f0-9]{32}$/u)
  expect(dispatch?.runtimeSessionId).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/u)
})
