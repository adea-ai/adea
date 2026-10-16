// TEST ONLY: the CP side of the lead-to-child journey (#1173). One separate pinned-Bun process runs
// CP's production Pi lead factory with the governed `delegate_child` tool from the pinned CP revision
// (merged CP #1134), serves CP's actual control API for Adea's installed SDK, and answers a JSON-line
// control channel for evidence and fault injection. The provider transport, funding records, scope
// and policy ports are scripted fixtures; there is no live provider and no credential.
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

const root = process.env.ADEA_CONTROL_PLANE_SOURCE
const config = JSON.parse(process.env.ADEA_CHILD_FACTORY_CONFIG)
const cpPath = (path) => join(root, path)
const cpRequire = createRequire(cpPath('package.json'))
await import(cpRequire.resolve('reflect-metadata'))
const governed = await import(cpPath('tests/pi-durable-compaction-governed-dispatch.fixture.mjs'))
const factory = await import(cpPath('tests/pi-production-factory.fixture.mjs'))
const { childIds, childObjective } = governed

const finalText = 'Delegated one bounded child; its receipt is recorded.\n'
const childText = 'Bounded child evidence.'
const originalFetch = globalThis.fetch

function eventStream(events) {
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  )
}
const usage = {
  input_tokens: 5,
  output_tokens: 3,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
}
const completed = (id, item) => ({
  type: 'response.completed',
  response: { id, status: 'completed', output: [item], usage },
})
function textResponse(text, responseId) {
  const item = {
    type: 'message',
    id: `msg_${responseId}`,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  return eventStream([
    { type: 'response.created', response: { id: responseId, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    completed(responseId, item),
  ])
}
function delegateCallResponse() {
  const item = {
    id: 'fc_journey',
    type: 'function_call',
    status: 'completed',
    name: 'delegate_child',
    call_id: 'call_journey',
    arguments: JSON.stringify({ objective: childObjective }),
  }
  return eventStream([
    { type: 'response.created', response: { id: 'resp_delegate', status: 'in_progress' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    {
      type: 'response.function_call_arguments.done',
      output_index: 0,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: 'response.output_item.done', output_index: 0, item },
    completed('resp_delegate', item),
  ])
}

// Named gates let the test hold a provider send at a precise point and release it later. Holding a
// send holds the physical request itself: nothing after it runs until the gate opens.
const gates = new Map()
const gateFor = (name) => {
  if (!gates.has(name)) {
    let open
    const promise = new Promise((resolve) => {
      open = resolve
    })
    gates.set(name, { promise, open, opened: false, waiters: 0, held: false })
  }
  return gates.get(name)
}
const passGate = async (name) => {
  const gate = gates.get(name)
  if (!gate || gate.opened) return
  gate.waiters++
  gate.held = true
  await gate.promise
}
const sent = { lead: [], child: [] }
let behavior = { childFails: false }

const hooks = governed.createGovernedDispatchHooks()
const host = await factory.createProductionFactoryFixture({
  childAllowanceSource: config.childAllowanceSource,
  workspaceId: config.workspaceId,
  actorPrincipalId: config.actorPrincipalId,
  transportPrincipalId: config.principalId,
  productProfilePin: config.productProfilePin,
  productHttp: {
    endpoint: 'https://1173-journey.invalid/api/internal/pi-durable/lead-product/current',
    credentials: { getExistingCredential: async () => config.assertion },
    fetch: (_endpoint, options) => originalFetch(config.readerUrl, options),
  },
  childrenFactory: governed.governedDispatchChildren(hooks),
  physicalResponder: async ({ body }) => {
    const input = body.input
    const isChild =
      input.length === 1 &&
      input[0].content?.length === 1 &&
      input[0].content[0].text === childObjective
    if (isChild) {
      sent.child.push(body)
      await passGate('child-send')
      if (behavior.childFails) return new Response('upstream failure', { status: 500 })
      return textResponse(childText, 'resp_child')
    }
    sent.lead.push(body)
    const ordinal = sent.lead.length
    if (ordinal === 1) {
      // The lead may not delegate until the harness has bound the dispatched execution.
      await passGate('lead-first')
      return delegateCallResponse()
    }
    await passGate('lead-final')
    return textResponse(finalText, `resp_lead_${ordinal}`)
  },
})
hooks.host = host
// Bounded diagnostics for the governed executor: the tool service reports a thrown executor error
// only as `reconciliation_required`, so the reason code is kept here for the evidence.
const executorErrors = []
const wrapExecutor = () => {
  const original = hooks.executeGoverned
  if (!original || original.wrapped) return
  const wrapped = async (...args) => {
    try {
      return await original(...args)
    } catch (error) {
      executorErrors.push(String(error?.code ?? error?.message ?? error).slice(0, 200))
      throw error
    }
  }
  wrapped.wrapped = true
  hooks.executeGoverned = wrapped
}
wrapExecutor()

// The pinned child role is carried by the immutable Adea intent; nothing here chooses a model.
const selections = host.composition.modelConnectionService.selections
const choose = (role, providerModel) =>
  selections.select({
    workspaceId: host.workspaceId,
    role,
    target: host.models.target,
    override: { connectionRef: host.models.refs.connectionRef, providerModel },
  })
// The scripted provider policy admits the fixture's provider model for both roles.
const leadSelection = await choose('lead', host.models.refs.providerModel)
const childSelection = await choose('child', host.models.refs.providerModel)
// The workspace default child role, as the CP qualification sets it for the governed child.
const defaults = await selections.getDefaults(host.workspaceId)
await selections.setDefaults(defaults.revision, {
  ...defaults,
  revision: defaults.revision + 1,
  child: {
    connectionRef: host.models.refs.connectionRef,
    providerModel: host.models.refs.providerModel,
  },
})
const ref = ({ selectionRef, selectionRevision }) => ({ selectionRef, selectionRevision })

// CP's actual control API over the composition that is current at each request, so an in-process
// reopen of the composition does not leave the listener serving a closed one.
const current = (name) =>
  new Proxy(
    {},
    {
      get: (_target, property) => {
        const value = host.composition[name][property]
        return typeof value === 'function' ? value.bind(host.composition[name]) : value
      },
      has: (_target, property) => property in host.composition[name],
    }
  )
const { createControlApiApplication } = await import(cpPath('apps/control-api/src/application.ts'))
const { createProductionFactoryServiceAuthenticator } = await import(
  cpPath('tests/pi-production-factory-auth.fixture.mjs')
)
const { productionFactorySourceIdentity } = await import(
  cpPath('tests/pi-production-factory-provenance.fixture.mjs')
)
const metadata = {
  serviceName: 'control-api',
  version: 'test-candidate',
  commitSha: productionFactorySourceIdentity(),
  environment: 'test',
}
const controlApp = await createControlApiApplication({
  metadata,
  health: () => ({ status: 'ok', metadata }),
  readiness: () => ({ status: 'ready', metadata }),
  logger: { write: () => {} },
  serviceAuthenticator: createProductionFactoryServiceAuthenticator({
    ...config.controlApi.serviceTrust,
    workspaceId: config.workspaceId,
    isRevoked: async () => false,
  }),
  piDurableLeadService: current('piDurableLeadService'),
  piLeadPublicationService: current('publicationService'),
  modelConnectionService: current('modelConnectionService'),
})
await controlApp.listen(0, '127.0.0.1')
const controlApiMetadata = {
  baseUrl: await controlApp.getUrl(),
  target: host.models.target,
  sourceIdentity: metadata.commitSha,
}
process.stdout.write(
  JSON.stringify({
    ready: true,
    directory: host.directory,
    requestedModelSelections: { lead: ref(leadSelection), child: ref(childSelection) },
    controlApi: controlApiMetadata,
  }) + '\n'
)

const journalRows = () => host.composition.adapter.journal.list()
const childRowOf = () =>
  journalRows().find((row) => row.admission.request.executionId === childIds.executionId)
const leadRowOf = (executionId) =>
  journalRows().find((row) => row.admission.request.executionId === executionId)

async function evidence() {
  const parentExecutionId = host.state.parentExecutionId
  const delegations = parentExecutionId
    ? await hooks.delegationRecords.listByParent(parentExecutionId)
    : []
  const child = childRowOf()
  const lead = parentExecutionId ? leadRowOf(parentExecutionId) : undefined
  const adapter = host.composition.adapter
  const childStatus = child ? await adapter.status(child.admission.handle) : undefined
  const leadStatus = lead ? await adapter.status(lead.admission.handle) : undefined
  const call = hooks.toolCalls ? await hooks.toolCalls.get(childIds.toolCallId) : undefined
  return {
    canonical: host.canonicalCounts(),
    physicalSends: host.state.physicalSends,
    leadSends: sent.lead.length,
    childSends: sent.child.length,
    productReads: host.state.productReads,
    publicationChecks: host.state.publicationChecks,
    secretResolutions: host.models.secretProvider.resolveCount,
    executorErrors: [...executorErrors],
    policyDecisions: hooks.evidence.policyDecisions,
    executorCalls: hooks.evidence.executorCalls,
    childStarts: hooks.evidence.childStarts.length,
    childStartKeys: hooks.evidence.childStarts.map((start) => start.idempotencyKey),
    reservations: hooks.evidence.reservations.map((reservation) => reservation.reservationKey),
    fundingWrites: hooks.evidence.fundingWrites.length,
    delegations: delegations.map((record) => ({
      delegationId: record.delegationId,
      parentExecutionId: record.parentExecutionId,
      parentAttemptId: record.parentAttemptId,
      childExecutionId: record.childExecutionId,
      childAttemptId: record.childAttemptId,
      state: record.state,
      cancellation: record.policy.cancellation,
    })),
    toolCall: call && {
      status: call.status,
      output: call.result?.output,
      failure: call.failure ?? call.error ?? call.result?.error,
    },
    lead: lead && {
      executionId: lead.admission.request.executionId,
      attemptId: lead.admission.request.attemptId,
      externalSessionId: lead.admission.handle.externalSessionId,
      state: leadStatus.state,
    },
    child: child && {
      executionId: child.admission.request.executionId,
      attemptId: child.admission.request.attemptId,
      externalSessionId: child.admission.handle.externalSessionId,
      state: childStatus.state,
      outcome: childStatus.result?.outcome,
      text: childStatus.result?.output?.text,
    },
    publications: parentExecutionId
      ? await governed.readPublicationRecords(hooks.persistence, parentExecutionId)
      : [],
  }
}

let closing
async function handle(request) {
  switch (request.command) {
    case 'bind': {
      // Binds the SDK-dispatched lead before it is allowed to delegate.
      hooks.intentId = request.intentId
      host.state.parentExecutionId = request.executionId
      return { bound: true }
    }
    case 'hold': {
      gateFor(request.name)
      return { held: request.name }
    }
    case 'release': {
      const gate = gates.get(request.name)
      if (gate) {
        gate.opened = true
        gate.open()
      }
      return { released: request.name, wasHeld: Boolean(gate?.held) }
    }
    case 'behavior': {
      behavior = { ...behavior, ...request.values }
      return behavior
    }
    case 'evidence':
      return evidence()
    case 'scan':
      return hooks.scanner.scan(host.composition.adapter)
    case 'reopen': {
      await host.reopenComposition()
      wrapExecutor()
      return { reopened: true, inProcess: true }
    }
    case 'cancel-children': {
      // CP's canonical child stop. It is not part of the public lead contract.
      const cancelled = await hooks.delegationService.cancelChildren({
        parentExecutionId: host.state.parentExecutionId,
        cancelledAt: new Date().toISOString(),
      })
      return { cancelled: cancelled.map((execution) => execution.executionId) }
    }
    case 'revoke-publication': {
      host.state.publicationRevoked = request.value !== false
      return { publicationRevoked: host.state.publicationRevoked }
    }
    case 'revoke-grants': {
      host.state.revoked = request.value !== false
      return { revoked: host.state.revoked }
    }
    case 'close': {
      closing = true
      return { closing: true }
    }
    default:
      throw new Error(`UNKNOWN_COMMAND:${request.command}`)
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  handle(request)
    .then((data) => process.stdout.write(JSON.stringify({ id: request.id, data }) + '\n'))
    .catch((error) =>
      process.stdout.write(
        JSON.stringify({ id: request.id, error: String(error?.message ?? error) }) + '\n'
      )
    )
    .finally(async () => {
      if (!closing) return
      for (const gate of gates.values()) gate.open()
      await controlApp.close().catch(() => {})
      await host.close().catch(() => {})
      process.exit(0)
    })
})
process.on('SIGTERM', async () => {
  for (const gate of gates.values()) gate.open()
  await controlApp.close().catch(() => {})
  await host.close().catch(() => {})
  process.exit(0)
})
