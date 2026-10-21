// Protected Home lifecycle, end to end over the production routes (M11.01.2 / #1214,
// M11.04 / #1175).
//
// Coverage class: real product route modules, real handlers, real PostgreSQL and the
// real session resolution. The only seam is the router factory, which is replaced with an
// identity `createFileRoute` so the route modules load under bun; the handlers are the
// production functions, reached through `Route.server.handlers`.
//
// The suite consumes the W6 readiness contract — `projectWorkspaceLeadSetup` and
// `projectWorkspaceLeadPresentation` — against the records the backend actually produced.
// The contract is not restated or edited here: the backend has to satisfy it, and this
// suite is the proof that it does.
//
// What the suite pins:
//   - the bootstrap is replay-safe and provisions exactly one protected personal Home;
//   - a blank optional workspace inherits no lead, agent, channel, credential or context;
//   - the rename contract is scope-aware and revision-safe, and Home keeps its identity;
//   - the archive contract refuses the protected Home and preserves an optional
//     workspace's history and links; permanent deletion stays blocked;
//   - the structural lead stays setup-blocked until an eligible funding source exists,
//     and the backend never fabricates a readiness or placement claim.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'

import {
  addWorkspaceMembership,
  agents,
  authorizationAuditRecords,
  createDatabase,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  ensureWorkspaceLead,
  projects,
  tasks,
  temporaryUserSessions,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
  type DatabaseConnection,
} from '@adea-ai/db'
import type { AgentSummary } from '@adea-ai/types'

import {
  createTemporaryCredential,
  digestTemporaryCredential,
} from '../../src/server/temporary-session'

// The W6 readiness contract. It is consumed, never edited: its projection decides what
// the backend's records mean, so a backend that drifts from it fails here.
import { projectWorkspaceLeadSetup } from '../../../../packages/workspace-ui/src/workspace-lead-setup'
import { projectWorkspaceLeadPresentation } from '../../../../packages/workspace-ui/src/workspace-lead-presentation'

const connectionUrl = process.env.DATABASE_URL

if (!connectionUrl) {
  // A missing database fails the lane; a silent skip would hide every route flow.
  throw new Error(
    'DATABASE_URL is required for the protected Home route lane: run it through `bun run test:integration`'
  )
}

//
// Lane: discovered by `bun run test:integration` (react-server condition, DATABASE_URL trio).
// Without DATABASE_URL the suite fails rather than skipping: a skipped lane is not a proof.

// The route modules are loaded after the router seam is in place, so the handlers under
// test are the production ones.
mock.module('@tanstack/solid-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}))
// `workspace-principal` reaches the real principal resolution through
// `@tanstack/solid-start/server`, whose module scope needs the bundler's solid aliasing;
// stub only its request helpers so the genuine temporary-session path can run under bun.
// The Neon account branch still fails closed on the stub.
mock.module('@tanstack/solid-start/server', () => ({
  getRequest: () => undefined,
  setCookie: () => undefined,
}))

type Handler = (input: { request: Request; params: Record<string, string> }) => Promise<Response>
type RouteModule = { server: { handlers: Record<string, Handler> } }

const bootstrapRoute = (await import('../../src/start/routes/api/workspaces/bootstrap'))
  .Route as unknown as RouteModule
const workspacesRoute = (await import('../../src/start/routes/api/workspaces'))
  .Route as unknown as RouteModule
const workspaceRoute = (await import('../../src/start/routes/api/workspaces/$workspaceId'))
  .Route as unknown as RouteModule
const archiveRoute = (await import('../../src/start/routes/api/workspaces/$workspaceId/archive'))
  .Route as unknown as RouteModule
const leadRoute = (
  await import('../../src/start/routes/api/v1/workspaces/$workspaceId/agents/lead')
).Route as unknown as RouteModule

type BootstrapResponse = {
  activeWorkspace: { id: string; isPersonal?: boolean } | null
  principal: { temporary: boolean; userId?: string }
  sessionRotated: boolean
  workspaces: readonly {
    canArchive?: boolean
    canDelete?: boolean
    id: string
    isPersonal?: boolean
    name: string
    version: number
  }[]
}

type WorkspaceResponse = {
  agents: readonly AgentSummary[]
  tasks: readonly { id: string }[]
  workspace: {
    canArchive?: boolean
    canDelete?: boolean
    id: string
    isPersonal?: boolean
    name: string
    version: number
  }
}

/** Presents the caller's temporary credential the way the browser session does. */
function authorized(credential: string, url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: { ...init.headers, authorization: `Temporary ${credential}` },
  })
}

