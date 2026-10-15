// TEST ONLY: separate CP compiler/runtime context; actual factories and transactional allocator.
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const root = process.env.ADEA_CONTROL_PLANE_SOURCE
const config = JSON.parse(process.env.ADEA_CHILD_FACTORY_CONFIG)
const cpPath = (path) => join(root, path)
const cpRequire = createRequire(cpPath('package.json'))
await import(cpRequire.resolve('reflect-metadata'))
const cp = {
  factory: await import(cpPath('tests/pi-production-factory.fixture.mjs')),
  domain: await import(cpPath('packages/domain/src/index.ts')),
  sqlite: await import(cpPath('packages/sqlite-persistence/src/index.ts')),
  tool: await import(cpPath('packages/tool-execution/src/index.ts')),
  context: await import(cpPath('packages/context/src/index.ts')),
  orchestration: await import(cpPath('packages/orchestration/src/index.ts')),
  executionPlan: await import(cpPath('packages/execution-plan/src/index.ts')),
  worker: await import(cpRequire.resolve('@control-plane/workflow-worker')),
}
const id = (prefix) => `${prefix}_01JBBCDEF0123456789ABCDEFG`
let host, delegationService, toolService, toolCalls, childRecords, lifecycle
let toolDefinitionId, toolVersionId
let releaseProvider
const held = new Promise((resolve) => {
  releaseProvider = resolve
})
const originalFetch = globalThis.fetch
host = await cp.factory.createProductionFactoryFixture({
  // The lead may delegate to siblings that share its one stated allowance.
  maximumChildren: 3,
  // Where CP's fixture states the allowance: only on the pinned profile version, on that and on
  // the request constraints, or nowhere.
  childAllowanceSource: config.childAllowanceSource,
  workspaceId: config.workspaceId,
  actorPrincipalId: config.actorPrincipalId,
  transportPrincipalId: config.principalId,
  productProfilePin: config.productProfilePin,
  productHttp: {
    endpoint: 'https://1211-source-proof.invalid/api/internal/pi-durable/lead-product/current',
    credentials: { getExistingCredential: async () => config.assertion },
    fetch: (_endpoint, options) => originalFetch(config.readerUrl, options),
  },
  physicalResponder: async () => {
    await held
    throw new Error('TEST_PROVIDER_RELEASED')
  },
  childrenFactory: async ({
    persistence,
    repositories,
    workspaceId: ws,
    actorPrincipalId,
    leasePrincipalRef,
    scopeAuthority,
    at,
  }) => {
    toolDefinitionId = id('tld')
    toolVersionId = id('tlv')
    const registry = new cp.tool.ToolRegistry(new cp.tool.InMemoryToolRegistryRepository())
    await registry.createDefinition({
      toolDefinitionId,
      name: 'delegate-child',
      displayName: 'Fixture child',
      description: 'Explicit scripted host tool authority',
      ownership: { scope: 'workspace', workspaceId: ws },
      createdAt: at,
    })
    await registry.publishVersion({
      toolDefinitionId,
      toolVersionId,
      semanticVersion: '1.0.0',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      operations: [
        {
          name: 'delegate-child',
          requiredCapabilities: [],
          riskClass: 'high',
          approvalMode: 'never',
          idempotency: 'provider_key',
        },
      ],
      executor: { type: 'internal', reference: '1211-scripted-tool-authority' },
      limits: { maxInputBytes: 8192, maxOutputBytes: 1024, timeoutMs: 5000 },
      createdAt: at,
      publishedAt: at,
    })
    const gateway = new cp.tool.ToolGateway(registry)
    gateway.registerExecutor('internal', '1211-scripted-tool-authority', {
      execute: async () => ({ output: { accepted: true } }),
    })
    const interactions = new cp.domain.InMemoryInteractionRepository()
    toolService = new cp.tool.PolicyControlledToolExecutionService({
      gateway,
      calls: (toolCalls = new cp.sqlite.SqliteToolCallRepository(persistence, ws)),
      authorizer: new cp.tool.StaticToolPolicyAuthorizer({
        effect: 'allow',
        decisionId: '1211-fixture',
        policyVersion: '1',
        reasonCode: 'FIXTURE_ALLOW',
        requiresApproval: false,
        evaluatedAt: at,
      }),
      approvals: new cp.tool.InteractionToolApprovalCoordinator(
        new cp.domain.InteractionService(interactions),
        interactions
      ),
      rateLimiter: new cp.tool.InMemoryToolRateLimiter(),
      now: () => at,
    })
    childRecords = new cp.sqlite.SqliteDelegationRepository(persistence)
    const allocateCanonical = childRecords.allocate.bind(childRecords)
    childRecords.allocate = (input) =>
      allocateCanonical({
        ...input,
        assertCurrent: async (reader) => {
          allocationStage = 'allocator-authority-recheck'
          await input.assertCurrent(reader)
          allocationStage = 'allocator-write'
        },
      })
    return {
      tools: { service: toolService, interactions },
      delegation: {
        records: childRecords,
        lifecycle: (lifecycle = new cp.domain.ExecutionLifecycleService(repositories.executions)),
        plans: repositories.plans,
        events: {
          publish: (event, key) =>
            new cp.sqlite.SqliteDelegationEventPublisher(
              persistence,
              event.parentExecutionId
            ).publish(event, key),
          list: async () => [],
        },
        scopeAdmission: {
          authority: scopeAuthority,
          resolveCallerPrincipalId: async () => actorPrincipalId,
          now: () => at,
        },
      },
      createGovernedDelegateChild(service) {
        delegationService = service
        return {
          prepare: async () => {
            throw new Error('NATIVE_TOOL_NOT_PART_OF_THIS_SOURCE_PROOF')
          },
        }
      },
      modelAuthority: { leasePrincipalRef, modelAlias: 'reasoning.standard' },
      runtime: {
        childProgress: { scan: async () => ({ reconciled: 0, pending: 0 }) },
        consumeParentInbox: async () => {},
      },
    }
  },
})
const selections = host.composition.modelConnectionService.selections
const choose = (role, providerModel) =>
  selections.select({
    workspaceId: host.workspaceId,
    role,
    target: host.models.target,
    override: { connectionRef: host.models.refs.connectionRef, providerModel },
  })
