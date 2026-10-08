import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import {
  createDatabase,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  ensureWorkspaceLead,
  createDirectAgentTopic,
  createLeadTurn,
  withCurrentLeadTurnProduct,
  workspaces,
  workspaceMemberships,
} from '@adea-ai/db'
import { createLeadProductReaderHandler } from '../../../../apps/web/src/server/lead-product-reader.ts'
import { createLeadProductServiceVerifier } from '../../../../apps/web/src/server/lead-product-service-auth.ts'

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

if (!process.env.DATABASE_URL) throw new Error('Owned test database required')
const connection = createDatabase(process.env.DATABASE_URL)
try {
  const owner = await createTemporaryUserSession(connection.db, {
    credentialDigest: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
  })
  const { workspace } = await createWorkspaceWithOwner(connection.db, {
    name: 'Signed product-reader proof',
    owner: owner.principal,
    idempotencyKey: crypto.randomUUID(),
  })
  const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
  const topic = await createDirectAgentTopic(
    connection.db,
    workspace.id,
    lead.id,
    owner.principal,
    {
      title: 'Current evidence',
      idempotencyKey: crypto.randomUUID(),
    }
  )
  const admitted = await createLeadTurn(connection.db, workspace.id, topic.id, owner.principal, {
    bodyText: 'Synthetic canonical test question',
    idempotencyKey: crypto.randomUUID(),
  })
  const [mapped] = await connection.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspace.id))
  assert.ok(mapped?.controlPlaneWorkspaceId)
  const mappedWorkspaceId = mapped.controlPlaneWorkspaceId
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const at = Date.now()
  const principalId = 'svc_control-plane'
  const keyId = 'synthetic-proof-key'
  const issuer = 'https://synthetic-proof.invalid'
  const trust = {
    issuer,
    keyId,
    publicJwk,
    principalId,
    workspaceIds: [mappedWorkspaceId],
    revokedCredentialIds: [],
  }
  const environment = { PI_LEAD_PRODUCT_TRUST: JSON.stringify(trust) }
  const claims = {
    audience: 'adea-lead-product',
    credentialId: crypto.randomUUID(),
    credentialKind: 'service',
    issuedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + 60_000).toISOString(),
    issuer,
    keyId,
    principalId,
    workspaceIds: [mappedWorkspaceId],
    projectIds: [],
    scopes: ['execution:read'],
  }
  const unsigned = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: keyId })}.${encode(claims)}`
  const signature = await crypto.subtle.sign(
    'Ed25519',
    pair.privateKey,
    new TextEncoder().encode(unsigned)
  )
  const token = `${unsigned}.${Buffer.from(signature).toString('base64url')}`
  let reads = 0
  const handler = createLeadProductReaderHandler({
    lifetimeMs: 300_000,
    verify: createLeadProductServiceVerifier(environment),
    withCurrent: async (workspaceId, intentId, disclose) => {
      reads++
      return withCurrentLeadTurnProduct(connection.db, workspaceId, intentId, disclose)
    },
  })
  const selectors = {
    workspaceId: mappedWorkspaceId,
    intentId: admitted.leadTurn.intentId,
    principalId,
  }
  const request = (authorization = `Bearer ${token}`, body = selectors) =>
    new Request('https://synthetic-proof.invalid/api/internal/pi-durable/lead-product/current', {
      method: 'POST',
      headers: { authorization },
      body: JSON.stringify(body),
    })
  const accepted = await handler(request())
  assert.equal(accepted.status, 200)
  const evidence = await accepted.json()
  assert.equal(evidence.intentId, admitted.leadTurn.intentId)
  assert.equal(evidence.workspaceId, mappedWorkspaceId)
  assert.equal(evidence.canonicalActorPrincipalId, `user:${owner.principal.userId}`)
  assert.equal(evidence.profileId, lead.profile.id)
  assert.equal(evidence.profileVersion, lead.profile.version)
  assert.equal(evidence.prompt, admitted.message.bodyText)
  assert.equal('selectionRef' in evidence, false)
  assert.equal('profileContentDigest' in evidence, false)
  assert.equal(reads, 1)
  assert.equal((await handler(request('Bearer unrelated'))).status, 404)
  assert.equal(
    (
      await handler(
        request(undefined, {
          ...selectors,
          canonicalActorPrincipalId: `user:${crypto.randomUUID()}`,
        })
      )
    ).status,
    404
  )
  assert.equal(reads, 1)
  environment.PI_LEAD_PRODUCT_TRUST = JSON.stringify({
    ...trust,
    revokedCredentialIds: [claims.credentialId],
  })
  assert.equal((await handler(request())).status, 404)
  assert.equal(reads, 1)
  environment.PI_LEAD_PRODUCT_TRUST = JSON.stringify(trust)
  await connection.db
    .delete(workspaceMemberships)
    .where(eq(workspaceMemberships.workspaceId, workspace.id))
  const denied = await handler(request())
  assert.equal(denied.status, 404)
  assert.deepEqual(await denied.json(), { code: 'LEAD_PRODUCT_UNAVAILABLE' })
  assert.equal(reads, 2)
  console.log(
    JSON.stringify({
      schemaVersion: 'adea-product-reader-proof/v1',
      authenticatedCurrentDbRead: true,
      originalActorProfilePins: true,
      callerAuthorityRejectedBeforeDb: true,
      revokedServiceRejectedBeforeDb: true,
      revokedOriginalActorDenied: true,
      publicReadiness: false,
      modelInference: false,
      canonicalReads: reads,
      credentialFixtures: 'synthetic',
      transport: 'Request/Response handler',
    })
  )
} finally {
  await connection.close()
}
