import { expect, test, type Page } from '@playwright/test'

import {
  LEAD_MODEL_PANE_HARNESS_PATH,
  leadModelPaneHarnessHtml,
  leadModelPaneHarnessModuleSource,
} from './helpers/lead-model-pane-harness'

// Mounted acceptance for the Agent models section in a fresh install: no model connection and no
// selected default exist yet. The pane's own copy and actions are asserted here. The route that
// opens the section is covered by workspace-lead-entry.spec.ts.

const WORKSPACE_ID = '00000000-0000-4000-8000-0000000000aa'
const CONNECTION_REF = 'conn_fixture_0001'
const CREDENTIAL_ID = 'crd_01HZX5M3Q7K8N2P4R6T8V0W2Y4'
const READY = { ready: true, reasonCode: 'READY', remedy: null }
const CREDENTIAL_REVOKED = { ready: false, reasonCode: 'CREDENTIAL_REVOKED', remedy: null }

type Scenario = {
  client: boolean
  holdReads: boolean
  inventory: unknown
  defaults: unknown
  credentials: unknown
  lead: unknown
}

type Call = { op: string; input: Record<string, unknown> }

const lead = {
  createdAt: '2026-10-01T00:00:00.000Z',
  id: 'agent-lead-fixture',
  isWorkspaceLead: true,
  lifecycleState: 'active',
  name: 'Workspace lead',
  presentationMetadata: {},
  profile: { id: 'lead-profile', state: 'available', version: '2' },
  projectId: null,
  revision: 0,
  roleSummary: 'Coordinates work in this workspace',
  updatedAt: '2026-10-01T00:00:00.000Z',
  workspaceId: WORKSPACE_ID,
}

function inventory(connections: unknown[] = []) {
  return { availability: 'available', canManage: true, target: null, connections }
}

function connection(models: unknown[] = [{ providerModel: 'fixture-model', readiness: READY }]) {
  return {
    connectionRef: CONNECTION_REF,
    revision: 1,
    provider: 'fixture-provider',
    accountRef: 'fixture-account',
    authKind: 'api_key',
    fundingSource: 'byo_api',
    status: 'active',
    models,
  }
}

const credential = {
  credentialId: CREDENTIAL_ID,
  provider: 'fixture-provider',
  connectorRef: 'fixture-connector',
  status: 'active',
  revision: 3,
  createdAt: '2026-10-01T00:00:00.000Z',
}

function scenario(parts: Partial<Scenario> = {}): Scenario {
  return {
    client: true,
    holdReads: false,
    inventory: inventory(),
    defaults: { availability: 'available', canManage: true, defaults: { revision: 0 } },
    credentials: { canManage: true, connections: [] },
    lead,
    ...parts,
  }
}

async function mount(page: Page, value: Scenario) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**' + LEAD_MODEL_PANE_HARNESS_PATH, (route) =>
    route.fulfill({ contentType: 'text/html', body: leadModelPaneHarnessHtml() })
  )
  await page.goto(LEAD_MODEL_PANE_HARNESS_PATH)
  await page.evaluate((next) => {
    ;(window as unknown as { adeaLeadModelPaneScenario?: unknown }).adeaLeadModelPaneScenario = next
  }, value)
  await page.addScriptTag({ type: 'module', content: leadModelPaneHarnessModuleSource() })
  await page.waitForFunction(() =>
    Boolean((window as unknown as { leadModelPaneHarness?: unknown }).leadModelPaneHarness)
  )
  return errors
}

const callsOf = (page: Page, op: string) =>
  page.evaluate(
    (name) =>
      (
        window as unknown as {
          leadModelPaneHarness: { state: { calls: Call[] } }
        }
      ).leadModelPaneHarness.state.calls.filter((call) => call.op === name),
    op
  )

const noConnectionsCopy =
  'No model connections are available. Add a supported provider credential in Connections, then refresh.'

