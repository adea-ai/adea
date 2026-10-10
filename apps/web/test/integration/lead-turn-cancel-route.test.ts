// Route-level cancellation for group lead admissions (#1244 with canonical #1232 group authority).
//
// The cancel route handler runs with a real Request, a real temporary-session cookie resolved from a database
// row, and the real application database. Only the TanStack router wrappers are stubbed (their module scope
// cannot initialize under bun), and the external CP runtime adapter is a stub that counts calls. No model is
// called, and every fixture is a synthetic workspace, agent and session. Nothing changes production code,
// permissions, grants or deployments.

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

// The external runtime adapter is the only fake. It records each cancel and echoes the stored binding.
const adapterCalls: string[] = []
const bound = { current: null as null | Record<string, string> }
const adapter = {
  async cancel(_input: unknown, dispatchId: string) {
    adapterCalls.push('cancel')
    const b = bound.current!
    return {
      attemptId: b.attemptId,
      dispatchId,
      executionId: b.executionId,
      intentId: b.intentId,
      runtimeSessionId: b.runtimeSessionId,
      schemaVersion: 'pi-lead-dispatch/v1',
      state: 'cancelling',
      status: { observedAt: new Date().toISOString() },
    }
  },
  async status() {
    adapterCalls.push('status')
    throw new Error('status is not part of this cancellation route test')
  },
  async progress() {
    adapterCalls.push('progress')
    throw new Error('progress is not part of this cancellation route test')
  },
  async dispatch() {
    adapterCalls.push('dispatch')
    throw new Error('dispatch must not run in a cancellation route test')
  },
  async prepare() {
    adapterCalls.push('prepare')
    throw new Error('prepare must not run in a cancellation route test')
  },
}

mock.module('../../src/server/lead-turn-composition', () => ({
  createConfiguredLeadTurnDependencies: async () => ({ adapter }),
}))

const databaseUrl = process.env.DATABASE_URL

type Handler = (input: { request: Request; params: Record<string, string> }) => Promise<Response>
type RouteModule = { Route: { options: { server: { handlers: { POST?: Handler } } } } }
type Who = { cookie: string; principal: { kind: 'user'; userId: string } }

const hex32 = () => crypto.randomUUID().replaceAll('-', '')
const crockford = () => hex32().slice(0, 26).toUpperCase()