const lead = await choose('lead', 'gpt-5-mini'),
  child = await choose('child', 'gpt-5')
const ref = ({ selectionRef, selectionRevision }) => ({ selectionRef, selectionRevision })
// Optionally serve CP's actual control API from this same composition so Adea's installed SDK can
// prepare and dispatch the lead over HTTP. The application, its service authenticator and the lead
// service are CP's own; only the trust record and the listener are this test host's.
let controlApp, controlApiMetadata
if (config.controlApi) {
  const { createControlApiApplication } = await import(
    cpPath('apps/control-api/src/application.ts')
  )
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
  controlApp = await createControlApiApplication({
    metadata,
    health: () => ({ status: 'ok', metadata }),
    readiness: () => ({ status: 'ready', metadata }),
    logger: { write: () => {} },
    serviceAuthenticator: createProductionFactoryServiceAuthenticator({
      ...config.controlApi.serviceTrust,
      workspaceId: config.workspaceId,
      isRevoked: async () => false,
    }),
    piDurableLeadService: host.composition.piDurableLeadService,
    piLeadPublicationService: host.composition.publicationService,
    modelConnectionService: host.composition.modelConnectionService,
  })
  await controlApp.listen(0, '127.0.0.1')
  controlApiMetadata = {
    baseUrl: await controlApp.getUrl(),
    target: host.models.target,
    sourceIdentity: metadata.commitSha,
  }
}
process.stdout.write(
  JSON.stringify({
    ready: true,
    directory: host.directory,
    requestedModelSelections: { lead: ref(lead), child: ref(child) },
    ...(controlApiMetadata ? { controlApi: controlApiMetadata } : {}),
  }) + '\n'
)
let prepared
// Stable ids so a retry is the same delegation, not a new one.
const ids = {
  delegation: id('dlg'),
  childExecution: id('exe'),
  childAttempt: id('att'),
  runtimeConnection: id('rtc'),
}
// Further delegations from the same lead: distinct ids, because a retry of the first one is a
// replay, not a new request.
const siblingIds = {
  second: {
    delegation: 'dlg_01JBBCDEF0123456789ABCDEFJ',
    childExecution: 'exe_01JBBCDEF0123456789ABCDEFJ',
    childAttempt: 'att_01JBBCDEF0123456789ABCDEFJ',
    task: 'tsk_01JBBCDEF0123456789ABCDEFJ',
    request: 'req_01JBBCDEF0123456789ABCDEFJ',
  },
  third: {
    delegation: 'dlg_01JBBCDEF0123456789ABCDEFK',
    childExecution: 'exe_01JBBCDEF0123456789ABCDEFK',
    childAttempt: 'att_01JBBCDEF0123456789ABCDEFK',
    task: 'tsk_01JBBCDEF0123456789ABCDEFK',
    request: 'req_01JBBCDEF0123456789ABCDEFK',
  },
}
const ledgerView = (summary) =>
  summary && {
    maximumMicrounits: summary.maximumMicrounits,
    reservedMicrounits: summary.reservedMicrounits,
    spentMicrounits: summary.spentMicrounits,
    availableMicrounits: summary.availableMicrounits,
    maximumTokens: summary.maximumTokens,
    reservedTokens: summary.reservedTokens,
    spentTokens: summary.spentTokens,
    availableTokens: summary.availableTokens,
  }
