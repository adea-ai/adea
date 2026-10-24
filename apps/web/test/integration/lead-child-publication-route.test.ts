// Route-level publication of a retained child outcome to the canonical Adea
// timeline (#1173). The endpoint is a separate empty-body POST beside the
// read-only child GET: it carries no authority, no result and no artifact
// grant, and every identity comes from the retained intent.
//
// Only the external control-plane adapter is faked. The session, the
// workspace, the audience, the runtime binding and the database are real, and
// every fixture is synthetic.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { eq } from 'drizzle-orm'

mock.module('@tanstack/solid-start/server', () => ({
  getRequest: () => undefined,
  getCookie: () => undefined,
  setCookie: () => undefined,
  deleteCookie: () => undefined,
  setResponseStatus: () => undefined,
  getHeader: () => undefined,
}))

mock.module('@tanstack/solid-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  createRootRoute: () => (options: unknown) => ({ options }),
  createRouter: () => ({}),
  RouterProvider: () => null,
  Link: () => null,
  Outlet: () => null,
  useNavigate: () => () => undefined,
  useParams: () => ({}),
}))

const adapterCalls: string[] = []
let publishedChild: Record<string, unknown> | undefined
const adapter = {
  async children() {
    adapterCalls.push('children')
    if (!publishedChild) throw new Error('no retained child in this route test')
    return publishedChild.page
  },
  async childPublicationCurrent() {
    adapterCalls.push('childPublicationCurrent')
    if (!publishedChild) throw new Error('no retained child in this route test')
    return publishedChild.evidence
  },
  async dispatch() {
    throw new Error('dispatch must not run in this route test')
  },
  async status() {
    throw new Error('status must not run in this route test')
  },
  async progress() {
    throw new Error('progress must not run in this route test')
  },
  async cancel() {
    throw new Error('cancel must not run in this route test')
  },
}

mock.module('../../src/server/lead-turn-composition', () => ({
  createConfiguredLeadTurnDependencies: async () => ({ adapter }),
}))

const databaseUrl = process.env.DATABASE_URL

type Handler = (input: { request: Request; params: Record<string, string> }) => Promise<Response>
type RouteModule = { Route: { options: { server: { handlers: { POST?: Handler } } } } }
type Who = { cookie: string; principal: { kind: 'user'; userId: string } }

/** A fresh opaque identifier. The runtime's attempt id is unique across every
 * intent in the database, so a fixture may not reuse one. */
const fresh = (prefix: string) =>
  `${prefix}_${crypto
    .randomUUID()
    .replaceAll('-', '')
    .slice(0, 26)
    .toUpperCase()
    .replace(/[ILOU]/g, '0')}`

function T(name: string, fn: () => Promise<void>) {
  test(name, fn, 30_000)
}