test('a fresh install shows no model connections, no selected defaults and no model actions', async ({
  page,
}) => {
  const errors = await mount(page, scenario())

  await expect(page.getByRole('heading', { name: 'Agent models' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByText(noConnectionsCopy)).toBeVisible()
  await expect(page.getByText('No model selected')).toHaveCount(3)
  await expect(page.getByText('Not configured', { exact: true })).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Register model connection' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Use for / })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Revoke model connection' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Refresh models' })).toBeEnabled()
  expect(errors).toEqual([])
})

test('while the model reads are in flight the pane says it is checking, then reports the settled result', async ({
  page,
}) => {
  const errors = await mount(page, scenario({ holdReads: true }))

  await expect(page.getByText('Checking model connections…')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Checking model defaults')).toHaveCount(3)

  await page.evaluate(() =>
    (
      window as unknown as { leadModelPaneHarness: { releaseReads(): void } }
    ).leadModelPaneHarness.releaseReads()
  )

  await expect(page.getByText('Checking model connections…')).toHaveCount(0)
  await expect(page.getByText(noConnectionsCopy)).toBeVisible()
  expect(errors).toEqual([])
})

test('an unreadable model inventory reads as unavailable, and a refresh recovers it', async ({
  page,
}) => {
  const errors = await mount(page, scenario())
  const unavailable =
    'Model setup is unavailable. Your lead customization, drafts and independent direct sessions are preserved.'
  await expect(page.getByText(noConnectionsCopy)).toBeVisible({ timeout: 30_000 })

  await page.evaluate(() =>
    (
      window as unknown as { leadModelPaneHarness: { setListFailing(failing: boolean): void } }
    ).leadModelPaneHarness.setListFailing(true)
  )
  await page.getByRole('button', { name: 'Refresh models' }).click()
  await expect(page.getByText(unavailable)).toBeVisible()
  await expect(page.getByText(noConnectionsCopy)).toHaveCount(0)

  await page.evaluate(() =>
    (
      window as unknown as { leadModelPaneHarness: { setListFailing(failing: boolean): void } }
    ).leadModelPaneHarness.setListFailing(false)
  )
  await page.getByRole('button', { name: 'Refresh models' }).click()
  await expect(page.getByText(noConnectionsCopy)).toBeVisible()
  await expect(page.getByText(unavailable)).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a workspace credential is registered as a model connection and its model is then listed', async ({
  page,
}) => {
  const errors = await mount(
    page,
    scenario({ credentials: { canManage: true, connections: [credential] } })
  )

  await page.getByRole('button', { name: 'Register model connection' }).click()

  await expect(
    page.getByText(
      'Model connection registered. Refresh model readiness before choosing a default.'
    )
  ).toBeVisible()
  await expect(page.getByText('fixture-provider · fixture-model', { exact: true })).toBeVisible()
  await expect(page.getByText('Eligible model', { exact: true })).toBeVisible()
  await expect(page.getByText(noConnectionsCopy)).toHaveCount(0)
  const calls = await callsOf(page, 'createModelConnection')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.input).toMatchObject({
    workspaceId: WORKSPACE_ID,
    input: { credentialRef: CREDENTIAL_ID, credentialRevision: 3 },
  })
  expect(errors).toEqual([])
})

test('a refused registration reports that nothing changed and keeps the credential offered', async ({
  page,
}) => {
  const errors = await mount(
    page,
    scenario({ credentials: { canManage: true, connections: [credential] } })
  )
  await page.evaluate(() =>
    (
      window as unknown as { leadModelPaneHarness: { failNext(op: string): void } }
    ).leadModelPaneHarness.failNext('createModelConnection')
  )

  await page.getByRole('button', { name: 'Register model connection' }).click()

  await expect(
    page.getByText('Model connection could not be changed. Refresh and review provider setup.')
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Register model connection' })).toBeVisible()
  await expect(page.getByText(noConnectionsCopy)).toBeVisible()
  expect(errors).toEqual([])
})

test('an eligible model can be chosen for a role, and the saved default names its provider and model', async ({
  page,
}) => {
  const errors = await mount(page, scenario({ inventory: inventory([connection()]) }))

  await page.getByRole('button', { name: 'Use for workspace lead' }).click()

  await expect(
    page.getByText(
      'Model default saved. Readiness and payer authorization are checked for each turn.'
    )
  ).toBeVisible()
  await expect(page.getByText('Selected', { exact: true })).toHaveCount(1)
  await expect(page.getByText('fixture-provider · fixture-model', { exact: true })).toHaveCount(2)
  const calls = await callsOf(page, 'setWorkspaceModelDefaults')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.input).toMatchObject({
    workspaceId: WORKSPACE_ID,
    input: {
      expectedRevision: 0,
      lead: { connectionRef: CONNECTION_REF, providerModel: 'fixture-model' },
    },
  })
  expect(errors).toEqual([])
})

test('a model that is not ready names its remedy and offers no default choice', async ({
  page,
}) => {
  const errors = await mount(
    page,
    scenario({
      inventory: inventory([
        connection([{ providerModel: 'fixture-model', readiness: CREDENTIAL_REVOKED }]),
      ]),
    })
  )

  await expect(page.getByText('Setup required', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Choose a connection with a valid credential in workspace settings.')
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Use for workspace lead' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Use for direct sessions' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Revoke model connection' })).toBeEnabled()
  expect(errors).toEqual([])
})

test('a saved default that names a connection no longer listed reads as unavailable', async ({
  page,
}) => {
  const errors = await mount(
    page,
    scenario({
      inventory: inventory([connection()]),
      defaults: {
        availability: 'available',
        canManage: true,
        defaults: {
          revision: 4,
          lead: { connectionRef: 'conn_fixture_removed', providerModel: 'fixture-model' },
        },
      },
    })
  )

  await expect(page.getByText('Saved model connection unavailable', { exact: true })).toBeVisible()
  await expect(page.getByText('Selected', { exact: true })).toHaveCount(1)
  expect(errors).toEqual([])
})

test('revoking a connection marks it revoked, removes the revoke action and keeps the saved lead default', async ({
  page,
}) => {
  const errors = await mount(
    page,
    scenario({
      inventory: inventory([connection()]),
      defaults: {
        availability: 'available',
        canManage: true,
        defaults: {
          revision: 1,
          lead: { connectionRef: CONNECTION_REF, providerModel: 'fixture-model' },
        },
      },
    })
  )
  await expect(page.getByText('Selected', { exact: true })).toHaveCount(1)

  await page.getByRole('button', { name: 'Revoke model connection' }).click()

  // The copy says drafts and direct sessions are preserved. This harness has neither, so only the
  // copy is asserted for them; the checks below are state checks on the saved lead default.
  await expect(
    page.getByText('Model connection revoked. Existing drafts and direct sessions are preserved.')
  ).toBeVisible()
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Revoke model connection' })).toHaveCount(0)
  await expect(page.getByText('Selected', { exact: true })).toHaveCount(1)
  await expect(
    page.getByText('fixture-provider · fixture-model', { exact: true }).first()
  ).toBeVisible()
  await expect(page.getByText('Saved model connection unavailable', { exact: true })).toHaveCount(0)
  expect(await callsOf(page, 'setWorkspaceModelDefaults')).toHaveLength(0)
  const saved = await page.evaluate(
    () =>
      (
        window as unknown as {
          leadModelPaneHarness: {
            state: { defaults: { defaults?: { lead?: { connectionRef: string } } } }
          }
        }
      ).leadModelPaneHarness.state.defaults.defaults?.lead?.connectionRef
  )
  expect(saved).toBe(CONNECTION_REF)
  const calls = await callsOf(page, 'revokeModelConnection')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.input).toMatchObject({
    workspaceId: WORKSPACE_ID,
    input: { connectionRef: CONNECTION_REF, expectedRevision: 1 },
  })
  expect(errors).toEqual([])
})

test('without a client the pane says model setup is unavailable in this view', async ({ page }) => {
  const errors = await mount(page, scenario({ client: false }))

  await expect(
    page.getByText(
      'Model setup is unavailable in this view. Your drafts and direct sessions remain available.'
    )
  ).toBeVisible({ timeout: 30_000 })
  expect(errors).toEqual([])
})
