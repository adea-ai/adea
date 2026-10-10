import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ServiceCredentialClaimsSchema } from '@adea-ai/contracts'
import {
  addWorkspaceMembership,
  agents,
  channelParticipants,
  channels,
  createDatabase,
  createDirectAgentTopic,
  createLeadTurn,
  createProject,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  ensureWorkspaceLead,
  fenceLeadTurnForRollback,
  markLeadTurnDispatchPending,
  observeLeadTurnRuntime,
  prepareLeadTurnRuntime,
  publishLeadTurnResult,
  recoverLeadTurnRuntimeBinding,
  removeWorkspaceMembership,
  withCurrentLeadTurnProduct,
  workspaceMemberships,
  workspaces,
  messages,
} from '@adea-ai/db'
import { eq } from 'drizzle-orm'
import { createLeadProductReaderHandler } from '../../src/server/lead-product-reader'
import { createLeadProductServiceVerifier } from '../../src/server/lead-product-service-auth'
import { createLeadTurnProduct } from '../../src/server/lead-turn-product'
import type { LeadRuntimeAdapter } from '../../src/server/lead-turn-runtime'

// Real product proof for pinned fence v2. The signed reader runs the real DB reader and the real service-token
// verifier. Signed envelopes are generated in memory and never touch operator configuration. The database is
// an owned, disposable product database, named with the `pinned_fence_v2_` prefix. Runs only when
// PINNED_FENCE_V2_DATABASE_URL is set. The external CP runtime adapter is a stub. The adapter is the only fake.

async function readBody(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}
const retainedFrom = (b: Record<string, unknown>): Retained => ({
  authorityRevision: b.authorityRevision as number,
  canonicalActorPrincipalId: b.canonicalActorPrincipalId as string,
  scopeRef: b.scopeRef as string,
})

const observedAt = () => new Date().toISOString()

const databaseUrl = process.env.PINNED_FENCE_V2_DATABASE_URL
const disposablePrefix = 'pinned_fence_v2_'
const servicePrincipal = 'svc_control-plane'
const issuer = 'https://cp-fixture.invalid'
const keyId = 'synthetic-pinned-fence-key'
const url = 'https://adea.invalid/api/internal/pi-durable/lead-product/current'
const v1FencedFixture = 'lead-product-current.fenced.json'
const v2FencedFixture = 'lead-product-current.fenced-v2.json'

const base64url = (value: string | Uint8Array) => Buffer.from(value).toString('base64url')
const hex32 = () => crypto.randomUUID().replaceAll('-', '')
const crockford = () => hex32().slice(0, 26).toUpperCase()

/** Generates an Ed25519 pair in memory and returns a verifier and token signer bound to one workspace. */
async function signedService(cpWorkspaceId: string) {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const trust = {
    issuer,
    keyId,
    publicJwk,
    principalId: servicePrincipal,
    workspaceIds: [cpWorkspaceId],
    revokedCredentialIds: [] as string[],
  }
  const verify = createLeadProductServiceVerifier({ PI_LEAD_PRODUCT_TRUST: JSON.stringify(trust) })
  async function token(workspaceId = cpWorkspaceId, principalId = servicePrincipal) {
    const issued = Date.now() - 1_000
    const claims = ServiceCredentialClaimsSchema.parse({
      audience: 'adea-lead-product',
      credentialId: `synthetic-${crockford()}`,
      credentialKind: 'service',
      expiresAt: new Date(issued + 240_000).toISOString(),
      issuedAt: new Date(issued).toISOString(),
      issuer,
      keyId,
      principalId,
      projectIds: [],
      scopes: ['execution:read'],
      workspaceIds: [workspaceId],
    })
    const input = `${base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: keyId }))}.${base64url(JSON.stringify(claims))}`
    const signature = await crypto.subtle.sign(
      'Ed25519',
      pair.privateKey,
      new TextEncoder().encode(input)
    )
    return `${input}.${base64url(new Uint8Array(signature))}`
  }
  return { verify, token }
}

type Scope = { workspaceId: string; intentId: string; userId: string }
type Retained = { authorityRevision: number; canonicalActorPrincipalId: string; scopeRef: string }