const bootstrap = (credential: string) =>
  bootstrapRoute.server.handlers.POST!({
    request: authorized(credential, 'https://adea.test/api/workspaces/bootstrap', {
      method: 'POST',
    }),
    params: {},
  })

const createWorkspace = (
  credential: string,
  body: unknown,
  idempotencyKey: string | null = `home-lifecycle-${crypto.randomUUID()}`
) =>
  workspacesRoute.server.handlers.POST!({
    request: authorized(credential, 'https://adea.test/api/workspaces', {
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      method: 'POST',
    }),
    params: {},
  })

const readWorkspace = (credential: string, workspaceId: string) =>
  workspaceRoute.server.handlers.GET!({
    request: authorized(credential, `https://adea.test/api/workspaces/${workspaceId}`),
    params: { workspaceId },
  })

const renameWorkspace = (credential: string, workspaceId: string, body: unknown) =>
  workspaceRoute.server.handlers.PATCH!({
    request: authorized(credential, `https://adea.test/api/workspaces/${workspaceId}`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
    }),
    params: { workspaceId },
  })

const archiveWorkspace = (credential: string, workspaceId: string, body: unknown) =>
  archiveRoute.server.handlers.POST!({
    request: authorized(credential, `https://adea.test/api/workspaces/${workspaceId}/archive`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
    params: { workspaceId },
  })

const readLead = (credential: string, workspaceId: string) =>
  leadRoute.server.handlers.GET!({
    request: authorized(
      credential,
      `https://adea.test/api/v1/workspaces/${workspaceId}/agents/lead`
    ),
    params: { workspaceId },
  })

const provisionLead = (credential: string, workspaceId: string) =>
  leadRoute.server.handlers.POST!({
    request: authorized(
      credential,
      `https://adea.test/api/v1/workspaces/${workspaceId}/agents/lead`,
      { body: '{}', headers: { 'content-type': 'application/json' }, method: 'POST' }
    ),
    params: { workspaceId },
  })

describe('protected Home lifecycle route flow (#1214, #1175)', () => {
  let connection: DatabaseConnection
  const fixtureUsers: string[] = []
  const fixtureWorkspaces: string[] = []
  const realFetch = globalThis.fetch
  let outbound = 0

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      outbound += 1
      return realFetch(...args)
    }) as typeof fetch
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    if (fixtureWorkspaces.length) {
      await connection.db.delete(agents).where(inArray(agents.workspaceId, fixtureWorkspaces))
      // The audit log has no foreign key, so the denied authorizations this
      // suite provokes would outlive their workspace. They are disposable
      // fixtures, not product history.
      await connection.db
        .delete(authorizationAuditRecords)
        .where(inArray(authorizationAuditRecords.workspaceId, fixtureWorkspaces))
      await connection.db
        .delete(workspaceMemberships)
        .where(inArray(workspaceMemberships.workspaceId, fixtureWorkspaces))
      await connection.db.delete(workspaces).where(inArray(workspaces.id, fixtureWorkspaces))
    }
    if (fixtureUsers.length) {
      await connection.db
        .delete(temporaryUserSessions)
        .where(inArray(temporaryUserSessions.userId, fixtureUsers))
      await connection.db.delete(users).where(inArray(users.id, fixtureUsers))
    }
    await connection.close()
  })

  /** A real session: the routes resolve the caller from the presented credential. */
  async function session(label: string) {
    const credential = createTemporaryCredential()
    const created = await createTemporaryUserSession(connection.db, {
      credentialDigest: await digestTemporaryCredential(credential),
      expiresAt: new Date(Date.now() + 600_000),
    })
    fixtureUsers.push(created.principal.userId)
    return { credential, label, principal: created.principal }
  }

  /** Bootstraps and records the provisioned workspaces so the fixture can be disposed. */
  async function bootstrapHome(credential: string): Promise<BootstrapResponse> {
    const response = await bootstrap(credential)
    expect(response.status).toBe(200)
    const body = (await response.json()) as BootstrapResponse
    for (const workspace of body.workspaces) fixtureWorkspaces.push(workspace.id)
    return body
  }

  test('the bootstrap provisions one protected Home, and a replay returns the same one', async () => {
    const caller = await session('bootstrap-owner')
    const first = await bootstrapHome(caller.credential)
    expect(first.workspaces).toHaveLength(1)
    const home = first.workspaces[0]!
    expect(home).toMatchObject({ isPersonal: true, canArchive: false, canDelete: false })
    expect(first.activeWorkspace?.id).toBe(home.id)

    // A replayed bootstrap converges on the same Home: it never mints a second one.
    const replay = (await (await bootstrap(caller.credential)).json()) as BootstrapResponse
    expect(replay.workspaces.map((workspace) => workspace.id)).toEqual([home.id])
    expect(replay.activeWorkspace?.id).toBe(home.id)
    const roots = await connection.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(eq(workspaces.ownerUserId, caller.principal.userId), eq(workspaces.isPersonal, true))
      )
    expect(roots).toEqual([{ id: home.id }])
    expect(outbound).toBe(0)
  })

  test('an optional workspace is created blank and inherits nothing from Home', async () => {
    const caller = await session('blank-owner')
    const bootstrapped = await bootstrapHome(caller.credential)
    const home = bootstrapped.workspaces[0]!
    await ensureWorkspaceLead(connection.db, home.id, caller.principal)

    const created = await createWorkspace(caller.credential, { name: 'Blank', scene: 'work' })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as {
      created: boolean
      workspace: { id: string; isPersonal?: boolean }
    }
    expect(createdBody.created).toBe(true)
    expect(createdBody.workspace.isPersonal).toBe(false)
    fixtureWorkspaces.push(createdBody.workspace.id)

    // Blank means blank: no agent, no project, no task and no lead.
    for (const table of [agents, projects, tasks]) {
      expect(
        await connection.db
          .select()
          .from(table)
          .where(eq(table.workspaceId, createdBody.workspace.id))
      ).toEqual([])
    }

    // A replayed create with the same key converges on the same workspace.
    const key = `home-lifecycle-${crypto.randomUUID()}`
    const first = await createWorkspace(caller.credential, { name: 'Replay' }, key)
    const replay = await createWorkspace(caller.credential, { name: 'Replay' }, key)
    const replayBody = (await replay.json()) as { created: boolean; workspace: { id: string } }
    expect(replayBody.created).toBe(false)
    const firstBody = (await first.json()) as { workspace: { id: string } }
    expect(replayBody.workspace.id).toBe(firstBody.workspace.id)
    fixtureWorkspaces.push(firstBody.workspace.id)

    // The personal root's own creation key is reserved: a caller can never claim
    // the protected Home's identity.
    const reserved = await createWorkspace(caller.credential, { name: 'Reserved' }, 'personal:home')
    expect(reserved.status).toBe(400)
    expect((await reserved.json()) as { code: string }).toMatchObject({ code: 'invalid_request' })

    // A body that is not a workspace request is an invalid request, never a crash.
    const nullBody = await createWorkspace(caller.credential, 'null')
    expect(nullBody.status).toBe(400)
    expect((await nullBody.json()) as { code: string }).toMatchObject({ code: 'invalid_request' })
    expect(outbound).toBe(0)
  })

  test('the protected Home is renameable, never archivable, and keeps its identity', async () => {
    const caller = await session('home-owner')
    const bootstrapped = await bootstrapHome(caller.credential)
    const home = bootstrapped.workspaces[0]!

    const read = (await (
      await readWorkspace(caller.credential, home.id)
    ).json()) as WorkspaceResponse
    expect(read.workspace).toMatchObject({
      id: home.id,
      isPersonal: true,
      canArchive: false,
      canDelete: false,
    })

    // The Home may be renamed: the rename is presentation only.
    const renamed = await renameWorkspace(caller.credential, home.id, {
      expectedVersion: home.version,
      name: 'Studio',
    })
    expect(renamed.status).toBe(200)
    const renamedBody = (await renamed.json()) as {
      workspace: { id: string; isPersonal?: boolean; name: string }
    }
    expect(renamedBody.workspace).toMatchObject({ id: home.id, isPersonal: true, name: 'Studio' })

    // A stale revision conflicts instead of overwriting the current name.
    const stale = await renameWorkspace(caller.credential, home.id, {
      expectedVersion: home.version,
      name: 'Stale',
    })
    expect(stale.status).toBe(409)
    expect((await stale.json()) as { code: string }).toMatchObject({
      code: 'workspace_version_conflict',
    })

    // An unknown field is an invalid request, not a silent no-op.
    const unknown = await renameWorkspace(caller.credential, home.id, {
      expectedVersion: home.version + 1,
      isPersonal: false,
      name: 'Studio',
    })
    expect(unknown.status).toBe(400)

    // The protected Home is refused by the archive contract, with a typed refusal.
    const refused = await archiveWorkspace(caller.credential, home.id, { confirmed: true })
    expect(refused.status).toBe(409)
    expect((await refused.json()) as { code: string }).toMatchObject({
      code: 'workspace_personal_protected',
    })
    const afterRefusal = (await (
      await readWorkspace(caller.credential, home.id)
    ).json()) as WorkspaceResponse
    expect(afterRefusal.workspace).toMatchObject({ id: home.id, name: 'Studio' })
    expect(outbound).toBe(0)
  })

  test('an optional workspace archives with explicit confirmation and keeps its history and links', async () => {
    const caller = await session('archive-owner')
    const member = await session('archive-member')
    await bootstrapHome(caller.credential)
    const created = await createWorkspace(caller.credential, { name: 'Optional' })
    const createdBody = (await created.json()) as { workspace: { id: string; version: number } }
    const optional = createdBody.workspace
    fixtureWorkspaces.push(optional.id)
    await addWorkspaceMembership(connection.db, optional.id, member.principal, 'member')

    // An archive without the explicit confirmation is refused and changes nothing.
    const unconfirmed = await archiveWorkspace(caller.credential, optional.id, { confirmed: false })
    expect(unconfirmed.status).toBe(400)
    expect(
      (await (await readWorkspace(caller.credential, optional.id)).json()) as WorkspaceResponse
    ).toMatchObject({ workspace: { id: optional.id } })

    const archived = await archiveWorkspace(caller.credential, optional.id, { confirmed: true })
    expect(archived.status).toBe(200)
    expect(await archived.json()).toEqual({ archived: true, workspaceId: optional.id })

    // The archived workspace is no longer an active read target, but its row, its
    // membership and its history are retained: archive is not erasure.
    expect((await readWorkspace(caller.credential, optional.id)).status).toBe(404)
    expect(
      await connection.db.select().from(workspaces).where(eq(workspaces.id, optional.id))
    ).toHaveLength(1)
    expect(
      await connection.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, optional.id))
    ).toHaveLength(2)
    const events = await connection.db
      .select({ eventType: workspaceEvents.eventType })
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, optional.id))
    expect(events).toContainEqual({ eventType: 'workspace.archived' })
    expect(outbound).toBe(0)
  })

  test('the structural lead stays setup-blocked and the readiness contract reads it as such', async () => {
    const caller = await session('lead-owner')
    const member = await session('lead-member')
    const outsider = await session('lead-outsider')
    const bootstrapped = await bootstrapHome(caller.credential)
    const home = bootstrapped.workspaces[0]!
    await addWorkspaceMembership(connection.db, home.id, member.principal, 'member')

    // Home starts with no lead: provisioning is an explicit, authorized act.
    const before = (await (await readLead(caller.credential, home.id)).json()) as {
      lead: AgentSummary | null
    }
    expect(before.lead).toBeNull()

    const provisioned = await provisionLead(caller.credential, home.id)
    expect(provisioned.status).toBe(200)
    const lead = ((await provisioned.json()) as { lead: AgentSummary | null }).lead!
    expect(lead).toMatchObject({
      isWorkspaceLead: true,
      lifecycleState: 'active',
      profile: { id: 'workspace-lead-unconfigured', state: 'missing' },
      workspaceId: home.id,
    })

    // A repeated provisioning returns the same lead: there is never a second
    // structural identity for the workspace.
    const again = (await (await provisionLead(caller.credential, home.id)).json()) as {
      lead: AgentSummary | null
    }
    expect(again.lead?.id).toBe(lead.id)
    expect(
      await connection.db.select().from(agents).where(eq(agents.workspaceId, home.id))
    ).toHaveLength(1)

    // The W6 readiness contract reads the backend's record: the lead is not ready,
    // because no approved profile and no eligible funding source exist yet.
    const setup = projectWorkspaceLeadSetup({
      connections: null,
      defaults: null,
      lead,
    })
    expect(setup.state).toBe('unconfigured')
    expect(setup.detail).toBe('Choose an approved profile for the workspace lead in Customize.')

    // The audience is the workspace's membership, and the placement stays unknown:
    // the backend binds no execution target and infers none.
    const presentation = projectWorkspaceLeadPresentation({
      connections: null,
      lead,
      leadKnown: true,
    })
    expect(presentation.audience.label).toBe('Visible to workspace members')
    expect(presentation.placement.state).toBe('unknown')
    expect(presentation.placement.label).toContain('Placement is not inferred from model selection')

    // A member reads the lead under the same audience; an outsider reads nothing.
    const memberRead = (await (await readLead(member.credential, home.id)).json()) as {
      lead: AgentSummary | null
    }
    expect(memberRead.lead?.id).toBe(lead.id)
    expect((await readLead(outsider.credential, home.id)).status).toBe(404)
    expect(outbound).toBe(0)
  })

  test('an unauthenticated, foreign or malformed request is refused without a leak', async () => {
    const caller = await session('negative-owner')
    const outsider = await session('negative-outsider')
    const bootstrapped = await bootstrapHome(caller.credential)
    const home = bootstrapped.workspaces[0]!

    // A request with no credential at all is a guest bootstrap: it provisions a
    // temporary principal of its own, never another principal's Home.
    const anonymous = await bootstrapRoute.server.handlers.POST!({
      request: new Request('https://adea.test/api/workspaces/bootstrap', { method: 'POST' }),
      params: {},
    })
    expect(anonymous.status).toBe(200)
    const guest = (await anonymous.json()) as BootstrapResponse
    expect(guest.principal.temporary).toBe(true)
    expect(guest.principal.userId).not.toBe(caller.principal.userId)
    fixtureUsers.push(guest.principal.userId!)
    for (const workspace of guest.workspaces) fixtureWorkspaces.push(workspace.id)

    // Another principal's workspace is not readable, not writable and not archivable.
    expect((await readWorkspace(outsider.credential, home.id)).status).toBe(404)
    const foreignRename = await renameWorkspace(outsider.credential, home.id, {
      expectedVersion: home.version,
      name: 'Stolen',
    })
    expect(foreignRename.status).toBe(404)
    const foreignArchive = await archiveWorkspace(outsider.credential, home.id, { confirmed: true })
    expect(foreignArchive.status).toBe(404)

    // A malformed workspace id is an invalid request, not a database error.
    const malformed = await archiveRoute.server.handlers.POST!({
      request: authorized(
        outsider.credential,
        'https://adea.test/api/workspaces/not-a-workspace/archive',
        {
          body: JSON.stringify({ confirmed: true }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      ),
      params: { workspaceId: 'not-a-workspace' },
    })
    expect(malformed.status).toBe(400)
    expect((await malformed.json()) as { code: string }).toMatchObject({ code: 'invalid_request' })
    expect(outbound).toBe(0)
  })

  test('the bootstrap fails closed when the reserved root key is held by a row that is not a root', async () => {
    const caller = await session('reserved-key-owner')
    // A row that merely holds the root's reserved creation key is never
    // promoted into the protected root, and never stands in for one.
    const { workspace: reserved } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'personal:home',
      name: 'Reserved',
      owner: caller.principal,
    })
    fixtureWorkspaces.push(reserved.id)

    const refused = await bootstrap(caller.credential)
    expect(refused.status).toBe(404)
    expect((await refused.json()) as { code: string }).toMatchObject({
      code: 'workspace_unavailable',
    })
    // No root was minted, and the row that holds the reserved key is still not
    // a root.
    const roots = await connection.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(eq(workspaces.ownerUserId, caller.principal.userId), eq(workspaces.isPersonal, true))
      )
    expect(roots).toEqual([])
    const [row] = await connection.db
      .select({ isPersonal: workspaces.isPersonal })
      .from(workspaces)
      .where(eq(workspaces.id, reserved.id))
    expect(row?.isPersonal).toBe(false)
  })
})