describe.skipIf(!databaseUrl)('group lead cancellation through the real route handler', () => {
  let db: any
  let closeConnection: () => Promise<void>
  let schema: any
  let temporary: any
  let cancelRoute: RouteModule

  beforeAll(async () => {
    schema = await import('@adea-ai/db')
    temporary = await import('../../src/server/temporary-session')
    const connection = schema.createDatabase(databaseUrl!)
    db = connection.db
    closeConnection = connection.close
    cancelRoute =
      (await import('../../src/start/routes/api/v1/workspaces/$workspaceId/lead-turns/$intentId/cancel')) as RouteModule
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

  async function cancel(who: Who, workspaceId: string, intentId: string) {
    const request = new Request(
      `https://adea.invalid/api/v1/workspaces/${workspaceId}/lead-turns/${intentId}/cancel`,
      {
        method: 'POST',
        headers: { cookie: who.cookie, 'content-type': 'application/json' },
        body: '{}',
      }
    )
    const response = await cancelRoute.Route.options.server.handlers.POST!({
      request,
      params: { intentId, workspaceId },
    })
    return { status: response.status, body: (await response.json()) as Record<string, any> }
  }

  /** Owner-owned workspace W with a real lead agent, a group with owner and admin audience, and an admitted lead. */
  async function groupAdmission(options: { archive?: boolean } = {}) {
    const owner = await session()
    const admin = await session()
    const { workspace } = await schema.createWorkspaceWithOwner(db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Cancel route workspace',
      owner: owner.principal,
    })
    await schema.addWorkspaceMembership(db, workspace.id, admin.principal, 'admin')
    const lead = await schema.ensureWorkspaceLead(db, workspace.id, owner.principal)
    const channelId = crypto.randomUUID()
    const issuedAt = new Date(Date.now() - 60_000).toISOString()
    const person = (participant: { kind: 'user'; userId: string }, index: number) => ({
      expiresAt: null,
      grantId: `gra_person_${index}`,
      groupId: channelId,
      issuedAt,
      participant,
      revision: 1,
      revokedAt: null,
    })
    await schema.createGroupChannelWithGrants(db, workspace.id, owner.principal, {
      candidates: schema.groupCreationCandidatesFromGrants(workspace.id, {
        audienceGrants: [person(owner.principal, 0), person(admin.principal, 1)],
        enlistmentGrants: [
          {
            agent: { agentId: lead.id, workspaceId: workspace.id },
            expiresAt: null,
            grantId: 'gra_lead',
            groupId: channelId,
            issuedAt,
            revision: 1,
            revokedAt: null,
          },
        ],
      }),
      channelId,
      idempotencyKey: crypto.randomUUID(),
      now: issuedAt,
      title: 'Group',
    })
    const posted = await schema.postGroupChannelMessage(
      db,
      workspace.id,
      channelId,
      owner.principal,
      owner.principal,
      {
        lead: { bodyText: 'run it', idempotencyKey: crypto.randomUUID(), mentions: [] },
        mode: 'lead',
      },
      { now: issuedAt }
    )
    const intentId = posted.leadTurn.intentId as string
    const [canonical] = await db
      .select({ controlPlaneWorkspaceId: schema.workspaces.controlPlaneWorkspaceId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspace.id))
    const selection = {
      attemptId: `att_${crockford()}`,
      executionId: `exe_${crockford()}`,
      expiresAt: '2027-01-01T00:00:00.000Z',
      intentId,
      preparationRef: `prep_${'d'.repeat(32)}`,
      selectionRef: `msel_${'d'.repeat(32)}`,
      selectionRevision: 1,
      workspaceId: canonical!.controlPlaneWorkspaceId,
    }
    const dispatchId = `dispatch_${hex32()}`
    const runtimeSessionId = `ses_${crockford()}`
    await schema.prepareLeadTurnRuntime(db, workspace.id, intentId, owner.principal, selection)
    await schema.markLeadTurnDispatchPending(db, workspace.id, intentId, owner.principal, selection)
    await schema.observeLeadTurnRuntime(db, workspace.id, intentId, owner.principal, {
      attemptId: selection.attemptId,
      dispatchId,
      executionId: selection.executionId,
      intentId,
      observedAt: issuedAt,
      runtimeSessionId,
      state: 'running',
    })
    bound.current = {
      attemptId: selection.attemptId,
      executionId: selection.executionId,
      intentId,
      runtimeSessionId,
    }
    if (options.archive) {
      const [channel] = await db
        .select({ version: schema.channels.version })
        .from(schema.channels)
        .where(eq(schema.channels.id, channelId))
      await schema.archiveChannel(db, workspace.id, channelId, owner.principal, channel!.version)
    }
    const outsider = await session()
    await schema.createWorkspaceWithOwner(db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Foreign workspace',
      owner: outsider.principal,
    })
    return { admin, channelId, intentId, outsider, owner, workspace }
  }

  async function cancelRequestedAt(intentId: string) {
    const [row] = await db
      .select({ at: schema.leadTurnRuntime.cancelRequestedAt })
      .from(schema.leadTurnRuntime)
      .where(eq(schema.leadTurnRuntime.intentId, intentId))
    return row?.at ?? null
  }

  test('the claim holder cancels through the route, a repeat converges, and other principals are refused without an adapter call', async () => {
    const f = await groupAdmission()
    const callsBefore = adapterCalls.length

    const first = await cancel(f.owner, f.workspace.id, f.intentId)
    expect(first.status).toBe(200)
    expect(first.body.leadTurn?.state).toBe('cancelling')
    expect(adapterCalls.length).toBe(callsBefore + 1)
    const recorded = await cancelRequestedAt(f.intentId)
    expect(recorded).not.toBeNull()

    const repeat = await cancel(f.owner, f.workspace.id, f.intentId)
    expect(repeat.status).toBe(200)
    expect(await cancelRequestedAt(f.intentId)).toEqual(recorded)

    const callsAfterOwner = adapterCalls.length
    const admin = await cancel(f.admin, f.workspace.id, f.intentId)
    expect(admin.status).toBe(404)
    expect(admin.body.code).toBe('workspace_unavailable')
    const outsider = await cancel(f.outsider, f.workspace.id, f.intentId)
    expect(outsider.status).toBe(404)
    expect(adapterCalls.length).toBe(callsAfterOwner)
  })

  test('an archived group admission is refused at the route, and the adapter is not called', async () => {
    const f = await groupAdmission({ archive: true })
    const callsBefore = adapterCalls.length
    const refused = await cancel(f.owner, f.workspace.id, f.intentId)
    expect(refused.status).toBe(404)
    expect(refused.body.code).toBe('workspace_unavailable')
    expect(adapterCalls.length).toBe(callsBefore)
    expect(await cancelRequestedAt(f.intentId)).toBeNull()
  })
})
