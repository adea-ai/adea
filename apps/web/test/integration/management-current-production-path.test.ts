import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

/**
 * Production current-authority path proof (#1215). Unlike the composition
 * proofs, nothing here injects the credential, the scope or the Control Plane
 * origin. `applicationManagementCurrentAuthority()` reads the process
 * environment, mints a real EdDSA service credential with a synthetic signing
 * key, maps each synthetic Adea workspace through the real database, and posts
 * to a loopback stand-in that verifies the minted token the way the Control
 * Plane does (EdDSA signature, issuer, key id, audience and scope). The stand-in
 * decides current authority for its own workspaces; the signed decisions,
 * durable claims and database executors are the real Adea ones.
 *
 * Runs through `bun run test:integration`, which provisions the isolated
 * database; a missing DATABASE_URL fails the lane instead of skipping it.
 */
const connectionUrl = process.env.DATABASE_URL

if (!connectionUrl) {
  throw new Error(
    'DATABASE_URL is required for the production current-authority lane: run it through `bun run test:integration`'
  )
}

const CANONICAL_REQUEST = {
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
}
const ENVIRONMENT_KEYS = [
  'CONTROL_PLANE_ORIGIN',
  'CONTROL_PLANE_SIGNING_ISSUER',
  'CONTROL_PLANE_SIGNING_KEY',
  'CONTROL_PLANE_SIGNING_KEY_ID',
] as const
const CONTROL_PLANE_ISSUER = 'https://adea-fixture.invalid/control-plane'
const SIGNING_KEY_ID = 'adea-web-production-path-synthetic'
const LEAD_ISSUER = 'https://cp-fixture.invalid'
const LEAD_KEY_ID = 'synthetic-production-path-lead-key'
const LEAD_PRINCIPAL_ID = 'svc_pi-lead-management'
const now = Date.parse('2026-10-09T12:00:00.000Z')

type Hop = Readonly<{
  boundary: string
  cpWorkspaceIds: readonly string[]
  scopes: readonly string[]
  verified: boolean
}>

function base64url(value: string | Uint8Array) {
  return Buffer.from(value).toString('base64url')
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>
}

function requestFor(
  body: { input: unknown; targetId: string; workspaceId: string },
  operation: string,
  token: string
) {
  return new Request('https://adea-fixture.invalid/api/internal/pi-durable/management', {
    body: JSON.stringify({
      canonicalRequest: CANONICAL_REQUEST,
      input: body.input,
      operation,
      schemaVersion: 'adea-management-call/v1',
      targetId: body.targetId,
      workspaceId: body.workspaceId,
    }),
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
  })
}

