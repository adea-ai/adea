// Authenticated request-path proof for the portable workspace export and import (M18.02.2, #1226).
//
// Coverage class: the real GET and POST route handlers (reached through `Route.server.handlers`), the
// real desktop session credential check, the real origin guard, the real per-request database client and
// the real PostgreSQL membership, audience and revocation decisions. The only seam is the router
// factory: `@tanstack/solid-router` is replaced with an identity `createFileRoute` so the route modules
// load under bun. `resolveWorkspacePrincipal` is NOT mocked: callers are identified by a desktop session
// issued by the production session service, presented with the production header contract.
//
// Earlier proofs in this lane call the response helpers with an injected principal and database
// (portable-workspace-routes, portable-residency-e2e, portable-workspace-clean-restore) and a fetch
// tripwire around those helpers. This file adds what they cannot reach:
//   - the 401/403 branches that live in the route wrappers and the principal resolver, including
//     missing, malformed, wrong, expired, revoked and allowlist-denied credentials, a disabled user, and
//     an untrusted origin, for export and import alike.
//   - private-audience canaries on the raw bytes (headers and body) the requester receives, for each of
//     an owner, a participant, a workspace member outside the audience, and an authenticated non-member.
//   - revocation between authenticated requests: group participation, workspace membership, desktop
//     session and account disablement each end the next response, with no leak in the refusal.
//   - import through the authenticated POST route into brand-new databases, with canary scans of every
//     table of the destination and of every response, and writes that do not happen on refusal.
//   - the route-level fetch fence: authenticated GET and POST handlers make no globalThis.fetch call.
//
// Not covered here (see the evidence page): mid-stream revocation inside one export, which needs the
// `hooks` seam that only the response helper exposes and is proven in portable-export-midstream-
// revocation.test.ts; the Neon-account and temporary-credential resolver branches, which need the
// framework request context and are covered by the auth boundary tests; artifact bytes (#86), replica
// sync (#193) and native checkpoints, which have no port.
//
// Required: DATABASE_URL and MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL. This file fails rather than skips.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  PORTABLE_EXTERNAL_DOMAIN_CLASSES,
  validatePortableWorkspaceExport,
  type PortableWorkspaceExport,
} from '@adea-ai/types/portable-export'
import { eq, inArray, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import {
  addWorkspaceMembership,
  artifacts,
  authIdentities,
  channelParticipants,
  channels,
  contentRefs,
  contentReplicas,
  createArtifact,
  createContentRef,
  createDatabase,
  createGroupChannel,
  createMessage,
  createProject,
  createProjectChannel,
  createUserWithAuthIdentity,
  createWorkspaceInvitation,
  createWorkspaceWithOwner,
  desktopSessions,
  getChannelForUser,
  messageArtifactReferences,
  messageMentions,
  messages,
  projectMembers,
  projects,
  removeWorkspaceMembership,
  setChannelParticipants,
  setProjectMember,
  setProjectVisibility,
  upsertContentReplica,
  users,
  workspaceInvitations,
  workspaceMemberships,
  workspaces,
  type DatabaseConnection,
  type UserPrincipalRef,
} from '@adea-ai/db'

mock.module('@tanstack/solid-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}))

const sourceUrl = process.env.DATABASE_URL
const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
if (!sourceUrl || !provisioningUrl)
  throw new Error(
    'DATABASE_URL and MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL are required: this authenticated-path proof restores into disposable databases and must not skip'
  )

type RouteModule = { server: { handlers: Record<string, Handler> } }

const exportRoute =
  (await import('../../src/start/routes/api/v1/workspaces/$workspaceId/portable-export')) as unknown as {
    Route: RouteModule
  }
const importRoute = (await import('../../src/start/routes/api/v1/portable-imports')) as unknown as {
  Route: RouteModule
}
const { desktopSessionService } = await import('../../src/server/desktop-auth')
const { withRequestScope } = await import('../../src/server/request-scope')
const { PORTABLE_API_MAX_BYTES } = await import('../../src/server/portable-workspace-request')

const run = randomBytes(6).toString('hex')
const TRUSTED_ORIGIN = 'http://127.0.0.1:4789'
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const credentialDigest = (value: string) => createHash('sha256').update(value).digest('base64url')

const projectName = `Authpath project ${run}`
const projectChannelTitle = `Authpath project lane ${run}`

const canary = {
  artifactLocator: `ARTIFACT-LOCATOR-${run}`,
  afterAdmissionText: `AFTER-ADMISSION-${run}`,
  artifactProvenance: `ARTIFACT-PROVENANCE-${run}`,
  executionRef: `EXECUTION-REF-${run}`,
  externalSession: `EXTERNAL-SESSION-${run}`,
  inviteEmail: `invitee-${run}@example.test`,
  membersText: `MEMBERS-ONLY-${run}`,
  privateText: `PRIVATE-GROUP-${run}`,
  publicText: `WORKSPACE-WIDE-${run}`,
  tamperedText: `TAMPERED-TEXT-${run}`,
}

type Person = {
  credential: string
  email: string
  name: string
  principal: UserPrincipalRef
  providerSessionId: string
  sessionId: string
}

type Handler = (input: { request: Request; params: Record<string, string> }) => Promise<Response>

/**
 * Every response any route handler returns in this file, as the client receives it. All route calls go
 * through `invoke`, and the last test scans the whole log, so a response read in passing (a status
 * check, a preflight, a refusal) is covered by the same canary scan as the ones inspected in detail.
 */
const wireLog: { label: string; raw: string }[] = []

function rawOf(status: number, headers: Headers, body: string) {
  const lines = [...headers.entries()].map(([name, value]) => `${name}: ${value}`)
  return `${status}\n${lines.join('\n')}\n${body}`
}

async function invoke(handler: Handler, input: Parameters<Handler>[0]): Promise<Response> {
  const response = await handler(input)
  const copy = response.clone()
  wireLog.push({
    label: `${input.request.method} ${new URL(input.request.url).pathname} -> ${response.status}`,
    raw: rawOf(copy.status, copy.headers, await copy.text()),
  })
  return response
}

type Destination = { admin: DatabaseConnection; connection: DatabaseConnection; name: string }

function scratchNameFor() {
  return `portable_authpath_${randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function assertDisposableScratch(name: string) {
  if (!/^portable_authpath_[0-9a-f]{16}$/.test(name)) throw new Error(`refusing to use ${name}`)
}

function urlForDatabase(database: string): string {
  const url = new URL(provisioningUrl!)
  url.pathname = `/${database}`
  return url.toString()
}

/** The production principal resolver and per-request client read DATABASE_URL at call time. */
async function againstDatabase<T>(url: string, work: () => Promise<T>): Promise<T> {
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = url
  try {
    return await work()
  } finally {
    process.env.DATABASE_URL = previous
  }
}

async function withAllowlist<T>(emails: string, work: () => Promise<T>): Promise<T> {
  const previous = process.env.ADEA_ALLOWED_EMAILS
  process.env.ADEA_ALLOWED_EMAILS = emails
  try {
    return await work()
  } finally {
    if (previous === undefined) delete process.env.ADEA_ALLOWED_EMAILS
    else process.env.ADEA_ALLOWED_EMAILS = previous
  }
}

/** Blocks and counts JavaScript calls through globalThis.fetch for one operation only. */
async function withFetchOnlyFence<T>(
  operation: () => Promise<T>
): Promise<{ attempts: number; value: T }> {
  const previousFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = (async () => {
    attempts += 1
    throw new Error('globalThis.fetch blocked by portable authenticated-path fence')
  }) as unknown as typeof fetch
  try {
    const value = await operation()
    return { attempts, value }
  } finally {
    globalThis.fetch = previousFetch
  }
}

/** The status, headers and body exactly as the client receives them, as one searchable string. */
async function wire(response: Response): Promise<{ body: string; raw: string; status: number }> {
  const body = await response.text()
  return { body, raw: rawOf(response.status, response.headers, body), status: response.status }
}

function assertAbsent(text: string, values: readonly string[]) {
  for (const value of values) expect(text).not.toContain(value)
}

function authHeaders(person: Pick<Person, 'credential' | 'sessionId'> | null, extra = {}) {
  return {
    ...(person
      ? {
          authorization: `Desktop ${person.credential}`,
          'x-adea-desktop-session': person.sessionId,
        }
      : {}),
    origin: TRUSTED_ORIGIN,
    'x-adea-client': 'desktop',
    ...extra,
  } as Record<string, string>
}

/** Issue a session through the production service against whichever database DATABASE_URL names. */
async function issue(principal: UserPrincipalRef, email: string) {
  const providerSessionId = `provider-session-${randomUUID()}`
  const session = await withRequestScope(() =>
    desktopSessionService().issue({
      email,
      providerExpiresAt: Date.now() + 60 * 60 * 1000,
      providerSessionId,
      userId: principal.userId,
    })
  )
  return { credential: session.credential, providerSessionId, sessionId: session.sessionId }
}

async function tableDump(database: DatabaseConnection['db']): Promise<string> {
  const tables = (await database.execute(
    sql`select table_name from information_schema.tables where table_schema = 'app' and table_type = 'BASE TABLE' order by 1`
  )) as unknown as { table_name: string }[]
  const parts: string[] = []
  for (const { table_name: table } of tables) {
    const rows = (await database.execute(
      sql.raw(
        `select coalesce(string_agg(row_to_json(t)::text, E'\\n' order by row_to_json(t)::text), '') as dump from app."${table}" t`
      )
    )) as unknown as { dump: string }[]
    parts.push(`-- ${table}\n${rows[0]!.dump}`)
  }
  return parts.join('\n')
}

const preflight = (origin: string) =>
  invoke(exportRoute.Route.server.handlers.OPTIONS!, {
    params: { workspaceId: randomUUID() },
    request: new Request('http://localhost/x', { headers: { origin }, method: 'OPTIONS' }),
  })

/**
 * Every user this file creates in the lane database, in creation order. Teardown deletes exactly
 * these, so a test that adds a person needs no cleanup of its own. Destination persons live in a
 * scratch database that is dropped whole, so they are not tracked here.
 */
const sourcePeople: Person[] = []

/** Every person in either database, for the final scan of the response log. */
const everyPerson: Person[] = []

async function createPerson(
  database: DatabaseConnection['db'],
  name: string,
  id?: string
): Promise<Person> {
  // A destination account is the same human with that destination's own sign-in, so its email differs
  // from the source's and the source's address stays a clean canary.
  const email = id
    ? `restored-${randomUUID()}@destination.test`
    : `${name.toLowerCase()}-${run}@example.test`
  let principal: UserPrincipalRef
  if (id) {
    await database.insert(users).values({ displayName: name, id })
    principal = { kind: 'user', userId: id }
  } else {
    principal = await createUserWithAuthIdentity(database, {
      identity: { provider: 'authpath-fixture', subject: `${name}-${run}-${randomUUID()}` },
      profile: { displayName: `${name} ${run}` },
    })
  }
  const person = { ...(await issue(principal, email)), email, name, principal }
  everyPerson.push(person)
  if (!id) sourcePeople.push(person)
  return person
}

describe('authenticated portable export and import request path', () => {
  let source: DatabaseConnection
  let workspaceId: string
  let owner: Person
  let member: Person
  let outsider: Person
  let stranger: Person
  let groupId: string
  let replicaCiphertext: string
  let inviteToken: string
  const destinations: Destination[] = []

  const people = () => [owner, member, outsider, stranger]
  const secretsOf = (...subjects: Person[]) =>
    subjects.flatMap((person) => [
      person.credential,
      credentialDigest(person.credential),
      person.email,
      person.providerSessionId,
    ])
  const sourceSecrets = () => [
    canary.artifactLocator,
    canary.artifactProvenance,
    canary.executionRef,
    canary.externalSession,
    canary.inviteEmail,
    inviteToken,
    replicaCiphertext,
    ...secretsOf(...people()),
  ]

  function exportCall(
    person: Pick<Person, 'credential' | 'sessionId'> | null,
    id = workspaceId,
    extraHeaders: Record<string, string> = {}
  ) {
    return invoke(exportRoute.Route.server.handlers.GET!, {
      params: { workspaceId: id },
      request: new Request(`http://localhost/api/v1/workspaces/${id}/portable-export`, {
        headers: authHeaders(person, extraHeaders),
      }),
    })
  }

  function importCall(
    person: Pick<Person, 'credential' | 'sessionId'> | null,
    body: BodyInit | null,
    extraHeaders: Record<string, string> = {}
  ) {
    return invoke(importRoute.Route.server.handlers.POST!, {
      params: {},
      request: new Request('http://localhost/api/v1/portable-imports', {
        body,
        headers: authHeaders(person, { 'content-type': 'application/json', ...extraHeaders }),
        method: 'POST',
      }),
    })
  }

  async function exportAs(person: Person) {
    const response = await wire(await exportCall(person))
    expect(response.status).toBe(200)
    return { ...response, bundle: JSON.parse(response.body) as PortableWorkspaceExport }
  }

  async function provisionDestination(
    bundleUsers: PortableWorkspaceExport['content']['users'],
    importerId: string
  ): Promise<Destination & { importer: Person }> {
    const name = scratchNameFor()
    assertDisposableScratch(name)
    // Clients connect lazily. The destination is registered for teardown before the database exists, so
    // a failure in creation or migration still drops whatever was made, and `drop ... if exists`
    // tolerates a database that was never created.
    const admin = createDatabase(urlForDatabase('postgres'))
    const connection = createDatabase(urlForDatabase(name))
    const destination = { admin, connection, name }
    destinations.push(destination)
    await admin.client.unsafe(`create database "${name}"`)
    await migrate(connection.db, {
      migrationsFolder: `${import.meta.dir}/../../../../packages/db/drizzle`,
    })
    // Only the importer exists at first: the rest of the bundle's users are provisioned later.
    const importerRow = bundleUsers.find((user) => user.userId === importerId)!
    const importer = await againstDatabase(urlForDatabase(name), () =>
      createPerson(connection.db, importerRow.displayName, importerRow.userId)
    )
    return { ...destination, importer }
  }

  /**
   * A content hash of every row this file's refusals could plausibly touch: each table that carries a
   * workspace_id, restricted to the fixture workspace, plus the workspace row, the fixture users' own
   * rows, memberships and desktop sessions, and any workspace they own. A refused request must leave it
   * identical. It is scoped to the fixture, not the whole database, because other route files share
   * the lane database concurrently.
   */
  async function sourceFingerprint() {
    const ids = sourcePeople.map((person) => person.principal.userId)
    const tables = (await source.db.execute(sql`
      select c.table_name from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'app' and c.column_name = 'workspace_id' and t.table_type = 'BASE TABLE'
      order by 1`)) as unknown as { table_name: string }[]
    const hash = async (from: string, where: ReturnType<typeof sql>) => {
      const [row] = (await source.db.execute(
        sql`select count(*)::int as n, coalesce(md5(string_agg(row_to_json(t)::text, ',' order by row_to_json(t)::text)), '') as h from ${sql.raw(from)} t where ${where}`
      )) as unknown as { h: string; n: number }[]
      return `${row!.n}:${row!.h}`
    }
    const result: Record<string, string> = {}
    for (const { table_name: table } of tables)
      result[table] = await hash(`app."${table}"`, sql`t.workspace_id = ${workspaceId}`)
    result['workspaces'] = await hash(
      'app.workspaces',
      sql`t.id = ${workspaceId} or t.owner_user_id in ${ids}`
    )
    result['users'] = await hash('app.users', sql`t.id in ${ids}`)
    result['memberships'] = await hash('app.workspace_memberships', sql`t.user_id in ${ids}`)
    result['desktop_sessions'] = await hash('app.desktop_sessions', sql`t.user_id in ${ids}`)
    return result
  }

  async function removeSource(id: string) {
    const db = source.db
    await db
      .update(messages)
      .set({ replyToMessageId: null, threadRootMessageId: null })
      .where(eq(messages.workspaceId, id))
    await db.delete(messageArtifactReferences).where(eq(messageArtifactReferences.workspaceId, id))
    await db.delete(messageMentions).where(eq(messageMentions.workspaceId, id))
    await db.delete(messages).where(eq(messages.workspaceId, id))
    await db.delete(channelParticipants).where(eq(channelParticipants.workspaceId, id))
    await db.delete(channels).where(eq(channels.workspaceId, id))
    await db.delete(artifacts).where(eq(artifacts.workspaceId, id))
    await db.delete(contentReplicas).where(eq(contentReplicas.workspaceId, id))
    await db.delete(contentRefs).where(eq(contentRefs.workspaceId, id))
    await db.delete(projectMembers).where(eq(projectMembers.workspaceId, id))
    await db.delete(projects).where(eq(projects.workspaceId, id))
    await db.delete(workspaceInvitations).where(eq(workspaceInvitations.workspaceId, id))
    await db.delete(workspaceMemberships).where(eq(workspaceMemberships.workspaceId, id))
    await db.delete(workspaces).where(eq(workspaces.id, id))
  }

  beforeAll(async () => {
    source = createDatabase(sourceUrl!)
    const db = source.db
    ;[owner, member, outsider, stranger] = await Promise.all([
      createPerson(db, 'AuthpathOwner'),
      createPerson(db, 'AuthpathMember'),
      createPerson(db, 'AuthpathOutsider'),
      createPerson(db, 'AuthpathStranger'),
    ])
    const { workspace } = await createWorkspaceWithOwner(db, {
      idempotencyKey: `authpath-${run}`,
      name: 'Authpath source',
      owner: owner.principal,
    })
    workspaceId = workspace.id
    await addWorkspaceMembership(db, workspaceId, member.principal, 'member')
    await addWorkspaceMembership(db, workspaceId, outsider.principal, 'member')

    // A participants-only group (owner, member) with a private text, a native-reference message and a
    // local-authority body that has a cloud replica row.
    const group = await createGroupChannel(db, workspaceId, owner.principal, {
      idempotencyKey: `authpath-group-${run}`,
      title: 'Authpath group',
    })
    groupId = group.id
    await setChannelParticipants(
      db,
      workspaceId,
      groupId,
      owner.principal,
      [
        { kind: 'user', userId: owner.principal.userId },
        { kind: 'user', userId: member.principal.userId },
      ],
      (await getChannelForUser(db, workspaceId, groupId, owner.principal)).version
    )
    const bodyRef = randomUUID()
    await createContentRef(db, workspaceId, owner.principal, {
      availability: 'offline',
      contentType: 'message_body',
      digestSha256: 'a'.repeat(64),
      id: bodyRef,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'sensitive',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'agent_hq_e2ee_sync',
    })
    await createMessage(db, workspaceId, groupId, owner.principal, {
      bodyContentRefId: bodyRef,
      idempotencyKey: `authpath-group-body-${run}`,
      sender: owner.principal,
    })
    replicaCiphertext = randomBytes(48).toString('base64url')
    await upsertContentReplica(db, workspaceId, bodyRef, owner.principal, {
      availability: 'available',
      ciphertext: replicaCiphertext,
      digestSha256: sha256(replicaCiphertext),
      nonce: randomBytes(12).toString('base64url'),
      replicaKind: 'self_hosted_authority',
      revision: 1,
      schemaVersion: 1,
    })
    await createMessage(db, workspaceId, groupId, owner.principal, {
      bodyText: canary.privateText,
      executionRef: canary.executionRef,
      externalSessionRef: canary.externalSession,
      idempotencyKey: `authpath-group-text-${run}`,
      sender: owner.principal,
    })

    // A members-only project the member views and the outsider does not.
    const project = await createProject(db, workspaceId, owner.principal, {
      iconKey: 'folder',
      name: projectName,
    })
    await setProjectVisibility(db, workspaceId, project.id, owner.principal, 'members')
    await setProjectMember(db, workspaceId, project.id, owner.principal, {
      role: 'viewer',
      userId: member.principal.userId,
    })
    const projectChannel = await createProjectChannel(
      db,
      workspaceId,
      project.id,
      owner.principal,
      {
        idempotencyKey: `authpath-project-channel-${run}`,
        title: projectChannelTitle,
      }
    )
    await createMessage(db, workspaceId, projectChannel.id, owner.principal, {
      bodyText: canary.membersText,
      idempotencyKey: `authpath-project-text-${run}`,
      sender: owner.principal,
    })

    // A workspace-wide channel, readable by every member, as the positive control.
    const wide = await createGroupChannel(db, workspaceId, owner.principal, {
      idempotencyKey: `authpath-wide-${run}`,
      title: 'Authpath wide',
    })
    await setChannelParticipants(
      db,
      workspaceId,
      wide.id,
      owner.principal,
      people()
        .slice(0, 3)
        .map((person) => ({ kind: 'user' as const, userId: person.principal.userId })),
      (await getChannelForUser(db, workspaceId, wide.id, owner.principal)).version
    )
    await createMessage(db, workspaceId, wide.id, owner.principal, {
      bodyText: canary.publicText,
      idempotencyKey: `authpath-wide-text-${run}`,
      sender: owner.principal,
    })

    await createArtifact(db, workspaceId, owner.principal, {
      checksumSha256: 'c'.repeat(64),
      executionRef: canary.executionRef,
      filename: 'plan.pdf',
      location: { reference: canary.artifactLocator, type: 'object_store' },
      mediaType: 'application/pdf',
      provenance: { origin: canary.artifactProvenance },
      sizeBytes: 10,
      sourceArtifactRef: `plan-${run}`,
      sourcePrincipal: owner.principal,
    })
    inviteToken = (
      await createWorkspaceInvitation(db, workspaceId, owner.principal, {
        email: canary.inviteEmail,
        role: 'member',
      })
    ).token
  }, 300_000)

  afterAll(async () => {
    // Each step runs whatever the previous one did, and the first failure is rethrown at the end, so one
    // broken drop cannot leave the remaining scratch databases or fixture users behind.
    const failures: unknown[] = []
    const attempt = async (step: () => Promise<unknown>) => {
      try {
        await step()
      } catch (error) {
        failures.push(error)
      }
    }
    for (const destination of destinations) {
      assertDisposableScratch(destination.name)
      await attempt(() => destination.connection.close())
      await attempt(() =>
        destination.admin.client.unsafe(
          `drop database if exists "${destination.name}" with (force)`
        )
      )
      await attempt(() => destination.admin.close())
    }
    if (source) {
      if (workspaceId) await attempt(() => removeSource(workspaceId))
      // Sessions and identities reference the user, so they go first; then every tracked user.
      const ids = sourcePeople.map((person) => person.principal.userId)
      if (ids.length) {
        await attempt(() =>
          source.db.delete(desktopSessions).where(inArray(desktopSessions.userId, ids))
        )
        await attempt(() =>
          source.db.delete(authIdentities).where(inArray(authIdentities.userId, ids))
        )
        await attempt(() => source.db.delete(users).where(inArray(users.id, ids)))
      }
      // Independent of the tracking list: anything this run created that teardown missed fails the
      // lane instead of piling up in a shared database.
      await attempt(async () => {
        const [left] = (await source.db.execute(sql`
          select
            (select count(*)::int from app.users where display_name like ${`% ${run}`}) as users,
            (select count(*)::int from app.auth_identities
              where provider = 'authpath-fixture' and subject like ${`%-${run}-%`}) as identities,
            (select count(*)::int from app.desktop_sessions
              where email like ${`%-${run}@example.test`}) as sessions
        `)) as unknown as { identities: number; sessions: number; users: number }[]
        expect(left).toEqual({ identities: 0, sessions: 0, users: 0 })
      })
      await attempt(() => source.close())
    }
    if (failures.length) throw failures[0]
  }, 300_000)

  describe('unauthenticated and rejected callers', () => {
    test('every missing, malformed, wrong, expired, revoked or disabled credential gets one 401 and no data', async () => {
      const expired = await createPerson(source.db, 'AuthpathExpired')
      await source.db
        .update(desktopSessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(desktopSessions.sessionId, expired.sessionId))
      const revoked = await createPerson(source.db, 'AuthpathRevoked')
      await withRequestScope(() =>
        desktopSessionService().revoke({
          credential: revoked.credential,
          sessionId: revoked.sessionId,
        })
      )
      const disabled = await createPerson(source.db, 'AuthpathDisabled')
      await source.db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, disabled.principal.userId))
      await addWorkspaceMembership(source.db, workspaceId, disabled.principal, 'member')
      await addWorkspaceMembership(source.db, workspaceId, revoked.principal, 'member')
      await addWorkspaceMembership(source.db, workspaceId, expired.principal, 'member')

      const known = await exportAs(owner)
      const cases: Record<string, Pick<Person, 'credential' | 'sessionId'> | null> = {
        'disabled account': disabled,
        'expired session': expired,
        'no credential': null,
        'revoked session': revoked,
        'right credential, another session id': {
          credential: owner.credential,
          sessionId: randomUUID(),
        },
        'right session id, wrong credential': {
          credential: randomBytes(32).toString('base64url'),
          sessionId: owner.sessionId,
        },
        'session id of another user': { credential: owner.credential, sessionId: member.sessionId },
      }
      const before = await sourceFingerprint()
      const bodies = new Set<string>()
      for (const [label, person] of Object.entries(cases)) {
        for (const response of [
          await wire(await exportCall(person)),
          await wire(await importCall(person, JSON.stringify(known.bundle))),
        ]) {
          expect(response.status, label).toBe(401)
          bodies.add(response.body)
          assertAbsent(response.raw, [
            ...sourceSecrets(),
            canary.privateText,
            canary.membersText,
            workspaceId,
            ...secretsOf(expired, revoked, disabled),
          ])
          expect(response.raw.toLowerCase()).not.toContain('set-cookie')
        }
      }
      // One indistinguishable body: a caller cannot tell which check failed or whether the id exists.
      expect([...bodies]).toEqual([
        JSON.stringify({ code: 'workspace_unavailable', message: 'Workspace unavailable' }),
      ])
      expect(await sourceFingerprint()).toEqual(before)
    })

    test('a malformed authorization scheme and an untrusted or missing origin are refused before any lookup', async () => {
      const schemes = [
        { authorization: `Bearer ${owner.credential}`, 'x-adea-desktop-session': owner.sessionId },
        {
          authorization: `Desktop ${owner.credential} extra`,
          'x-adea-desktop-session': owner.sessionId,
        },
        { authorization: `Desktop short`, 'x-adea-desktop-session': owner.sessionId },
        { authorization: `Desktop ${owner.credential}`, 'x-adea-desktop-session': 'not-a-uuid' },
      ]
      for (const headers of schemes) {
        const response = await wire(
          await invoke(exportRoute.Route.server.handlers.GET!, {
            params: { workspaceId },
            request: new Request('http://localhost/x', {
              headers: { origin: TRUSTED_ORIGIN, 'x-adea-client': 'desktop', ...headers },
            }),
          })
        )
        expect(response.status).toBe(401)
        assertAbsent(response.raw, [owner.credential, canary.privateText])
      }

      const foreignOrigin = 'https://evil.example'
      for (const response of [
        await wire(await exportCall(owner, workspaceId, { origin: foreignOrigin })),
        await wire(await importCall(owner, '{}', { origin: foreignOrigin })),
      ]) {
        expect(response.status).toBe(403)
        expect(response.raw.toLowerCase()).not.toContain('access-control-allow-origin')
        assertAbsent(response.raw, [owner.credential, canary.privateText, workspaceId])
      }
      // A desktop session presented without any origin is not trusted either.
      const noOrigin = await invoke(exportRoute.Route.server.handlers.GET!, {
        params: { workspaceId },
        request: new Request('http://localhost/x', {
          headers: {
            authorization: `Desktop ${owner.credential}`,
            'x-adea-desktop-session': owner.sessionId,
          },
        }),
      })
      expect(noOrigin.status).toBe(401)
    })

    test('preflight answers only trusted origins and reveals nothing', async () => {
      const trusted = await preflight(TRUSTED_ORIGIN)
      expect(trusted.status).toBe(204)
      expect(trusted.headers.get('access-control-allow-origin')).toBe(TRUSTED_ORIGIN)
      expect(trusted.headers.get('access-control-allow-origin')).not.toBe('*')
      const untrusted = await wire(await preflight('https://evil.example'))
      expect(untrusted.status).toBe(403)
      expect(untrusted.raw.toLowerCase()).not.toContain('access-control-allow-origin')
    })

    test('the account allowlist stops an otherwise valid session at both routes', async () => {
      const bundle = (await exportAs(owner)).bundle
      const before = await sourceFingerprint()
      await withAllowlist(`someone-else-${run}@example.test`, async () => {
        for (const response of [
          await wire(await exportCall(owner)),
          await wire(await importCall(owner, JSON.stringify(bundle))),
        ]) {
          expect(response.status).toBe(401)
          assertAbsent(response.raw, [...sourceSecrets(), canary.privateText])
        }
      })
      expect(await sourceFingerprint()).toEqual(before)
      await withAllowlist(` ${owner.email.toUpperCase()} `, async () => {
        expect((await exportCall(owner)).status).toBe(200)
        // Only the listed account passes: the member's session is denied, and so is a session with no
        // recorded email while the allowlist is configured.
        expect((await exportCall(member)).status).toBe(401)
      })
    })
  })

  describe('authorized export and private-audience canaries on the wire', () => {
    let bundles: Record<'member' | 'outsider' | 'owner', Awaited<ReturnType<typeof exportAs>>>

    test('each requester receives only the audience they hold, with no credential, ciphertext, locator or native reference', async () => {
      bundles = {
        member: await exportAs(member),
        outsider: await exportAs(outsider),
        owner: await exportAs(owner),
      }
      for (const [label, result] of Object.entries(bundles)) {
        expect(validatePortableWorkspaceExport(result.bundle).ok, label).toBe(true)
        expect(result.bundle.content.workspace.name).toBe('Authpath source')
        assertAbsent(result.raw, sourceSecrets())
        expect(result.raw.toLowerCase()).not.toContain('set-cookie')
      }
      for (const result of [bundles.owner, bundles.member]) {
        expect(result.body).toContain(canary.privateText)
        expect(result.body).toContain(canary.membersText)
        expect(result.body).toContain(canary.publicText)
      }
      for (const result of [bundles.owner, bundles.member]) {
        expect(result.bundle.content.projects.map((project) => project.name)).toContain(projectName)
        expect(result.body).toContain(projectChannelTitle)
      }
      // The outsider is a workspace member but holds neither the group audience nor a project seat:
      // the group, the members-only project and that project's channel are all absent, by text and
      // by record, while the workspace-wide channel is present.
      expect(bundles.outsider.body).toContain(canary.publicText)
      assertAbsent(bundles.outsider.raw, [
        canary.privateText,
        canary.membersText,
        projectName,
        projectChannelTitle,
      ])
      expect(bundles.outsider.bundle.content.projects.map((project) => project.name)).not.toContain(
        projectName
      )
      expect(
        bundles.outsider.bundle.content.channels.some((channel) => channel.channelId === groupId)
      ).toBe(false)
    })

    test('headers: private, never cached, an attachment named only by id, no cookie, one explicit origin', async () => {
      const response = await exportCall(member)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('content-disposition')).toBe(
        `attachment; filename="workspace-${workspaceId}.portable.json"`
      )
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(response.headers.get('access-control-allow-origin')).toBe(TRUSTED_ORIGIN)
      await response.arrayBuffer()
    })

    test('an authenticated non-member, an unknown id and a malformed id are not told apart from absence', async () => {
      const refused = await wire(await exportCall(stranger))
      const unknown = await wire(await exportCall(owner, randomUUID()))
      expect(refused.status).toBe(404)
      expect(unknown.status).toBe(404)
      expect(refused.body).toBe(unknown.body)
      assertAbsent(refused.raw, [...sourceSecrets(), canary.privateText, canary.publicText])
      assertAbsent(refused.raw, [workspaceId])

      const malformed = await wire(await exportCall(owner, 'not-a-uuid'))
      expect(malformed.status).toBe(400)
      assertAbsent(malformed.raw, [...sourceSecrets(), canary.privateText])
    })

    test('authenticated GET and POST handlers make no global fetch call', async () => {
      const probe = await withFetchOnlyFence(async () => {
        const exported = await exportCall(owner)
        const text = await exported.text()
        const refused = await importCall(owner, text)
        await refused.arrayBuffer()
        return { exported: exported.status, imported: refused.status }
      })
      expect(probe.value).toEqual({ exported: 200, imported: 409 })
      expect(probe.attempts).toBe(0)

      // Positive control: the fence blocks and counts a fetch made inside it.
      const control = await withFetchOnlyFence(async () =>
        globalThis
          .fetch('https://fetch-only-tripwire.invalid')
          .catch((error: Error) => error.message)
      )
      expect(control.attempts).toBe(1)
      expect(control.value).toBe('globalThis.fetch blocked by portable authenticated-path fence')
    })
  })

  describe('revocation between authenticated requests', () => {
    test('removing a participant ends their private export on the next request, even with a live session', async () => {
      const revokedParticipant = await createPerson(source.db, 'AuthpathRevokedParticipant')
      await addWorkspaceMembership(source.db, workspaceId, revokedParticipant.principal, 'member')
      const current = (await getChannelForUser(source.db, workspaceId, groupId, owner.principal))
        .version
      await setChannelParticipants(
        source.db,
        workspaceId,
        groupId,
        owner.principal,
        [
          { kind: 'user', userId: owner.principal.userId },
          { kind: 'user', userId: member.principal.userId },
          { kind: 'user', userId: revokedParticipant.principal.userId },
        ],
        current
      )
      // A participant reads from the point they were admitted, so a text sent after admission is theirs.
      await createMessage(source.db, workspaceId, groupId, owner.principal, {
        bodyText: canary.afterAdmissionText,
        idempotencyKey: `authpath-group-after-${run}`,
        sender: owner.principal,
      })
      const before = await exportAs(revokedParticipant)
      expect(before.body).toContain(canary.afterAdmissionText)

      await setChannelParticipants(
        source.db,
        workspaceId,
        groupId,
        owner.principal,
        [
          { kind: 'user', userId: owner.principal.userId },
          { kind: 'user', userId: member.principal.userId },
        ],
        (await getChannelForUser(source.db, workspaceId, groupId, owner.principal)).version
      )
      const after = await exportAs(revokedParticipant)
      assertAbsent(after.raw, [canary.privateText, canary.afterAdmissionText, ...sourceSecrets()])
      expect(after.bundle.content.channels.some((channel) => channel.channelId === groupId)).toBe(
        false
      )
    })

    test('removing a workspace member turns the next export into the same 404 as absence', async () => {
      const leaver = await createPerson(source.db, 'AuthpathLeaver')
      await addWorkspaceMembership(source.db, workspaceId, leaver.principal, 'member')
      expect((await exportCall(leaver)).status).toBe(200)
      expect(await removeWorkspaceMembership(source.db, workspaceId, leaver.principal)).toBe(true)

      const refused = await wire(await exportCall(leaver))
      const unknown = await wire(await exportCall(leaver, randomUUID()))
      expect(refused.status).toBe(404)
      expect(refused.body).toBe(unknown.body)
      assertAbsent(refused.raw, [...sourceSecrets(), canary.publicText, canary.privateText])
    })

    test('revoking the desktop session or disabling the account ends access on the next request', async () => {
      const departing = await createPerson(source.db, 'AuthpathDeparting')
      await addWorkspaceMembership(source.db, workspaceId, departing.principal, 'member')
      expect((await exportCall(departing)).status).toBe(200)
      await withRequestScope(() =>
        desktopSessionService().revoke({
          credential: departing.credential,
          sessionId: departing.sessionId,
        })
      )
      const afterRevoke = await wire(await exportCall(departing))
      expect(afterRevoke.status).toBe(401)
      assertAbsent(afterRevoke.raw, [canary.publicText, ...secretsOf(departing)])

      const disabling = await createPerson(source.db, 'AuthpathDisabling')
      await addWorkspaceMembership(source.db, workspaceId, disabling.principal, 'member')
      expect((await exportCall(disabling)).status).toBe(200)
      await source.db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, disabling.principal.userId))
      const afterDisable = await wire(await exportCall(disabling))
      expect(afterDisable.status).toBe(401)
      assertAbsent(afterDisable.raw, [canary.publicText, ...secretsOf(disabling)])
    })

    test('a revoked session cannot import a bundle it already holds', async () => {
      const holder = await createPerson(source.db, 'AuthpathHolder')
      await addWorkspaceMembership(source.db, workspaceId, holder.principal, 'member')
      const held = await exportAs(holder)
      await withRequestScope(() =>
        desktopSessionService().revoke({
          credential: holder.credential,
          sessionId: holder.sessionId,
        })
      )
      const before = await sourceFingerprint()
      const refused = await wire(await importCall(holder, JSON.stringify(held.bundle)))
      expect(refused.status).toBe(401)
      assertAbsent(refused.raw, [...sourceSecrets(), ...secretsOf(holder)])
      expect(await sourceFingerprint()).toEqual(before)
    })
  })

  describe('authenticated import', () => {
    test('refusals through the route write nothing and echo nothing from the bundle', async () => {
      const bundle = (await exportAs(owner)).bundle
      const before = await sourceFingerprint()

      // The workspace id already exists in this database.
      const exists = await wire(await importCall(owner, JSON.stringify(bundle)))
      expect(exists.status).toBe(409)
      expect(JSON.parse(exists.body)).toEqual({ error: 'target_exists' })

      // A text edited after export no longer matches the digest it carries.
      const tampered = structuredClone(bundle)
      const victim = tampered.content.messages.find(
        (message) => message.body.kind === 'text' && message.body.text === canary.publicText
      )
      expect(victim).toBeDefined()
      victim!.body = { kind: 'text', text: canary.tamperedText }
      const mismatch = await wire(await importCall(owner, JSON.stringify(tampered)))
      expect(mismatch.status).toBe(422)
      expect(JSON.parse(mismatch.body).error).toBe('digest_mismatch')
      assertAbsent(mismatch.raw, [canary.tamperedText, canary.publicText, canary.privateText])

      // A ledger class the version-1 format does not name is refused by the contract.
      const unknownClass = structuredClone(bundle)
      unknownClass.exclusions = [
        ...unknownClass.exclusions,
        {
          authority: 'nowhere',
          class: `unknown-domain-${run}`,
          reason: 'not in version one',
          treatment: 'excluded',
        },
      ] as typeof unknownClass.exclusions
      const unnamed = await wire(await importCall(owner, JSON.stringify(unknownClass)))
      expect(unnamed.status).toBe(422)
      assertAbsent(unnamed.raw, [`unknown-domain-${run}`, ...sourceSecrets()])

      const malformed = await wire(await importCall(owner, '{"not json'))
      expect(malformed.status).toBe(400)
      const declared = await wire(
        await importCall(owner, '{}', { 'content-length': String(PORTABLE_API_MAX_BYTES + 1) })
      )
      expect(declared.status).toBe(413)
      expect(JSON.parse(declared.body)).toEqual({
        error: 'too_large',
        maxBytes: PORTABLE_API_MAX_BYTES,
      })
      const oversized = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('['))
          controller.enqueue(new TextEncoder().encode('0'.repeat(PORTABLE_API_MAX_BYTES)))
          controller.enqueue(new TextEncoder().encode(']'))
          controller.close()
        },
      })
      const streamed = await invoke(importRoute.Route.server.handlers.POST!, {
        params: {},
        request: new Request('http://localhost/api/v1/portable-imports', {
          body: oversized,
          duplex: 'half',
          headers: authHeaders(owner, { 'content-type': 'application/json' }),
          method: 'POST',
        } as RequestInit),
      })
      expect(streamed.status).toBe(413)
      await streamed.arrayBuffer()

      expect(await sourceFingerprint()).toEqual(before)
    })

    test('the owner restores through the authenticated route and the destination keeps only what the bundle permits', async () => {
      const exported = await exportAs(owner)
      const bundle = exported.bundle
      const destination = await provisionDestination(bundle.content.users, owner.principal.userId)
      const url = urlForDatabase(destination.name)

      // The bundle names users this destination does not hold yet: refused, and nothing is written.
      const emptyDestination = await tableDump(destination.connection.db)
      const unresolved = await againstDatabase(url, async () =>
        wire(await importCall(destination.importer, JSON.stringify(bundle)))
      )
      expect(unresolved.status).toBe(422)
      expect(JSON.parse(unresolved.body).error).toBe('unresolved_users')
      // Every table of the destination is byte-for-byte what it was before the refused request.
      expect(await tableDump(destination.connection.db)).toBe(emptyDestination)

      const others = bundle.content.users.filter((user) => user.userId !== owner.principal.userId)
      if (others.length)
        await destination.connection.db
          .insert(users)
          .values(others.map((user) => ({ displayName: user.displayName, id: user.userId })))

      const restored = await againstDatabase(url, () =>
        withFetchOnlyFence(async () =>
          wire(await importCall(destination.importer, JSON.stringify(bundle)))
        )
      )
      expect(restored.attempts).toBe(0)
      expect(restored.value.status).toBe(201)
      assertAbsent(restored.value.raw, [...sourceSecrets(), ...secretsOf(destination.importer)])
      const result = JSON.parse(restored.value.body) as {
        contentDigest: string
        externalDomains: { class: string; status: string }[]
        workspaceId: string
      }
      expect(result.workspaceId).toBe(workspaceId)
      expect(result.contentDigest).toBe(bundle.contentDigest.value)
      expect(result.externalDomains.map((domain) => domain.class).toSorted()).toEqual(
        [...PORTABLE_EXTERNAL_DOMAIN_CLASSES].toSorted()
      )
      expect(result.externalDomains.every((domain) => domain.status === 'unavailable')).toBe(true)

      // The destination's own export of the restored workspace is the same content for its owner.
      const reexported = await againstDatabase(url, async () =>
        wire(await exportCall(destination.importer))
      )
      expect(reexported.status).toBe(200)
      expect(JSON.parse(reexported.body).contentDigest.value).toBe(bundle.contentDigest.value)

      // Residency: nothing but the bundle's content crossed. Every table of the destination is searched.
      const dump = await tableDump(destination.connection.db)
      assertAbsent(dump, sourceSecrets())
      const rows = destination.connection.db
      expect(await rows.select().from(contentReplicas)).toEqual([])
      expect(await rows.select().from(artifacts)).toEqual([])
      expect(await rows.select().from(workspaceInvitations)).toEqual([])
      expect(
        (await rows.select().from(workspaceMemberships)).map((row) => [row.userId, row.role])
      ).toEqual([[owner.principal.userId, 'owner']])
      expect((await rows.select().from(desktopSessions)).map((row) => row.userId)).toEqual([
        owner.principal.userId,
      ])
      // Restored refs carry metadata only: the body is not here and no replica row backs it.
      const refs = await rows.select().from(contentRefs)
      expect(refs.length).toBeGreaterThan(0)
      for (const ref of refs) expect(ref.availability).toBe('missing')

      // The same bundle cannot be restored twice into the same destination.
      const restoredDump = await tableDump(destination.connection.db)
      const again = await againstDatabase(url, async () =>
        wire(await importCall(destination.importer, JSON.stringify(bundle)))
      )
      expect(again.status).toBe(409)
      expect(await tableDump(destination.connection.db)).toBe(restoredDump)
    }, 300_000)

    test('the outsider restores their own bundle and no private audience content reaches the destination', async () => {
      const exported = await exportAs(outsider)
      const bundle = exported.bundle
      const destination = await provisionDestination(
        bundle.content.users,
        outsider.principal.userId
      )
      const url = urlForDatabase(destination.name)
      const others = bundle.content.users.filter(
        (user) => user.userId !== outsider.principal.userId
      )
      if (others.length)
        await destination.connection.db
          .insert(users)
          .values(others.map((user) => ({ displayName: user.displayName, id: user.userId })))

      const restored = await againstDatabase(url, async () =>
        wire(await importCall(destination.importer, JSON.stringify(bundle)))
      )
      expect(restored.status).toBe(201)
      assertAbsent(restored.raw, [
        ...sourceSecrets(),
        canary.privateText,
        canary.membersText,
        ...secretsOf(destination.importer),
      ])

      const dump = await tableDump(destination.connection.db)
      assertAbsent(dump, [...sourceSecrets(), canary.privateText, canary.membersText])
      expect(dump).toContain(canary.publicText)
      expect(
        await destination.connection.db.select().from(channels).where(eq(channels.id, groupId))
      ).toEqual([])
    }, 300_000)

    test('an importer revoked in the destination cannot restore there', async () => {
      const exported = await exportAs(owner)
      const destination = await provisionDestination(
        exported.bundle.content.users,
        owner.principal.userId
      )
      const url = urlForDatabase(destination.name)
      await againstDatabase(url, () =>
        withRequestScope(() =>
          desktopSessionService().revoke({
            credential: destination.importer.credential,
            sessionId: destination.importer.sessionId,
          })
        )
      )
      const revokedDump = await tableDump(destination.connection.db)
      const refused = await againstDatabase(url, async () =>
        wire(await importCall(destination.importer, JSON.stringify(exported.bundle)))
      )
      expect(refused.status).toBe(401)
      expect(await tableDump(destination.connection.db)).toBe(revokedDump)
    }, 300_000)
  })

  describe('every response this file received', () => {
    test('none carries source secrets or any credential material, and every route answer was logged', () => {
      // Responses to the test's own calls (including status-only checks, preflights and refusals),
      // not only the ones inspected individually above.
      expect(wireLog.length).toBeGreaterThan(50)
      const statuses = new Set(wireLog.map((entry) => entry.raw.split('\n', 1)[0]))
      for (const status of ['200', '201', '204', '400', '401', '403', '404', '409', '413', '422'])
        expect(statuses.has(status), `no logged ${status}`).toBe(true)
      const secrets = [
        canary.artifactLocator,
        canary.artifactProvenance,
        canary.executionRef,
        canary.externalSession,
        canary.inviteEmail,
        inviteToken,
        replicaCiphertext,
        ...secretsOf(...everyPerson),
      ]
      for (const entry of wireLog) {
        for (const secret of secrets) expect(entry.raw, entry.label).not.toContain(secret)
        expect(entry.raw.toLowerCase(), entry.label).not.toContain('set-cookie')
      }
    })
  })
})
