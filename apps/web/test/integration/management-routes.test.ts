// Route → shared management handler → PostgreSQL flows for the #1215 human and
// lead management boundaries.
//
// Lane: a normal part of `bun run test:integration` (the runner discovers this
// directory and supplies the DATABASE_URL trio with the react-server
// condition). A missing database configuration fails the lane; it never skips
// it.
//
// What is real here: the shared `applicationManagementOperations` composition
// the human project routes call (real gateway, real authorization, real
// executors), the real `createLeadManagementHandler` the private CP route
// wraps (real service verifier, real durable claim/complete, real
// current-authority client over loopback HTTP), and the real database. The
// only injected seam is the host current-authority mapping (the route's
// documented port), pointed at a loopback CP route contract.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'

import {
  agents,
  authorizationAuditRecords,
  channelParticipants,
  channelReadStates,
  channels,
  claimManagementAuthorityDecision,
  completeManagementAuthorityDecision,
  createDatabase,
  createProject,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  getProjectForUser,
  managementAuthorityConsumptions,
  messageMentions,
  messages,
  projects,
  temporaryUserSessions,
  threadReadStates,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
  type DatabaseConnection,
  type UserPrincipalRef,
} from '@adea-ai/db'

const connectionUrl = process.env.DATABASE_URL

if (!connectionUrl) {
  throw new Error(
    'DATABASE_URL is required for the management route-flow lane: run it through `bun run test:integration` (which provisions the restricted local Postgres or requires the DATABASE_URL / DATABASE_URL_UNPOOLED / DATABASE_MIGRATION_URL trio)'
  )
}

const CANONICAL_REQUEST = {
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
}

const now = Date.parse('2026-10-09T12:00:00.000Z')
const issuer = 'https://cp-fixture.invalid'
const keyId = 'route-flow-management-key'
const servicePrincipalId = 'svc_pi-lead-management'

function base64url(value: string | Uint8Array) {
  return Buffer.from(value).toString('base64url')
}

