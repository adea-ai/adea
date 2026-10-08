// TEST ONLY. Real product/controller ports, PG authority and a separately pinned composed host.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createDatabase } from '../../packages/db/src/connection.ts'
import { createAdeaIntentFixture } from '../../packages/db/tests/fixtures/pi-durable-candidate.ts'
import { createLeadTurnProduct } from '../../apps/web/src/server/lead-turn-product.ts'
import { createLeadTurnSdkAdapter } from '../../apps/web/src/server/lead-turn-sdk-adapter.ts'
import { projectModelSelectionFunding } from '../../apps/web/src/server/model-connections-proxy.ts'
import { createLeadTurnViewController } from '../../packages/workspace-ui/src/lead-turn-state.ts'
import { roleModelChoice } from '../../packages/workspace-ui/src/lead-model-state.ts'
import { createPackedConsumerFixture } from './packed-consumer-fixture.mjs'
import { startCandidateLeadHostProcess } from './lead-host-process.mjs'
import { createCurrentProductReaderHandler } from './current-product-reader.mjs'

const args = Object.fromEntries(
  Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [
    process.argv[2 + i * 2],
    process.argv[3 + i * 2],
  ])
)
for (const flag of ['--manifest', '--host', '--head', '--report'])
  if (!args[flag]) throw new Error(`Missing ${flag}`)
if (args['--phase'] && args['--phase'] !== 'preparation')
  throw new Error('Unknown diagnostic phase')
