/**
 * Joined #1230 × Control Plane proof (opt-in).
 *
 * Drives the production Adea management path against the canonical Control Plane
 * management-current route, mounted in-process from the explicit control-plane checkout named
 * by ADEA_CONTROL_PLANE_SOURCE and pinned in control-plane-source.json. Only
 * `bun run test:integration:control-plane-joined` loads this directory; the default lanes never
 * do, and a missing checkout or a revision mismatch fails instead of skipping.
 *
 * Real: the Adea production current-authority client (credential minted from the process
 * environment, workspace-to-control-plane scope read from the database), the control-plane
 * route on a loopback port, the control-plane current-tool authority composition from its
 * production factory, the control-plane Ed25519 service verifier, decision issuer and canonical
 * digest, the Adea lead route, durable claim and completion, consumption rows and the database
 * executors.
 *
 * In memory (control-plane side, disclosed): the tool registry repository (with a withdrawal
 * seam, since the control plane has no tool-version delete), the tool call repository (the
 * management call row is seeded here), the interactions repository and the rate limiter. The
 * control-plane lead turn that owns the attempt uses the factory's SQLite canonical store.
 *
 * Not exercised: control-plane policy authorization (a static allow stands in), approval
 * semantics (approval mode `never`), and rate limiting or funding for the management call.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const connectionUrl = process.env.DATABASE_URL
const controlPlaneSource = process.env.ADEA_CONTROL_PLANE_SOURCE
if (!connectionUrl || !controlPlaneSource) {
  throw new Error(
    'The joined proof needs DATABASE_URL and ADEA_CONTROL_PLANE_SOURCE; run `bun run test:integration:control-plane-joined`'
  )
}

const pinned = JSON.parse(
  readFileSync(new URL('./control-plane-source.json', import.meta.url), 'utf8')
) as { repository: string; revision: string; cp1043Squash: string }
const git = (...args: string[]) =>
  Bun.spawnSync(['git', '-C', controlPlaneSource, ...args], { stdout: 'pipe', stderr: 'pipe' })
if (git('rev-parse', 'HEAD').stdout.toString().trim() !== pinned.revision) {
  throw new Error(`control-plane source is not the pinned revision ${pinned.revision}`)
}
if (git('status', '--porcelain', '--untracked-files=no').stdout.toString().trim() !== '') {
  throw new Error(
    'control-plane source has tracked changes; the proof needs the pinned revision exactly'
  )
}
if (git('merge-base', '--is-ancestor', pinned.cp1043Squash, 'HEAD').exitCode !== 0) {
  throw new Error(`control-plane source does not contain the CP1043 squash ${pinned.cp1043Squash}`)
}

const controlPlane = (path: string) => join(controlPlaneSource, path)
const requireFromDatabase = createRequire(
  new URL('../../../../packages/db/package.json', import.meta.url)
)
const { eq } = await import(requireFromDatabase.resolve('drizzle-orm'))

const ADEA_ISSUER = 'https://adea-fixture.invalid/control-plane'
const SIGNING_KEY_ID = 'adea-web-joined-ephemeral'
const LEAD_ISSUER = 'https://cp-fixture.invalid'
const LEAD_KEY_ID = 'adea-joined-decision-key'
const LEAD_PRINCIPAL = 'svc_pi-lead-management'
const TOOL_DEFINITION = 'tld_01JABCDEF0123456789ABCDEFG'
const TOOL_VERSION = 'tlv_01JABCDEF0123456789ABCDEFG'
const CP_WORKSPACE_B = `wsp_01J${'B'.repeat(23)}`
const ENVIRONMENT_KEYS = [
  'CONTROL_PLANE_ORIGIN',
  'CONTROL_PLANE_SIGNING_KEY',
  'CONTROL_PLANE_SIGNING_KEY_ID',
  'CONTROL_PLANE_SIGNING_ISSUER',
] as const

const uniqueId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase()}`

type Tenant = {
  workspaceId: string
  controlPlaneWorkspaceId: string
  projectId: string
  principal: { kind: 'user'; userId: string }
}
type Hop = {
  boundary: string
  workspaceId: string
  verifiedWorkspaceIds: unknown
  verifiedScopes: unknown
}
type Decision = {
  decisionId: string
  token: string
  tenant: Tenant
  name: string
  request: unknown
}

describe('joined #1230 × control-plane management-current proof', () => {
  // Loaded from the control-plane checkout and the Adea source at setup time.
  let cp: any
  let adea: any
  let host: any
  let application: any
  let connection: any
  let registryRepository: { withdrawn: boolean }
  let nativeFetch: typeof fetch
  let savedEnvironment: Record<string, string | undefined> = {}
  let leadHandler: (request: Request) => Promise<Response>
  let assertCurrent: (request: unknown, boundary: string) => Promise<void>
  let issueDecision: (args: unknown) => Promise<{ decision: string }>
  let canonicalRequestFor: (name: string, workspaceId?: string) => Promise<unknown>
  let authorityRevision = 0
  let fixtureAt = ''
  let controlPlaneWorkspaceA = ''
  let tenantA: Tenant
  let tenantB: Tenant
  let acceptedDecision: Decision
  let cpExecutions = 0
  const hops: Hop[] = []
  let lastVerified: { workspaceIds: unknown; scopes: unknown } = {
    workspaceIds: undefined,
    scopes: undefined,
  }
  const now = () => Date.parse(fixtureAt)

  const projectOf = (tenant: Tenant) =>
    adea.db.getProjectForUser(connection.db, tenant.workspaceId, tenant.projectId, tenant.principal)
  const consumptionOf = async (decisionId: string) =>
    (
      await connection.db
        .select()
        .from(adea.db.managementAuthorityConsumptions)
        .where(eq(adea.db.managementAuthorityConsumptions.decisionId, decisionId))
    )[0]

  async function decide(tenant: Tenant, name: string, request: unknown): Promise<Decision> {
    const binding = await adea.types.managementCallBinding({
      input: { name },
      operation: 'project.update',
      targetId: tenant.projectId,
      workspaceId: tenant.workspaceId,
    })
    const decisionId = uniqueId('dec')
    const issued = await issueDecision({
      actorUserId: tenant.principal.userId,
      approval: {
        audienceRef: 'audience:fixture',
        expiresAt: new Date(now() + 120_000).toISOString(),
        interactionId: `interaction-${decisionId}`,
      },
      audienceRef: 'audience:fixture',
      authorityRef: 'authority-1',
      authorityRevision,
      binding,
      canonicalRequest: request,
      credentialId: `credential-${decisionId}`,
      decisionId,
      intentId: 'intent-1',
      leadAgentId: 'agent-lead-1',
      planRef: 'plan:fixture',
      planRevision: 3,
    })
    return { decisionId, token: issued.decision, tenant, name, request }
  }

  /** Posts a decision to the Adea route for `route` (defaults to the decision's own tenant). */
  async function invoke(decision: Decision, route: Tenant = decision.tenant): Promise<Response> {
    return adea.scope.withRequestScope(() =>
      leadHandler(
        new Request('https://adea-fixture.invalid/api/internal/pi-durable/management', {
          body: JSON.stringify({
            canonicalRequest: decision.request,
            input: { name: decision.name },
            operation: 'project.update',
            schemaVersion: 'adea-management-call/v1',
            targetId: route.projectId,
            workspaceId: route.workspaceId,
          }),
          headers: { authorization: `Bearer ${decision.token}` },
          method: 'POST',
        })
      )
    )
  }

  beforeAll(async () => {
    cp = {
      factory: await import(controlPlane('tests/pi-production-factory.fixture.mjs')),
      application: await import(controlPlane('apps/control-api/src/application.ts')),
      authentication: await import(
        controlPlane('apps/control-api/src/auth/service-authentication.ts')
      ),
      decisionIssuer: await import(
        controlPlane('apps/control-api/src/pi-durable/management-decision-issuer.ts')
      ),
      tool: await import(controlPlane('packages/tool-execution/src/index.ts')),
      domain: await import(controlPlane('packages/domain/src/interactions.ts')),
    }
    adea = {
      db: await import('@adea-ai/db'),
      types: await import('@adea-ai/types/management'),
      authentication: await import('../../src/server/lead-management-service-auth'),
      route: await import('../../src/server/lead-management-route'),
      composition: await import('../../src/server/management-composition'),
      scope: await import('../../src/server/request-scope'),
    }

    // ---- Control-plane governed tool service: the same classes the control plane's own test uses ----
    class WithdrawableRegistryRepository extends cp.tool.InMemoryToolRegistryRepository {
      withdrawn = false
      async getVersion(toolVersionId: string) {
        return this.withdrawn ? undefined : super.getVersion(toolVersionId)
      }
    }
    registryRepository = new WithdrawableRegistryRepository()
    const registry = new cp.tool.ToolRegistry(registryRepository)
    const gateway = new cp.tool.ToolGateway(registry)
    const calls = new cp.tool.InMemoryToolCallRepository()
    const interactions = new cp.domain.InMemoryInteractionRepository()
    gateway.registerExecutor('internal', 'adea.management.v1', {
      async execute() {
        cpExecutions += 1
        throw new Error('CP_EXECUTOR_MUST_NOT_RUN')
      },
    })
    const service = new cp.tool.PolicyControlledToolExecutionService({
      gateway,
      calls,
      authorizer: new cp.tool.StaticToolPolicyAuthorizer({
        effect: 'allow',
        decisionId: 'joined-proof-allow',
        policyVersion: 'joined-proof-policy-v1',
        reasonCode: 'GRANTED',
        requiresApproval: false,
        evaluatedAt: new Date().toISOString(),
      }),
      approvals: {
        repository: interactions,
        async review({ interactionId }: { interactionId: string }) {
          return { state: 'pending', interactionId }
        },
      },
      rateLimiter: new cp.tool.InMemoryToolRateLimiter(),
      now: () => fixtureAt,
    })

    nativeFetch = globalThis.fetch
    host = await cp.factory.createProductionFactoryFixture({
      managementAuthority: { interactions, service },
    })
    fixtureAt = host.at
    controlPlaneWorkspaceA = host.workspaceId
    authorityRevision = 0

    await registry.createDefinition({
      toolDefinitionId: TOOL_DEFINITION,
      name: 'adea.management',
      displayName: 'Adea management',
      description: 'Adea executes the management effect; the control plane only asserts authority.',
      ownership: { scope: 'workspace', workspaceId: controlPlaneWorkspaceA },
      createdAt: host.at,
    })
    await registry.publishVersion({
      toolDefinitionId: TOOL_DEFINITION,
      toolVersionId: TOOL_VERSION,
      semanticVersion: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object', properties: {}, additionalProperties: false },
      operations: [
        {
          name: 'project.update',
          requiredCapabilities: [],
          riskClass: 'high',
          approvalMode: 'never',
          idempotency: 'provider_key',
          retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
        },
      ],
      executor: { type: 'internal', reference: 'adea.management.v1' },
      limits: { maxInputBytes: 1024, maxOutputBytes: 1024, timeoutMs: 1000 },
      createdAt: host.at,
      publishedAt: host.at,
    })

    // The control-plane lead turn that owns the attempt, through the factory.
    const intentId = host.setIntent()
    const preparation = (
      await host.composition.piDurableLeadService.prepare(
        host.command('pi-durable.lead.prepare', { intentId }),
        host.principal
      )
    ).data
    const dispatched = (
      await host.composition.piDurableLeadService.dispatch(
        host.command('pi-durable.lead.dispatch', {
          intentId,
          preparationRef: preparation.preparationRef,
        }),
        host.principal
      )
    ).data
    await host.composition.adapter.drain()
    const product = host.rawProductEvidence(intentId)
    authorityRevision = product.authorityRevision

    canonicalRequestFor = async (name: string, workspaceId = controlPlaneWorkspaceA) => {
      const toolCallId = uniqueId('tlc')
      const request = {
        attemptId: dispatched.attemptId,
        audit: { principalRef: product.canonicalActorPrincipalId, traceId: uniqueId('trc') },
        executionId: dispatched.executionId,
        grant: {
          expiresAt: host.expiresAt,
          operations: ['project.update'],
          profileId: product.profileId,
          toolDefinitionId: TOOL_DEFINITION,
          toolVersionId: TOOL_VERSION,
          workspaceId,
        },
        idempotencyKey: `joined-proof:${toolCallId}`,
        input: { name },
        operation: 'project.update',
        policySnapshotRef: 'policy://fixture',
        profileId: product.profileId,
        requestId: uniqueId('req'),
        requestedAt: host.at,
        toolCallId,
        toolDefinitionId: TOOL_DEFINITION,
        toolVersionId: TOOL_VERSION,
        workspaceId,
      }
      const inserted = await calls.insert({
        attemptId: request.attemptId,
        executionId: request.executionId,
        executor: { type: 'internal', reference: 'adea.management.v1' },
        idempotencyKey: request.idempotencyKey,
        inputDigest: cp.tool.toolInputDigest(request.input),
        operation: request.operation,
        policySnapshotRef: request.policySnapshotRef,
        principalRef: request.audit.principalRef,
        profileId: request.profileId,
        requestedAt: request.requestedAt,
        startedAt: host.at,
        status: 'executing',
        toolCallId,
        toolDefinitionId: request.toolDefinitionId,
        toolVersionId: request.toolVersionId,
        workspaceId,
      })
      if (!inserted) throw new Error('control-plane call row was refused')
      return request
    }

    // ---- Control-plane route on a real loopback port; spies only around verification and authority ----
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const signingPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
    const signingPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(signingPkcs8)
      .toString('base64')
      .match(/.{1,64}/gu)!
      .join('\n')}\n-----END PRIVATE KEY-----\n`
    const signingPublic = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as { x: string }
    const realVerifier = new cp.authentication.Ed25519ServiceCredentialVerifier([
      { keyId: SIGNING_KEY_ID, publicKey: signingPublic.x },
    ])
    const realAuthority = host.composition.piDurableCurrentToolAuthority
    const metadata = {
      commitSha: pinned.revision,
      environment: 'test',
      instanceId: 'joined-proof',
      serviceName: 'control-api',
      version: 'test',
    }
    application = await cp.application.createControlApiApplication({
      health: () => ({ metadata, status: 'ok' }),
      logger: { write: () => undefined },
      metadata,
      piDurableCurrentToolAuthority: {
        async assertCurrent(
          request: { toolCallId: string; workspaceId: string },
          boundary: string
        ) {
          hops.push({
            boundary,
            workspaceId: request.workspaceId,
            verifiedWorkspaceIds: lastVerified.workspaceIds,
            verifiedScopes: lastVerified.scopes,
          })
          return realAuthority.assertCurrent(request, boundary)
        },
      },
      readiness: () => ({ metadata, status: 'ready' }),
      serviceAuthenticator: new cp.authentication.PolicyServiceAuthenticator({
        audience: 'control-plane',
        clockSkewMs: 30_000,
        issuer: ADEA_ISSUER,
        logger: { write: () => undefined },
        now: () => new Date(),
        revocationChecker: { isRevoked: async () => false },
        verifier: {
          async verify(token: string) {
            const claims = (await realVerifier.verify(token)) as {
              workspaceIds: unknown
              scopes: unknown
            }
            lastVerified = { workspaceIds: claims.workspaceIds, scopes: claims.scopes }
            return claims
          },
        },
      }),
    })
    await application.listen(0, '127.0.0.1')
    const cpOrigin = new URL(await application.getUrl()).origin
    // The factory swaps globalThis.fetch for a provider-only transport that refuses all egress.
    // The production client uses the global fetch, so restore the native transport for exactly
    // the control-plane loopback origin; every other origin stays refused.
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : String(input))
      if (target.origin !== cpOrigin) throw new Error('TEST_UNEXPECTED_EGRESS')
      return nativeFetch(input, init)
    }

    // ---- Production Adea wiring: the environment names the production route reads ----
    for (const key of ENVIRONMENT_KEYS) savedEnvironment[key] = process.env[key]
    process.env.CONTROL_PLANE_ORIGIN = cpOrigin
    process.env.CONTROL_PLANE_SIGNING_KEY = signingPem
    process.env.CONTROL_PLANE_SIGNING_KEY_ID = SIGNING_KEY_ID
    process.env.CONTROL_PLANE_SIGNING_ISSUER = ADEA_ISSUER
    assertCurrent = adea.composition.applicationManagementCurrentAuthority()

    // ---- Disposable Adea data: two synthetic accounts, each workspace mapped to a control-plane identity ----
    connection = adea.db.createDatabase(connectionUrl)
    const tenantFor = async (name: string, controlPlaneWorkspaceId: string): Promise<Tenant> => {
      const session = await adea.db.createTemporaryUserSession(connection.db, {
        credentialDigest: `digest-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.parse(host.at) + 3_600_000),
      })
      const workspace = (
        await adea.db.createWorkspaceWithOwner(connection.db, {
          idempotencyKey: `joined-proof-${name}-${crypto.randomUUID()}`,
          name: `Joined proof ${name}`,
          owner: session.principal,
        })
      ).workspace
      await connection.db
        .update(adea.db.workspaces)
        .set({ controlPlaneWorkspaceId })
        .where(eq(adea.db.workspaces.id, workspace.id))
      const project = await adea.db.createProject(connection.db, workspace.id, session.principal, {
        iconKey: 'box',
        name: `Before ${name}`,
      })
      return {
        workspaceId: workspace.id,
        controlPlaneWorkspaceId,
        projectId: project.id,
        principal: session.principal,
      }
    }
    tenantA = await tenantFor('A', controlPlaneWorkspaceA)
    tenantB = await tenantFor('B', CP_WORKSPACE_B)

    // ---- Control-plane decision issuer, trusted by the Adea lead verifier ----
    const leadPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const leadPublicJwk = await crypto.subtle.exportKey('jwk', leadPair.publicKey)
    const decisionIssuer = cp.decisionIssuer.createPiDurableManagementDecisionIssuer({
      issuer: LEAD_ISSUER,
      now,
      principalId: LEAD_PRINCIPAL,
      signer: {
        keyId: LEAD_KEY_ID,
        sign: async (payload: Uint8Array) =>
          new Uint8Array(await crypto.subtle.sign('Ed25519', leadPair.privateKey, payload)),
      },
    })
    issueDecision = (args) => decisionIssuer.issue(args)
    const trust = JSON.stringify({
      issuer: LEAD_ISSUER,
      keyId: LEAD_KEY_ID,
      principalId: LEAD_PRINCIPAL,
      publicJwk: leadPublicJwk,
      revokedCredentialIds: [],
      workspaceIds: [tenantA.workspaceId, tenantB.workspaceId],
    })

    // ---- The real Adea lead route, with the production current-authority port ----
    leadHandler = adea.route.createLeadManagementHandler({
      assertCurrent,
      claim: (decision: any) =>
        adea.db.claimManagementAuthorityDecision(connection.db, {
          actionDigest: decision.binding.actionDigest,
          authorityRef: decision.authorityRef,
          authorityRevision: decision.authorityRevision,
          decisionId: decision.decisionId,
          inputDigest: decision.binding.inputDigest,
          operation: decision.binding.operation,
          targetDigest: decision.binding.targetDigest,
          targetId: decision.binding.targetId,
          workspaceId: decision.binding.workspaceId,
        }),
      complete: (decision: any, completion: unknown) =>
        adea.db.completeManagementAuthorityDecision(connection.db, decision.decisionId, completion),
      now,
      operationsFor: (caller: unknown) =>
        adea.composition.applicationManagementOperations(caller, { assertCurrent, now }),
      verify: adea.authentication.createLeadManagementServiceVerifier(
        {
          get PI_LEAD_MANAGEMENT_TRUST() {
            return trust
          },
        },
        now
      ),
    })
  })

  afterAll(async () => {
    globalThis.fetch = nativeFetch
    for (const key of ENVIRONMENT_KEYS) {
      if (savedEnvironment[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnvironment[key]
    }
    await application?.close()
    await host?.close()
    await connection?.close()
  })

  test('an authorized decision applies once through the production path and its consumption row is retained', async () => {
    const request = await canonicalRequestFor('After one')
    const decision = await decide(tenantA, 'After one', request)
    const versionBefore = (await projectOf(tenantA)).version
    const hopsBefore = hops.length

    const response = await invoke(decision)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { value: unknown }

    expect(hops.slice(hopsBefore).map((hop) => hop.boundary)).toEqual(['admission', 'effect'])
    for (const hop of hops.slice(hopsBefore)) {
      expect(hop.verifiedWorkspaceIds).toEqual([tenantA.controlPlaneWorkspaceId])
      expect(hop.verifiedScopes).toEqual(['execution:read'])
    }
    const after = await projectOf(tenantA)
    expect(after.name).toBe('After one')
    expect(after.version).toBe(versionBefore + 1)
    expect(cpExecutions).toBe(0)
    const consumed = await consumptionOf(decision.decisionId)
    expect(consumed?.state).toBe('succeeded')
    expect(consumed?.resultDigest).toBe(await adea.types.managementInputDigest(body.value))
    acceptedDecision = decision
  })

  test('a replayed decision is refused before any second effect boundary', async () => {
    const versionBefore = (await projectOf(tenantA)).version
    const hopsBefore = hops.length
    const response = await invoke(acceptedDecision)
    expect(response.status).toBe(403)
    expect(((await response.json()) as { reason: string }).reason).toBe('authority_replay')
    expect(hops.slice(hopsBefore).map((hop) => hop.boundary)).toEqual(['admission'])
    expect((await projectOf(tenantA)).version).toBe(versionBefore)
  })

  test('a foreign workspace is refused by the Adea binding and by the control-plane authority', async () => {
    const versionsBefore = [(await projectOf(tenantA)).version, (await projectOf(tenantB)).version]
    const hopsBefore = hops.length

    // B's decision presented to A's route: refused by the binding before any control-plane hop.
    const foreign = await decide(tenantB, 'Foreign', await canonicalRequestFor('Foreign'))
    const crossed = await invoke(foreign, tenantA)
    expect(crossed.status).not.toBe(200)
    expect(hops.length).toBe(hopsBefore)

    // B's production assertion over A's attempt: refused by the control-plane authority.
    let refusal: { reason?: string } | undefined
    try {
      await assertCurrent(
        {
          canonicalRequest: await canonicalRequestFor('Foreign CP', CP_WORKSPACE_B),
          binding: { workspaceId: tenantB.workspaceId },
        },
        'admission'
      )
    } catch (error) {
      refusal = error as { reason?: string }
    }
    expect(refusal?.reason).toBe('authority_unavailable')
    expect(hops.at(-1)).toMatchObject({ boundary: 'admission', workspaceId: CP_WORKSPACE_B })
    expect(hops.at(-1)?.verifiedWorkspaceIds).toEqual([CP_WORKSPACE_B])
    expect([(await projectOf(tenantA)).version, (await projectOf(tenantB)).version]).toEqual(
      versionsBefore
    )
  })

  test('a control-plane denial refuses without burning the decision, which applies once when authority returns', async () => {
    const decision = await decide(
      tenantA,
      'Retried after denial',
      await canonicalRequestFor('Retried after denial')
    )
    const versionBefore = (await projectOf(tenantA)).version

    registryRepository.withdrawn = true
    try {
      const hopsBefore = hops.length
      const denied = await invoke(decision)
      expect(denied.status).not.toBe(200)
      expect(((await denied.json()) as { reason: string }).reason).toBe('authority_unavailable')
      expect(hops.slice(hopsBefore).map((hop) => hop.boundary)).toEqual(['admission'])
      expect((await projectOf(tenantA)).version).toBe(versionBefore)
      expect(await consumptionOf(decision.decisionId)).toBeUndefined()
    } finally {
      registryRepository.withdrawn = false
    }

    const retried = await invoke(decision)
    expect(retried.status).toBe(200)
    const after = await projectOf(tenantA)
    expect(after.name).toBe('Retried after denial')
    expect(after.version).toBe(versionBefore + 1)
    expect((await consumptionOf(decision.decisionId))?.state).toBe('succeeded')
    expect(((await (await invoke(decision)).json()) as { reason: string }).reason).toBe(
      'authority_replay'
    )
  })
})