const summaryOf = async (executionId) => {
  try {
    return ledgerView(await host.ledger.summary(host.workspaceId, executionId))
  } catch {
    return undefined
  }
}
// The child runtime is an explicit synthetic port: it records starts and dedupes by the
// idempotency key the canonical bridge supplies. It is not a live Pi child process.
const runtimeStarts = { calls: 0, sessions: new Map() }
const scriptedChildRuntime = {
  async start(request) {
    runtimeStarts.calls++
    const retained = runtimeStarts.sessions.get(request.idempotencyKey)
    if (retained) return retained
    const handle = {
      handleId: `pi-durable:${'b'.repeat(32)}`,
      attemptId: request.attemptId,
      externalSessionId: id('ses'),
      startedAt: host.at,
    }
    runtimeStarts.sessions.set(request.idempotencyKey, handle)
    return handle
  },
}
const runtimeEvidence = async () => {
  const budget = await host.repositories.usage.transaction(host.workspaceId, (tx) =>
    tx.getBudget(ids.childExecution)
  )
  return {
    startCalls: runtimeStarts.calls,
    distinctStarts: runtimeStarts.sessions.size,
    childAttemptReservations:
      budget?.reservations.filter((r) => r.reservationKey === `runtime-attempt:${ids.childAttempt}`)
        .length ?? 0,
  }
}
const evidence = () => ({
  canonical: host.canonicalCounts(),
  physicalSends: host.state.physicalSends,
  productReads: host.state.productReads,
  secretResolutions: host.models.secretProvider.resolveCount,
})
let allocationStage
let dispatched
let toolAdmission
async function dispatchLead(intentId) {
  if (dispatched) return dispatched
  allocationStage = 'dispatch'
  const dispatch = (
    await host.composition.piDurableLeadService.dispatch(
      host.command('pi-durable.lead.dispatch', {
        intentId,
        preparationRef: prepared.preparationRef,
      }),
      host.principal
    )
  ).data
  return awaitRunningLead(intentId, dispatch)
}
async function awaitRunningLead(intentId, dispatch) {
  allocationStage = 'parent-current'
  const deadline = Date.now() + 10000
  let parent, parentAttempt
  // The lead's own start must finish before any authority is changed: a revocation that lands
  // while the attempt is still starting would stop the lead itself, not the child.
  do {
    parent = await host.repositories.executions.getExecution(dispatch.executionId)
    parentAttempt = await host.repositories.executions.getAttempt(dispatch.attemptId)
    if (parent.state === 'running' && parentAttempt.state === 'running') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  if (parent.state !== 'running' || parentAttempt.state !== 'running')
    return {
      ok: false,
      stage: 'parent-running',
      state: parent.state,
      attemptState: parentAttempt.state,
      ...evidence(),
    }
  const plan = host.parentPlanForIntent(intentId)
  dispatched = { ok: true, intentId, dispatch, plan }
  return dispatched
}
// A lead that Adea's installed SDK already dispatched over CP's HTTP API: bind to the execution and
// attempt that dispatch created, after checking they are the retained ones for this intent.
async function adoptSdkDispatch(intentId, { executionId, attemptId }) {
  if (dispatched) return dispatched
  const plan = host.parentPlanForIntent(intentId)
  if (!plan)
    throw Object.assign(new Error('NO_RETAINED_LEAD_PLAN'), { code: 'NO_RETAINED_LEAD_PLAN' })
  const execution = await host.repositories.executions.getExecution(executionId)
  const attempt = await host.repositories.executions.getAttempt(attemptId)
  if (
    execution?.executionId !== executionId ||
    attempt?.executionId !== executionId ||
    execution.executionPlan.executionPlanId !== plan.executionPlanId ||
    execution.executionPlan.contentDigest !== plan.contentDigest
  )
    throw Object.assign(new Error('SDK_DISPATCH_NOT_RETAINED_LEAD'), {
      code: 'SDK_DISPATCH_NOT_RETAINED_LEAD',
    })
  return awaitRunningLead(intentId, { executionId, attemptId })
}
async function admitTool({ dispatch, plan }) {
  if (toolAdmission) return toolAdmission
  const toolCallId = id('tlc')
  const outcome = await toolService.execute({
    toolCallId,
    idempotencyKey: '1211-explicit-host-tool',
    requestedAt: host.at,
    policySnapshotRef: 'policy://1211-fixture',
    requestId: id('req'),
    executionId: dispatch.executionId,
    attemptId: dispatch.attemptId,
    workspaceId: host.workspaceId,
    profileId: plan.profile.profileId,
    toolDefinitionId,
    toolVersionId,
    operation: 'delegate-child',
    input: { objective: 'Bounded child' },
    grant: {
      workspaceId: host.workspaceId,
      profileId: plan.profile.profileId,
      toolDefinitionId,
      toolVersionId,
      operations: ['delegate-child'],
      expiresAt: host.expiresAt,
    },
    audit: { principalRef: host.actorPrincipalId, traceId: id('trc') },
  })
  if (outcome.state !== 'succeeded') throw new Error('TOOL_NOT_ADMITTED')
  toolAdmission = toolCallId
  return toolCallId
}
async function parentState() {
  const execution = await host.repositories.executions.getExecution(dispatched.dispatch.executionId)
  const attempt = await host.repositories.executions.getAttempt(dispatched.dispatch.attemptId)
  return { execution: execution.state, attempt: attempt.state, version: execution.version }
}
async function leadEvidence() {
  return {
    ...evidence(),
    parentState: await parentState(),
    parent: await summaryOf(dispatched.dispatch.executionId),
    child: await summaryOf(ids.childExecution),
    runtime: await runtimeEvidence(),
  }
}
async function allocateBody(intentId, allocationIds = ids) {
  const leadRun = await dispatchLead(intentId)
  if (!leadRun.ok) return leadRun
  allocationStage = 'child-allocation'
  const { dispatch, plan } = leadRun
  const toolCallId = await admitTool(leadRun)
  const context = await host.repositories.contexts.get(plan.contextPackage)
  const childContext = cp.context.deriveContextPackage(context, {
    objective: 'Bounded child',
    allowedStateItemIds: [],
    allowedArtifactIds: [],
    budgets: context.budgets,
    successCriteria: context.successCriteria,
    returnContract: context.returnContract,
    compiledAt: host.at,
  })
  await host.repositories.contexts.put(childContext)
  const childConstraints = structuredClone(plan.constraints)
  childConstraints.limits.budget.maximumMicrounits = Math.floor(
    plan.constraints.limits.budget.maximumMicrounits / 2
  )
  childConstraints.limits.tokens.maximumTotal = Math.floor(
    plan.constraints.limits.tokens.maximumTotal / 2
  )
  // The child is a restriction of its parent in every limit, and states its own allowance for its
  // own children instead of inheriting the parent's number, which is as large as its whole budget.
  const childAllowance = {
    maximumMicrounits: Math.floor(childConstraints.limits.budget.maximumMicrounits / 4),
    maximumTokens: Math.floor(childConstraints.limits.tokens.maximumTotal / 4),
  }
  childConstraints.limits.childExecutions = {
    maximumTotal: 1,
    maximumDepth: 1,
    budgetAllowance: childAllowance,
  }
  const before = await leadEvidence()
  try {
    const allocated = await delegationService.delegate({
      delegationId: allocationIds.delegation,
      parentIntentId: intentId,
      parentExecutionId: dispatch.executionId,
      parentAttemptId: dispatch.attemptId,
      admittedToolCallId: toolCallId,
      childExecutionId: allocationIds.childExecution,
      childAttemptId: allocationIds.childAttempt,
      initialDispatch: {
        delegationId: allocationIds.delegation,
        childAttemptId: allocationIds.childAttempt,
        runtime: { runtimeConnectionId: ids.runtimeConnection },
        dispatchedAt: host.at,
      },
      role: 'researcher',
      profileVersionId: plan.profile.profileVersionId,
      objective: 'Bounded child',
      parentPlan: plan,
      childPlan: {
        correlation: {
          ...plan.correlation,
          taskId: allocationIds.task ?? id('tsk'),
          requestId: allocationIds.request ?? id('req'),
        },
        contextPackage: childContext,
        constraints: childConstraints,
        runtimeRequirements: plan.runtimeRequirements,
        outputContract: plan.outputContract,
        compiledAt: host.at,
      },
      policy: {
        cancellation: 'cascade',
        deadline: 'bounded_by_parent',
        failure: 'manual',
        maximumRetries: 0,
      },
      acceptedAt: host.at,
      deadlineAt: host.expiresAt,
    })
    return {
      ok: true,
      childExecutionId: allocated.childExecutionId,
      persistedChild: true,
      childPlanMaximumMicrounits: childConstraints.limits.budget.maximumMicrounits,
      childPlanMaximumTokens: childConstraints.limits.tokens.maximumTotal,
      childAllowance,
      leadAllowance: plan.constraints.limits.childExecutions.budgetAllowance,
      childBudget: await summaryOf(allocationIds.childExecution),
      before,
      after: await leadEvidence(),
    }
  } catch (error) {
    return {
      ok: false,
      stage: 'child-allocation',
      code: error.code ?? error.message ?? 'UNKNOWN',
      persistedChild: Boolean(await childRecords.findByChild(allocationIds.childExecution)),
      childBudget: await summaryOf(allocationIds.childExecution),
      before,
      after: await leadEvidence(),
    }
  }
}
async function allocate(intentId, allocationIds) {
  let timer
  try {
    return await Promise.race([
      allocateBody(intentId, allocationIds),
      new Promise((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              ok: false,
              stage: allocationStage,
              code: 'FACTORY_BOUNDARY_TIMEOUT',
              physicalSends: host.state.physicalSends,
              productReads: host.state.productReads,
              secretResolutions: host.models.secretProvider.resolveCount,
            }),
          8000
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
// Child-runtime admission through the canonical bridge. Authority is re-read at every
// start: the admitting tool call, then the same current account/product/readiness
// resolution the allocator used. Budget is the child's own ledger reservation.
async function assertChildAuthority(admission) {
  const call = await toolCalls.get(admission.record.admittedToolCallId)
  if (
    !call ||
    call.executionId !== admission.identity.parentExecutionId ||
    call.attemptId !== admission.identity.parentAttemptId ||
    !['executing', 'succeeded'].includes(call.status)
  )
    throw new Error('CHILD_TOOL_AUTHORITY_REJECTED')
  // The caller's workspace grant is independently revocable: re-read it for the parent and the
  // child plan, as the delegation service does, before anything else is trusted.
  for (const scoped of [dispatched.plan, admission.plan]) {
    const allowed = await cp.executionPlan.currentExecutionScopeAllows(
      host.state.scopeAuthority,
      {
        ...scoped.correlation,
        callerPrincipalId: host.actorPrincipalId,
        executionPlan: {
          executionPlanId: scoped.executionPlanId,
          contentDigest: scoped.contentDigest,
          schemaVersion: scoped.schemaVersion,
        },
      },
      host.at
    )
    if (!allowed) throw new Error('CHILD_SCOPE_AUTHORITY_REJECTED')
  }
  await host.composition.resolveChildSelection(
    {
      schemaVersion: 'pi-lead-intent/v1',
      workspaceId: host.workspaceId,
      intentId: dispatched.intentId,
      principalId: host.principal.principalId,
    },
    {
      // A separate request id: this is a current-readiness read, not a second acceptance of the
      // child request whose selection the allocator already retained.
      childRequestId: 'req_01JBBCDEF0123456789ABCDEFH',
      childRequestDigest: `sha256:${createHash('sha256').update(admission.record.delegationId).digest('hex')}`,
      canonicalActorPrincipalId: host.actorPrincipalId,
      requestedSelection: ref(child),
    }
  )
}
const bridge = new cp.orchestration.CanonicalDelegationRuntimeBridge({
  records: childRecords,
  lifecycle,
  plans: host.repositories.plans,
  delegations: delegationService,
  runtime: scriptedChildRuntime,
  runtimeConnectionId: ids.runtimeConnection,
  assertAuthority: assertChildAuthority,
  // CP's production reservation for a delegated child, over the budget the transactional allocator
  // opened and funded. Nothing about the reservation is mirrored in this host.
  reserveBudget: new cp.worker.DurableChildRuntimeBudgetAdmission({
    store: host.repositories.usage,
    plans: host.repositories.plans,
  }).reserve,
})
async function startChild() {
  const before = await leadEvidence()
  try {
    const identity = {
      schemaVersion: 'delegation-runtime-admission/v1',
      parentExecutionId: dispatched.dispatch.executionId,
      parentAttemptId: dispatched.dispatch.attemptId,
      delegationId: ids.delegation,
      childAttemptId: ids.childAttempt,
    }
    // CP's delegation runtime dispatches the admitted child, then starts it. Authority is read
    // first so a revoked or quota-blocked caller moves nothing, not even the delegation state.
    const record = await childRecords.get(ids.delegation)
    const plan = await host.repositories.plans.get({
      executionPlanId: record.childExecutionPlanId,
      contentDigest: record.childExecutionPlanDigest,
    })
    await assertChildAuthority({ identity, record, plan })
    await delegationService.dispatchChild({
      delegationId: ids.delegation,
      childAttemptId: ids.childAttempt,
      runtime: { runtimeConnectionId: ids.runtimeConnection },
      dispatchedAt: host.at,
    })
    const handle = await bridge.startChild(identity)
    return { ok: true, handleAttemptId: handle.attemptId, before, after: await leadEvidence() }
  } catch (error) {
    return {
      ok: false,
      code: error.code ?? error.message ?? 'UNKNOWN',
      before,
      after: await leadEvidence(),
    }
  }
}
// Scripted spending, written through the real ledger so there is something to settle. No provider
// is reached.
const ledgerSource = (key) => ({ sourceId: key, idempotencyKey: key })
const leadReservationKey = () => `runtime-attempt:${dispatched.dispatch.attemptId}`
const childReservationKey = () => `runtime-attempt:${ids.childAttempt}`
const spendOn = async (executionId, attemptId, reservationKey, costMicrounits, tokens, key) => {
  await host.ledger.charge({
    workspaceId: host.workspaceId,
    executionId,
    attemptId,
    reservationKey,
    kind: 'model_usage',
    quantity: { unit: 'tokens', value: tokens },
    costMicrounits,
    fundingSource: 'hq_managed',
    source: ledgerSource(`${key}-charge`),
  })
  await host.ledger.settle({
    workspaceId: host.workspaceId,
    executionId,
    reservationKey,
    source: ledgerSource(`${key}-settle`),
  })
}
const spendOnLead = async ({ costMicrounits, tokens }) => {
  await spendOn(
    dispatched.dispatch.executionId,
    dispatched.dispatch.attemptId,
    leadReservationKey(),
    costMicrounits,
    tokens,
    'lead'
  )
  return {
    ...evidence(),
    parent: await summaryOf(dispatched.dispatch.executionId),
    child: await summaryOf(ids.childExecution),
  }
}
const spendOnChild = async ({ costMicrounits, tokens }) => {
  await spendOn(
    ids.childExecution,
    ids.childAttempt,
    childReservationKey(),
    costMicrounits,
    tokens,
    'child'
  )
  await host.ledger.finalizeBudget({
    workspaceId: host.workspaceId,
    executionId: ids.childExecution,
    source: ledgerSource('child-finalize'),
  })
  return {
    ...evidence(),
    parent: await summaryOf(dispatched.dispatch.executionId),
    child: await summaryOf(ids.childExecution),
  }
}
// The lead is cancelled through the canonical lifecycle, attempt first, then the execution.
async function cancelLead() {
  const at = new Date(Date.parse(host.at) + 60_000).toISOString()
  const attempt = await host.repositories.executions.getAttempt(dispatched.dispatch.attemptId)
  await lifecycle.transitionAttempt({
    attemptId: attempt.attemptId,
    expectedVersion: attempt.version,
    to: 'cancelled',
    transitionedAt: at,
  })
  const execution = await host.repositories.executions.getExecution(dispatched.dispatch.executionId)
  await lifecycle.transitionExecution({
    executionId: execution.executionId,
    expectedVersion: execution.version,
    to: 'cancelled',
    transitionedAt: at,
  })
  return { ...(await leadEvidence()) }
}
const stated = (constraints) => constraints.limits.childExecutions.budgetAllowance
// Where the allowance on the lead's plan came from. Read independently: the pinned profile version
// from CP's catalog, the constraints the request supplied, and the plan the lead actually ran on.
async function profileProvenance() {
  const { plan } = dispatched
  const version = await host.repositories.catalog.getAgentProfileVersion(
    plan.profile.profileVersionId
  )
  return {
    source: host.childAllowanceSource,
    pin: host.productProfilePin,
    planProfile: plan.profile,
    catalogVersion: version && {
      profileId: version.profileId,
      profileVersionId: version.profileVersionId,
      version: version.version,
      revision: version.revision,
      lifecycle: version.lifecycle,
      contentDigest: version.contentDigest,
    },
    profileAllowance: version && stated(version.definition.executionConstraints),
    requestAllowance: stated(host.requestConstraints),
    planAllowance: stated(plan.constraints),
    lead: await summaryOf(dispatched.dispatch.executionId),
  }
}
const baseline = () => host.models.currentAccountEvidence()
let originalAccount
function setAuthority(mode) {
  originalAccount ??= baseline()
  host.state.revoked = false
  host.models.setCurrentAccount(originalAccount)
  if (mode === 'quota-exhausted') host.models.setCurrentAccount({ quota: 'exhausted' })
  else if (mode === 'workspace-revoked') host.state.revoked = true
  else if (mode !== 'current') throw new Error('UNKNOWN_AUTHORITY_MODE')
}
let closing
const close = () =>
  (closing ??= (async () => {
    releaseProvider()
    try {
      await controlApp?.close()
    } finally {
      await host.close()
    }
  })())
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  void (async () => {
    const request = JSON.parse(line)
    let data
    if (request.command === 'prepare') {
      prepared = (
        await host.composition.piDurableLeadService.prepare(
          host.command('pi-durable.lead.prepare', { intentId: request.intentId }),
          host.principal
        )
      ).data
      data = { prepared, ...evidence() }
    } else if (request.command === 'constraints') {
      const account = host.models.currentAccountEvidence()
      host.models.setCurrentAccount({
        targets: [{ ...host.models.target, location: 'local_device' }],
      })
      let locationDenied = false
      try {
        await host.composition.resolveChildSelection(
          {
            schemaVersion: 'pi-lead-intent/v1',
            workspaceId: host.workspaceId,
            intentId: request.intentId,
            principalId: host.principal.principalId,
          },
          {
            childRequestId: id('req'),
            childRequestDigest: `sha256:${'a'.repeat(64)}`,
            canonicalActorPrincipalId: host.actorPrincipalId,
            requestedSelection: ref(child),
          }
        )
      } catch {
        locationDenied = true
      } finally {
        host.models.setCurrentAccount(account)
      }
      const path = host.records.get(request.intentId).payerPath,
        original = await readFile(path)
      await writeFile(path, JSON.stringify({ ...JSON.parse(original), status: 'revoked' }), {
        mode: 0o600,
      })
      let funding
      try {
        funding = await host.composition.modelConnectionService.funding(
          host.read('model-selection.funding.get', {
            executionId: prepared.executionId,
            attemptId: prepared.attemptId,
            selectionRef: prepared.selectionRef,
            selectionRevision: prepared.selectionRevision,
          }),
          host.principal.principalId
        )
      } finally {
        await writeFile(path, original, { mode: 0o600 })
      }
      data = { locationDenied, fundingState: funding.data.funding.state, ...evidence() }
    } else if (request.command === 'dispatch') {
      const leadRun = await dispatchLead(request.intentId)
      data = leadRun.ok ? { ok: true, ...(await leadEvidence()) } : leadRun
    } else if (request.command === 'evidence') {
      data = { ...evidence(), ...(dispatched?.ok ? await leadEvidence() : {}) }
    } else if (request.command === 'adopt') {
      const leadRun = await adoptSdkDispatch(request.intentId, request)
      data = leadRun.ok ? { ok: true, ...(await leadEvidence()) } : leadRun
    } else if (request.command === 'provenance') data = await profileProvenance()
    else if (request.command === 'profile-statement')
      // The pinned profile version as CP's catalog fixture holds it, readable before any dispatch.
      data = {
        source: host.childAllowanceSource,
        profileId: host.profile.profileId,
        profileVersionId: host.profile.profileVersionId,
        version: host.profile.version,
        revision: host.profile.revision,
        allowance: stated(host.profile.definition.executionConstraints),
      }
    else if (request.command === 'authority') {
      setAuthority(request.mode)
      data = { mode: request.mode }
    } else if (request.command === 'allocate') data = await allocate(request.intentId)
    else if (request.command === 'start-child') data = await startChild()
    else if (request.command === 'allocate-sibling')
      data = await allocate(request.intentId, siblingIds[request.which])
    else if (request.command === 'spend-lead') data = await spendOnLead(request)
    else if (request.command === 'spend-child') data = await spendOnChild(request)
    else if (request.command === 'cancel-lead') data = await cancelLead()
    else if (request.command === 'close') {
      await close()
      process.exit(0)
    } else throw new Error('UNKNOWN_TEST_CONTROL')
    process.stdout.write(JSON.stringify({ id: request.id, data }) + '\n')
  })().catch((error) => {
    process.stdout.write(
      JSON.stringify({ id: JSON.parse(line).id, error: error.code ?? 'HOST_CONTROL_FAILED' }) + '\n'
    )
  })
})
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    void close().then(
      () => process.exit(0),
      () => process.exit(1)
    )
  })
