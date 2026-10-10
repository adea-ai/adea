// Route → PostgreSQL proofs for artifact-reference sharing grants (#1216).
//
// The granting workspace issues an artifact-reference grant to an audience workspace
// through three routes: create, revoke and regrant. Every request goes through the
// production route modules, with the router's `createFileRoute` stubbed so the module
// loads under bun. Principals resolve through the real temporary-credential path. The
// grant store decides every authority question from the database, so these tests check
// outcomes at the HTTP boundary: who may act, what each caller may see, and what a
// refused request leaves behind.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

mock.module('@tanstack/solid-router', () => ({
  createFileRoute: (path: string) => (options: unknown) => ({ path, options }),
}))
mock.module('@tanstack/solid-start/server', () => ({
  getRequest: () => {
    throw new Error('no request context in the route-flow lane')
  },
  setCookie: () => {},
}))

import {
  artifactReferenceGrants,
  createArtifact,
  createDatabase,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  readCurrentArtifactReferenceGrant,
  registerArtifactReferenceGrant,
  withArtifactReferenceGrantLocks,
  workspaceMemberships,
  type DatabaseConnection,
} from '@adea-ai/db'
import type { UserPrincipalRef } from '@adea-ai/types'

import {
  createTemporaryCredential,
  digestTemporaryCredential,
} from '../../src/server/temporary-session'

const url = process.env.DATABASE_URL
if (!url)
  throw new Error(
    'DATABASE_URL is required for the artifact-grant route-flow lane: run it through `bun run test:integration`'
  )

const ROUTES = '../../src/start/routes/api/v1'
const WORKSPACE = `${ROUTES}/workspaces/$workspaceId`
const CREATE = `${WORKSPACE}/artifact-grants`
const REVOKE = `${WORKSPACE}/artifact-grants/$grantId/revoke`
const REGRANT = `${WORKSPACE}/artifact-grants/$grantId/regrant`
const CHECKSUM = 'c'.repeat(64)
const FILENAME = 'SOURCE_FILE_SENTINEL.txt'

type Handler = (context: { request: Request; params: Record<string, string> }) => Promise<Response>
type RouteModule = { Route: { options: { server: { handlers: Record<string, Handler> } } } }
const routeModules = new Map<string, RouteModule>()
async function routeFor(path: string): Promise<RouteModule> {
  let module = routeModules.get(path)
  if (!module) {
    module = (await import(path)) as RouteModule
    routeModules.set(path, module)
  }
  return module
}

/** One production POST, as the mounted route receives it. */
async function post(
  path: string,
  options: Readonly<{
    body?: unknown
    credential?: string
    params: Record<string, string>
  }>
): Promise<Response> {
  const handler = (await routeFor(path)).Route.options.server.handlers.POST!
  const location = `http://adea.test${path.replace(/^.*\/api\/v1/, '/api/v1').replace(/\$(\w+)/g, (_, name: string) => options.params[name] ?? '')}`
  const headers = new Headers({ 'content-type': 'application/json' })
  if (options.credential) headers.set('authorization', `Temporary ${options.credential}`)
  const request = new Request(location, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: 'POST',
  })
  return handler({ request, params: options.params })
}

type Person = Readonly<{ credential: string; principal: UserPrincipalRef }>

function revokeAs(caller: Person, workspaceId: string, grantId: string) {
  return post(REVOKE, { credential: caller.credential, params: { grantId, workspaceId } })
}