/** The reference predicates a CP consumer applies to v2 pins. They match the consumer proposal. */
function observeAllowed(body: Record<string, unknown>, retained: Retained, requester: string) {
  return (
    body.schemaVersion === 'pi-lead-intent-fence/v2' &&
    body.dispatchPermitted === false &&
    body.authorityRevision === retained.authorityRevision &&
    body.canonicalActorPrincipalId === retained.canonicalActorPrincipalId &&
    body.scopeRef === retained.scopeRef &&
    Array.isArray(body.allowedPrincipalIds) &&
    body.allowedPrincipalIds.includes(requester)
  )
}
const cancelAllowed = (
  body: Record<string, unknown>,
  retained: Retained,
  requester: string,
  actor: string
) => observeAllowed(body, retained, requester) && actor === retained.canonicalActorPrincipalId

/** Strict v2 consumer check. Exact keys, exact discriminator, canonical timestamp and pinned identities. */
function parseV2Strict(body: unknown): Record<string, unknown> {
  const record = body as Record<string, unknown>
  const fence = record.rollbackFence as Record<string, unknown>
  const v2Keys = [
    'allowedPrincipalIds',
    'authorityRevision',
    'canonicalActorPrincipalId',
    'dispatchPermitted',
    'intentId',
    'rollbackFence',
    'schemaVersion',
    'scopeRef',
    'workspaceId',
  ]
  if (
    typeof record !== 'object' ||
    Object.keys(record).toSorted().join(',') !== v2Keys.join(',') ||
    record.schemaVersion !== 'pi-lead-intent-fence/v2' ||
    record.dispatchPermitted !== false ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      String(record.intentId)
    ) ||
    !/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(record.workspaceId)) ||
    !Number.isSafeInteger(record.authorityRevision) ||
    !/^user:[0-9a-f-]{36}$/i.test(String(record.canonicalActorPrincipalId)) ||
    !/^adea-product:sha256:[0-9a-f]{64}$/.test(String(record.scopeRef)) ||
    !Array.isArray(record.allowedPrincipalIds) ||
    record.allowedPrincipalIds.length !== 1 ||
    typeof fence !== 'object' ||
    Object.keys(fence).toSorted().join(',') !== 'actor,fencedAt,reason' ||
    new Date(String(fence.fencedAt)).toISOString() !== fence.fencedAt
  )
    throw new Error('PI_PRODUCT_READER_UNAVAILABLE')
  return record
}

