import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ManagementAuthorityError } from '@adea-ai/types/management'

/**
 * Production-composed host proof (#1215). Uses the real
 * `applicationManagementOperations` composition, the real signed-decision
 * verifier, the real durable claim functions and the real database executors —
 * no injected fake operations. It runs only with an isolated DATABASE_URL and
 * the react-server condition so the server-only composition loads:
 *
 *   DATABASE_URL=... bun test --conditions=react-server \
 *     apps/web/test/management-production-composition.test.ts
 */
const connectionUrl = process.env.DATABASE_URL

let mode: 'ok' | 'revoked' = 'ok'
const boundaries: string[] = []

function base64url(value: string | Uint8Array) {
  return Buffer.from(value).toString('base64url')
}

const current = async (_request: unknown, boundary: string): Promise<void> => {
  boundaries.push(boundary)
  if (mode === 'revoked') throw new ManagementAuthorityError('authority_unavailable')
}

describe.skipIf(!connectionUrl)('production-composed lead management route (#1215)', () => {
  let authModule: typeof import('../src/server/lead-management-service-auth')
  let composition: typeof import('../src/server/management-composition')
  let dbModule: typeof import('@adea-ai/db')
  let routeModule: typeof import('../src/server/lead-management-route')
  let scopeModule: typeof import('../src/server/request-scope')
  let typesModule: typeof import('@adea-ai/types/management')
  let connection: import('@adea-ai/db').DatabaseConnection

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

  function requestFor(input: { name: string }, binding: { [key: string]: unknown }, token: string) {
    return new Request('https://adea-fixture.invalid/api/internal/pi-durable/management', {
      body: JSON.stringify({
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
    authModule = await import('../src/server/lead-management-service-auth')
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
    await connection?.close()
  })

  function handler() {
    return routeModule.createLeadManagementHandler({
      assertCurrent: current,
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
      // The real production composition; the same current-owner instance flows
      // into createManagementGateway through the composition, not a bypass.
      operationsFor: (caller) =>
        composition.applicationManagementOperations(caller, {
          assertCurrent: current,
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
    const response = await scopeModule.withRequestScope(() =>
      handler()(requestFor({ name: 'Composed rename' }, binding, token))
    )
    expect(response.status).toBe(200)
    const project = await dbModule.getProjectForUser(
      connection.db,
      workspaceId,
      projectId,
      principal
    )
    expect(project?.name).toBe('Composed rename')
    expect(boundaries).toEqual(['admission', 'effect'])
  })

  test('a replayed decision is refused by the durable claim with no second effect', async () => {
    const binding = await bindingFor('Composed rename')
    const decisionId = `decision-${crypto.randomUUID()}`
    const token = await signedDecision(binding, decisionId)
    const first = await scopeModule.withRequestScope(() =>
      handler()(requestFor({ name: 'Composed rename' }, binding, token))
    )
    expect(first.status).toBe(200)
    const afterFirst = boundaries.length
    mode = 'ok'
    const replay = await scopeModule.withRequestScope(() =>
      handler()(requestFor({ name: 'Composed rename' }, binding, token))
    )
    expect(replay.status).toBe(403)
    expect(await replay.json()).toMatchObject({ reason: 'authority_replay' })
    // The replay never reaches the effect boundary.
    expect(boundaries.slice(afterFirst)).toEqual(['admission'])
  })

  test('revocation refuses a fresh decision with zero effect and no burned claim', async () => {
    const binding = await bindingFor('Composed denied')
    const decisionId = `decision-${crypto.randomUUID()}`
    const token = await signedDecision(binding, decisionId)
    mode = 'revoked'
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
    expect(boundaries.at(-1)).toBe('admission')
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
    mode = 'ok'
  })
})
