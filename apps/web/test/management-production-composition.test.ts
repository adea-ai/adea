import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

/**
 * Production-composed host proof (#1215). Uses the real
 * `applicationManagementOperations` composition, the real signed-decision
 * verifier, the real Control API current-authority client (against a loopback
 * CP route contract), the real durable claim functions and the real database
 * executors — no injected fake operations. It runs only with an isolated
 * DATABASE_URL and the react-server condition so the server-only composition
 * loads:
 *
 *   DATABASE_URL=... bun test --conditions=react-server \
 *     apps/web/test/management-production-composition.test.ts
 */
const connectionUrl = process.env.DATABASE_URL
const CANONICAL_REQUEST = {
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
}
const CP_WORKSPACE = 'wsp_01JABCDEF0123456789ABCDEFG'

let cpMode: 'ok' | 'revoked' = 'ok'
const cpSeen: Array<{ boundary: string; request: unknown }> = []

function base64url(value: string | Uint8Array) {
  return Buffer.from(value).toString('base64url')
}

describe.skipIf(!connectionUrl)('production-composed lead management route (#1215)', () => {
  let authModule: typeof import('../src/server/lead-management-service-auth')
  let clientModule: typeof import('../src/server/management-authority-current')
  let composition: typeof import('../src/server/management-composition')
  let dbModule: typeof import('@adea-ai/db')
  let routeModule: typeof import('../src/server/lead-management-route')
  let scopeModule: typeof import('../src/server/request-scope')
  let typesModule: typeof import('@adea-ai/types/management')
  let connection: import('@adea-ai/db').DatabaseConnection
  let cpServer: ReturnType<typeof Bun.serve>

  let workspaceId = ''
  let projectId = ''
  let principal: import('@adea-ai/types').UserPrincipalRef
  let trust = ''
  let signingKey: CryptoKey

  const issuer = 'https://cp-fixture.invalid'
  const keyId = 'synthetic-production-composition-key'
  const servicePrincipalId = 'svc_pi-lead-management'
  const now = Date.parse('2026-10-09T12:00:00.000Z')

  async function signedDecision(binding: { [key: string]: unknown }, decisionId: string) {
    const claims = {
      actionDigest: binding.actionDigest,
      actorUserId: principal.userId,
      approvalAudienceRef: 'audience:fixture',
      approvalExpiresAt: new Date(now + 120_000).toISOString(),
      approvalInteractionId: `interaction-${decisionId}`,
      audience: 'adea-lead-management',
      audienceRef: 'audience:fixture',
      authorityRevision: 7,
      canonicalRequestDigest: await typesModule.managementInputDigest(CANONICAL_REQUEST),
      credentialId: `credential-${decisionId}`,
      credentialKind: 'service',
      decision: 'allowed',
      decisionId,
      expiresAt: new Date(now + 60_000).toISOString(),
      inputDigest: binding.inputDigest,
      intentId: 'intent-1',
      issuedAt: new Date(now - 1_000).toISOString(),
      issuer,
      keyId,
      leadAgentId: 'agent-lead-1',
      operation: binding.operation,
      planRef: 'plan:fixture',
      planRevision: 3,
      principalId: servicePrincipalId,
      projectIds: [] as string[],
      scopes: ['management:execute'],
      targetDigest: binding.targetDigest,
      targetId: binding.targetId,
      workspaceIds: [workspaceId],
    }
    const header = base64url(JSON.stringify({ alg: 'EdDSA', kid: keyId, typ: 'JWT' }))
    const payload = base64url(JSON.stringify(claims))
    const signature = await crypto.subtle.sign(
      'Ed25519',
      signingKey,
      new TextEncoder().encode(`${header}.${payload}`)
    )
    return `${header}.${payload}.${base64url(new Uint8Array(signature))}`
  }

  function requestFor(
    input: Record<string, unknown>,
    binding: { [key: string]: unknown },
    token: string
  ) {
    return new Request('https://adea-fixture.invalid/api/internal/pi-durable/management', {
      body: JSON.stringify({
        canonicalRequest: CANONICAL_REQUEST,
        input,
        operation: binding.operation,
        schemaVersion: 'adea-management-call/v1',
        targetId: binding.targetId,
        workspaceId,
      }),
      headers: { authorization: `Bearer ${token}` },
      method: 'POST',
    })
  }

  beforeAll(async () => {
    cpServer = Bun.serve({
      fetch: async (incoming) => {
        const body = (await incoming.json()) as Record<string, unknown>
        const parameters = (body.parameters ?? {}) as Record<string, unknown>
        cpSeen.push({
          boundary: String(parameters.boundary ?? ''),
          request: parameters.request,
        })
        if (cpMode === 'revoked') return new Response('{"code":"NOPE"}', { status: 503 })
        // The reviewed CP1043 route answers a successful assertion with
        // exactly this document; the loopback mirror must not invent fields.
        return Response.json({ asserted: true })
      },
      port: 0,
    })
    authModule = await import('../src/server/lead-management-service-auth')
    clientModule = await import('../src/server/management-authority-current')
    composition = await import('../src/server/management-composition')
    dbModule = await import('@adea-ai/db')
    routeModule = await import('../src/server/lead-management-route')
    scopeModule = await import('../src/server/request-scope')
    typesModule = await import('@adea-ai/types/management')

    connection = dbModule.createDatabase(connectionUrl!)
    const temporary = await dbModule.createTemporaryUserSession(connection.db, {
      credentialDigest: `digest-${crypto.randomUUID()}`,
      expiresAt: new Date(now + 3_600_000),
    })
    principal = temporary.principal
    const created = await dbModule.createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `production-composition-${crypto.randomUUID()}`,
      name: 'Production composition fixture',
      owner: principal,
    })
    workspaceId = created.workspace.id
    const project = await dbModule.createProject(connection.db, workspaceId, principal, {
      iconKey: 'box',
      name: 'Composed before',
    })
    projectId = project.id

    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    signingKey = pair.privateKey
    trust = JSON.stringify({
      issuer,
      keyId,
      principalId: servicePrincipalId,
      publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
      revokedCredentialIds: [],
      workspaceIds: [workspaceId],
    })
  })

  afterAll(async () => {
    cpServer?.stop(true)
    await connection?.close()
  })

  function handler() {
    // Real Adea client against the loopback CP route; the same instance flows
    // into createManagementGateway through the composition, not a bypass.
    const assertCurrent = clientModule.createControlPlaneManagementCurrentAuthority({
      credential: async () => ({ token: 'fixture-cp-token', workspaceId: CP_WORKSPACE }),
      environment: { CONTROL_PLANE_ORIGIN: `http://127.0.0.1:${cpServer.port}` },
      now: () => now,
    })
    return routeModule.createLeadManagementHandler({
      assertCurrent,
      claim: (decision) =>
        dbModule.claimManagementAuthorityDecision(connection.db, {
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
      complete: (decision, completion) =>
        dbModule.completeManagementAuthorityDecision(
          connection.db,
          decision.decisionId,
          completion
        ),
      operationsFor: (caller) =>
        composition.applicationManagementOperations(caller, {
          assertCurrent,
          now: () => now,
        }),
      now: () => now,
      verify: authModule.createLeadManagementServiceVerifier(
        {
          get PI_LEAD_MANAGEMENT_TRUST() {
            return trust
          },
        },
        () => now
      ),
    })
  }

  async function bindingFor(name: string) {
    const binding = await typesModule.managementCallBinding({
      input: { name },
      operation: 'project.update',
      targetId: projectId,
      workspaceId,
    })
    if (!binding) throw new Error('unreachable')
    return binding
  }

  test('the production composition executes and audits one authorized update', async () => {
    const binding = await bindingFor('Composed rename')
    const decisionId = `decision-${crypto.randomUUID()}`
    const token = await signedDecision(binding, decisionId)
    cpSeen.length = 0
    cpMode = 'ok'
    const response = await scopeModule.withRequestScope(() =>
      handler()(requestFor({ name: 'Composed rename' }, binding, token))
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { value: unknown }
    const project = await dbModule.getProjectForUser(
      connection.db,
      workspaceId,
      projectId,
      principal
    )
    expect(project?.name).toBe('Composed rename')
    expect(cpSeen).toEqual([
      { boundary: 'admission', request: CANONICAL_REQUEST },
      { boundary: 'effect', request: CANONICAL_REQUEST },
    ])
    // Result authorization: the durable claim retains the digest of exactly
    // the value the authorized caller received.
    const retained = await dbModule.claimManagementAuthorityDecision(connection.db, {
      actionDigest: binding.actionDigest,
      authorityRef: `credential-${decisionId}`,
      authorityRevision: 7,
      decisionId,
      inputDigest: binding.inputDigest,
      operation: binding.operation,
      targetDigest: binding.targetDigest,
      targetId: binding.targetId,
      workspaceId,
    })
    expect(retained.state).toBe('replayed')
    expect(retained.resultDigest).toBe(await typesModule.managementInputDigest(body.value))
  })

  test('a replayed decision is refused by the durable claim with no second effect', async () => {
    const binding = await bindingFor('Composed rename')
    const decisionId = `decision-${crypto.randomUUID()}`
    const token = await signedDecision(binding, decisionId)
    cpSeen.length = 0
    cpMode = 'ok'
    const first = await scopeModule.withRequestScope(() =>
      handler()(requestFor({ name: 'Composed rename' }, binding, token))
    )
    expect(first.status).toBe(200)
    const afterFirst = cpSeen.length
    const replay = await scopeModule.withRequestScope(() =>
      handler()(requestFor({ name: 'Composed rename' }, binding, token))
    )
    expect(replay.status).toBe(403)
    expect(await replay.json()).toMatchObject({ reason: 'authority_replay' })
    // The replay never reaches the effect boundary.
    expect(cpSeen.slice(afterFirst)).toEqual([
      { boundary: 'admission', request: CANONICAL_REQUEST },
    ])
  })

  test('revocation refuses a fresh decision with zero effect and no burned claim', async () => {
    const binding = await bindingFor('Composed denied')
    const decisionId = `decision-${crypto.randomUUID()}`
    const token = await signedDecision(binding, decisionId)
    const before = cpSeen.length
    cpMode = 'revoked'
    const denied = await scopeModule.withRequestScope(() =>
      handler()(requestFor({ name: 'Composed denied' }, binding, token))
    )
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ reason: 'authority_unavailable' })
    const project = await dbModule.getProjectForUser(
      connection.db,
      workspaceId,
      projectId,
      principal
    )
    expect(project?.name).toBe('Composed rename')
    expect(cpSeen.slice(before)).toEqual([{ boundary: 'admission', request: CANONICAL_REQUEST }])
    // The admission assertion precedes the claim, so no row was burned: a
    // later claim of the same decision id still starts fresh.
    const probe = await dbModule.claimManagementAuthorityDecision(connection.db, {
      actionDigest: binding.actionDigest,
      authorityRef: `credential-${decisionId}`,
      authorityRevision: 7,
      decisionId,
      inputDigest: binding.inputDigest,
      operation: binding.operation,
      targetDigest: binding.targetDigest,
      targetId: binding.targetId,
      workspaceId,
    })
    expect(probe).toEqual({ state: 'claimed' })
    cpMode = 'ok'
  })

  test('an interrupted durable claim refuses with recovery_required and zero effects', async () => {
    const binding = await bindingFor('Composed recovery')
    const decisionId = `decision-${crypto.randomUUID()}`
    const token = await signedDecision(binding, decisionId)
    // A crashed worker leaves the exact-call claim `claimed`; the next
    // delivery must refuse and never execute a second effect.
    await dbModule.claimManagementAuthorityDecision(connection.db, {
      actionDigest: binding.actionDigest,
      authorityRef: `credential-${decisionId}`,
      authorityRevision: 7,
      decisionId,
      inputDigest: binding.inputDigest,
      operation: binding.operation,
      targetDigest: binding.targetDigest,
      targetId: binding.targetId,
      workspaceId,
    })
    const before = cpSeen.length
    cpMode = 'ok'
    const response = await scopeModule.withRequestScope(() =>
      handler()(requestFor({ name: 'Composed recovery' }, binding, token))
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ reason: 'authority_recovery_required' })
    expect(cpSeen.slice(before)).toEqual([{ boundary: 'admission', request: CANONICAL_REQUEST }])
    const project = await dbModule.getProjectForUser(
      connection.db,
      workspaceId,
      projectId,
      principal
    )
    expect(project?.name).toBe('Composed rename')
  })

  test('a signed exact-call promotion reaches the real promotion executor', async () => {
    const created = await dbModule.createProject(connection.db, workspaceId, principal, {
      iconKey: 'box',
      name: 'Composed promotion',
    })
    await dbModule.archiveProject(connection.db, workspaceId, created.id, principal)
    const archived = await dbModule.getProjectForUser(
      connection.db,
      workspaceId,
      created.id,
      principal,
      { includeArchived: true }
    )
    if (!archived) throw new Error('unreachable')
    const exact = { confirmed: true, expectedVersion: archived.version }
    const binding = await typesModule.managementCallBinding({
      input: exact,
      operation: 'project.promote',
      targetId: created.id,
      workspaceId,
    })
    if (!binding) throw new Error('unreachable')
    cpSeen.length = 0
    cpMode = 'ok'

    // Signed but non-executing shapes: missing/false confirmation, invalid
    // revision, extra fields and a decision bound to another revision. None
    // may reach the executor or change the archived project.
    const refused = [
      {
        body: { expectedVersion: archived.version },
        signed: { expectedVersion: archived.version },
        status: 404,
      },
      {
        body: { confirmed: false, expectedVersion: archived.version },
        signed: { confirmed: false, expectedVersion: archived.version },
        status: 404,
      },
      {
        body: { confirmed: true, expectedVersion: 0 },
        signed: { confirmed: true, expectedVersion: 0 },
        status: 404,
      },
      {
        body: { confirmed: true, expectedVersion: archived.version, extra: true },
        signed: { confirmed: true, expectedVersion: archived.version, extra: true },
        status: 404,
      },
      {
        body: exact,
        signed: { confirmed: true, expectedVersion: archived.version + 1 },
        status: 403,
      },
    ] as const
    for (const entry of refused) {
      const signedBinding = await typesModule.managementCallBinding({
        input: entry.signed,
        operation: 'project.promote',
        targetId: created.id,
        workspaceId,
      })
      if (!signedBinding) throw new Error('unreachable')
      const token = await signedDecision(signedBinding, `decision-${crypto.randomUUID()}`)
      const response = await scopeModule.withRequestScope(() =>
        handler()(requestFor(entry.body, signedBinding, token))
      )
      expect(response.status).toBe(entry.status)
      const unchanged = await dbModule.getProjectForUser(
        connection.db,
        workspaceId,
        created.id,
        principal,
        { includeArchived: true }
      )
      expect(unchanged?.lifecycleState).toBe('archived')
    }
    expect(cpSeen).toEqual([])

    const token = await signedDecision(binding, `decision-${crypto.randomUUID()}`)
    const response = await scopeModule.withRequestScope(() =>
      handler()(requestFor(exact, binding, token))
    )
    expect(response.status).toBe(200)
    const promoted = await dbModule.getProjectForUser(
      connection.db,
      workspaceId,
      created.id,
      principal
    )
    expect(promoted?.lifecycleState).toBe('active')
    expect(cpSeen).toEqual([
      { boundary: 'admission', request: CANONICAL_REQUEST },
      { boundary: 'effect', request: CANONICAL_REQUEST },
    ])
  })
})