if (!process.env.DATABASE_URL) throw new Error('Isolated fixture DATABASE_URL required')
function id(prefix) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let number = BigInt(`0x${randomBytes(16).toString('hex')}`),
    suffix = ''
  for (let i = 0; i < 26; i++) {
    suffix = alphabet[Number(number & 31n)] + suffix
    number >>= 5n
  }
  return `${prefix}_${suffix}`
}
function binding(pin) {
  return {
    executionId: pin.executionId,
    attemptId: pin.attemptId,
    selectionRef: pin.selectionRef,
    selectionRevision: pin.selectionRevision,
  }
}
let adea, database, host, modelPack, leadPack, controller, readerServer
let selectedPins, acceptedIntentId
const readerCredential = randomBytes(32).toString('hex')
let currentProductReads = 0
let phase = 'fixture-setup'
let preparationReceived = false
let prepareErrorCode
let productPreparation
const transportResponses = []
try {
  adea = await createAdeaIntentFixture(process.env.DATABASE_URL)
  modelPack = await createPackedConsumerFixture(args['--manifest'], 'model')
  leadPack = await createPackedConsumerFixture(args['--manifest'], 'lead')
  readerServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: createCurrentProductReaderHandler({
      credential: readerCredential,
      readCurrent: async (request) => {
        if (
          !host ||
          !selectedPins ||
          request.workspaceId !== adea.workspaceId ||
          request.intentId !== acceptedIntentId ||
          request.principalId !== host.principalId
        )
          return undefined
        const current = await adea.currentEvidence(
          { ...host, ...selectedPins },
          { includeCanonicalActor: true }
        )
        currentProductReads++
        return current
      },
    }),
  })
  host = await startCandidateLeadHostProcess(args['--host'], {
    expectedHead: args['--head'],
    workspaceId: adea.workspaceId,
    workspaceScope: true,
    prepareFunding: true,
    currentProductReader: {
      url: new URL('/current-product', readerServer.url).href,
      credential: readerCredential,
    },
  })
  // Exact R2 composed-host metadata is required; never synthesize a separate service or selection.
  assert.equal(host.currentProductReaderConfigured, true)
  assert.ok(host.credentialRef && host.target, 'COMPOSED_METADATA_HOST_REQUIRED')
  const options = {
    baseUrl: host.baseUrl,
    serviceToken: host.testCredential,
    workspaceId: host.workspaceId,
    servicePrincipalId: host.principalId,
    requestId: () => id('req'),
    traceId: () => id('trc'),
    commandId: () => id('cmd'),
    now: () => new Date(host.at),
    fetch: async (input, init) => {
      const response = await fetch(input, init)
      transportResponses.push({
        path: new URL(input instanceof Request ? input.url : input).pathname,
        status: response.status,
      })
      return response
    },
  }
  const models = modelPack.entry.createCandidateModelConnections(options)
  const leads = leadPack.entry.createCandidateLeadDispatch(options)
  const connection = await models.create(
    { credentialRef: host.credentialRef, credentialRevision: 1 },
    `connection:${randomUUID()}`
  )
  const inventory = await models.list({ target: host.target })
  const eligible = inventory
    .find((item) => item.connection.connectionRef === connection.connectionRef)
    ?.models.find((model) => model.readiness.ready)
  assert.ok(eligible, 'No qualified model from the actual metadata API')
  const choice = { connectionRef: connection.connectionRef, providerModel: eligible.providerModel }
  await models.setDefaults({ expectedRevision: 0, lead: choice }, `default:${randomUUID()}`)
  assert.deepEqual(roleModelChoice(await models.getDefaults(), 'lead'), choice)
  const selected = await models.resolve({ role: 'lead', target: host.target })
  assert.equal(selected.connectionRef, choice.connectionRef)
  assert.equal(selected.providerModel, choice.providerModel)
  await adea.configureProfile(host)
  const accepted = await adea.admit()
  selectedPins = {
    selectionRef: selected.selectionRef,
    selectionRevision: selected.selectionRevision,
  }
  acceptedIntentId = accepted.leadTurn.intentId
  const evidence = await adea.currentEvidence(
    { ...host, selectionRef: selected.selectionRef, selectionRevision: selected.selectionRevision },
    { includeCanonicalActor: true }
  )
  assert.equal(evidence.canonicalActorPrincipalId, `user:${adea.actorUserId}`)
  assert.ok(!evidence.allowedPrincipalIds.includes(evidence.canonicalActorPrincipalId))
  const initial = await host.metrics()
  phase = 'intent-registration'
  await host.registerIntent(evidence)
  const registered = await host.metrics()
  for (const key of [
    'commands',
    'executions',
    'attempts',
    'usageBudgets',
    'usageEntries',
    'runtimeAdmissions',
    'runtimeSessions',
    'dispatchReceipts',
    'providerRequests',
  ]) {
    assert.ok(Number.isSafeInteger(initial[key]) && Number.isSafeInteger(registered[key]))
    assert.equal(initial[key], 0)
    assert.equal(registered[key], initial[key], `Registration cannot admit or infer: ${key}`)
  }
  let preparation
  const adapter = createLeadTurnSdkAdapter({
    workspaceId: host.workspaceId,
    preparationSchema: leadPack.entry.candidatePreparationSchema,
    lookupResponseSchema: leadPack.entry.candidateLookupResponseSchema,
    prepare: async (intentId) => {
      try {
        preparation = await leads.prepare(intentId)
        preparationReceived = true
        return { data: preparation }
      } catch (error) {
        if (
          [
            'CANDIDATE_OPERATION_REJECTED',
            'CANDIDATE_RESPONSE_MISMATCH',
            'PI_LEAD_PROJECT_SCOPE_REQUIRED',
            'PI_LEAD_UNAVAILABLE',
            'PI_LEAD_AUTHORITY_REVOKED',
            'PI_LEAD_INTENT_CONFLICT',
          ].includes(error?.code)
        )
          prepareErrorCode = error.code
        throw error
      }
    },
    lookup: (intentId) => leads.lookup(intentId),
    dispatch: (intentId, preparationRef) => leads.dispatch(intentId, preparationRef),
    status: (dispatchId) => leads.status(dispatchId),
    progress: (dispatchId, cursor) => leads.progress(dispatchId, cursor),
    cancel: (dispatchId) => leads.cancel(dispatchId),
  })
  database = createDatabase(process.env.DATABASE_URL)
  const product = createLeadTurnProduct(database.db, {
    adapter,
    authorizeConfirmedStart: async (authority, prepared) => {
      assert.equal(authority.originalActorRef, evidence.canonicalActorPrincipalId)
      assert.deepEqual(
        await models.funding(binding(prepared)),
        preparation.funding,
        'The recorded payer/authority must remain identical before explicit start'
      )
      return prepared
    },
  })
  const productScope = {
    workspaceId: adea.adeaWorkspaceId,
    intentId: accepted.leadTurn.intentId,
    userId: adea.actorUserId,
  }
  controller = createLeadTurnViewController({
    scope: () => ({
      workspaceId: adea.adeaWorkspaceId,
      channelId: adea.channelId,
      audienceEpoch: 0,
    }),
    changed: () => {},
    port: {
      latest: async () => ({
        leadTurn: await product.latest(adea.adeaWorkspaceId, adea.channelId, adea.actorUserId),
      }),
      status: async () => ({ leadTurn: await product.status(productScope) }),
      progress: (_scope, _intent, cursor) => product.progress(productScope, cursor),
      prepare: async () => {
        const leadTurn = await product.prepare(productScope)
        productPreparation = { state: leadTurn.state, reasonCode: leadTurn.reasonCode }
        return { leadTurn }
      },
      funding: async (_scope, pin) => ({
        funding: projectModelSelectionFunding(
          await models.funding(pin),
          adea.adeaWorkspaceId,
          host.workspaceId,
          pin,
          Date.now()
        ),
      }),
      start: async () => ({ leadTurn: await product.dispatch(productScope) }),
      cancel: async () => ({ leadTurn: await product.cancel(productScope) }),
    },
  })
  await controller.refresh()
  phase = 'product-preparation'
  await controller.prepare()
  assert.equal(controller.view.turn.state, 'prepared')
  assert.equal(controller.view.funding?.state, 'ready')
  for (const key of ['selectionRef', 'selectionRevision'])
    assert.equal(preparation[key], selected[key])
  for (const key of ['provider', 'providerModel', 'accountRef', 'authKind', 'fundingSource'])
    assert.equal(preparation.funding[key], selected[key], `Prepared ${key} cannot use a fallback`)
  const afterPrepare = await host.metrics()
  for (const key of [
    'providerRequests',
    'runtimeAdmissions',
    'runtimeSessions',
    'dispatchReceipts',
    'fixtureCredentialUses',
    'modelsResolutions',
  ]) {
    assert.ok(Number.isSafeInteger(initial[key]) && Number.isSafeInteger(afterPrepare[key]))
    assert.equal(afterPrepare[key], initial[key], `Preparation must not increment ${key}`)
  }
  if (args['--phase'] === 'preparation') {
    await writeFile(
      args['--report'],
      JSON.stringify(
        {
          schemaVersion: 'adea-selected-model-preparation/v1',
          sourceIdentity: host.sourceIdentity,
          packages: modelPack.hashes,
          productPreparation,
          preparationReceived,
          currentProductReads,
          transportResponses,
          state: controller.view.turn.state,
          fundingState: controller.view.funding.state,
          metrics: afterPrepare,
          selectedPreparationVerified: true,
          explicitStartPerformed: false,
          inferenceVerified: false,
          liveProviderVerified: false,
        },
        null,
        2
      ) + '\n'
    )
  } else {
    const reviewed = controller.view.funding
    phase = 'explicit-start'
    await controller.start(reviewed)
    assert.ok(
      controller.view.turn.dispatchId,
      'Explicit confirmed start must retain an actual dispatch'
    )
    const dispatchId = controller.view.turn.dispatchId
    const deadline = Date.now() + 60_000
    phase = 'runtime-status'
    let observed
    do {
      observed = await leads.status(dispatchId)
      if (['completed', 'failed', 'cancelled'].includes(observed.state)) break
      await new Promise((done) => setTimeout(done, 50))
    } while (Date.now() < deadline)
    assert.equal(observed.state, 'completed')
    for (const key of ['executionId', 'attemptId']) assert.equal(observed[key], preparation[key])
    await controller.refresh()
    // No public current-publication port is invented from a status/funding read.
    assert.equal((await product.status(productScope)).reasonCode, 'PUBLICATION_WITHHELD')
    assert.equal((await adea.counts()).totalChannelMessages, 1)
    const completed = await host.evidence(evidence.intentId)
    assert.equal(completed.metrics.providerRequests, 1)
    const modelUsageEntries = completed.usage.filter((entry) => entry.kind === 'model_usage')
    assert.equal(modelUsageEntries.length, 1)
    const beforeReplay = await host.metrics()
    phase = 'canonical-replay'
    const replay = await leads.dispatch(evidence.intentId, preparation.preparationRef)
    assert.equal(replay.replayed, true)
    assert.equal(replay.intentId, evidence.intentId)
    assert.equal(replay.dispatchId, dispatchId)
    for (const key of ['executionId', 'attemptId', 'runtimeSessionId'])
      assert.equal(replay[key], observed[key])
    const afterReplay = await host.metrics()
    for (const key of [
      'commands',
      'executions',
      'attempts',
      'usageBudgets',
      'usageEntries',
      'intentAdmissions',
      'dispatchReceipts',
      'runtimeAdmissions',
      'runtimeSessions',
      'providerRequests',
    ]) {
      assert.ok(Number.isSafeInteger(beforeReplay[key]))
      assert.equal(afterReplay[key], beforeReplay[key], `Replay cannot create ${key}`)
    }
    assert.ok(currentProductReads > 0, 'Live PG authority reader must be exercised')
    assert.equal((await adea.retry()).leadTurn.intentId, evidence.intentId)
    await writeFile(
      args['--report'],
      JSON.stringify(
        {
          schemaVersion: 'adea-selected-model-journey/v1',
          sourceIdentity: host.sourceIdentity,
          packages: modelPack.hashes,
          intentId: evidence.intentId,
          originalActorRef: evidence.canonicalActorPrincipalId,
          choice,
          selectionRef: selected.selectionRef,
          selectionRevision: selected.selectionRevision,
          executionId: observed.executionId,
          attemptId: observed.attemptId,
          runtimeSessionId: observed.runtimeSessionId,
          payerReviewed: reviewed,
          providerRequests: completed.metrics.providerRequests,
          modelUsageEntries: modelUsageEntries.length,
          currentProductReads,
          selectedPreparationVerified: true,
          productControllerVerified: true,
          prepareBeforeInferenceVerified: true,
          replayVerified: true,
          publicationWithheldVerified: true,
          timelineVerified: false,
          currentAdeaAudienceAtPhysicalSendVerified: false,
          restartVerified: false,
          naturalCancellationVerified: false,
          liveProviderVerified: false,
        },
        null,
        2
      ) + '\n'
    )
  }
} catch (error) {
  // Bounded diagnostic projection only: never persist prompts, credentials or raw provider errors.
  await writeFile(
    args['--report'],
    JSON.stringify(
      {
        schemaVersion: 'adea-selected-model-journey-failure/v1',
        phase,
        sourceIdentity: host?.sourceIdentity,
        packages: modelPack?.hashes,
        preparationReceived,
        productPreparation,
        prepareErrorCode,
        transportResponses,
        currentProductReads,
        state: controller?.view.turn?.state,
        reasonCode: controller?.view.turn?.reasonCode,
        fundingState: controller?.view.funding?.state,
        metrics: await host?.metrics().catch(() => undefined),
        selectedJourneyVerified: false,
        liveProviderVerified: false,
      },
      null,
      2
    ) + '\n'
  )
  throw error
} finally {
  controller?.dispose()
  const cleanup = await Promise.allSettled([
    host?.close(),
    modelPack?.close(),
    leadPack?.close(),
    database?.close(),
    adea?.close(),
  ])
  await readerServer?.stop(true)
  if (cleanup.some((result) => result.status === 'rejected')) {
    process.stderr.write('SELECTED_JOURNEY_OWNED_CLEANUP_FAILED\n')
    process.exitCode = 1
  }
}
