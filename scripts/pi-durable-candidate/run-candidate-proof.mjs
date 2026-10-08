/** Real candidate cross-repository proof. Run only after the shared light-lane handoff. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createAdeaIntentFixture } from '../../packages/db/tests/fixtures/pi-durable-candidate.ts'
import { createPackedConsumerFixture } from './packed-consumer-fixture.mjs'
import { createLeadTurnSdkAdapter } from '../../apps/web/src/server/lead-turn-sdk-adapter.ts'
import { startCandidateLeadHostProcess } from './lead-host-process.mjs'

const args = Object.fromEntries(
  Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [
    process.argv[2 + i * 2],
    process.argv[3 + i * 2],
  ])
)
for (const flag of [
  '--model-manifest',
  '--model-host',
  '--model-repo',
  '--lead-manifest',
  '--lead-host',
  '--report',
])
  if (!args[flag]) throw new Error(`Missing candidate fixture option ${flag}`)
if (!process.env.DATABASE_URL) throw new Error('Isolated fixture DATABASE_URL required')
if (
  args['--workspace-positive'] !== undefined &&
  !['true', 'false'].includes(args['--workspace-positive'])
)
  throw new Error('--workspace-positive must be true or false')
if (
  args['--workspace-cancel-in-flight'] !== undefined &&
  !['true', 'false'].includes(args['--workspace-cancel-in-flight'])
)
  throw new Error('--workspace-cancel-in-flight must be true or false')
if (args['--workspace-cancel-in-flight'] === 'true' && args['--workspace-positive'] !== 'true')
  throw new Error('--workspace-cancel-in-flight requires --workspace-positive true')
if (
  args['--workspace-prepare-funding'] !== undefined &&
  !['true', 'false'].includes(args['--workspace-prepare-funding'])
)
  throw new Error('--workspace-prepare-funding must be true or false')
if (args['--workspace-prepare-funding'] === 'true' && args['--workspace-positive'] !== 'true')
  throw new Error('--workspace-prepare-funding requires --workspace-positive true')
const prepareFunding = args['--workspace-prepare-funding'] === 'true'
if (
  args['--lead-host-process'] !== undefined &&
  !['true', 'false'].includes(args['--lead-host-process'])
)
  throw new Error('--lead-host-process must be true or false')
const hostProcess = args['--lead-host-process'] === 'true'
if (hostProcess && args['--workspace-cancel-in-flight'] === 'true')
  throw new Error('CANDIDATE_PROCESS_IN_FLIGHT_DRAIN_UNAVAILABLE')

const admissionCountKeys = [
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
  'modelsResolutions',
  'planResolutions',
]

async function admissionCounts(host) {
  const counts = await host.inspectAdmissionRecordCounts()
  return Object.fromEntries(
    admissionCountKeys.map((key) => {
      assert.ok(Number.isSafeInteger(counts[key]) && counts[key] >= 0, `Invalid ${key} count`)
      return [key, counts[key]]
    })
  )
}

async function drainCandidate(host, consumer, dispatchId) {
  if (host.drain) return host.drain()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const status = await consumer.status(dispatchId)
    if (['completed', 'failed', 'cancelled'].includes(status.status.state)) return
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error('CANDIDATE_EXECUTION_COMPLETION_TIMEOUT')
}

function id(prefix) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let value = BigInt(`0x${randomBytes(16).toString('hex')}`),
    suffix = ''
  for (let i = 0; i < 26; i++) {
    suffix = alphabet[Number(value & 31n)] + suffix
    value >>= 5n
  }
  return `${prefix}_${suffix}`
}
function options(host, baseUrl) {
  return {
    baseUrl,
    serviceToken: host.credential ?? host.testCredential,
    workspaceId: host.workspaceId,
    servicePrincipalId: host.principalId,
    requestId: () => id('req'),
    traceId: () => id('trc'),
    commandId: () => id('cmd'),
    now: () => new Date(host.clock ?? host.at),
  }
}

let adea, positiveAdea, cancellationAdea, modelPack, leadPack
let modelHost, leadHost, workspaceLeadHost, cancellationHost
let cleanupFailed = false
const proof = {
  schemaVersion: 'adea-pi-candidate-proof/v1',
  liveProviderVerified: false,
  productionActivated: false,
  combinedModelRuntimeSelectionVerified: false,
}
try {
  adea = await createAdeaIntentFixture(process.env.DATABASE_URL)
  modelPack = await createPackedConsumerFixture(args['--model-manifest'], 'model')
  const { createCandidateModelHost } = await import(pathToFileURL(args['--model-host']).href)
  modelHost = await createCandidateModelHost(args['--model-repo'], {
    workspaceId: adea.workspaceId,
  })
  await modelHost.app.listen(0, '127.0.0.1')
  const modelUrl = `http://127.0.0.1:${modelHost.app.getHttpServer().address().port}`
  const models = modelPack.entry.createCandidateModelConnections(options(modelHost, modelUrl))
  assert.deepEqual(await models.list({ target: modelHost.target }), [])
  const connection = await models.create(
    { credentialRef: modelHost.credentialRef, credentialRevision: 1 },
    `candidate-create:${randomUUID()}`
  )
  const choice = { connectionRef: connection.connectionRef, providerModel: 'fixture-model' }
  assert.equal(connection.workspaceId, adea.workspaceId)
  assert.equal(connection.fundingSource, 'byo_api')
  assert.equal((await models.list({ target: modelHost.target }))[0].models[0].readiness.ready, true)
  const defaults = await models.setDefaults(
    { expectedRevision: 0, lead: choice, child: choice, direct: choice },
    `candidate-default:${randomUUID()}`
  )
  assert.equal(defaults.revision, 1)
  assert.deepEqual(await models.getDefaults(), defaults)
  const selected = await models.resolve({ role: 'lead', target: modelHost.target })
  const direct = await models.resolve({
    role: 'direct',
    target: modelHost.target,
    override: choice,
  })
  assert.equal(selected.workspaceId, adea.workspaceId)
  assert.equal(selected.connectionRef, choice.connectionRef)
  assert.equal(selected.providerModel, choice.providerModel)
  assert.equal(direct.providerModel, choice.providerModel)
  await assert.rejects(
    models.setDefaults({ expectedRevision: 0, direct: choice }, `candidate-stale:${randomUUID()}`)
  )
  modelHost.setCredentialRevision(2)
  assert.equal(
    (await models.list({ target: modelHost.target }))[0].models[0].readiness.reasonCode,
    'CREDENTIAL_REVISION_CHANGED'
  )
  modelHost.setCredentialRevision(1)
  modelHost.setCredentialStatus('revoked')
  assert.equal(
    (await models.list({ target: modelHost.target }))[0].models[0].readiness.reasonCode,
    'CREDENTIAL_REVOKED'
  )
  await assert.rejects(models.resolve({ role: 'lead', target: modelHost.target }), {
    reasonCode: 'CREDENTIAL_REVOKED',
  })
  modelHost.setCredentialStatus('active')
  await models.revoke(
    { connectionRef: connection.connectionRef, expectedRevision: connection.revision },
    `candidate-revoke:${randomUUID()}`
  )
  assert.equal(
    (await models.list({ target: modelHost.target }))[0].models[0].readiness.reasonCode,
    'CONNECTION_REVOKED'
  )
  const other = modelPack.entry.createCandidateModelConnections({
    ...options(modelHost, modelUrl),
    workspaceId: id('wsp'),
  })
  await assert.rejects(other.list({ target: modelHost.target }))
  proof.model = {
    artifacts: modelPack.hashes,
    source: modelPack.source,
    typedOperations: 6,
    defaultsRevision: defaults.revision,
    immutableSelectionRef: selected.selectionRef,
    directOverrideVerified: true,
    staleDefaultDenied: true,
    revisionAndRevocationDenied: true,
    wrongWorkspaceDenied: true,
  }
  await modelHost.app.close()
  modelHost = undefined

  leadPack = await createPackedConsumerFixture(args['--lead-manifest'], 'lead')
  const startNodePiDurableCandidateHost = hostProcess
    ? (hostSettings) =>
        startCandidateLeadHostProcess(args['--lead-host'], {
          ...hostSettings,
          expectedHead: leadPack.source.head,
        })
    : (await import(pathToFileURL(args['--lead-host']).href)).startNodePiDurableCandidateHost
  leadHost = await startNodePiDurableCandidateHost({ workspaceId: adea.workspaceId })
  await adea.configureProfile({
    profileId: leadHost.profileId,
    profileVersionId: leadHost.profileVersionId,
  })
  const first = await adea.admit()
  const canonical = await adea.currentEvidence(leadHost)
  assert.equal(canonical.projectId, null)
  assert.equal(canonical.workspaceId, leadHost.workspaceId)
  await leadHost.registerIntent(canonical)
  const leads = leadPack.entry.createCandidateLeadDispatch(options(leadHost, leadHost.baseUrl))
  const before = await leadHost.inspectAdmissionRecordCounts()
  await assert.rejects(leads.dispatch(first.leadTurn.intentId), {
    code: 'PI_LEAD_PROJECT_SCOPE_REQUIRED',
  })
  const after = await leadHost.inspectAdmissionRecordCounts()
  for (const key of admissionCountKeys) assert.equal(after[key], before[key])
  const retry = await adea.retry()
  assert.equal(retry.message.id, first.message.id)
  assert.equal(retry.leadTurn.intentId, first.leadTurn.intentId)
  assert.deepEqual(await adea.counts(), {
    messages: 1,
    intents: 1,
    messageCreatedEvents: 1,
    totalChannelMessages: 1,
  })
  assert.equal(
    (await adea.verifyDirectSessionBypass('ses_01JABCDEF0123456789ABCDEFG')).leadTurn,
    null
  )
  assert.equal((await adea.counts()).intents, 1)
  proof.workspaceLead = {
    intentId: first.leadTurn.intentId,
    messageId: first.message.id,
    dispatchKey: first.leadTurn.dispatchKey,
    denial: 'PI_LEAD_PROJECT_SCOPE_REQUIRED',
    zeroCpAdmissionRecords: true,
    canonicalRetryIdentityVerified: true,
    ordinaryHistoryIntentBypassVerified: true,
  }

  // Independent CP project control; this project is never written into the Adea lead or intent.
  const projectIntentId = randomUUID()
  await leadHost.registerIntent({
    intentId: projectIntentId,
    projectId: leadHost.explicitProjectId,
  })
  const dispatch = await leads.dispatch(projectIntentId)
  assert.equal(dispatch.intentId, projectIntentId)
  await drainCandidate(leadHost, leads, dispatch.dispatchId)
  const status = await leads.status(dispatch.dispatchId)
  assert.equal(status.status.state, 'completed')
  assert.deepEqual(status.status.result.output, { text: 'Candidate canonical answer' })
  const page = await leads.progress(dispatch.dispatchId)
  assert.ok(page.events.length > 1)
  assert.deepEqual(
    (await leads.progress(dispatch.dispatchId, page.events[0].sequence)).events,
    page.events.slice(1)
  )
  const replay = await leads.dispatch(projectIntentId)
  assert.equal(replay.dispatchId, dispatch.dispatchId)
  assert.equal(replay.runtimeSessionId, dispatch.runtimeSessionId)
  assert.equal(replay.replayed, true)
  const assistedCancellation = typeof leadHost.awaitInput === 'function'
  if (assistedCancellation) {
    await leadHost.awaitInput(dispatch.dispatchId)
    assert.equal((await leads.cancel(dispatch.dispatchId)).state, 'cancelled')
  }
  assert.equal((await leadHost.metrics()).providerRequests, 1)
  proof.projectControl = {
    artifacts: leadPack.hashes,
    source: leadHost.sourceIdentity,
    typedOperations: assistedCancellation ? 4 : 3,
    runtimeSessionId: dispatch.runtimeSessionId,
    replayAndProgressVerified: true,
    cancelVerified: assistedCancellation,
    cancellationScenario: assistedCancellation
      ? 'fixture-assisted-awaiting-input-after-completion'
      : 'not-requested-process-fixture-has-no-await-input-control',
    naturalWaitingInputCancellationVerified: false,
    provider: 'scripted-loopback-http',
    adeaProjectMappingCreated: false,
  }

  if (args['--workspace-positive'] === 'true') {
    // Preserve the default-denial and project-control host and its counters.
    // Positive workspace execution gets a fresh actual Adea intent and host.
    await leadHost.close()
    leadHost = undefined
    positiveAdea = await createAdeaIntentFixture(process.env.DATABASE_URL)
    workspaceLeadHost = await startNodePiDurableCandidateHost({
      workspaceId: positiveAdea.workspaceId,
      workspaceScope: true,
      prepareFunding,
    })
    await positiveAdea.configureProfile({
      profileId: workspaceLeadHost.profileId,
      profileVersionId: workspaceLeadHost.profileVersionId,
    })
    const accepted = await positiveAdea.admit()
    const evidence = await positiveAdea.currentEvidence(workspaceLeadHost, {
      includeCanonicalActor: true,
    })
    assert.equal(evidence.projectId, null)
    assert.equal(evidence.workspaceId, workspaceLeadHost.workspaceId)
    assert.equal(evidence.intentId, accepted.leadTurn.intentId)
    assert.equal(evidence.messageRef, `message:${accepted.message.id}`)
    assert.match(
      evidence.canonicalActorPrincipalId,
      /^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
    assert.equal(evidence.canonicalActorPrincipalId, evidence.principalRef)
    assert.ok(!evidence.allowedPrincipalIds.includes(evidence.canonicalActorPrincipalId))
    await workspaceLeadHost.registerIntent(evidence)
    const workspaceLeads = leadPack.entry.createCandidateLeadDispatch(
      options(workspaceLeadHost, workspaceLeadHost.baseUrl)
    )
    const positiveBefore = await admissionCounts(workspaceLeadHost)
    const authority = {
      intentId: accepted.leadTurn.intentId,
      messageId: accepted.message.id,
      workspaceId: positiveAdea.adeaWorkspaceId,
      controlPlaneWorkspaceId: positiveAdea.workspaceId,
      originalActorRef: evidence.canonicalActorPrincipalId,
    }
    const adapter = createLeadTurnSdkAdapter({
      workspaceId: positiveAdea.workspaceId,
      preparationSchema: leadPack.entry.candidatePreparationSchema,
      lookupResponseSchema: leadPack.entry.candidateLookupResponseSchema,
      prepare: async (intentId) => ({ data: await workspaceLeads.prepare(intentId) }),
      lookup: (intentId) => workspaceLeads.lookup(intentId),
      dispatch: (intentId, preparationRef) => workspaceLeads.dispatch(intentId, preparationRef),
      status: (dispatchId) => workspaceLeads.status(dispatchId),
      progress: (dispatchId, afterSequence) => workspaceLeads.progress(dispatchId, afterSequence),
      cancel: (dispatchId) => workspaceLeads.cancel(dispatchId),
    })
    const preparation = prepareFunding ? await adapter.prepare(authority) : undefined
    if (preparation) {
      assert.equal(preparation.workspaceId, positiveAdea.workspaceId)
      assert.equal(preparation.selectionRef, evidence.selectionRef)
      assert.equal(preparation.selectionRevision, evidence.selectionRevision)
      assert.equal((await workspaceLeadHost.metrics()).providerRequests, 0)
      const afterPrepare = await admissionCounts(workspaceLeadHost)
      for (const key of [
        'runtimeAdmissions',
        'runtimeSessions',
        'dispatchReceipts',
        'providerRequests',
      ])
        assert.equal(afterPrepare[key], positiveBefore[key])
      assert.equal((await adapter.lookup(authority)).receipt, null)
      assert.deepEqual(await admissionCounts(workspaceLeadHost), afterPrepare)
    }
    const workspaceDispatch = preparation
      ? await adapter.dispatch(authority, accepted.leadTurn.dispatchKey, preparation)
      : await workspaceLeads.dispatch(accepted.leadTurn.intentId)
    assert.equal(workspaceDispatch.intentId, accepted.leadTurn.intentId)
    if (preparation)
      for (const key of ['executionId', 'attemptId'])
        assert.equal(workspaceDispatch[key], preparation[key])
    await drainCandidate(workspaceLeadHost, workspaceLeads, workspaceDispatch.dispatchId)
    const workspaceStatus = await workspaceLeads.status(workspaceDispatch.dispatchId)
    assert.equal(workspaceStatus.status.state, 'completed')
    assert.deepEqual(workspaceStatus.status.result.output, { text: 'Candidate canonical answer' })
    const workspaceEvidence = await workspaceLeadHost.evidence(accepted.leadTurn.intentId)
    const modelUsageEntries = workspaceEvidence.usage.filter(
      (entry) => entry.kind === 'model_usage'
    )
    assert.equal(modelUsageEntries.length, 1)
    const positiveCompleted = await admissionCounts(workspaceLeadHost)
    assert.equal(positiveCompleted.runtimeSessions, 0)
    assert.equal((await workspaceLeadHost.metrics()).providerRequests, 1)

    const workspaceProgress = await workspaceLeads.progress(workspaceDispatch.dispatchId)
    assert.ok(workspaceProgress.events.length > 1)
    for (let i = 1; i < workspaceProgress.events.length; i++)
      assert.ok(workspaceProgress.events[i].sequence > workspaceProgress.events[i - 1].sequence)
    assert.deepEqual(
      (
        await workspaceLeads.progress(
          workspaceDispatch.dispatchId,
          workspaceProgress.events[0].sequence
        )
      ).events,
      workspaceProgress.events.slice(1)
    )
    const canonicalRetry = await positiveAdea.retry()
    assert.equal(canonicalRetry.message.id, accepted.message.id)
    assert.equal(canonicalRetry.leadTurn.intentId, accepted.leadTurn.intentId)
    assert.equal(canonicalRetry.leadTurn.dispatchKey, accepted.leadTurn.dispatchKey)
    const workspaceLookup = await adapter.lookup(authority)
    assert.deepEqual(await admissionCounts(workspaceLeadHost), positiveCompleted)
    assert.ok(workspaceLookup.receipt)
    for (const key of ['dispatchId', 'executionId', 'attemptId', 'runtimeSessionId'])
      assert.equal(workspaceLookup.receipt[key], workspaceDispatch[key])
    const workspaceReplay = await workspaceLeads.dispatch(
      accepted.leadTurn.intentId,
      preparation?.preparationRef
    )
    for (const key of ['intentId', 'dispatchId', 'executionId', 'attemptId', 'runtimeSessionId'])
      assert.equal(workspaceReplay[key], workspaceDispatch[key])
    assert.equal(workspaceReplay.replayed, true)
    const positiveReplayed = await admissionCounts(workspaceLeadHost)
    assert.deepEqual(positiveReplayed, positiveCompleted)
    assert.equal((await workspaceLeadHost.metrics()).providerRequests, 1)
    assert.deepEqual(await positiveAdea.counts(), {
      messages: 1,
      intents: 1,
      messageCreatedEvents: 1,
      totalChannelMessages: 1,
    })

    const directBypass = await positiveAdea.verifyDirectSessionBypass(
      workspaceDispatch.runtimeSessionId
    )
    assert.equal(directBypass.leadTurn, null)
    assert.equal(directBypass.externalSessionRef, workspaceDispatch.runtimeSessionId)
    const positiveDbCounts = await positiveAdea.counts()
    assert.deepEqual(positiveDbCounts, {
      messages: 1,
      intents: 1,
      messageCreatedEvents: 1,
      totalChannelMessages: 2,
    })
    proof.workspacePositive = {
      artifacts: leadPack.hashes,
      packedSource: leadPack.source,
      hostSource: workspaceLeadHost.sourceIdentity,
      scope: 'scripted-candidate',
      provider: 'scripted-loopback-http',
      intentId: accepted.leadTurn.intentId,
      messageId: accepted.message.id,
      dispatchKey: accepted.leadTurn.dispatchKey,
      dispatchId: workspaceDispatch.dispatchId,
      executionId: workspaceDispatch.executionId,
      attemptId: workspaceDispatch.attemptId,
      runtimeSessionId: workspaceDispatch.runtimeSessionId,
      canonicalRetryIdentityVerified: true,
      recordedProductActorSeparateFromTransportVerified: true,
      typedOperations: preparation ? 5 : 4,
      modelUsageEntries: modelUsageEntries.length,
      replayAndProgressVerified: true,
      preparationFundingVerified: Boolean(preparation),
      prepareBeforeProviderVerified: Boolean(preparation),
      readOnlyLookupVerified: true,
      cancelVerified: false,
      cancellationQualification: 'separate-optional-in-flight-scenario',
      naturalWaitingInputCancellationVerified: false,
      ordinaryHistoryIntentBypassVerified: true,
      adeaProjectMappingCreated: false,
      adeaTimelinePublicationVerified: false,
      combinedModelRuntimeSelectionVerified: false,
      admissionCounts: {
        before: positiveBefore,
        completed: positiveCompleted,
        replayed: positiveReplayed,
      },
      databaseCounts: positiveDbCounts,
      providerRequests: (await workspaceLeadHost.metrics()).providerRequests,
    }

    if (args['--workspace-cancel-in-flight'] === 'true') {
      // Physical provider cancellation is a distinct canonical turn and host.
      await workspaceLeadHost.close()
      workspaceLeadHost = undefined
      cancellationAdea = await createAdeaIntentFixture(process.env.DATABASE_URL)
      cancellationHost = await startNodePiDurableCandidateHost({
        workspaceId: cancellationAdea.workspaceId,
        workspaceScope: true,
        prepareFunding,
      })
      await cancellationAdea.configureProfile({
        profileId: cancellationHost.profileId,
        profileVersionId: cancellationHost.profileVersionId,
      })
      const cancellationAccepted = await cancellationAdea.admit()
      const cancellationEvidence = await cancellationAdea.currentEvidence(cancellationHost, {
        includeCanonicalActor: true,
      })
      assert.equal(cancellationEvidence.projectId, null)
      assert.equal(cancellationEvidence.workspaceId, cancellationHost.workspaceId)
      assert.equal(cancellationEvidence.intentId, cancellationAccepted.leadTurn.intentId)
      assert.equal(cancellationEvidence.messageRef, `message:${cancellationAccepted.message.id}`)
      assert.equal(
        cancellationEvidence.canonicalActorPrincipalId,
        `user:${cancellationAdea.actorUserId}`
      )
      assert.equal(
        cancellationEvidence.canonicalActorPrincipalId,
        cancellationEvidence.principalRef
      )
      assert.ok(
        !cancellationEvidence.allowedPrincipalIds.includes(
          cancellationEvidence.canonicalActorPrincipalId
        )
      )
      await cancellationHost.registerIntent(cancellationEvidence)
      const cancellationLeads = leadPack.entry.createCandidateLeadDispatch(
        options(cancellationHost, cancellationHost.baseUrl)
      )
      const cancellationBefore = await admissionCounts(cancellationHost)
      const cancellationPreparation = prepareFunding
        ? await cancellationLeads.prepare(cancellationAccepted.leadTurn.intentId)
        : undefined
      if (cancellationPreparation)
        assert.equal((await cancellationHost.metrics()).providerRequests, 0)
      cancellationHost.holdProviderResponse()
      const cancellationDispatch = await cancellationLeads.dispatch(
        cancellationAccepted.leadTurn.intentId,
        cancellationPreparation?.preparationRef
      )
      assert.equal(cancellationDispatch.intentId, cancellationAccepted.leadTurn.intentId)
      const providerDeadline = Date.now() + 5_000
      while (
        (await cancellationHost.metrics()).providerRequests === 0 &&
        Date.now() < providerDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal((await cancellationHost.metrics()).providerRequests, 1)
      const cancellationInFlight = await admissionCounts(cancellationHost)
      const cancellation = await cancellationLeads.cancel(cancellationDispatch.dispatchId)
      assert.equal(cancellation.state, 'cancelling')
      assert.equal(cancellation.runtimeSessionId, cancellationDispatch.runtimeSessionId)
      cancellationHost.releaseProviderResponse()
      await cancellationHost.drain()
      const cancellationDrained = await admissionCounts(cancellationHost)
      const cancellationReplay = await cancellationLeads.cancel(cancellationDispatch.dispatchId)
      assert.equal(cancellationReplay.state, 'cancelling')
      for (const key of ['intentId', 'dispatchId', 'executionId', 'attemptId', 'runtimeSessionId'])
        assert.equal(cancellationReplay[key], cancellationDispatch[key])
      const cancellationReplayed = await admissionCounts(cancellationHost)
      assert.deepEqual(cancellationReplayed, cancellationDrained)
      const cancellationRuntimeEvidence = await cancellationHost.evidence(
        cancellationAccepted.leadTurn.intentId
      )
      const modelUsage = cancellationRuntimeEvidence.usage.filter(
        (entry) => entry.kind === 'model_usage'
      )
      const modelReservations = cancellationRuntimeEvidence.usage.filter(
        (entry) => entry.kind === 'model_reservation'
      )
      assert.equal(modelUsage.length, 0)
      assert.equal(modelReservations.length, 1)
      assert.equal(cancellationRuntimeEvidence.modelHolds.length, 1)
      const [uncertainHold] = cancellationRuntimeEvidence.modelHolds
      assert.equal(uncertainHold.status, 'open')
      for (const key of ['commands', 'executions', 'attempts', 'providerRequests'])
        assert.equal(cancellationReplayed[key], 1)
      assert.equal(cancellationReplayed.runtimeSessions, 0)
      const cancellationRetry = await cancellationAdea.retry()
      assert.equal(cancellationRetry.message.id, cancellationAccepted.message.id)
      assert.equal(cancellationRetry.leadTurn.intentId, cancellationAccepted.leadTurn.intentId)
      assert.equal(
        cancellationRetry.leadTurn.dispatchKey,
        cancellationAccepted.leadTurn.dispatchKey
      )
      const cancellationDbCounts = await cancellationAdea.counts()
      assert.deepEqual(cancellationDbCounts, {
        messages: 1,
        intents: 1,
        messageCreatedEvents: 1,
        totalChannelMessages: 1,
      })
      proof.workspaceInFlightCancellation = {
        artifacts: leadPack.hashes,
        packedSource: leadPack.source,
        hostSource: cancellationHost.sourceIdentity,
        scope: 'scripted-candidate',
        provider: 'scripted-loopback-http',
        intentId: cancellationAccepted.leadTurn.intentId,
        messageId: cancellationAccepted.message.id,
        dispatchKey: cancellationAccepted.leadTurn.dispatchKey,
        dispatchId: cancellationDispatch.dispatchId,
        executionId: cancellationDispatch.executionId,
        attemptId: cancellationDispatch.attemptId,
        runtimeSessionId: cancellationDispatch.runtimeSessionId,
        state: cancellation.state,
        replayedState: cancellationReplay.state,
        inFlightCancellationFenceVerified: true,
        cancelReplayIdentityVerified: true,
        canonicalRetryIdentityVerified: true,
        recordedProductActorSeparateFromTransportVerified: true,
        cancelledVerified: false,
        usageSettlementVerified: false,
        usageDisposition: 'uncertain-open-hold',
        usageCounts: { modelUsage: modelUsage.length, modelReservations: modelReservations.length },
        modelHolds: [
          {
            modelCallId: uncertainHold.modelCallId,
            status: uncertainHold.status,
            maximumTokens: uncertainHold.maximumTokens,
            maximumMicrounits: uncertainHold.maximumMicrounits,
          },
        ],
        admissionCounts: {
          before: cancellationBefore,
          inFlight: cancellationInFlight,
          drained: cancellationDrained,
          replayed: cancellationReplayed,
        },
        databaseCounts: cancellationDbCounts,
        adeaProjectMappingCreated: false,
        adeaTimelinePublicationVerified: false,
        combinedModelRuntimeSelectionVerified: false,
        liveProviderVerified: false,
        j1ApprovalVerified: false,
      }
    }
  }
  await writeFile(args['--report'], `${JSON.stringify(proof, null, 2)}\n`)
  console.log(JSON.stringify(proof))
} finally {
  const results = await Promise.allSettled([
    modelHost?.app.close(),
    leadHost?.close(),
    workspaceLeadHost?.close(),
    // The exact candidate close() contract releases a held physical response.
    cancellationHost?.close(),
    modelPack?.close(),
    leadPack?.close(),
    adea?.close(),
    positiveAdea?.close(),
    cancellationAdea?.close(),
  ])
  cleanupFailed = results.some((result) => result.status === 'rejected')
}

if (cleanupFailed) throw new Error('Candidate fixture cleanup failed')
