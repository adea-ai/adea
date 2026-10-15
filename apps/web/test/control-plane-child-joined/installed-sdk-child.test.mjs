// Opt-in installed-SDK consumer proof for #1211's child path. The lead is prepared and dispatched
// by Adea's product (createLeadTurnProduct) through the SDK packages installed from Adea's own
// lockfile, over HTTP to CP's actual control API and production lead service. CP's host then
// allocates a child from that same running lead. The child runtime, spending and the account,
// scope, tool-policy and provider ports are scripted. Not live, not a deployment, not TLS.
import { beforeAll, afterAll, test, expect } from 'bun:test'
import { startHarness, pin, root } from './harness.mjs'
import { verifyInstalledPackages } from './installed-packages.mjs'
import { installedLeadSdkPort } from '../../src/server/lead-turn-sdk-port.ts'
import { createConfiguredLeadTurnDependencies } from '../../src/server/lead-turn-composition.ts'
import { createLeadTurnProduct } from '../../src/server/lead-turn-product.ts'

const manifestPath = process.env.PI_FACTORY_MANIFEST
if (!manifestPath) throw new Error('VERIFIED_CANDIDATE_MANIFEST_REQUIRED')
let harness, control, product, scope, installed, started, status
beforeAll(async () => {
  // Package and source identity are verified before any database connection is opened.
  installed = await verifyInstalledPackages({
    manifestPath,
    expectedHead: pin.revision,
    cpRoot: root,
    port: installedLeadSdkPort,
  })
  harness = await startHarness({
    allowanceSource: 'profile',
    controlApi: true,
    title: '1211 installed SDK child proof',
  })
  control = harness.control
  const { hostMetadata, signing, workspaceId } = harness
  const dependencies = await createConfiguredLeadTurnDependencies({
    environment: {
      NODE_ENV: 'test',
      PI_DURABLE_LEAD_ENABLED: 'true',
      PI_DURABLE_LEAD_TARGET: JSON.stringify(hostMetadata.target),
      CONTROL_PLANE_ORIGIN: hostMetadata.baseUrl,
      CONTROL_PLANE_SIGNING_KEY: JSON.stringify(signing.privateJwk),
      CONTROL_PLANE_SIGNING_KEY_ID: signing.keyId,
      CONTROL_PLANE_SIGNING_ISSUER: signing.issuer,
    },
    resolveControlPlaneScope: async () => ({ workspaceId }),
  })
  expect(dependencies.adapter).toBeTruthy()
  product = createLeadTurnProduct(harness.connection.db, dependencies)
  scope = {
    workspaceId: harness.workspace.id,
    intentId: harness.intentId,
    userId: harness.owner.principal.userId,
  }
}, 60000)
afterAll(async () => {
  await harness?.stop()
}, 15000)

test('the installed SDK packages are the registry versions the CP head under test builds', () => {
  expect(installed.head).toBe(pin.revision)
  expect(installed.packages.map((p) => p.name).toSorted()).toEqual([
    '@adea-ai/contracts',
    '@adea-ai/runtime-sdk',
    '@adea-ai/sdk',
  ])
  for (const entry of installed.packages) expect(entry.comparedFiles).toBeGreaterThan(0)
})
test('Adea prepares the lead through the installed SDK with no inference or provider work', async () => {
  const prepared = await product.prepare(scope)
  expect(prepared.state).toBe('prepared')
  expect(prepared.selectionRef).toBe(harness.choices.requestedModelSelections.lead.selectionRef)
  const evidence = await control('evidence')
  expect(evidence.physicalSends).toBe(0)
  expect(evidence.secretResolutions).toBe(0)
  expect(evidence.canonical).toMatchObject({ executions: 1, attempts: 1, budgets: 1 })
  // Every CP product read came through Adea's signed reader.
  expect(evidence.productReads).toBe(harness.productRequests())
}, 30000)
test('Adea dispatches the lead through the installed SDK and it runs', async () => {
  started = await product.dispatch(scope)
  expect(['starting', 'running']).toContain(started.state)
  expect(started.reasonCode).toBeUndefined()
  expect(started.dispatchId).toBeTruthy()
  expect(started.runtimeSessionId).toBeTruthy()
  const deadline = Date.now() + 15000
  do {
    status = await product.status(scope)
    if (status.state === 'running' && status.executionId && status.attemptId) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  expect(status.state).toBe('running')
  expect(status.executionId).toBeTruthy()
  expect(status.attemptId).toBeTruthy()
}, 30000)
test('the SDK-dispatched lead carries the allowance stated only on its pinned profile version', async () => {
  const adopted = await control('adopt', {
    executionId: status.executionId,
    attemptId: status.attemptId,
  })
  expect(adopted.ok).toBe(true)
  const provenance = await control('provenance')
  expect(provenance.source).toBe('profile')
  expect(provenance.catalogVersion).toMatchObject({
    profileVersionId: provenance.planProfile.profileVersionId,
    contentDigest: provenance.planProfile.contentDigest,
    lifecycle: 'published',
  })
  expect(provenance.requestAllowance).toBeUndefined()
  expect(provenance.planAllowance).toEqual(provenance.profileAllowance)
  expect(provenance.lead.availableMicrounits).toBe(provenance.profileAllowance.maximumMicrounits)
  expect(provenance.lead.availableTokens).toBe(provenance.profileAllowance.maximumTokens)
}, 30000)
test('that lead funds its child with exactly the allowance and the child starts once', async () => {
  const allocation = await control('allocate')
  expect(allocation.ok).toBe(true)
  const { before, after, leadAllowance } = allocation
  expect(after.parent.maximumMicrounits).toBe(before.parent.maximumMicrounits)
  expect(after.parent.spentMicrounits).toBe(0)
  expect(after.child.maximumMicrounits).toBe(leadAllowance.maximumMicrounits)
  expect(after.child.maximumTokens).toBe(leadAllowance.maximumTokens)
  expect(after.parent.availableMicrounits).toBe(0)
  expect(after.parent.availableTokens).toBe(0)
  expect(after.canonical).toMatchObject({ executions: 2, attempts: 2, budgets: 2 })
  const childStarted = await control('start-child')
  expect(childStarted.ok).toBe(true)
  expect(childStarted.after.runtime).toEqual({
    startCalls: 1,
    distinctStarts: 1,
    childAttemptReservations: 1,
  })
  const retried = await control('start-child')
  expect(retried.after.runtime.distinctStarts).toBe(1)
  expect(retried.after.physicalSends).toBe(0)
}, 30000)
test('a settled lead frees balance but the allowance still funds no sibling', async () => {
  await control('spend-lead', { costMicrounits: 1000, tokens: 10 })
  const sibling = await control('allocate-sibling', { which: 'second' })
  expect(sibling.ok).toBe(false)
  expect(sibling.code).toBe('BUDGET_EXHAUSTED')
  expect(sibling.persistedChild).toBe(false)
  expect(sibling.after.canonical).toEqual(sibling.before.canonical)
  expect(sibling.after.physicalSends).toBe(0)
}, 30000)
test('the lead stays visible and consistent through the installed SDK after child funding', async () => {
  const after = await product.status(scope)
  expect(after.state).toBe('running')
  expect(after.executionId).toBe(status.executionId)
  expect(after.attemptId).toBe(status.attemptId)
}, 30000)