describe.skipIf(!url)('artifact sharing grants through the production routes', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(url!)
  })
  afterAll(async () => {
    await connection.close()
  })

  async function person(): Promise<Person> {
    const credential = createTemporaryCredential()
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: await digestTemporaryCredential(credential),
      expiresAt: new Date(Date.now() + 30 * 60_000),
    })
    return { credential, principal: session.principal }
  }

  async function artifactIn(workspaceId: string, principal: UserPrincipalRef) {
    return createArtifact(connection.db, workspaceId, principal, {
      availability: 'available',
      checksumSha256: CHECKSUM,
      filename: FILENAME,
      location: { reference: `outputs/${crypto.randomUUID()}`, type: 'object_store' },
      mediaType: 'text/plain',
      sizeBytes: 32,
      sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
      sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
    })
  }

  /**
   * A granting workspace with an owner, an admin and a plain member; an audience
   * workspace whose owner is `recipient`; an `outsider` with no membership anywhere;
   * and one live artifact in the granting workspace.
   */
  async function setup() {
    const owner = await person()
    const admin = await person()
    const member = await person()
    const recipient = await person()
    const outsider = await person()
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Granting workspace',
      owner: owner.principal,
    })
    const { workspace: audience } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Audience workspace',
      owner: recipient.principal,
    })
    await connection.db.insert(workspaceMemberships).values([
      { role: 'admin', userId: admin.principal.userId, workspaceId: source.id },
      { role: 'member', userId: member.principal.userId, workspaceId: source.id },
    ])
    const artifact = await artifactIn(source.id, owner.principal)
    return { admin, artifact, audience, member, outsider, owner, recipient, source }
  }

  type Fixture = Awaited<ReturnType<typeof setup>>

  /** A create body for a fresh grant of the fixture's artifact to its audience. */
  function grantBody(f: Fixture, overrides: Record<string, unknown> = {}) {
    return {
      artifactId: f.artifact.id,
      audienceWorkspaceId: f.audience.id,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId: `grant-${crypto.randomUUID()}`,
      version: f.artifact.version,
      ...overrides,
    }
  }

  /** The identity fields of an existing grant, as a regrant body presents them. */
  function regrantBody(f: Fixture, grantId: string, expectedRevision: number) {
    return { ...grantBody(f, { grantId }), expectedRevision }
  }

  function createAs(f: Fixture, caller: Person, body: unknown) {
    return post(CREATE, {
      body,
      credential: caller.credential,
      params: { workspaceId: f.source.id },
    })
  }

  function regrantAs(f: Fixture, caller: Person, grantId: string, body: unknown) {
    return post(REGRANT, {
      body,
      credential: caller.credential,
      params: { grantId, workspaceId: f.source.id },
    })
  }

  async function rowsFor(grantId: string) {
    return connection.db
      .select()
      .from(artifactReferenceGrants)
      .where(eq(artifactReferenceGrants.grantId, grantId))
  }

  /** The owner registers a grant directly, for tests that exercise only the later routes. */
  async function registeredGrant(f: Fixture) {
    const grantId = `grant-${crypto.randomUUID()}`
    await registerArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, {
      artifactId: f.artifact.id,
      audienceWorkspaceId: f.audience.id,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId,
      version: f.artifact.version,
    })
    return grantId
  }

  test('the granting owner creates a grant at revision 1, and an identical replay returns it unchanged', async () => {
    const f = await setup()
    const body = grantBody(f)
    const created = await createAs(f, f.owner, body)
    expect(created.status).toBe(201)
    const createdText = await created.text()
    expect(JSON.parse(createdText)).toMatchObject({
      grant: {
        artifactId: f.artifact.id,
        audienceWorkspaceIds: [f.audience.id],
        grantId: body.grantId,
        revision: 1,
        revoked: false,
        sourceWorkspaceId: f.source.id,
        version: f.artifact.version,
      },
      outcome: 'registered',
    })

    const replay = await createAs(f, f.owner, body)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({
      grant: { revision: 1, revoked: false },
      outcome: 'existing',
    })
    expect(await rowsFor(body.grantId)).toHaveLength(1)
    expect(
      await readCurrentArtifactReferenceGrant(connection.db, { grantId: body.grantId, revision: 1 })
    ).toMatchObject({ revoked: false })
    // The grant carries identity and revision. The artifact's file name never reaches the caller.
    expect(createdText).not.toContain(FILENAME)
  })

  test('an admin creates a grant, the audience renounces it, and a repeated revocation changes nothing', async () => {
    const f = await setup()
    const body = grantBody(f)
    expect((await createAs(f, f.admin, body)).status).toBe(201)

    // The audience sees its revision and revocation mark only: not the artifact, digest or source.
    const renounced = await revokeAs(f.recipient, f.audience.id, body.grantId)
    expect(renounced.status).toBe(200)
    expect(await renounced.json()).toEqual({
      grant: { grantId: body.grantId, revision: 1, revoked: true },
    })

    // The granting owner's repeated revocation is idempotent: same revision, still revoked.
    const again = await revokeAs(f.owner, f.source.id, body.grantId)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({
      grant: { revision: 1, revoked: true, sourceWorkspaceId: f.source.id },
    })

    // Consumers read the canonical state: the revocation is visible on the locked authorize path.
    const seen = await withArtifactReferenceGrantLocks(
      connection.db,
      {
        artifactId: f.artifact.id,
        grantId: body.grantId,
        revision: 1,
        sourceWorkspaceId: f.source.id,
      },
      async (_transaction, state) => state
    )
    expect(seen).toMatchObject({ revision: 1, revoked: true })
  })

  test('an outsider and a plain member can neither create, revoke, nor regrant, and the grant is unchanged', async () => {
    const f = await setup()
    const body = grantBody(f)
    expect((await createAs(f, f.owner, body)).status).toBe(201)

    const outsiderAttempt = grantBody(f)
    const outsiderCreate = await createAs(f, f.outsider, outsiderAttempt)
    expect(outsiderCreate.status).toBe(404)
    expect(await outsiderCreate.json()).toEqual({
      code: 'workspace_unavailable',
      message: 'Workspace unavailable',
    })
    const memberAttempt = grantBody(f)
    expect((await createAs(f, f.member, memberAttempt)).status).toBe(404)

    expect((await revokeAs(f.outsider, f.source.id, body.grantId)).status).toBe(404)
    expect(
      (await regrantAs(f, f.outsider, body.grantId, regrantBody(f, body.grantId, 1))).status
    ).toBe(404)
    const unauthenticated = await post(CREATE, { body, params: { workspaceId: f.source.id } })
    expect(unauthenticated.status).toBe(401)

    expect(await rowsFor(outsiderAttempt.grantId)).toHaveLength(0)
    expect(await rowsFor(memberAttempt.grantId)).toHaveLength(0)
    expect(await rowsFor(body.grantId)).toMatchObject([{ revision: 1, revokedAt: null }])
  })

  test('a revoked issuer cannot create, replay, or regrant, and no grant is resurrected', async () => {
    const f = await setup()
    const revoked = grantBody(f)
    const live = grantBody(f)
    expect((await createAs(f, f.admin, revoked)).status).toBe(201)
    expect((await createAs(f, f.admin, live)).status).toBe(201)
    expect((await revokeAs(f.owner, f.source.id, revoked.grantId)).status).toBe(200)

    // The admin's authority lapses: demoted to a plain member of the granting workspace.
    await connection.db
      .update(workspaceMemberships)
      .set({ role: 'member' })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, f.source.id),
          eq(workspaceMemberships.userId, f.admin.principal.userId)
        )
      )

    // Replaying the revoked grant does not restore it, through the route or by regrant.
    expect((await createAs(f, f.admin, revoked)).status).toBe(404)
    expect(
      (await regrantAs(f, f.admin, revoked.grantId, regrantBody(f, revoked.grantId, 1))).status
    ).toBe(404)
    const [revokedRow] = await rowsFor(revoked.grantId)
    expect(revokedRow).toMatchObject({ revision: 1 })
    expect(revokedRow!.revokedAt).not.toBeNull()

    // Replaying a live grant is refused too: the store re-checks issuer authority on every path.
    expect((await createAs(f, f.admin, live)).status).toBe(404)
    await expect(
      registerArtifactReferenceGrant(connection.db, f.source.id, f.admin.principal, {
        artifactId: live.artifactId,
        audienceWorkspaceId: live.audienceWorkspaceId,
        checksumSha256: CHECKSUM,
        expiresAt: null,
        grantId: live.grantId,
        version: live.version,
      })
    ).rejects.toMatchObject({ code: 'grant_issuer_unauthorized' })
    const [liveRow] = await rowsFor(live.grantId)
    expect(liveRow).toMatchObject({ revision: 1 })
    expect(liveRow!.revokedAt).toBeNull()
  })

  test('a mismatched artifact or identity is refused and persists nothing', async () => {
    const f = await setup()
    const body = grantBody(f)
    expect((await createAs(f, f.owner, body)).status).toBe(201)

    const staleVersion = grantBody(f, { version: f.artifact.version + 1 })
    const versionResponse = await createAs(f, f.owner, staleVersion)
    expect(versionResponse.status).toBe(409)
    expect(await versionResponse.json()).toMatchObject({ code: 'grant_target_divergence' })
    expect(await rowsFor(staleVersion.grantId)).toHaveLength(0)

    const wrongDigest = grantBody(f, { checksumSha256: 'd'.repeat(64) })
    const digestResponse = await createAs(f, f.owner, wrongDigest)
    expect(digestResponse.status).toBe(409)
    expect(await digestResponse.json()).toMatchObject({ code: 'grant_target_divergence' })
    expect(await rowsFor(wrongDigest.grantId)).toHaveLength(0)

    // An artifact that lives in the audience, not the granting workspace, is unknown to the grant.
    const foreign = await artifactIn(f.audience.id, f.recipient.principal)
    const foreignBody = grantBody(f, { artifactId: foreign.id })
    const foreignResponse = await createAs(f, f.owner, foreignBody)
    expect(foreignResponse.status).toBe(404)
    expect(await foreignResponse.json()).toMatchObject({ code: 'grant_artifact_unknown' })
    expect(await rowsFor(foreignBody.grantId)).toHaveLength(0)

    // Reusing a registered grant id for another artifact is an identity conflict, not a relabel.
    const other = await artifactIn(f.source.id, f.owner.principal)
    const relabel = await createAs(f, f.owner, { ...body, artifactId: other.id })
    expect(relabel.status).toBe(409)
    expect(await relabel.json()).toMatchObject({ code: 'grant_identity_conflict' })
    expect(await rowsFor(body.grantId)).toMatchObject([{ artifactId: f.artifact.id }])

    // A body with an unknown key, or with a field omitted, is malformed and never reaches the store.
    const extraKey = await createAs(f, f.owner, { ...grantBody(f), role: 'owner' })
    expect(extraKey.status).toBe(400)
    expect(await extraKey.json()).toMatchObject({ code: 'invalid_request' })
    const missing: Record<string, unknown> = { ...grantBody(f) }
    delete missing.grantId
    expect((await createAs(f, f.owner, missing)).status).toBe(400)
  })

  test('a stale or wrong revision is refused, and only the current revision regrants', async () => {
    const f = await setup()
    const grantId = await registeredGrant(f)
    expect((await revokeAs(f.owner, f.source.id, grantId)).status).toBe(200)

    const wrongRevision = await regrantAs(f, f.owner, grantId, regrantBody(f, grantId, 2))
    expect(wrongRevision.status).toBe(409)
    expect(await wrongRevision.json()).toMatchObject({ code: 'grant_revision_conflict' })
    expect(await rowsFor(grantId)).toMatchObject([{ revision: 1, revokedAt: expect.any(Date) }])

    const regranted = await regrantAs(f, f.owner, grantId, regrantBody(f, grantId, 1))
    expect(regranted.status).toBe(200)
    expect(await regranted.json()).toMatchObject({
      grant: { revision: 2, revoked: false },
      outcome: 'registered',
    })

    // The superseded revision is never current again, so a stale caller cannot regain access.
    const stale = await regrantAs(f, f.owner, grantId, regrantBody(f, grantId, 1))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'grant_revision_conflict' })
    expect(
      await readCurrentArtifactReferenceGrant(connection.db, { grantId, revision: 1 })
    ).toBeNull()

    // A live grant presented at its current revision replays unchanged.
    const replay = await regrantAs(f, f.owner, grantId, regrantBody(f, grantId, 2))
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({
      grant: { revision: 2, revoked: false },
      outcome: 'existing',
    })

    // The path names the grant, so a body that names another grant is refused.
    const otherName = await regrantAs(
      f,
      f.owner,
      grantId,
      regrantBody(f, `grant-${crypto.randomUUID()}`, 2)
    )
    expect(otherName.status).toBe(400)
    expect(await rowsFor(grantId)).toMatchObject([{ revision: 2, revokedAt: null }])
  })

  test('a retry after revocation is refused: the replay never restores access', async () => {
    const f = await setup()
    const body = grantBody(f)
    expect((await createAs(f, f.owner, body)).status).toBe(201)
    expect((await revokeAs(f.owner, f.source.id, body.grantId)).status).toBe(200)

    const retry = await createAs(f, f.owner, body)
    expect(retry.status).toBe(409)
    expect(await retry.json()).toMatchObject({ code: 'grant_revoked_retry' })
    const [row] = await rowsFor(body.grantId)
    expect(row).toMatchObject({ revision: 1 })
    expect(row!.revokedAt).not.toBeNull()
    expect(
      await readCurrentArtifactReferenceGrant(connection.db, { grantId: body.grantId, revision: 1 })
    ).toMatchObject({ revoked: true })
  })

  test('a revocation from a workspace the grant does not bind is refused and changes nothing', async () => {
    const f = await setup()
    const body = grantBody(f)
    expect((await createAs(f, f.owner, body)).status).toBe(201)
    const unrelated = await setup()
    const response = await revokeAs(unrelated.owner, unrelated.source.id, body.grantId)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'workspace_unavailable' })
    const [row] = await rowsFor(body.grantId)
    expect(row!.revokedAt).toBeNull()
  })

  test('a create body that overflows the cap while it streams is refused, and no grant is created', async () => {
    const f = await setup()
    // Five 1 KiB pieces of whitespace: no Content-Length, and the stream crosses the 4 KiB cap.
    const pieces = Array.from({ length: 5 }, () => new Uint8Array(1_024).fill(0x20))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece)
        controller.close()
      },
    })
    const handler = (await routeFor(CREATE)).Route.options.server.handlers.POST!
    const request = new Request(
      `http://adea.test/api/v1/workspaces/${f.source.id}/artifact-grants`,
      {
        body,
        duplex: 'half',
        headers: {
          authorization: `Temporary ${f.owner.credential}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      } as RequestInit
    )
    const response = await handler({ request, params: { workspaceId: f.source.id } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'invalid_request' })
    const created = await connection.db
      .select()
      .from(artifactReferenceGrants)
      .where(eq(artifactReferenceGrants.sourceWorkspaceId, f.source.id))
    expect(created).toHaveLength(0)
  })
})
