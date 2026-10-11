import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'

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
  body: { input: unknown; targetId: string | null; workspaceId: string },
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
  let effectBarrier: (() => Promise<void>) | undefined
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
        if (body.parameters?.boundary === 'effect') await effectBarrier?.()
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

  const fencedOperations = [
    'project.create',
    'project.update',
    'project.archive',
    'project.delete',
    'project.promote',
    'project.reorder',
    'project.visibility.set',
    'project.member.set',
    'project.member.remove',
    'config.workspace.update',
    'config.workspace.reopen',
  ] as const

  test('the transaction proofs cover every supported cloud lead management operation', () => {
    expect(
      Object.entries(typesModule.managementOperations)
        .filter(
          ([, definition]) =>
            definition.surface === 'cloud' && definition.lanes.lead === 'supported'
        )
        .map(([operation]) => operation)
        .toSorted()
    ).toEqual([...fencedOperations].toSorted())
  })

  async function effectFixture(operation: (typeof fencedOperations)[number]) {
    const { workspace } = await dbModule.createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `fenced-${crypto.randomUUID()}`,
      name: 'Fenced workspace',
      owner: owner.principal,
    })
    const actor = operation === 'config.workspace.reopen' ? owner.principal : otherOwner.principal
    if (actor !== owner.principal)
      await dbModule.addWorkspaceMembership(connection.db, workspace.id, actor, 'admin')
    const [mapping] = await connection.db
      .select({ id: dbModule.workspaces.controlPlaneWorkspaceId })
      .from(dbModule.workspaces)
      .where(eq(dbModule.workspaces.id, workspace.id))
    liveControlPlaneWorkspaces.add(mapping!.id)
    leadTrustWorkspaces.push(workspace.id)
    let project = await dbModule.createProject(connection.db, workspace.id, owner.principal, {
      iconKey: 'box',
      name: 'Before fenced operation',
    })
    let targetId: string | null = project.id
    let input: Record<string, unknown> = {}
    switch (operation) {
      case 'project.create':
        targetId = null
        input = { iconKey: 'box', name: 'Fenced create' }
        break
      case 'project.update':
        input = { name: 'Fenced update' }
        break
      case 'project.promote':
        await dbModule.archiveProject(connection.db, workspace.id, project.id, owner.principal)
        project = (await dbModule.getProjectForUser(
          connection.db,
          workspace.id,
          project.id,
          owner.principal,
          { includeArchived: true }
        ))!
        input = { confirmed: true, expectedVersion: project.version }
        break
      case 'project.reorder':
        targetId = null
        input = { projectIds: [project.id] }
        break
      case 'project.visibility.set':
        input = { visibility: 'members' }
        break
      case 'project.member.set':
        targetId = owner.principal.userId
        input = { projectId: project.id, role: 'editor' }
        break
      case 'project.member.remove':
        await dbModule.setProjectMember(connection.db, workspace.id, project.id, owner.principal, {
          userId: owner.principal.userId,
          role: 'viewer',
        })
        targetId = owner.principal.userId
        input = { projectId: project.id }
        break
      case 'config.workspace.update':
        targetId = workspace.id
        input = { expectedVersion: workspace.version, name: 'Fenced workspace update' }
        break
      case 'config.workspace.reopen':
        // The production CP scope mapper refuses archived workspaces before
        // admission. Exercise lead reopen on an active workspace (idempotent);
        // archived human reopen is covered separately below.
        targetId = workspace.id
        break
      case 'project.archive':
      case 'project.delete':
        break
    }
    const binding = await typesModule.managementCallBinding({
      input,
      operation,
      targetId,
      workspaceId: workspace.id,
    })
    if (!binding) throw new Error('Fixture binding unavailable')
    const token = await signedDecision(binding, `decision-${crypto.randomUUID()}`, actor.userId)
    return { actor, input, operation, targetId, token, workspaceId: workspace.id }
  }

  async function effectSnapshot(workspaceId: string) {
    return Promise.all([
      connection.db
        .select()
        .from(dbModule.workspaces)
        .where(eq(dbModule.workspaces.id, workspaceId)),
      connection.db
        .select()
        .from(dbModule.projects)
        .where(eq(dbModule.projects.workspaceId, workspaceId)),
      connection.db
        .select()
        .from(dbModule.projectMembers)
        .where(eq(dbModule.projectMembers.workspaceId, workspaceId)),
      connection.db
        .select()
        .from(dbModule.workspaceEvents)
        .where(eq(dbModule.workspaceEvents.workspaceId, workspaceId)),
    ])
  }

  test('human archived reopen retains its owner-only semantics under the transaction fence', async () => {
    const f = await effectFixture('config.workspace.reopen')
    await dbModule.archiveWorkspace(connection.db, f.workspaceId, owner.principal)
    const before = await effectSnapshot(f.workspaceId)
    await dbModule.addWorkspaceMembership(
      connection.db,
      f.workspaceId,
      otherOwner.principal,
      'admin'
    )
    const admin = await scopeModule.withRequestScope(() =>
      composition.applicationManagementOperations().workspaceReopen({
        principal: otherOwner.principal,
        workspaceId: f.workspaceId,
      })
    )
    expect(admin.ok).toBe(false)
    expect(await effectSnapshot(f.workspaceId)).toEqual(before)
    const reopened = await scopeModule.withRequestScope(() =>
      composition.applicationManagementOperations().workspaceReopen({
        principal: owner.principal,
        workspaceId: f.workspaceId,
      })
    )
    expect(reopened.ok).toBe(true)
    const after = await effectSnapshot(f.workspaceId)
    expect(after[0]![0]!.deletedAt).toBeNull()
    expect(after[3]!.length).toBe(before[3]!.length + 1)
  })

  for (const operation of fencedOperations) {
    // Owner membership removal is prohibited by its canonical revocation API;
    // reopen is owner-only. Its downgrade still exercises the permission fence.
    const changes =
      operation === 'config.workspace.reopen'
        ? (['downgrade'] as const)
        : (['remove', 'downgrade'] as const)
    for (const change of changes) {
      test(`${operation}: ${change} committed during the production CP effect await prevents its mutation/event`, async () => {
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        let pending: Promise<Response> | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          // A separately bound allowed call proves the fixture can perform the
          // actual operation, so refusal cannot pass due to malformed/stale input.
          const allowed = await effectFixture(operation)
          const beforeAllowed = await effectSnapshot(allowed.workspaceId)
          const applied = await scopeModule.withRequestScope(() =>
            handler()(requestFor(allowed, operation, allowed.token))
          )
          expect(applied.status).toBe(200)
          const appliedEvents = (await effectSnapshot(allowed.workspaceId))[3]!.length
          if (operation === 'config.workspace.reopen')
            expect(appliedEvents).toBe(beforeAllowed[3]!.length)
          else expect(appliedEvents).toBeGreaterThan(beforeAllowed[3]!.length)
          const f = await effectFixture(operation)
          const before = await effectSnapshot(f.workspaceId)
          effectBarrier = async () => {
            entered.resolve()
            await release.promise
          }
          hops = []
          pending = scopeModule.withRequestScope(() => handler()(requestFor(f, operation, f.token)))
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error('Call completed before the CP effect barrier')
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('CP effect barrier was not reached')),
                3_000
              )
            }),
          ])
          expect(hops.map((hop) => hop.boundary)).toEqual(['admission', 'effect'])
          if (change === 'remove') {
            expect(
              await dbModule.removeWorkspaceMembership(connection.db, f.workspaceId, f.actor)
            ).toBe(true)
          } else {
            await connection.db
              .update(dbModule.workspaceMemberships)
              .set({ role: 'member' })
              .where(
                and(
                  eq(dbModule.workspaceMemberships.workspaceId, f.workspaceId),
                  eq(dbModule.workspaceMemberships.userId, f.actor.userId)
                )
              )
          }
          expect(
            (
              await dbModule.findWorkspaceMembership(connection.db, f.workspaceId, f.actor, {
                includeArchived: true,
              })
            )?.role ?? null
          ).toBe(change === 'remove' ? null : 'member')
          release.resolve()
          expect((await pending).status).not.toBe(200)
          expect(await effectSnapshot(f.workspaceId)).toEqual(before)
        } finally {
          if (timer !== undefined) clearTimeout(timer)
          effectBarrier = undefined
          release.resolve()
          await pending?.catch(() => undefined)
        }
      })
    }
  }

  for (const change of ['remove', 'downgrade'] as const) {
    test(`the production executor holds ${change} until its mutation/event commit`, async () => {
      const release = Promise.withResolvers<void>()
      const locked = Promise.withResolvers<number>()
      let blocker: Promise<void> | undefined
      let pending: Promise<Response> | undefined
      let revocation: Promise<unknown> | undefined
      let revoker: import('@adea-ai/db').DatabaseConnection | undefined
      try {
        const f = await effectFixture('project.update')
        const before = await effectSnapshot(f.workspaceId)
        blocker = connection.db.transaction(async (transaction) => {
          await transaction
            .select({ id: dbModule.projects.id })
            .from(dbModule.projects)
            .where(eq(dbModule.projects.id, f.targetId!))
            .for('update')
          const [row] = await transaction.execute(sql`select pg_backend_pid() as pid`)
          locked.resolve(Number(row!.pid))
          await release.promise
        })
        void blocker.catch(() => undefined)
        const blockerPid = await Promise.race([
          locked.promise,
          blocker.then(() => {
            throw new Error('Row blocker ended early')
          }),
        ])
        pending = scopeModule.withRequestScope(() => handler()(requestFor(f, f.operation, f.token)))
        void pending.catch(() => undefined)
        async function blockedPid(pattern: string, ownerPid: number, applicationName?: string) {
          const deadline = Date.now() + 3_000
          while (Date.now() < deadline) {
            const rows = await connection.db.execute(sql`
              select a.pid from pg_stat_activity a where a.datname = current_database()
                and a.wait_event_type = 'Lock' and a.query ilike ${pattern}
                and (${applicationName ?? null}::text is null or a.application_name = ${applicationName ?? null})
                and pg_blocking_pids(a.pid) @> array[${ownerPid}]::int[]
            `)
            if (rows[0]) return Number(rows[0].pid)
            await Bun.sleep(10)
          }
          throw new Error(`Expected PostgreSQL lock wait for ${pattern}`)
        }
        // The real executor has passed permission acquisition and is now
        // blocked inside its savepoint, immediately before the project write.
        const mutationPid = await blockedPid('%update%projects%', blockerPid)
        const label = `production-revocation-${crypto.randomUUID()}`
        const url = new URL(connectionUrl!)
        url.searchParams.set('application_name', label)
        revoker = dbModule.createDatabase(url.toString())
        revocation =
          change === 'remove'
            ? dbModule.removeWorkspaceMembership(revoker.db, f.workspaceId, f.actor)
            : revoker.db
                .update(dbModule.workspaceMemberships)
                .set({ role: 'member' })
                .where(
                  and(
                    eq(dbModule.workspaceMemberships.workspaceId, f.workspaceId),
                    eq(dbModule.workspaceMemberships.userId, f.actor.userId)
                  )
                )
        // Drizzle queries are lazy: normalize the update to a running promise.
        revocation = Promise.resolve(revocation)
        void revocation.catch(() => undefined)
        expect(await blockedPid('%workspace_memberships%', mutationPid, label)).toBeGreaterThan(0)
        expect(
          (await dbModule.findWorkspaceMembership(connection.db, f.workspaceId, f.actor))?.role
        ).toBe('admin')
        expect(await effectSnapshot(f.workspaceId)).toEqual(before)
        release.resolve()
        await blocker
        expect((await pending).status).toBe(200)
        await revocation
        expect(
          (await dbModule.findWorkspaceMembership(connection.db, f.workspaceId, f.actor))?.role ??
            null
        ).toBe(change === 'remove' ? null : 'member')
        const after = await effectSnapshot(f.workspaceId)
        expect(after[1]![0]!.name).toBe('Fenced update')
        expect(after[3]!.length).toBe(before[3]!.length + 1)
      } finally {
        release.resolve()
        await blocker?.catch(() => undefined)
        await pending?.catch(() => undefined)
        await revocation?.catch(() => undefined)
        await revoker?.close()
      }
    })
  }
})