describe.skipIf(!databaseUrl)('pinned fence v2 on the real product handler', () => {
  let connection: ReturnType<typeof createDatabase>
  beforeAll(() => {
    const name = new URL(databaseUrl!).pathname.slice(1)
    if (!name.startsWith(disposablePrefix))
      throw new Error('Refusing a database that is not an owned disposable product database')
    connection = createDatabase(databaseUrl!)
  })
  afterAll(() => connection.close())

  /** A workspace with an owner, an admin who is the original actor, and a fenced in-flight admission. */
  async function fixture() {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 600_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      name: 'Pinned fence v2 proof',
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
        title: 'Pinned fence v2',
        idempotencyKey: crypto.randomUUID(),
      }
    )
    const actor = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 600_000),
    })
    await addWorkspaceMembership(connection.db, workspace.id, actor.principal, 'admin')
    await connection.db.insert(channelParticipants).values({
      workspaceId: workspace.id,
      channelId: topic.id,
      principalKind: 'user',
      userId: actor.principal.userId,
    })
    const admitted = await createLeadTurn(connection.db, workspace.id, topic.id, actor.principal, {
      bodyText: 'Canonical question',
      idempotencyKey: crypto.randomUUID(),
    })
    const [canonical] = await connection.db
      .select({ controlPlaneWorkspaceId: workspaces.controlPlaneWorkspaceId })
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id))
    const cpWorkspaceId = canonical!.controlPlaneWorkspaceId
    const intentId = admitted.leadTurn.intentId
    const execution = crockford()
    const pin = {
      workspaceId: cpWorkspaceId,
      intentId,
      executionId: `exe_${execution}`,
      attemptId: `att_${execution}`,
      selectionRef: `msel_${hex32()}`,
      selectionRevision: 1,
      preparationRef: `prep_${hex32()}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }
    const binding = {
      intentId,
      executionId: pin.executionId,
      attemptId: pin.attemptId,
      dispatchId: `dispatch_${hex32()}`,
      runtimeSessionId: `ses_${crockford()}`,
    }
    const scope: Scope = { workspaceId: workspace.id, intentId, userId: actor.principal.userId }
    const signer = await signedService(cpWorkspaceId)
    return {
      owner,
      actor,
      workspace,
      lead,
      topic,
      intentId,
      cpWorkspaceId,
      pin,
      binding,
      scope,
      service: signer,
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  /** Prepare, dispatch and bind the attempt, then observe it running. Admission is unfenced at this point. */
  async function prepareDispatchAndRun(f: Fixture) {
    const { actor, workspace, intentId, pin, binding } = f
    await prepareLeadTurnRuntime(connection.db, workspace.id, intentId, actor.principal, pin)
    await markLeadTurnDispatchPending(connection.db, workspace.id, intentId, actor.principal, pin)
    await recoverLeadTurnRuntimeBinding(
      connection.db,
      workspace.id,
      intentId,
      actor.principal,
      binding
    )
    await observeLeadTurnRuntime(connection.db, workspace.id, intentId, actor.principal, {
      ...binding,
      state: 'running',
      observedAt: new Date().toISOString(),
    })
  }

  /** The real handler: the real verifier, the real DB reader, and a counter on the lookup. */
  function reader(f: Fixture) {
    const counts = { lookup: 0 }
    const handler = createLeadProductReaderHandler({
      lifetimeMs: 300_000,
      verify: f.service.verify,
      withCurrent: (workspaceId, intentId, disclose) => {
        counts.lookup++
        return withCurrentLeadTurnProduct(connection.db, workspaceId, intentId, disclose)
      },
    })
    return {
      counts,
      read: async (
        principalId = servicePrincipal,
        token?: string,
        workspaceId = f.cpWorkspaceId,
        intentId = f.intentId
      ) =>
        handler(
          new Request(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${token ?? (await f.service.token())}` },
            body: JSON.stringify({ workspaceId, intentId, principalId }),
          })
        ),
    }
  }

  /** The real product service: DB-backed store, stub external adapter that counts every call. */
  function stubbedService(f: Fixture) {
    const calls: string[] = []
    const adapter = {
      async prepare() {
        calls.push('prepare')
        throw new Error('adapter.prepare must not run for a fenced admission')
      },
      async dispatch() {
        calls.push('dispatch')
        throw new Error('adapter.dispatch must not run for a fenced admission')
      },
      async status() {
        calls.push('status')
        return {
          ...f.binding,
          schemaVersion: 'pi-lead-dispatch/v1',
          state: 'running',
          status: { observedAt: observedAt() },
        }
      },
      async progress() {
        calls.push('progress')
        return {
          ...f.binding,
          schemaVersion: 'pi-lead-dispatch/v1',
          state: 'running',
          status: { observedAt: observedAt() },
          events: [],
          nextSequence: 0,
        }
      },
      async cancel() {
        calls.push('cancel')
        return {
          ...f.binding,
          schemaVersion: 'pi-lead-dispatch/v1',
          state: 'cancelling',
          status: { observedAt: observedAt() },
        }
      },
      async assertPublicationCurrent() {},
    } as unknown as LeadRuntimeAdapter
    return { calls, product: createLeadTurnProduct(connection.db, { adapter }) }
  }

  test('matching: the retained v2 pins still match after the fence, and status, progress and original-actor cancel succeed', async () => {
    const f = await fixture()
    await prepareDispatchAndRun(f)
    const { read, counts } = reader(f)
    const unfenced = await readBody(await read())
    expect(unfenced.status).toBe(200)
    expect(unfenced.body.schemaVersion).toBe('pi-lead-intent/v1')
    const retained = retainedFrom(unfenced.body)
    await fenceLeadTurnForRollback(connection.db, f.workspace.id, f.intentId, {
      actor: { kind: 'user', principal: f.owner.principal },
      reason: 'rollback_cohort',
    })
    const fenced = await readBody(await read())
    expect(fenced.status).toBe(200)
    const v2 = parseV2Strict(fenced.body)
    expect(v2.schemaVersion).toBe('pi-lead-intent-fence/v2')
    expect(v2.scopeRef).toBe(retained.scopeRef)
    expect(v2.authorityRevision).toBe(retained.authorityRevision)
    expect(observeAllowed(fenced.body, retained, servicePrincipal)).toBe(true)
    expect(
      cancelAllowed(fenced.body, retained, servicePrincipal, `user:${f.actor.principal.userId}`)
    ).toBe(true)
    expect(counts.lookup).toBe(2)

    const { product, calls } = stubbedService(f)
    expect(await product.status(f.scope)).toMatchObject({
      schemaVersion: 'adea-lead-turn/v1',
      state: 'running',
    })
    expect(await product.progress(f.scope, 0)).toMatchObject({ nextSequence: 0 })
    const cancelled = await product.cancel(f.scope)
    expect(cancelled).toMatchObject({ state: 'cancelling' })
    expect(calls.filter((c) => c === 'cancel')).toHaveLength(1)
  })

  test('original actor only: another admin cannot cancel the fenced admission, and the adapter is not called', async () => {
    const f = await fixture()
    await prepareDispatchAndRun(f)
    await fenceLeadTurnForRollback(connection.db, f.workspace.id, f.intentId, {
      actor: { kind: 'user', principal: f.owner.principal },
      reason: 'rollback_cohort',
    })
    const other = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 600_000),
    })
    await addWorkspaceMembership(connection.db, f.workspace.id, other.principal, 'admin')
    const { product, calls } = stubbedService(f)
    await expect(product.cancel({ ...f.scope, userId: other.principal.userId })).rejects.toThrow(
      'unavailable'
    )
    expect(calls).not.toContain('cancel')
  })

  test('new effects fail closed on a fenced admission: prepare, dispatch, a new attempt and publication are refused before any runtime call', async () => {
    const f = await fixture()
    await prepareDispatchAndRun(f)
    await fenceLeadTurnForRollback(connection.db, f.workspace.id, f.intentId, {
      actor: { kind: 'user', principal: f.owner.principal },
      reason: 'rollback_cohort',
    })
    const { product, calls } = stubbedService(f)
    await expect(product.prepare(f.scope)).rejects.toThrow('LEAD_TURN_FENCED')
    await expect(product.dispatch(f.scope)).rejects.toThrow('LEAD_TURN_FENCED')
    const resumed = { ...f.pin, executionId: `exe_${crockford()}`, attemptId: `att_${crockford()}` }
    await expect(
      prepareLeadTurnRuntime(connection.db, f.workspace.id, f.intentId, f.actor.principal, resumed)
    ).rejects.toThrow('LEAD_TURN_FENCED')
    expect(calls).toEqual([])

    await observeLeadTurnRuntime(connection.db, f.workspace.id, f.intentId, f.actor.principal, {
      ...f.binding,
      state: 'completed',
      observedAt: new Date().toISOString(),
    })
    const before = await connection.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.channelId, f.topic.id))
    await expect(
      publishLeadTurnResult(
        connection.db,
        f.workspace.id,
        f.intentId,
        f.actor.principal,
        f.binding,
        'Answer',
        async () => {}
      )
    ).rejects.toThrow('LEAD_TURN_FENCED')
    const after = await connection.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.channelId, f.topic.id))
    expect(after).toHaveLength(before.length)
  })

  test('concurrent actor change: removing the original actor during the read leaves no mismatched body, and status and cancel are refused afterwards', async () => {
    const f = await fixture()
    await prepareDispatchAndRun(f)
    const { read } = reader(f)
    const retained = retainedFrom((await readBody(await read())).body)
    await fenceLeadTurnForRollback(connection.db, f.workspace.id, f.intentId, {
      actor: { kind: 'user', principal: f.owner.principal },
      reason: 'rollback_cohort',
    })
    const [during, removed] = await Promise.all([
      read(),
      removeWorkspaceMembership(connection.db, f.workspace.id, f.actor.principal),
    ])
    const raced = await readBody(during)
    if (raced.status === 200)
      expect(observeAllowed(raced.body, retained, servicePrincipal)).toBe(true)
    else expect(raced.status).toBe(404)
    expect(removed).toBe(true)
    expect(await readBody(await read())).toEqual({
      status: 404,
      body: { code: 'LEAD_PRODUCT_UNAVAILABLE' },
    })
    const { product, calls } = stubbedService(f)
    await expect(product.status(f.scope)).rejects.toThrow()
    await expect(product.cancel(f.scope)).rejects.toThrow()
    expect(calls).toEqual([])
  })

  test('concurrent ownership change: downgrading the original actor below runtime.invoke refuses the reader and cancel with the pins unchanged', async () => {
    const f = await fixture()
    await prepareDispatchAndRun(f)
    const { read } = reader(f)
    const retained = retainedFrom((await readBody(await read())).body)
    await fenceLeadTurnForRollback(connection.db, f.workspace.id, f.intentId, {
      actor: { kind: 'user', principal: f.owner.principal },
      reason: 'rollback_cohort',
    })
    const [during] = await Promise.all([
      read(),
      connection.db
        .update(workspaceMemberships)
        .set({ role: 'member' })
        .where(eq(workspaceMemberships.userId, f.actor.principal.userId)),
    ])
    const raced = await readBody(during)
    if (raced.status === 200)
      expect(observeAllowed(raced.body, retained, servicePrincipal)).toBe(true)
    else expect(raced.status).toBe(404)
    expect(await readBody(await read())).toEqual({
      status: 404,
      body: { code: 'LEAD_PRODUCT_UNAVAILABLE' },
    })
    const { product, calls } = stubbedService(f)
    await expect(product.cancel(f.scope)).rejects.toThrow()
    expect(calls).not.toContain('cancel')
  })

  test('concurrent placement change: moving the workspace lead or its topic into a project is refused by the database, and the retained pins still match', async () => {
    const f = await fixture()
    await prepareDispatchAndRun(f)
    const { read } = reader(f)
    const retained = retainedFrom((await readBody(await read())).body)
    await fenceLeadTurnForRollback(connection.db, f.workspace.id, f.intentId, {
      actor: { kind: 'user', principal: f.owner.principal },
      reason: 'rollback_cohort',
    })
    const project = await createProject(connection.db, f.workspace.id, f.owner.principal, {
      iconKey: 'folder',
      name: 'Placement proof',
    })
    // The workspace lead is standalone (agents_workspace_lead_standalone) and a direct topic has no project.
    // Both placement moves are therefore refused by the database, so no concurrent placement can change the admission.
    const [during, leadMove, topicMove] = await Promise.all([
      read(),
      connection.db
        .update(agents)
        .set({ projectId: project.id })
        .where(eq(agents.id, f.lead.id))
        .then(
          () => 'moved',
          (error: Error & { constraint_name?: string; cause?: { constraint_name?: string } }) =>
            error.cause?.constraint_name ?? error.constraint_name ?? error.message
        ),
      connection.db
        .update(channels)
        .set({ projectId: project.id })
        .where(eq(channels.id, f.topic.id))
        .then(
          () => 'moved',
          (error: Error & { constraint_name?: string; cause?: { constraint_name?: string } }) =>
            error.cause?.constraint_name ?? error.constraint_name ?? error.message
        ),
    ])
    expect(leadMove).toBe('agents_workspace_lead_standalone')
    expect(topicMove).not.toBe('moved')
    const raced = await readBody(during)
    expect(raced.status).toBe(200)
    expect(observeAllowed(raced.body, retained, servicePrincipal)).toBe(true)
    const settled = await readBody(await read())
    expect(settled.status).toBe(200)
    expect(observeAllowed(settled.body, retained, servicePrincipal)).toBe(true)
  })

  test('stale pins: a participant added after the retained read makes the reader refuse, so the retained scopeRef cannot be revalidated', async () => {
    const f = await fixture()
    await prepareDispatchAndRun(f)
    const { read } = reader(f)
    const retained = retainedFrom((await readBody(await read())).body)
    await fenceLeadTurnForRollback(connection.db, f.workspace.id, f.intentId, {
      actor: { kind: 'user', principal: f.owner.principal },
      reason: 'rollback_cohort',
    })
    const joiner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 600_000),
    })
    await addWorkspaceMembership(connection.db, f.workspace.id, joiner.principal, 'member')
    const [during] = await Promise.all([
      read(),
      connection.db.insert(channelParticipants).values({
        workspaceId: f.workspace.id,
        channelId: f.topic.id,
        principalKind: 'user',
        userId: joiner.principal.userId,
      }),
    ])
    const raced = await readBody(during)
    if (raced.status === 200)
      expect(observeAllowed(raced.body, retained, servicePrincipal)).toBe(true)
    else expect(raced.status).toBe(404)
    const settled = await readBody(await read())
    expect(settled).toEqual({ status: 404, body: { code: 'LEAD_PRODUCT_UNAVAILABLE' } })
    expect(retained.scopeRef).toMatch(/^adea-product:sha256:[0-9a-f]{64}$/)
  })

  test('wrong principal, wrong workspace and wrong intent get no lookup and no pins', async () => {
    const f = await fixture()
    await prepareDispatchAndRun(f)
    await fenceLeadTurnForRollback(connection.db, f.workspace.id, f.intentId, {
      actor: { kind: 'user', principal: f.owner.principal },
      reason: 'rollback_cohort',
    })
    const { read, counts } = reader(f)
    const refused = { status: 404, body: { code: 'LEAD_PRODUCT_UNAVAILABLE' } }
    expect(await readBody(await read('svc_other'))).toEqual(refused)
    expect(
      await readBody(
        await read(servicePrincipal, await f.service.token(f.cpWorkspaceId, 'svc_other'))
      )
    ).toEqual(refused)
    expect(
      await readBody(await read(servicePrincipal, undefined, `wsp_${'7'.repeat(26)}`))
    ).toEqual(refused)
    expect(
      await readBody(await read(servicePrincipal, undefined, f.cpWorkspaceId, crypto.randomUUID()))
    ).toEqual(refused)
    expect(counts.lookup).toBe(1)
  })

  test('v1 stays refused and v2 has an exact discriminator: the strict parser rejects the v1 fixture, extra fields and unknown schemas', async () => {
    const f = await fixture()
    await prepareDispatchAndRun(f)
    await fenceLeadTurnForRollback(connection.db, f.workspace.id, f.intentId, {
      actor: { kind: 'user', principal: f.owner.principal },
      reason: 'rollback_cohort',
    })
    const { read } = reader(f)
    const emitted = (await readBody(await read())).body
    expect(parseV2Strict(emitted).schemaVersion).toBe('pi-lead-intent-fence/v2')
    const v1 = (await Bun.file(new URL(`../contracts/${v1FencedFixture}`, import.meta.url)).json())
      .body
    expect(() => parseV2Strict(v1)).toThrow('PI_PRODUCT_READER_UNAVAILABLE')
    expect(() => parseV2Strict({ ...emitted, prompt: 'injected' })).toThrow(
      'PI_PRODUCT_READER_UNAVAILABLE'
    )
    expect(() => parseV2Strict({ ...emitted, schemaVersion: 'pi-lead-intent-fence/v2 ' })).toThrow(
      'PI_PRODUCT_READER_UNAVAILABLE'
    )
    expect(() => parseV2Strict({ ...emitted, schemaVersion: 'pi-lead-intent-fence/v3' })).toThrow(
      'PI_PRODUCT_READER_UNAVAILABLE'
    )
    const fixtureV2 = (
      await Bun.file(new URL(`../contracts/${v2FencedFixture}`, import.meta.url)).json()
    ).body
    expect(parseV2Strict(fixtureV2).schemaVersion).toBe('pi-lead-intent-fence/v2')
  })
})