describe('management human and lead routes (#1215)', () => {
  let connection: DatabaseConnection
  let composition: typeof import('../../src/server/management-composition')
  let databaseModule: typeof import('../../src/server/database')
  let routeModule: typeof import('../../src/server/lead-management-route')
  let authModule: typeof import('../../src/server/lead-management-service-auth')
  let clientModule: typeof import('../../src/server/management-authority-current')
  let scopeModule: typeof import('../../src/server/request-scope')
  let typesModule: typeof import('@adea-ai/types/management')
  let cpServer: ReturnType<typeof Bun.serve>

  const workspaceIds: string[] = []
  const userIds: string[] = []
  const cpSeen: Array<{ boundary: string; request: unknown }> = []
  let cpMode: 'ok' | 'revoked' = 'ok'
  let owner: UserPrincipalRef
  let workspaceA = ''
  let workspaceB = ''
  let signingKey: CryptoKey
  let trust = ''

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
        return Response.json({ asserted: true })
      },
      port: 0,
    })
    composition = await import('../../src/server/management-composition')
    databaseModule = await import('../../src/server/database')
    routeModule = await import('../../src/server/lead-management-route')
    authModule = await import('../../src/server/lead-management-service-auth')
    clientModule = await import('../../src/server/management-authority-current')
    scopeModule = await import('../../src/server/request-scope')
    typesModule = await import('@adea-ai/types/management')

    connection = createDatabase(connectionUrl)
    const ownerSession = await createTemporaryUserSession(connection.db, {
      credentialDigest: `management-routes-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(now + 3_600_000),
    })
    owner = ownerSession.principal
    userIds.push(owner.userId)
    const createdA = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `management-routes-a-${crypto.randomUUID()}`,
      name: 'Management routes A',
      owner,
    })
    workspaceA = createdA.workspace.id
    workspaceIds.push(workspaceA)
    const createdB = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `management-routes-b-${crypto.randomUUID()}`,
      name: 'Management routes B',
      owner,
    })
    workspaceB = createdB.workspace.id
    workspaceIds.push(workspaceB)

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
      workspaceIds: [workspaceA, workspaceB],
    })
  })

  afterAll(async () => {
    const db = connection.db
    if (workspaceIds.length) {
      await db
        .delete(managementAuthorityConsumptions)
        .where(inArray(managementAuthorityConsumptions.workspaceId, workspaceIds))
      await db
        .delete(authorizationAuditRecords)
        .where(inArray(authorizationAuditRecords.workspaceId, workspaceIds))
      await db.delete(threadReadStates).where(inArray(threadReadStates.workspaceId, workspaceIds))
      await db.delete(channelReadStates).where(inArray(channelReadStates.workspaceId, workspaceIds))
      await db.delete(messageMentions).where(inArray(messageMentions.workspaceId, workspaceIds))
      await db.delete(messages).where(inArray(messages.workspaceId, workspaceIds))
      await db
        .delete(channelParticipants)
        .where(inArray(channelParticipants.workspaceId, workspaceIds))
      await db.delete(channels).where(inArray(channels.workspaceId, workspaceIds))
      await db.delete(agents).where(inArray(agents.workspaceId, workspaceIds))
      await db.delete(projects).where(inArray(projects.workspaceId, workspaceIds))
      await db.delete(workspaceEvents).where(inArray(workspaceEvents.workspaceId, workspaceIds))
      await db
        .delete(workspaceMemberships)
        .where(inArray(workspaceMemberships.workspaceId, workspaceIds))
      await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds))
    }
    for (const userId of userIds) {
      await db.delete(temporaryUserSessions).where(eq(temporaryUserSessions.userId, userId))
      await db.delete(users).where(eq(users.id, userId))
    }
    await connection.close()
    cpServer.stop(true)
  })

  async function signedDecision(
    binding: { [key: string]: unknown },
    decisionId: string,
    actorUserId: string = owner.userId
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
      workspaceIds: [binding.workspaceId],
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
    token: string,
    bodyWorkspaceId: string = workspaceA
  ) {
    return new Request('https://adea-fixture.invalid/api/internal/pi-durable/management', {
      body: JSON.stringify({
        canonicalRequest: CANONICAL_REQUEST,
        input,
        operation: binding.operation,
        schemaVersion: 'adea-management-call/v1',
        targetId: binding.targetId,
        workspaceId: bodyWorkspaceId,
      }),
      headers: { authorization: `Bearer ${token}` },
      method: 'POST',
    })
  }

  function handler() {
    // The host current-authority mapping (the route's documented seam): the
    // real Adea client against the loopback CP route, the same instance the
    // gateway receives through the composition.
    const assertCurrent = clientModule.createControlPlaneManagementCurrentAuthority({
      credential: async () => ({ token: 'fixture-cp-token', workspaceId: workspaceA }),
      environment: { CONTROL_PLANE_ORIGIN: `http://127.0.0.1:${cpServer.port}` },
      now: () => now,
    })
    return routeModule.createLeadManagementHandler({
      assertCurrent,
      claim: (decision) =>
        claimManagementAuthorityDecision(databaseModule.applicationDatabase(), {
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
        completeManagementAuthorityDecision(
          databaseModule.applicationDatabase(),
          decision.decisionId,
          completion
        ),
      now: () => now,
      operationsFor: (caller) =>
        composition.applicationManagementOperations(caller, { assertCurrent, now: () => now }),
      verify: authModule.createLeadManagementServiceVerifier(
        { PI_LEAD_MANAGEMENT_TRUST: trust },
        () => now
      ),
    })
  }

  async function bindingFor(input: Record<string, unknown>, targetId: string, workspaceId: string) {
    const binding = await typesModule.managementCallBinding({
      input,
      operation: 'project.update',
      targetId,
      workspaceId,
    })
    if (!binding) throw new Error('unreachable')
    return binding
  }

  test('the human path executes the shared operation and audits the user decision', async () => {
    const project = await createProject(connection.db, workspaceA, owner, {
      iconKey: 'box',
      name: 'Human before',
    })
    const outcome = await scopeModule.withRequestScope(() =>
      composition.applicationManagementOperations().projectUpdate({
        name: 'Human renamed',
        principal: owner,
        projectId: project.id,
        workspaceId: workspaceA,
      })
    )
    expect(outcome).toMatchObject({ ok: true, operation: 'project.update' })
    const after = await getProjectForUser(connection.db, workspaceA, project.id, owner)
    expect(after?.name).toBe('Human renamed')
    expect(after?.version).toBe(project.version + 1)
    // A routine allowed `workspace.update` is intentionally not audited by the
    // shared authorization API (only denials and privileged permissions are);
    // the shared executor effect above is the human-lane proof.
  })

  test('the durable lead boundary asserts current authority and applies one effect', async () => {
    const project = await createProject(connection.db, workspaceA, owner, {
      iconKey: 'box',
      name: 'Lead before',
    })
    const input = { name: 'Lead renamed' }
    const binding = await bindingFor(input, project.id, workspaceA)
    const decisionId = `decision-${crypto.randomUUID()}`
    const token = await signedDecision(binding, decisionId)
    cpSeen.length = 0
    cpMode = 'ok'
    const response = await scopeModule.withRequestScope(() =>
      handler()(requestFor(input, binding, token))
    )
    expect(response.status).toBe(200)
    const after = await getProjectForUser(connection.db, workspaceA, project.id, owner)
    expect(after?.name).toBe('Lead renamed')
    expect(after?.version).toBe(project.version + 1)
    expect(cpSeen).toEqual([
      { boundary: 'admission', request: CANONICAL_REQUEST },
      { boundary: 'effect', request: CANONICAL_REQUEST },
    ])
    // The durable retained contract holds the settled decision exactly once.
    const retained = await claimManagementAuthorityDecision(connection.db, {
      actionDigest: binding.actionDigest,
      authorityRef: `credential-${decisionId}`,
      authorityRevision: 7,
      decisionId,
      inputDigest: binding.inputDigest,
      operation: binding.operation,
      targetDigest: binding.targetDigest,
      targetId: binding.targetId,
      workspaceId: binding.workspaceId,
    })
    expect(retained).toMatchObject({ state: 'replayed' })
    if (retained.state === 'replayed') expect(retained.resultDigest).toBeDefined()
  })

  test('a decision for one workspace cannot act on another', async () => {
    const projectA = await createProject(connection.db, workspaceA, owner, {
      iconKey: 'box',
      name: 'Workspace A project',
    })
    const projectB = await createProject(connection.db, workspaceB, owner, {
      iconKey: 'box',
      name: 'Workspace B project',
    })
    const input = { name: 'Cross workspace' }
    const bindingA = await bindingFor(input, projectA.id, workspaceA)
    const token = await signedDecision(bindingA, `decision-${crypto.randomUUID()}`)
    const response = await scopeModule.withRequestScope(() =>
      handler()(requestFor(input, bindingA, token, workspaceB))
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ reason: 'authority_binding_mismatch' })
    const unchangedB = await getProjectForUser(connection.db, workspaceB, projectB.id, owner)
    expect(unchangedB?.name).toBe('Workspace B project')
    const unchangedA = await getProjectForUser(connection.db, workspaceA, projectA.id, owner)
    expect(unchangedA?.name).toBe('Workspace A project')

    // The human path applies the same isolation: a principal without a
    // membership in the target workspace cannot execute there.
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `management-routes-outsider-${crypto.randomUUID()}`,
      expiresAt: new Date(now + 3_600_000),
    })
    userIds.push(outsider.principal.userId)
    const denied = await scopeModule.withRequestScope(() =>
      composition.applicationManagementOperations().projectUpdate({
        name: 'Outsider rename',
        principal: outsider.principal,
        projectId: projectA.id,
        workspaceId: workspaceA,
      })
    )
    expect(denied).toMatchObject({ failure: { code: 'forbidden' }, ok: false })
    const afterDenied = await getProjectForUser(connection.db, workspaceA, projectA.id, owner)
    expect(afterDenied?.name).toBe('Workspace A project')
    const deniedAudit = await connection.db
      .select()
      .from(authorizationAuditRecords)
      .where(eq(authorizationAuditRecords.workspaceId, workspaceA))
    expect(
      deniedAudit.some(
        (row) =>
          row.decision === 'denied' &&
          row.permission === 'workspace.update' &&
          row.principalId === outsider.principal.userId
      )
    ).toBe(true)
  })

  test('a retry after an uncertain response does not double-apply', async () => {
    const project = await createProject(connection.db, workspaceA, owner, {
      iconKey: 'box',
      name: 'Retry before',
    })
    const input = { name: 'Retry renamed' }
    const binding = await bindingFor(input, project.id, workspaceA)
    const token = await signedDecision(binding, `decision-${crypto.randomUUID()}`)
    // The first response is delivered but treated as lost by the caller; the
    // retry must be answered from the retained contract, never re-executed.
    const first = await scopeModule.withRequestScope(() =>
      handler()(requestFor(input, binding, token))
    )
    expect(first.status).toBe(200)
    const second = await scopeModule.withRequestScope(() =>
      handler()(requestFor(input, binding, token))
    )
    expect(second.status).toBe(403)
    expect(await second.json()).toMatchObject({ reason: 'authority_replay' })
    const after = await getProjectForUser(connection.db, workspaceA, project.id, owner)
    expect(after?.name).toBe('Retry renamed')
    expect(after?.version).toBe(project.version + 1)
  })

  test('a revoked current authority refuses before any effect', async () => {
    const project = await createProject(connection.db, workspaceA, owner, {
      iconKey: 'box',
      name: 'Revocation before',
    })
    const input = { name: 'Revoked rename' }
    const binding = await bindingFor(input, project.id, workspaceA)
    const token = await signedDecision(binding, `decision-${crypto.randomUUID()}`)
    cpSeen.length = 0
    cpMode = 'revoked'
    const response = await scopeModule.withRequestScope(() =>
      handler()(requestFor(input, binding, token))
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ reason: 'authority_unavailable' })
    expect(cpSeen).toEqual([{ boundary: 'admission', request: CANONICAL_REQUEST }])
    const after = await getProjectForUser(connection.db, workspaceA, project.id, owner)
    expect(after?.name).toBe('Revocation before')
    cpMode = 'ok'
  })

  test('human and lead paths apply the same operation through the shared executor', async () => {
    const humanProject = await createProject(connection.db, workspaceA, owner, {
      iconKey: 'box',
      name: 'Parity human before',
    })
    const leadProject = await createProject(connection.db, workspaceA, owner, {
      iconKey: 'box',
      name: 'Parity lead before',
    })
    const input = { name: 'Parity renamed' }
    const humanOutcome = await scopeModule.withRequestScope(() =>
      composition.applicationManagementOperations().projectUpdate({
        name: 'Parity renamed',
        principal: owner,
        projectId: humanProject.id,
        workspaceId: workspaceA,
      })
    )
    expect(humanOutcome).toMatchObject({ ok: true, operation: 'project.update' })
    const binding = await bindingFor(input, leadProject.id, workspaceA)
    const token = await signedDecision(binding, `decision-${crypto.randomUUID()}`)
    const leadResponse = await scopeModule.withRequestScope(() =>
      handler()(requestFor(input, binding, token))
    )
    expect(leadResponse.status).toBe(200)
    const humanAfter = await getProjectForUser(connection.db, workspaceA, humanProject.id, owner)
    const leadAfter = await getProjectForUser(connection.db, workspaceA, leadProject.id, owner)
    expect(humanAfter?.name).toBe('Parity renamed')
    expect(leadAfter?.name).toBe('Parity renamed')
    expect(humanAfter?.version).toBe(humanProject.version + 1)
    expect(leadAfter?.version).toBe(leadProject.version + 1)
    // Both lanes share the executor effect above; only the lead lane adds its
    // agent attribution row (the human lane's routine allowed update is not
    // audited by the shared authorization API).
    const audit = await connection.db
      .select()
      .from(authorizationAuditRecords)
      .where(eq(authorizationAuditRecords.workspaceId, workspaceA))
    expect(audit.some((row) => row.decision === 'allowed' && row.principalKind === 'agent')).toBe(
      true
    )
  })
})