describe.skipIf(!databaseUrl)('retained child publication through the real route handler', () => {
  let db: any
  let closeConnection: () => Promise<void>
  let schema: any
  let temporary: any
  let route: RouteModule

  beforeAll(async () => {
    schema = await import('@adea-ai/db')
    temporary = await import('../../src/server/temporary-session')
    const connection = schema.createDatabase(databaseUrl!)
    db = connection.db
    closeConnection = connection.close
    route =
      (await import('../../src/start/routes/api/v1/workspaces/$workspaceId/lead-turns/$intentId/children')) as RouteModule
  })
  afterAll(async () => closeConnection())

  async function session(): Promise<Who> {
    const credential = temporary.createTemporaryCredential()
    const digest = await temporary.digestTemporaryCredential(credential)
    const created = await schema.createTemporaryUserSession(db, {
      credentialDigest: digest,
      expiresAt: new Date(Date.now() + 600_000),
    })
    return {
      cookie: `${temporary.TEMPORARY_SESSION_COOKIE}=${credential}`,
      principal: created.principal,
    }
  }

  async function admittedLead() {
    const owner = await session()
    const { workspace } = await schema.createWorkspaceWithOwner(db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Child publication route workspace',
      owner: owner.principal,
    })
    const lead = await schema.ensureWorkspaceLead(db, workspace.id, owner.principal)
    const topic = await schema.createDirectAgentTopic(db, workspace.id, lead.id, owner.principal, {
      title: 'Child publication',
      idempotencyKey: crypto.randomUUID(),
    })
    const admitted = await schema.createLeadTurn(db, workspace.id, topic.id, owner.principal, {
      bodyText: 'Start one child',
      idempotencyKey: crypto.randomUUID(),
    })
    const [canonical] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspace.id))
    const token = crypto.randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase()
    const pin = {
      workspaceId: canonical!.controlPlaneWorkspaceId,
      intentId: admitted.leadTurn.intentId,
      executionId: fresh('exe'),
      attemptId: fresh('att'),
      selectionRef: `msel_${'a'.repeat(32)}`,
      selectionRevision: 1,
      preparationRef: `prep_${'b'.repeat(32)}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }
    const binding = {
      schemaVersion: 'pi-lead-dispatch/v1' as const,
      intentId: pin.intentId,
      dispatchId: `dispatch_${crypto.randomUUID().replaceAll('-', '')}`,
      executionId: pin.executionId,
      attemptId: pin.attemptId,
      runtimeSessionId: `ses_${token}`,
    }
    await schema.prepareLeadTurnRuntime(db, workspace.id, pin.intentId, owner.principal, pin)
    await schema.markLeadTurnDispatchPending(db, workspace.id, pin.intentId, owner.principal, pin)
    await schema.observeLeadTurnRuntime(db, workspace.id, pin.intentId, owner.principal, {
      ...binding,
      state: 'running',
      observedAt: new Date().toISOString(),
    })
    const delegationId = fresh('dlg')
    const childExecutionId = fresh('exe')
    const childAttemptId = fresh('att')
    const resultRef = fresh('art')
    publishedChild = {
      page: {
        ...binding,
        children: [
          {
            delegationId,
            childExecutionId,
            childAttemptId,
            role: 'researcher',
            state: 'completed',
            awaitingInput: false,
            stopRequested: false,
            acceptedAt: '2026-10-20T00:00:00.000Z',
            updatedAt: '2026-10-20T00:01:00.000Z',
            revision: 3,
            outcome: {
              state: 'completed',
              resultRef,
              publication: { status: 'published' },
            },
          },
        ],
        totalChildren: 1,
        complete: true,
      },
      evidence: {
        delegationId,
        childExecutionId,
        childAttemptId,
        role: 'researcher',
        state: 'completed',
        resultRef,
        conclusion: 'The requested answer is 42.',
        publication: 'published',
      },
    }
    return { owner, workspace, lead, topic, admitted, pin, binding }
  }

  async function publish(who: Who | undefined, workspaceId: string, intentId: string, body = '{}') {
    const request = new Request(
      `https://adea.invalid/api/v1/workspaces/${workspaceId}/lead-turns/${intentId}/children`,
      {
        method: 'POST',
        headers: {
          ...(who ? { cookie: who.cookie } : {}),
          'content-type': 'application/json',
        },
        body,
      }
    )
    const response = await route.Route.options.server.handlers.POST!({
      request,
      params: { intentId, workspaceId },
    })
    return { status: response.status, body: (await response.json()) as Record<string, any> }
  }

  T('a published retained child becomes one canonical message and one receipt', async () => {
    const f = await admittedLead()
    adapterCalls.length = 0
    const response = await publish(f.owner, f.workspace.id, f.pin.intentId)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ published: 1 })
    const receipts = await db
      .select()
      .from(schema.leadChildPublications)
      .where(eq(schema.leadChildPublications.intentId, f.pin.intentId))
    expect(receipts).toHaveLength(1)
    const timeline = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.channelId, f.topic.id))
    expect(timeline).toHaveLength(2)
    expect(timeline.find((message: any) => message.id === receipts[0]!.messageId)?.bodyText).toBe(
      'Child researcher completed: The requested answer is 42.'
    )
    // A replay publishes the same receipt again and adds no second message.
    const replay = await publish(f.owner, f.workspace.id, f.pin.intentId)
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual({ published: 1 })
    const after = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.channelId, f.topic.id))
    expect(after).toHaveLength(2)
  })

  T('a request without a session is refused and publishes nothing', async () => {
    const f = await admittedLead()
    adapterCalls.length = 0
    const response = await publish(undefined, f.workspace.id, f.pin.intentId)
    expect(response.status).toBe(401)
    expect(adapterCalls).toEqual([])
  })

  T('a body that is not an empty object is refused and publishes nothing', async () => {
    const f = await admittedLead()
    adapterCalls.length = 0
    for (const body of ['{"delegationId":"forged"}', 'x'.repeat(513)]) {
      const response = await publish(f.owner, f.workspace.id, f.pin.intentId, body)
      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ code: 'invalid_request' })
    }
    expect(adapterCalls).toEqual([])
  })

  T('a principal outside the workspace is refused and publishes nothing', async () => {
    const f = await admittedLead()
    const outsider = await session()
    adapterCalls.length = 0
    const response = await publish(outsider, f.workspace.id, f.pin.intentId)
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'workspace_unavailable' })
    expect(adapterCalls).toEqual([])
    const receipts = await db
      .select()
      .from(schema.leadChildPublications)
      .where(eq(schema.leadChildPublications.intentId, f.pin.intentId))
    expect(receipts).toHaveLength(0)
  })

  T('an intent that does not exist is refused and publishes nothing', async () => {
    const f = await admittedLead()
    adapterCalls.length = 0
    const response = await publish(f.owner, f.workspace.id, crypto.randomUUID())
    expect(response.status).toBe(404)
    expect(adapterCalls).toEqual([])
  })
})
