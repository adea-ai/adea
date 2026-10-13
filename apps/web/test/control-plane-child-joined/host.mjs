// TEST ONLY: separate CP compiler/runtime context; actual factories and transactional allocator.
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
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
}
const id = (prefix) => `${prefix}_01JBBCDEF0123456789ABCDEFG`
let host, delegationService, toolService, childRecords, toolDefinitionId, toolVersionId
let releaseProvider
const held = new Promise((resolve) => {
  releaseProvider = resolve
})
const originalFetch = globalThis.fetch
host = await cp.factory.createProductionFactoryFixture({
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
      calls: new cp.sqlite.SqliteToolCallRepository(persistence, ws),
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
        lifecycle: new cp.domain.ExecutionLifecycleService(repositories.executions),
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
process.stdout.write(
  JSON.stringify({
    ready: true,
    directory: host.directory,
    requestedModelSelections: { lead: ref(lead), child: ref(child) },
  }) + '\n'
)
let prepared
const evidence = () => ({
  canonical: host.canonicalCounts(),
  physicalSends: host.state.physicalSends,
  productReads: host.state.productReads,
  secretResolutions: host.models.secretProvider.resolveCount,
})
let allocationStage
async function allocateBody(intentId) {
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
  allocationStage = 'parent-current'
  const deadline = Date.now() + 10000
  let parent
  do {
    parent = await host.repositories.executions.getExecution(dispatch.executionId)
    if (parent.state === 'running') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  if (parent.state !== 'running')
    return { ok: false, stage: 'parent-running', state: parent.state, ...evidence() }
  allocationStage = 'child-allocation'
  const plan = host.parentPlanForIntent(intentId)
  const context = await host.repositories.contexts.get(plan.contextPackage)
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
  const before = host.canonicalCounts()
  try {
    const allocated = await delegationService.delegate({
      delegationId: id('dlg'),
      parentIntentId: intentId,
      parentExecutionId: dispatch.executionId,
      parentAttemptId: dispatch.attemptId,
      admittedToolCallId: toolCallId,
      childExecutionId: id('exe'),
      childAttemptId: id('att'),
      initialDispatch: {
        delegationId: id('dlg'),
        childAttemptId: id('att'),
        runtime: { runtimeConnectionId: id('rtc') },
        dispatchedAt: host.at,
      },
      role: 'researcher',
      profileVersionId: plan.profile.profileVersionId,
      objective: 'Bounded child',
      parentPlan: plan,
      childPlan: {
        correlation: { ...plan.correlation, taskId: id('tsk'), requestId: id('req') },
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
      canonical: host.canonicalCounts(),
    }
  } catch (error) {
    const after = host.canonicalCounts()
    const persisted = await childRecords.findByChild(id('exe'))
    const allowance = await host.ledger.summary(host.workspaceId, dispatch.executionId)
    return {
      ok: false,
      stage: 'child-allocation',
      code: error.code ?? 'UNKNOWN',
      before,
      after,
      persistedChild: Boolean(persisted),
      availableMicrounits: allowance.availableMicrounits,
      availableTokens: allowance.availableTokens,
      physicalSends: host.state.physicalSends,
    }
  }
}
async function allocate(intentId) {
  let timer
  try {
    return await Promise.race([
      allocateBody(intentId),
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
let closing
const close = () =>
  (closing ??= (async () => {
    releaseProvider()
    await host.close()
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
    } else if (request.command === 'allocate') data = await allocate(request.intentId)
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
