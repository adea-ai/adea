// TEST-ONLY reproducer for the group enlistment authority question (root finding, #1232 head ab555698c).
//
// The channel POST, the group-message POST and the group participants POST are the real route handlers, invoked
// with real Request objects, real temporary-session cookies resolved from real database rows, and the real
// application database. Only the TanStack router wrapper and the TanStack server-request reader are stubbed,
// because the router's module scope cannot initialize under bun. Nothing here changes production code, SQL,
// roles, settings or grants. Every fixture is a synthetic workspace, agent and session, and no model is called.
//
// Each test records current behaviour. A test named "REPRO" asserts what the code does today, so when an upstream
// authority check lands, its assertion flips and this file is the regression to update.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

// The request-context module reads the TanStack server request. The resolution path under test takes the Request
// directly, so these reads return the empty value the Neon branch already tolerates.
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

const databaseUrl = process.env.DATABASE_URL

async function invoke(
  handler: Handler,
  path: string,
  params: Record<string, string>,
  who: Who,
  body: unknown,
  extra: Record<string, string> = {}
) {
  const request = new Request(`https://adea.invalid${path}`, {
    method: 'POST',
    headers: {
      cookie: who.cookie,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
      ...extra,
    },
    body: JSON.stringify(body),
  })
  const response = await handler({ request, params })
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

/** The caller-authored enlistment grant: well formed, effective, bound to the group, claiming a home workspace. */
function enlistmentGrant(groupId: string, agentId: string, claimedWorkspaceId: string) {
  return {
    agent: { agentId, workspaceId: claimedWorkspaceId },
    expiresAt: null,
    grantId: `gra_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
    groupId,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    revision: 1,
    revokedAt: null,
  }
}

type Handler = (input: { request: Request; params: Record<string, string> }) => Promise<Response>
type RouteModule = {
  Route: { options: { server: { handlers: { GET?: Handler; POST?: Handler } } } }
}
type Who = { cookie: string; principal: { kind: 'user'; userId: string } }

describe.skipIf(!databaseUrl)(
  'group enlistment authority reproducer (route handlers, real DB)',
  () => {
    let db: any
    let closeConnection: () => Promise<void>
    let schema: any
    let temporary: any
    let channelsRoute: RouteModule
    let messagesRoute: RouteModule
    let participantsRoute: RouteModule

    beforeAll(async () => {
      schema = await import('@adea-ai/db')
      temporary = await import('../../src/server/temporary-session')
      const connection = schema.createDatabase(databaseUrl!)
      db = connection.db
      closeConnection = connection.close
      channelsRoute =
        (await import('../../src/start/routes/api/v1/workspaces/$workspaceId/channels')) as RouteModule
      messagesRoute =
        (await import('../../src/start/routes/api/v1/workspaces/$workspaceId/channels/$channelId/messages')) as RouteModule
      participantsRoute =
        (await import('../../src/start/routes/api/v1/workspaces/$workspaceId/channels/$channelId/participants')) as RouteModule
    })
    afterAll(async () => closeConnection())

    /** A real temporary session: the cookie credential is digested and resolved from a real database row. */
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

    /** Foreign workspace W, owned by `owner`, with its real workspace lead agent A. */
    async function foreignWorkspace() {
      const owner = await session()
      const { workspace } = await schema.createWorkspaceWithOwner(db, {
        idempotencyKey: crypto.randomUUID(),
        name: 'Foreign workspace W',
        owner: owner.principal,
      })
      const lead = await schema.ensureWorkspaceLead(db, workspace.id, owner.principal)
      return { owner, workspace, lead }
    }

    /** Workspace owned by `owner`. The attacker is the owner of a host workspace H and has no membership in W. */
    async function hostWorkspace(owner: Who, name: string) {
      const { workspace } = await schema.createWorkspaceWithOwner(db, {
        idempotencyKey: crypto.randomUUID(),
        name,
        owner: owner.principal,
      })
      return { workspace }
    }

    async function createGroup(
      who: Who,
      workspaceId: string,
      channelId: string,
      enlistmentGrants: unknown[]
    ) {
      return invoke(
        channelsRoute.Route.options.server.handlers.POST!,
        `/api/v1/workspaces/${workspaceId}/channels`,
        { workspaceId },
        who,
        { channelId, enlistmentGrants, kind: 'group', title: 'Group with a claimed lead' }
      )
    }

    async function leadMessage(who: Who, workspaceId: string, channelId: string) {
      return invoke(
        messagesRoute.Route.options.server.handlers.POST!,
        `/api/v1/workspaces/${workspaceId}/channels/${channelId}/messages`,
        { channelId, workspaceId },
        who,
        { bodyText: 'Run the group lead', leadTurn: true }
      )
    }

    /** Effects visible in the database for one group channel and one agent. */
    async function effects(channelId: string, agentId: string) {
      const [channel] = await db
        .select({ kind: schema.channels.kind, workspaceId: schema.channels.workspaceId })
        .from(schema.channels)
        .where(eq(schema.channels.id, channelId))
      const grants = await db
        .select({ grantId: schema.groupEnlistmentGrants.grantId })
        .from(schema.groupEnlistmentGrants)
        .where(
          and(
            eq(schema.groupEnlistmentGrants.channelId, channelId),
            eq(schema.groupEnlistmentGrants.agentId, agentId)
          )
        )
      const intents = await db
        .select({ id: schema.leadTurnIntents.id, workspaceId: schema.leadTurnIntents.workspaceId })
        .from(schema.leadTurnIntents)
        .where(
          and(
            eq(schema.leadTurnIntents.channelId, channelId),
            eq(schema.leadTurnIntents.agentId, agentId)
          )
        )
      return {
        channelKind: channel?.kind ?? null,
        channelWorkspaceId: channel?.workspaceId ?? null,
        enlistmentGrantRows: grants.length,
        leadIntentRows: intents.length,
        leadIntentWorkspaceId: intents[0]?.workspaceId ?? null,
      }
    }

    async function membershipRows(workspaceId: string, userId: string) {
      return db
        .select({ id: schema.workspaceMemberships.id })
        .from(schema.workspaceMemberships)
        .where(
          and(
            eq(schema.workspaceMemberships.workspaceId, workspaceId),
            eq(schema.workspaceMemberships.userId, userId)
          )
        )
    }

    test('REPRO host-only owner invents a well-formed enlistment grant for a foreign lead, creates the group, and admits the lead', async () => {
      const { lead, workspace: W } = await foreignWorkspace()
      const attacker = await session()
      const { workspace: H } = await hostWorkspace(attacker, 'Host workspace H')
      expect(await membershipRows(W.id, attacker.principal.userId)).toHaveLength(0)

      const channelId = crypto.randomUUID()
      const created = await createGroup(attacker, H.id, channelId, [
        enlistmentGrant(channelId, lead.id, W.id),
      ])
      console.log(
        'REPRO create',
        JSON.stringify({
          status: created.status,
          code: created.body.code ?? null,
          channelId: created.body.channel?.id ?? null,
        })
      )
      expect(created.status).toBe(201)

      const admitted = await leadMessage(attacker, H.id, channelId)
      console.log(
        'REPRO lead',
        JSON.stringify({
          status: admitted.status,
          code: admitted.body.code ?? null,
          leadTurnState: admitted.body.leadTurn?.state ?? null,
          leadTurnReasonCode: admitted.body.leadTurn?.reasonCode ?? null,
        })
      )
      expect(admitted.status).toBe(201)

      const after = await effects(channelId, lead.id)
      console.log(
        'REPRO effects',
        JSON.stringify({
          ...after,
          channelWorkspaceIsHost: after.channelWorkspaceId === H.id,
          leadIntentWorkspaceIsHost: after.leadIntentWorkspaceId === H.id,
        })
      )
      expect(after.channelKind).toBe('group')
      expect(after.enlistmentGrantRows).toBe(1)
      expect(after.leadIntentRows).toBe(1)
    })

    test('positive control: the same owner, authorized in both workspaces, makes the same request with the same effects', async () => {
      const { owner, lead, workspace: W } = await foreignWorkspace()
      const { workspace: H } = await hostWorkspace(owner, 'Second workspace of the same owner')
      const channelId = crypto.randomUUID()
      const created = await createGroup(owner, H.id, channelId, [
        enlistmentGrant(channelId, lead.id, W.id),
      ])
      expect(created.status).toBe(201)
      const admitted = await leadMessage(owner, H.id, channelId)
      expect(admitted.status).toBe(201)
      const after = await effects(channelId, lead.id)
      expect(after.enlistmentGrantRows).toBe(1)
      expect(after.leadIntentRows).toBe(1)
    })

    test('control: a spoofed source (the host claimed as the agent home) is refused by the equality check, with zero writes', async () => {
      const { lead } = await foreignWorkspace()
      const attacker = await session()
      const { workspace: H } = await hostWorkspace(attacker, 'Host for spoof control')
      const channelId = crypto.randomUUID()
      const refused = await createGroup(attacker, H.id, channelId, [
        enlistmentGrant(channelId, lead.id, H.id),
      ])
      console.log(
        'REPRO spoof-control',
        JSON.stringify({
          status: refused.status,
          code: refused.body.code ?? null,
          reasons: (refused.body.rejections ?? []).map((r: any) => r.reason),
        })
      )
      expect(refused.status).toBe(400)
      expect((await effects(channelId, lead.id)).channelKind).toBeNull()
    })

    test('control: a host member without workspace.update cannot create the group, so the route host check is real', async () => {
      const { lead, workspace: W } = await foreignWorkspace()
      const ownerH = await session()
      const { workspace: H } = await hostWorkspace(ownerH, 'Host with member only')
      const member = await session()
      await schema.addWorkspaceMembership(db, H.id, member.principal, 'member')
      const channelId = crypto.randomUUID()
      const refused = await createGroup(member, H.id, channelId, [
        enlistmentGrant(channelId, lead.id, W.id),
      ])
      console.log(
        'REPRO member-control',
        JSON.stringify({ status: refused.status, code: refused.body.code ?? null })
      )
      expect(refused.status).not.toBe(201)
      expect((await effects(channelId, lead.id)).channelKind).toBeNull()
    })

    test('REPRO roster replacement: an existing host group, a foreign enlisted agent through the participants route', async () => {
      const { lead, workspace: W } = await foreignWorkspace()
      const attacker = await session()
      const { workspace: H } = await hostWorkspace(attacker, 'Host for roster replacement')
      const channelId = crypto.randomUUID()
      const created = await createGroup(attacker, H.id, channelId, [])
      expect(created.status).toBe(201)
      const replaced = await invoke(
        participantsRoute.Route.options.server.handlers.POST!,
        `/api/v1/workspaces/${H.id}/channels/${channelId}/participants`,
        { channelId, workspaceId: H.id },
        attacker,
        {
          enlistmentGrants: [enlistmentGrant(channelId, lead.id, W.id)],
          participants: [
            { kind: 'user', userId: attacker.principal.userId },
            { kind: 'agent', agentId: lead.id },
          ],
        },
        { 'if-match': String(created.body.channel.version) }
      )
      console.log(
        'REPRO roster',
        JSON.stringify({
          status: replaced.status,
          code: replaced.body.code ?? null,
          message: replaced.body.message ?? null,
        })
      )
      const after = await effects(channelId, lead.id)
      console.log(
        'REPRO roster-effects',
        JSON.stringify({ enlistmentGrantRows: after.enlistmentGrantRows })
      )
    })
  }
)
