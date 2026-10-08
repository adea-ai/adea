// TEST ONLY. A desired connected boundary; failure is retained, never reclassified as acceptance.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createAdeaIntentFixture } from '../../packages/db/tests/fixtures/pi-durable-candidate.ts'
import { createPackedConsumerFixture } from './packed-consumer-fixture.mjs'
import { startCandidateLeadHostProcess } from './lead-host-process.mjs'

const args = Object.fromEntries(
  Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [
    process.argv[2 + i * 2],
    process.argv[3 + i * 2],
  ])
)
for (const flag of ['--manifest', '--model-host', '--repo', '--lead-host', '--head', '--report'])
  if (!args[flag]) throw new Error(`Missing ${flag}`)
if (!process.env.DATABASE_URL) throw new Error('Isolated fixture DATABASE_URL required')
let adea, pack, modelHost, leadHost
const id = (prefix) => `${prefix}_${'0'.repeat(26)}`
try {
  adea = await createAdeaIntentFixture(process.env.DATABASE_URL)
  pack = await createPackedConsumerFixture(args['--manifest'], 'model')
  const { createCandidateModelHost } = await import(pathToFileURL(args['--model-host']).href)
  modelHost = await createCandidateModelHost(args['--repo'], { workspaceId: adea.workspaceId })
  await modelHost.app.listen(0, '127.0.0.1')
  // All IDs and envelopes are parsed by the actual packed public SDK.
  const models = pack.entry.createCandidateModelConnections({
    baseUrl: `http://127.0.0.1:${modelHost.app.getHttpServer().address().port}`,
    serviceToken: modelHost.credential,
    workspaceId: adea.workspaceId,
    servicePrincipalId: modelHost.principalId,
    requestId: () => id('req'),
    traceId: () => id('trc'),
    commandId: () => id('cmd'),
    now: () => new Date(modelHost.clock),
  })
  const connection = await models.create(
    { credentialRef: modelHost.credentialRef, credentialRevision: 1 },
    `selected-model:${randomUUID()}`
  )
  const choice = { connectionRef: connection.connectionRef, providerModel: 'fixture-model' }
  await models.setDefaults({ expectedRevision: 0, lead: choice }, `default:${randomUUID()}`)
  assert.deepEqual((await models.getDefaults()).lead, choice)
  const selected = await models.resolve({ role: 'lead', target: modelHost.target })
  assert.equal(selected.connectionRef, choice.connectionRef)
  assert.equal(selected.providerModel, choice.providerModel)
  leadHost = await startCandidateLeadHostProcess(args['--lead-host'], {
    expectedHead: args['--head'],
    workspaceId: adea.workspaceId,
    workspaceScope: true,
    prepareFunding: true,
  })
  await adea.configureProfile(leadHost)
  const accepted = await adea.admit()
  const evidence = await adea.currentEvidence(leadHost, { includeCanonicalActor: true })
  const before = await leadHost.metrics()
  let registrationFailure
  try {
    // Do not substitute the fixture's fixed model for the user's actual resolved choice.
    await leadHost.registerIntent({
      ...evidence,
      selectionRef: selected.selectionRef,
      selectionRevision: selected.selectionRevision,
    })
  } catch (error) {
    registrationFailure = error.message
  }
  const after = await leadHost.metrics()
  assert.deepEqual(after, before, 'Selection registration must not start execution')
  const report = {
    schemaVersion: 'adea-selected-model-boundary/v1',
    head: leadHost.sourceIdentity.head,
    sourceIdentity: leadHost.sourceIdentity,
    packages: pack.hashes,
    intentId: accepted.leadTurn.intentId,
    originalActorRef: evidence.canonicalActorPrincipalId,
    selected: {
      selectionRef: selected.selectionRef,
      selectionRevision: selected.selectionRevision,
    },
    hostSelection: {
      selectionRef: leadHost.selectionRef,
      selectionRevision: leadHost.selectionRevision,
    },
    registrationFailure: registrationFailure ?? null,
    countersUnchanged: true,
    countersBefore: before,
    countersAfter: after,
    selectionRegistrationAccepted: registrationFailure === undefined,
    connectedSelectionVerified: false,
    timelineVerified: false,
    naturalCancellationVerified: false,
    liveProviderVerified: false,
  }
  await writeFile(args['--report'], JSON.stringify(report, null, 2) + '\n')
  assert.equal(
    registrationFailure,
    undefined,
    'CONNECTED_SELECTION_REQUIRED: trusted intent resolver cannot consume the actual saved model selection'
  )
} finally {
  const cleanup = await Promise.allSettled([
    leadHost?.close(),
    modelHost?.app.close(),
    pack?.close(),
    adea?.close(),
  ])
  if (cleanup.some((result) => result.status === 'rejected')) {
    process.stderr.write('SELECTED_MODEL_BOUNDARY_OWNED_CLEANUP_FAILED\n')
    process.exitCode = 1
  }
}