describe('production current-authority path (#1215)', () => {
  let cpServer: ReturnType<typeof Bun.serve>
  let connection: import('@adea-ai/db').DatabaseConnection
  let composition: typeof import('../../src/server/management-composition')
  let dbModule: typeof import('@adea-ai/db')
  let routeModule: typeof import('../../src/server/lead-management-route')
  let authModule: typeof import('../../src/server/lead-management-service-auth')
  let scopeModule: typeof import('../../src/server/request-scope')
  let typesModule: typeof import('@adea-ai/types/management')

  let signingPublicKey: CryptoKey
  let leadPrivateKey: CryptoKey
  let leadPublicJwk: JsonWebKey
  let leadTrustWorkspaces: string[] = []
  let hops: Hop[] = []
  const liveControlPlaneWorkspaces = new Set<string>()
  const savedEnvironment: Record<string, string | undefined> = {}

  let owner: { principal: import('@adea-ai/types').UserPrincipalRef }
  let otherOwner: { principal: import('@adea-ai/types').UserPrincipalRef }
  let workspaceA = ''
  let workspaceB = ''
  let controlPlaneA = ''
  let controlPlaneB = ''
  let projectA = ''
  let projectB = ''

  /** Verifies the minted service JWT exactly as a Control Plane verifier would. */
  async function verifyServiceToken(token: string): Promise<Record<string, unknown> | null> {
    const [header, payload, signature] = token.split('.')
    if (!header || !payload || !signature) return null
    const valid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      signingPublicKey,
      Buffer.from(signature, 'base64url'),
      new TextEncoder().encode(`${header}.${payload}`)
    )
    if (!valid) return null
    const headerClaims = decodeSegment(header)
    const claims = decodeSegment(payload)
    if (
      headerClaims.kid !== SIGNING_KEY_ID ||
      claims.keyId !== SIGNING_KEY_ID ||
      claims.issuer !== CONTROL_PLANE_ISSUER ||
      claims.audience !== 'control-plane'
    )
      return null
    return claims
  }

  function trustDocument() {
    return JSON.stringify({
      issuer: LEAD_ISSUER,
      keyId: LEAD_KEY_ID,
      principalId: LEAD_PRINCIPAL_ID,
      publicJwk: leadPublicJwk,
      revokedCredentialIds: [],
      workspaceIds: leadTrustWorkspaces,
    })
  }

  async function signedDecision(
    binding: { [key: string]: unknown },
    decisionId: string,
    actorUserId: string
  ) {
    const claims = {
      actionDigest: binding.actionDigest,
      actorUserId,
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
      issuer: LEAD_ISSUER,
      keyId: LEAD_KEY_ID,
      leadAgentId: 'agent-lead-1',
      operation: binding.operation,
      planRef: 'plan:fixture',
      planRevision: 3,
      principalId: LEAD_PRINCIPAL_ID,
      projectIds: [] as string[],
      scopes: ['management:execute'],
      targetDigest: binding.targetDigest,
      targetId: binding.targetId,
      workspaceIds: [binding.workspaceId as string],
    }
    const header = base64url(JSON.stringify({ alg: 'EdDSA', kid: LEAD_KEY_ID, typ: 'JWT' }))
    const payload = base64url(JSON.stringify(claims))
    const signature = await crypto.subtle.sign(
      'Ed25519',
      leadPrivateKey,
      new TextEncoder().encode(`${header}.${payload}`)
    )
    return `${header}.${payload}.${base64url(new Uint8Array(signature))}`
  }

  async function bindingFor(workspaceId: string, targetId: string, name: string) {
    const binding = await typesModule.managementCallBinding({
      input: { name },
      operation: 'project.update',
      targetId,
      workspaceId,
    })
    if (!binding) throw new Error('unreachable')
    return binding
  }

  /** The real production current-authority port, reading the process environment. */
  function handler() {
    const assertCurrent = composition.applicationManagementCurrentAuthority()
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
        composition.applicationManagementOperations(caller, { assertCurrent, now: () => now }),
      now: () => now,
      verify: authModule.createLeadManagementServiceVerifier(
        {
          get PI_LEAD_MANAGEMENT_TRUST() {
            return trustDocument()
          },
        },
        () => now
      ),
    })
  }

  async function call(
    workspaceId: string,
    targetId: string,
    name: string,
    actor: { principal: import('@adea-ai/types').UserPrincipalRef } = owner
  ) {
    const binding = await bindingFor(workspaceId, targetId, name)
    const decisionId = `decision-${crypto.randomUUID()}`
    const token = await signedDecision(binding, decisionId, actor.principal.userId)
    return { binding, decisionId, token }
  }

  async function projectName(
    workspaceId: string,
    projectId: string,
    reader: import('@adea-ai/types').UserPrincipalRef = owner.principal
  ) {
    const project = await dbModule.getProjectForUser(connection.db, workspaceId, projectId, reader)
    return project?.name
  }

  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    signingPublicKey = pair.publicKey
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
    const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8)
      .toString('base64')
      .match(/.{1,64}/gu)!
      .join('\n')}\n-----END PRIVATE KEY-----\n`
    const leadPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    leadPrivateKey = leadPair.privateKey
    leadPublicJwk = await crypto.subtle.exportKey('jwk', leadPair.publicKey)

    cpServer = Bun.serve({
      fetch: async (incoming) => {
        const token = (incoming.headers.get('authorization') ?? '').replace(/^Bearer /u, '')
        const body = (await incoming.json()) as { parameters?: { boundary?: unknown } }
        const claims = await verifyServiceToken(token)
        const cpWorkspaceIds = Array.isArray(claims?.workspaceIds)
          ? (claims.workspaceIds as string[])
          : []
        const scopes = Array.isArray(claims?.scopes) ? (claims.scopes as string[]) : []
        hops.push({
          boundary: String(body.parameters?.boundary ?? ''),
          cpWorkspaceIds,
          scopes,
          verified: claims !== null,
        })
        if (!claims || !scopes.includes('execution:read'))
          return Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 })
        if (cpWorkspaceIds.length !== 1 || !liveControlPlaneWorkspaces.has(cpWorkspaceIds[0]!))
          return Response.json({ code: 'PI_MANAGEMENT_CURRENT_UNAVAILABLE' }, { status: 503 })
        return Response.json({ asserted: true })
      },
      port: 0,
    })

    for (const key of ENVIRONMENT_KEYS) savedEnvironment[key] = process.env[key]
    process.env.CONTROL_PLANE_ORIGIN = `http://127.0.0.1:${cpServer.port}`
    process.env.CONTROL_PLANE_SIGNING_ISSUER = CONTROL_PLANE_ISSUER
    process.env.CONTROL_PLANE_SIGNING_KEY = pem
    process.env.CONTROL_PLANE_SIGNING_KEY_ID = SIGNING_KEY_ID

    composition = await import('../../src/server/management-composition')
    dbModule = await import('@adea-ai/db')
    routeModule = await import('../../src/server/lead-management-route')
    authModule = await import('../../src/server/lead-management-service-auth')
    scopeModule = await import('../../src/server/request-scope')
    typesModule = await import('@adea-ai/types/management')

    connection = dbModule.createDatabase(connectionUrl!)
    owner = await dbModule
      .createTemporaryUserSession(connection.db, {
        credentialDigest: `digest-${crypto.randomUUID()}`,
        expiresAt: new Date(now + 3_600_000),
      })
      .then((session) => ({ principal: session.principal }))
    otherOwner = await dbModule
      .createTemporaryUserSession(connection.db, {
        credentialDigest: `digest-${crypto.randomUUID()}`,
        expiresAt: new Date(now + 3_600_000),
      })
      .then((session) => ({ principal: session.principal }))

    const created = await dbModule.createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `production-path-a-${crypto.randomUUID()}`,
      name: 'Production path workspace A',
      owner: owner.principal,
    })
    workspaceA = created.workspace.id
    const createdB = await dbModule.createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `production-path-b-${crypto.randomUUID()}`,
      name: 'Production path workspace B',
      owner: otherOwner.principal,
    })
    workspaceB = createdB.workspace.id
    // The Control Plane identifiers are minted by the real workspace creation;
    // the production scope lookup reads them from the same rows.
    const [rowA] = await connection.db
      .select({ id: dbModule.workspaces.controlPlaneWorkspaceId })
      .from(dbModule.workspaces)
      .where(eq(dbModule.workspaces.id, workspaceA))
    const [rowB] = await connection.db
      .select({ id: dbModule.workspaces.controlPlaneWorkspaceId })
      .from(dbModule.workspaces)
      .where(eq(dbModule.workspaces.id, workspaceB))
    controlPlaneA = rowA!.id
    controlPlaneB = rowB!.id
    liveControlPlaneWorkspaces.add(controlPlaneA)
    liveControlPlaneWorkspaces.add(controlPlaneB)

    projectA = (
      await dbModule.createProject(connection.db, workspaceA, owner.principal, {
        iconKey: 'box',
        name: 'Production path before A',
      })
    ).id
    projectB = (
      await dbModule.createProject(connection.db, workspaceB, otherOwner.principal, {
        iconKey: 'box',
        name: 'Production path before B',
      })
    ).id
    leadTrustWorkspaces = [workspaceA, workspaceB]
  })

  afterAll(async () => {
    for (const key of ENVIRONMENT_KEYS) {
      if (savedEnvironment[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnvironment[key]
    }
    cpServer?.stop(true)
    await connection?.close()
  })

  test('the production path mints a verified credential for the mapped workspace and applies one update', async () => {
    hops = []
    const { binding, token } = await call(workspaceA, projectA, 'Renamed A')
    const response = await scopeModule.withRequestScope(() =>
      handler()(
        requestFor(
          { input: { name: 'Renamed A' }, targetId: projectA, workspaceId: workspaceA },
          binding.operation,
          token
        )
      )
    )
    expect(response.status).toBe(200)
    expect(await projectName(workspaceA, projectA)).toBe('Renamed A')
    expect(hops.map((hop) => hop.boundary)).toEqual(['admission', 'effect'])
    for (const hop of hops) {
      expect(hop.verified).toBe(true)
      expect(hop.cpWorkspaceIds).toEqual([controlPlaneA])
      expect(hop.scopes).toEqual(['execution:read'])
    }
  })

  test('a decision for another workspace is refused before any hop and changes nothing', async () => {
    hops = []
    const foreign = await call(workspaceB, projectB, 'Foreign write', otherOwner)
    // The decision is bound to workspace B, but the caller posts it to A's route.
    const response = await scopeModule.withRequestScope(() =>
      handler()(
        requestFor(
          { input: { name: 'Foreign write' }, targetId: projectA, workspaceId: workspaceA },
          foreign.binding.operation,
          foreign.token
        )
      )
    )
    expect(response.status).not.toBe(200)
    expect(hops).toEqual([])
    expect(await projectName(workspaceA, projectA)).toBe('Renamed A')
    expect(await projectName(workspaceB, projectB, otherOwner.principal)).toBe(
      'Production path before B'
    )
  })

  test('a control-plane denial refuses the call with zero effect and leaves the decision unburned', async () => {
    hops = []
    const { binding, token } = await call(workspaceA, projectA, 'Denied A')
    const request = () =>
      requestFor(
        { input: { name: 'Denied A' }, targetId: projectA, workspaceId: workspaceA },
        binding.operation,
        token
      )
    liveControlPlaneWorkspaces.delete(controlPlaneA)
    try {
      const denied = await scopeModule.withRequestScope(() => handler()(request()))
      expect(denied.status).not.toBe(200)
      expect(await projectName(workspaceA, projectA)).toBe('Renamed A')
      expect(hops.map((hop) => hop.boundary)).toEqual(['admission'])
    } finally {
      liveControlPlaneWorkspaces.add(controlPlaneA)
    }
    // The refusal happened before the durable claim, so the same decision still
    // runs once the Control Plane asserts current authority again.
    const retried = await scopeModule.withRequestScope(() => handler()(request()))
    expect(retried.status).toBe(200)
    expect(await projectName(workspaceA, projectA)).toBe('Denied A')
  })

  test('an unmapped workspace is refused before any hop and changes nothing', async () => {
    hops = []
    const unmapped = crypto.randomUUID()
    leadTrustWorkspaces = [workspaceA, workspaceB, unmapped]
    try {
      const { binding, token } = await call(unmapped, projectA, 'Unmapped write')
      const response = await scopeModule.withRequestScope(() =>
        handler()(
          requestFor(
            { input: { name: 'Unmapped write' }, targetId: projectA, workspaceId: unmapped },
            binding.operation,
            token
          )
        )
      )
      expect(response.status).not.toBe(200)
      expect(hops).toEqual([])
      expect(await projectName(workspaceA, projectA)).toBe('Denied A')
    } finally {
      leadTrustWorkspaces = [workspaceA, workspaceB]
    }
  })

  test('missing Control Plane configuration refuses before any hop and recovers when restored', async () => {
    for (const key of ['CONTROL_PLANE_ORIGIN', 'CONTROL_PLANE_SIGNING_KEY'] as const) {
      hops = []
      const { binding, token } = await call(workspaceA, projectA, `Config ${key}`)
      const request = () =>
        requestFor(
          { input: { name: `Config ${key}` }, targetId: projectA, workspaceId: workspaceA },
          binding.operation,
          token
        )
      const saved = process.env[key]
      delete process.env[key]
      try {
        const refused = await scopeModule.withRequestScope(() => handler()(request()))
        expect(refused.status).not.toBe(200)
        expect(hops).toEqual([])
      } finally {
        if (saved === undefined) delete process.env[key]
        else process.env[key] = saved
      }
      const restored = await scopeModule.withRequestScope(() => handler()(request()))
      expect(restored.status).toBe(200)
      expect(await projectName(workspaceA, projectA)).toBe(`Config ${key}`)
    }
  })
})
