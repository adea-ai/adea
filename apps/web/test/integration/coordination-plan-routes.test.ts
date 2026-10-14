// Route → PostgreSQL proofs for coordination plans that cite separately owned jobs (#1217).
//
// A job runs in a source workspace and publishes its result into a group channel of a separate
// audience workspace. A plan in that channel cites the job by id. Every request below goes through
// the production route modules: the same handlers the server mounts, with the router's
// `createFileRoute` stubbed so the module loads under bun. Principals resolve through the real
// temporary-credential path. Fixtures and the revocation use the canonical db functions.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { desc, eq } from 'drizzle-orm'

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
  createAgent,
  createArtifact,
  createDatabase,
  createGroupChannel,
  createProject,
  createRuntimeNodeChallenge,
  createTask,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  enqueueTaskSubmission,
  channels,
  coordinationPlanRevisions,
  coordinationPlans,
  registerArtifactReferenceGrant,
  registerRuntimeNode,
  revokeArtifactReferenceGrant,
  setChannelParticipants,
  workspaceMemberships,
  type DatabaseConnection,
  type TaskSubmissionInput,
} from '@adea-ai/db'
// The web package does not depend on the envelope package; the database package does. The
// test seals a real command envelope with the same source the database verifies it against.
import {
  generateRemoteCommandKeyPair,
  sealRemoteContent,
} from '../../../../packages/remote-content/src/index'

import {
  createTemporaryCredential,
  digestTemporaryCredential,
} from '../../src/server/temporary-session'

const url = process.env.DATABASE_URL
if (!url)
  throw new Error(
    'DATABASE_URL is required for the job-outbound route-flow lane: run it through `bun run test:integration`'
  )

const ROUTES = '../../src/start/routes/api/v1'
const WORKSPACE = `${ROUTES}/workspaces/$workspaceId`
const CHECKSUM = 'c'.repeat(64)
const profile = { id: `prf_${'0'.repeat(25)}1`, version: `pfv_${'0'.repeat(25)}1`, revision: 0 }

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

/** One production request, as the mounted route receives it. */
async function call(
  path: string,
  method: 'GET' | 'POST',
  options: Readonly<{
    body?: unknown
    credential?: string
    idempotencyKey?: string
    params: Record<string, string>
    query?: Readonly<Record<string, string>>
    signal?: AbortSignal
    version?: number
  }>
): Promise<Response> {
  const handler = (await routeFor(path)).Route.options.server.handlers[method]!
  const search = new URLSearchParams(options.query ?? {}).toString()
  const location = `http://adea.test${path.replace(/^.*\/api\/v1/, '/api/v1').replace(/\$(\w+)/g, (_, name: string) => options.params[name] ?? '')}${search ? `?${search}` : ''}`
  const headers = new Headers({ 'content-type': 'application/json' })
  if (options.credential) headers.set('authorization', `Temporary ${options.credential}`)
  if (method === 'POST') {
    headers.set('idempotency-key', options.idempotencyKey ?? crypto.randomUUID())
    headers.set('x-request-id', crypto.randomUUID())
    if (options.version !== undefined) headers.set('if-match', String(options.version))
  }
  const request = new Request(location, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return handler({ request, params: options.params })
}

const unavailableBody = { code: 'workspace_unavailable', message: 'Workspace unavailable' }
const unavailableReference = (jobId: string) => ({
  authority: 'none',
  availability: 'unavailable',
  jobId,
})

describe.skipIf(!url)(
  'coordination plans citing separately owned jobs through the production routes',
  () => {
    let connection: DatabaseConnection
    const previousSecret = process.env.NEON_AUTH_COOKIE_SECRET
    beforeAll(() => {
      connection = createDatabase(url!)
      // The event cursor is signed with the deployment secret; the lane supplies a test value.
      process.env.NEON_AUTH_COOKIE_SECRET = 'route-flow-cursor-secret-0123456789abcdef'
    })
    afterAll(async () => {
      if (previousSecret === undefined) delete process.env.NEON_AUTH_COOKIE_SECRET
      else process.env.NEON_AUTH_COOKIE_SECRET = previousSecret
      await connection.close()
    })

    /** A source owner and a separate audience with a member and a group channel the member is in. */
    async function setup() {
      const ownerCredential = createTemporaryCredential()
      const recipientCredential = createTemporaryCredential()
      const expiresAt = new Date(Date.now() + 30 * 60_000)
      const owner = await createTemporaryUserSession(connection.db, {
        credentialDigest: await digestTemporaryCredential(ownerCredential),
        expiresAt,
      })
      const recipient = await createTemporaryUserSession(connection.db, {
        credentialDigest: await digestTemporaryCredential(recipientCredential),
        expiresAt,
      })
      const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
        idempotencyKey: crypto.randomUUID(),
        name: 'Source workspace',
        owner: owner.principal,
      })
      const { workspace: audience } = await createWorkspaceWithOwner(connection.db, {
        idempotencyKey: crypto.randomUUID(),
        name: 'Audience workspace',
        owner: owner.principal,
      })
      await connection.db.insert(workspaceMemberships).values({
        role: 'member',
        userId: recipient.principal.userId,
        workspaceId: audience.id,
      })
      const channel = await createGroupChannel(connection.db, audience.id, owner.principal, {
        idempotencyKey: crypto.randomUUID(),
        title: 'Results group',
      })
      await setChannelParticipants(
        connection.db,
        audience.id,
        channel.id,
        owner.principal,
        [owner.principal, { kind: 'user', userId: recipient.principal.userId }],
        channel.version
      )
      const project = await createProject(connection.db, source.id, owner.principal, {
        name: 'Source project',
        iconKey: 'planning',
      })
      const agent = await createAgent(connection.db, source.id, owner.principal, {
        name: 'Source agent',
        profileId: profile.id,
        profileVersion: profile.version,
      })
      const artifact = await createArtifact(connection.db, source.id, owner.principal, {
        availability: 'available',
        checksumSha256: CHECKSUM,
        filename: 'SOURCE_FILE_SENTINEL.txt',
        location: { reference: `outputs/${crypto.randomUUID()}`, type: 'object_store' },
        mediaType: 'text/plain',
        sizeBytes: 32,
        sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
        sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
      })
      const grantId = `grant-${crypto.randomUUID()}`
      const registration = await registerArtifactReferenceGrant(
        connection.db,
        source.id,
        owner.principal,
        {
          artifactId: artifact.id,
          audienceWorkspaceId: audience.id,
          checksumSha256: CHECKSUM,
          expiresAt: null,
          grantId,
          version: artifact.version,
        }
      )
      return {
        agent,
        artifact,
        audience,
        channel,
        grantId,
        grantRevision: registration.state.revision,
        owner,
        ownerCredential,
        project,
        recipient,
        recipientCredential,
        source,
      }
    }

    /** A task with one submission, ready to start. The runtime node is paired through the canonical functions. */
    async function createJob(f: Awaited<ReturnType<typeof setup>>, title: string) {
      const task = await createTask(
        connection.db,
        f.source.id,
        f.owner.principal,
        {
          agentId: f.agent.id,
          projectId: f.project.id,
          title,
          objective: 'SOURCE_PROMPT_SENTINEL',
        },
        { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
      )
      const encryption = await generateRemoteCommandKeyPair()
      const publicKey = Buffer.from(
        await crypto.subtle.exportKey('raw', encryption.publicKey)
      ).toString('base64url')
      const challenge = await createRuntimeNodeChallenge(connection.db, {
        createdByUserId: f.owner.principal.userId,
        kind: 'remote_host',
        nonce: crypto.randomUUID(),
        purpose: 'pair',
        workspaceId: f.source.id,
      })
      const node = await registerRuntimeNode(connection.db, {
        challengeId: challenge.challengeId,
        displayName: 'Source host',
        keys: [
          {
            algorithm: 'ed25519' as const,
            publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
              'base64url'
            ),
            role: 'signing' as const,
          },
          { algorithm: 'x25519' as const, publicKey, role: 'command_encryption' as const },
        ],
        kind: 'remote_host',
        ownerUserId: f.owner.principal.userId,
        platform: 'fixture',
        softwareVersion: '1.0.0',
        workspaceId: f.source.id,
      })
      const requestId = crypto.randomUUID()
      const keyId = node.keys.find((key) => key.role === 'command_encryption')!.keyId
      const envelope = await sealRemoteContent({
        keyId,
        recipientPublicKey: encryption.publicKey,
        aad: {
          workspaceId: f.source.id,
          runtimeNodeId: node.id,
          requestId,
          payloadType: 'command.input',
          schemaVersion: 1,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        plaintext: new TextEncoder().encode('SOURCE_CONTEXT_SENTINEL'),
      })
      const input: TaskSubmissionInput = {
        envelope,
        profile,
        queueWhenOffline: false,
        runtimeNodeId: node.id,
      }
      await enqueueTaskSubmission(connection.db, f.source.id, task.id, f.owner.principal, input, {
        idempotencyKey: crypto.randomUUID(),
        requestId,
        expectedVersion: task.version,
      })
      return { id: task.id, version: task.version }
    }

    type Fixture = Awaited<ReturnType<typeof setup>>

    /** Starts a job through the production start route and returns its version. */
    async function startJob(f: Fixture, job: { id: string; version: number }) {
      const response = await call(`${WORKSPACE}/tasks/$taskId/start`, 'POST', {
        credential: f.ownerCredential,
        params: { taskId: job.id, workspaceId: f.source.id },
        version: job.version,
        body: {},
      })
      expect(response.status).toBe(200)
      return ((await response.json()) as { task: { version: number } }).task.version
    }

    /** Completes a job through the production complete route, as its source owner. */
    async function completeJob(
      f: Fixture,
      job: { id: string },
      version: number,
      outboundResult: Record<string, unknown>
    ) {
      return call(`${WORKSPACE}/tasks/$taskId/complete`, 'POST', {
        credential: f.ownerCredential,
        params: { taskId: job.id, workspaceId: f.source.id },
        version,
        body: { outboundResult },
      })
    }

    /** The job's lifecycle as the source workspace reports it to its owner. */
    async function sourceTask(f: Fixture, taskId: string) {
      const response = await call(`${WORKSPACE}/tasks/$taskId`, 'GET', {
        credential: f.ownerCredential,
        params: { taskId, workspaceId: f.source.id },
      })
      return (await response.json()) as { task: { lifecycleState: string; workspaceId: string } }
    }

    const PLANS = `${WORKSPACE}/channels/$channelId/plans`
    const REVISIONS = `${PLANS}/$planId/revisions`
    const REFERENCES = `${REVISIONS}/$revision/job-references`
    const NIL_UUID = '00000000-0000-4000-8000-000000000000'
    const PRIVATE_SENTINELS = [
      'SOURCE_PROMPT_SENTINEL',
      'SOURCE_CONTEXT_SENTINEL',
      'SOURCE_FILE_SENTINEL',
    ]

    type PlanView = { createdAt: string; jobIds: string[]; planId: string; revision: number }
    type ReferencesView = {
      planId: string
      references: Record<string, unknown>[]
      revision: number
    }

    /** A job published to the audience channel through the production start and complete routes. */
    async function publishedJob(
      f: Fixture,
      title: string,
      options: { artifact?: boolean; memorySource?: string } = {}
    ) {
      const job = await createJob(f, title)
      const version = await startJob(f, job)
      const response = await completeJob(f, job, version, {
        ...(options.artifact === false
          ? {}
          : { artifact: { artifactId: f.artifact.id, grantId: f.grantId } }),
        artifactPolicy: 'require',
        channelId: f.channel.id,
        ...(options.memorySource ? { memorySource: options.memorySource } : {}),
        summary: 'Approved result.',
      })
      expect(response.status).toBe(200)
      const outcome = (await response.json()) as {
        outboundPublication: { action: string; messageId: string | null }
      }
      return { ...job, messageId: outcome.outboundPublication.messageId, outcome }
    }

    function postPlan(
      f: Fixture,
      credential: string,
      jobIds: unknown,
      options: { channelId?: string; extra?: Record<string, unknown>; idempotencyKey?: string } = {}
    ) {
      return call(PLANS, 'POST', {
        body: { jobIds, ...options.extra },
        credential,
        idempotencyKey: options.idempotencyKey,
        params: { channelId: options.channelId ?? f.channel.id, workspaceId: f.audience.id },
      })
    }

    function postRevision(
      f: Fixture,
      credential: string,
      planId: string,
      body: Record<string, unknown>
    ) {
      return call(REVISIONS, 'POST', {
        body,
        credential,
        params: { channelId: f.channel.id, planId, workspaceId: f.audience.id },
      })
    }

    function getReferences(
      f: Fixture,
      credential: string | undefined,
      planId: string,
      revision: string | number,
      channelId = f.channel.id
    ) {
      return call(REFERENCES, 'GET', {
        credential,
        params: {
          channelId,
          planId,
          revision: String(revision),
          workspaceId: f.audience.id,
        },
      })
    }

    async function created(response: Response): Promise<PlanView> {
      expect(response.status).toBe(201)
      return (await response.json()) as PlanView
    }

    async function planCount(f: Fixture) {
      const rows = await connection.db
        .select({ id: coordinationPlans.id })
        .from(coordinationPlans)
        .where(eq(coordinationPlans.workspaceId, f.audience.id))
      return rows.length
    }

    test('a participant creates a plan and any participant reads its references; the read is private and carries no source detail', async () => {
      const f = await setup()
      const job = await publishedJob(f, 'Plan input')
      const response = await postPlan(f, f.recipientCredential, [job.id])
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      const plan = await created(response)
      expect(plan).toMatchObject({ jobIds: [job.id], revision: 1 })

      for (const credential of [f.recipientCredential, f.ownerCredential]) {
        const read = await getReferences(f, credential, plan.planId, 1)
        expect(read.status).toBe(200)
        expect(read.headers.get('cache-control')).toBe('private, no-store')
        const text = await read.text()
        expect(JSON.parse(text)).toEqual({
          planId: plan.planId,
          references: [
            {
              authority: 'none',
              availability: 'available',
              jobId: job.id,
              messageId: job.messageId,
            },
          ],
          revision: 1,
        })
        for (const secret of [...PRIVATE_SENTINELS, f.source.id, 'Source workspace'])
          expect(text).not.toContain(secret)
      }
      // The write response carries what the caller sent, and nothing the source holds.
      expect(JSON.stringify(plan)).not.toContain(f.source.id)
    })

    test('the actor is the authenticated principal: a body that names another author changes nothing', async () => {
      const f = await setup()
      const job = await publishedJob(f, 'Plan input')
      const plan = await created(
        await postPlan(f, f.recipientCredential, [job.id], {
          extra: {
            authorUserId: f.owner.principal.userId,
            createdByUserId: f.owner.principal.userId,
            userId: f.owner.principal.userId,
          },
        })
      )
      const [row] = await connection.db
        .select({ createdByUserId: coordinationPlans.createdByUserId })
        .from(coordinationPlans)
        .where(eq(coordinationPlans.id, plan.planId))
      expect(row?.createdByUserId).toBe(f.recipient.principal.userId)
      const revision = await created(
        await postRevision(f, f.ownerCredential, plan.planId, {
          authorUserId: f.recipient.principal.userId,
          expectedRevision: 1,
          jobIds: [job.id],
        })
      )
      const [stored] = await connection.db
        .select({ authorUserId: coordinationPlanRevisions.authorUserId })
        .from(coordinationPlanRevisions)
        .where(eq(coordinationPlanRevisions.planId, revision.planId))
        .orderBy(desc(coordinationPlanRevisions.revision))
        .limit(1)
      expect(stored?.authorUserId).toBe(f.owner.principal.userId)
    })

    test('unauthenticated, outside and wrong-channel callers get the same unavailable answer for writes and reads', async () => {
      const f = await setup()
      const job = await publishedJob(f, 'Plan input')
      const plan = await created(await postPlan(f, f.recipientCredential, [job.id]))
      const outsiderCredential = createTemporaryCredential()
      const outsider = await createTemporaryUserSession(connection.db, {
        credentialDigest: await digestTemporaryCredential(outsiderCredential),
        expiresAt: new Date(Date.now() + 30 * 60_000),
      })
      // A member of the audience workspace who is not in the group.
      await connection.db.insert(workspaceMemberships).values({
        role: 'member',
        userId: outsider.principal.userId,
        workspaceId: f.audience.id,
      })
      // A user with no membership in the audience workspace at all.
      const strangerCredential = createTemporaryCredential()
      await createTemporaryUserSession(connection.db, {
        credentialDigest: await digestTemporaryCredential(strangerCredential),
        expiresAt: new Date(Date.now() + 30 * 60_000),
      })

      const answers: Response[] = []
      for (const credential of [outsiderCredential, strangerCredential]) {
        answers.push(await postPlan(f, credential, [job.id]))
        answers.push(
          await postRevision(f, credential, plan.planId, { expectedRevision: 1, jobIds: [job.id] })
        )
        answers.push(await getReferences(f, credential, plan.planId, 1))
      }
      // Wrong channel and malformed paths read like a plan that is not there.
      answers.push(await getReferences(f, f.recipientCredential, plan.planId, 1, NIL_UUID))
      answers.push(await getReferences(f, f.recipientCredential, NIL_UUID, 1))
      answers.push(await getReferences(f, f.recipientCredential, plan.planId, 2))
      answers.push(await getReferences(f, f.recipientCredential, plan.planId, 0))
      answers.push(await getReferences(f, f.recipientCredential, plan.planId, '1.5'))
      answers.push(await getReferences(f, f.recipientCredential, plan.planId, '99999999999'))
      answers.push(await getReferences(f, f.recipientCredential, 'not-a-uuid', 1))
      for (const answer of answers) {
        expect(answer.status).toBe(404)
        expect(await answer.json()).toEqual(unavailableBody)
      }
      expect((await getReferences(f, undefined, plan.planId, 1)).status).toBe(401)
      expect((await postPlan(f, '', [job.id])).status).toBe(401)
      expect(await planCount(f)).toBe(1)
    })

    test('a citation the actor cannot read is refused exactly like an unknown job, and writes nothing', async () => {
      const f = await setup()
      const released = await publishedJob(f, 'Released')
      // Completed at source but held by memory provenance: never a publication.
      const held = await publishedJob(f, 'Held by memory', {
        artifact: false,
        memorySource: 'private',
      })
      expect(held.outcome.outboundPublication.action).toBe('hold')
      const answers = [
        await postPlan(f, f.recipientCredential, [NIL_UUID]),
        await postPlan(f, f.recipientCredential, [held.id]),
        await postPlan(f, f.recipientCredential, [released.id, held.id]),
      ]
      for (const answer of answers) {
        expect(answer.status).toBe(404)
        expect(await answer.json()).toEqual(unavailableBody)
      }
      expect(await planCount(f)).toBe(0)
    })

    test('citations are ordered, deduplicated and bounded; malformed requests are refused before any write', async () => {
      const f = await setup()
      const first = await publishedJob(f, 'First')
      const second = await publishedJob(f, 'Second', { artifact: false })
      const plan = await created(
        await postPlan(f, f.recipientCredential, [
          second.id,
          first.id.toUpperCase(),
          second.id,
          first.id,
        ])
      )
      expect(plan.jobIds).toEqual([second.id, first.id])
      const read = (await (
        await getReferences(f, f.recipientCredential, plan.planId, 1)
      ).json()) as ReferencesView
      expect(read.references.map((reference) => reference.jobId)).toEqual([second.id, first.id])

      const distinct = Array.from({ length: 51 }, () => crypto.randomUUID())
      const invalid: Response[] = [
        await postPlan(f, f.recipientCredential, distinct),
        await postPlan(f, f.recipientCredential, [first.id, 'not-a-uuid']),
        await postPlan(f, f.recipientCredential, 'nope'),
        await postPlan(f, f.recipientCredential, undefined),
        await postPlan(f, f.recipientCredential, [first.id], { idempotencyKey: 'k'.repeat(129) }),
        await call(PLANS, 'POST', {
          body: [first.id],
          credential: f.recipientCredential,
          params: { channelId: f.channel.id, workspaceId: f.audience.id },
        }),
      ]
      for (const answer of invalid) expect(answer.status).toBe(400)
      expect(await planCount(f)).toBe(1)
      // Exactly the bound is accepted; duplicates do not count toward it.
      const filler = Array.from({ length: 48 }, () => crypto.randomUUID())
      expect(
        (await postPlan(f, f.recipientCredential, [...filler, first.id, first.id, second.id]))
          .status
      ).toBe(404)
      expect((await postPlan(f, f.recipientCredential, [...distinct, first.id])).status).toBe(400)
    })

    test('create is idempotent per key and conflicts on a different request', async () => {
      const f = await setup()
      const job = await publishedJob(f, 'Plan input')
      const key = `plan-${crypto.randomUUID()}`
      const one = await created(
        await postPlan(f, f.recipientCredential, [job.id], { idempotencyKey: key })
      )
      const again = await created(
        await postPlan(f, f.recipientCredential, [job.id], { idempotencyKey: key })
      )
      expect(again).toEqual(one)
      const conflict = await postPlan(f, f.recipientCredential, [], { idempotencyKey: key })
      expect(conflict.status).toBe(409)
      expect(await planCount(f)).toBe(1)
    })

    test('revisions need the revision the writer saw: stale writes get 409, and accepted revisions stay as written', async () => {
      const f = await setup()
      const one = await publishedJob(f, 'One')
      const two = await publishedJob(f, 'Two', { artifact: false })
      const plan = await created(await postPlan(f, f.recipientCredential, [one.id]))

      const next = await created(
        await postRevision(f, f.ownerCredential, plan.planId, {
          expectedRevision: 1,
          jobIds: [two.id, one.id],
        })
      )
      expect(next).toMatchObject({ jobIds: [two.id, one.id], revision: 2 })

      for (const expectedRevision of [1, 3]) {
        const stale = await postRevision(f, f.recipientCredential, plan.planId, {
          expectedRevision,
          jobIds: [],
        })
        expect(stale.status).toBe(409)
        expect(await stale.json()).toMatchObject({ code: 'conversation_conflict' })
      }
      for (const body of [
        { jobIds: [] },
        { expectedRevision: '1', jobIds: [] },
        { expectedRevision: 1.5, jobIds: [] },
        { expectedRevision: 1 },
      ])
        expect((await postRevision(f, f.recipientCredential, plan.planId, body)).status).toBe(400)

      const read = async (revision: number) =>
        (
          (await (
            await getReferences(f, f.recipientCredential, plan.planId, revision)
          ).json()) as ReferencesView
        ).references.map((reference) => reference.jobId)
      expect(await read(1)).toEqual([one.id])
      expect(await read(2)).toEqual([two.id, one.id])
      expect((await getReferences(f, f.recipientCredential, plan.planId, 3)).status).toBe(404)
    })

    test('a citation grants no authority: the job stays with its source, the audience cannot read or complete it, and no dependency exists', async () => {
      const f = await setup()
      const job = await publishedJob(f, 'Plan input')
      const before = await sourceTask(f, job.id)
      const plan = await created(await postPlan(f, f.ownerCredential, [job.id]))
      expect((await getReferences(f, f.ownerCredential, plan.planId, 1)).status).toBe(200)

      expect(await sourceTask(f, job.id)).toEqual(before)
      for (const credential of [f.ownerCredential, f.recipientCredential]) {
        const asAudience = await call(`${WORKSPACE}/tasks/$taskId`, 'GET', {
          credential,
          params: { taskId: job.id, workspaceId: f.audience.id },
        })
        expect(asAudience.status).toBe(404)
        const complete = await call(`${WORKSPACE}/tasks/$taskId/complete`, 'POST', {
          body: {},
          credential,
          params: { taskId: job.id, workspaceId: f.audience.id },
          version: 1,
        })
        expect(complete.status).toBeGreaterThanOrEqual(400)
      }
      expect(await sourceTask(f, job.id)).toEqual(before)
    })

    test('revocation ends the reference in every revision for every reader, and it reads like an unknown job', async () => {
      const f = await setup()
      const job = await publishedJob(f, 'Plan input')
      const plan = await created(await postPlan(f, f.recipientCredential, [job.id]))
      await created(
        await postRevision(f, f.recipientCredential, plan.planId, {
          expectedRevision: 1,
          jobIds: [job.id],
        })
      )
      const available = [
        { authority: 'none', availability: 'available', jobId: job.id, messageId: job.messageId },
      ]
      for (const revision of [1, 2])
        expect(
          (
            (await (
              await getReferences(f, f.recipientCredential, plan.planId, revision)
            ).json()) as ReferencesView
          ).references
        ).toEqual(available)

      await revokeArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, f.grantId)

      for (const revision of [1, 2])
        for (const credential of [f.recipientCredential, f.ownerCredential]) {
          const read = await getReferences(f, credential, plan.planId, revision)
          expect(read.status).toBe(200)
          const body = (await read.json()) as ReferencesView
          expect(body.references).toEqual([unavailableReference(job.id)])
          for (const secret of [...PRIVATE_SENTINELS, f.grantId, f.artifact.id])
            expect(JSON.stringify(body)).not.toContain(secret)
        }
      // The channel read also withholds the publication, and retrieval by id answers like a missing message.
      expect(
        await (
          await call(`${WORKSPACE}/messages/$messageId`, 'GET', {
            credential: f.recipientCredential,
            params: { messageId: job.messageId!, workspaceId: f.audience.id },
          })
        ).json()
      ).toEqual(
        await (
          await call(`${WORKSPACE}/messages/$messageId`, 'GET', {
            credential: f.recipientCredential,
            params: { messageId: NIL_UUID, workspaceId: f.audience.id },
          })
        ).json()
      )
      // A new citation of the revoked result is refused; a plan carrying it forward is not.
      expect((await postPlan(f, f.recipientCredential, [job.id])).status).toBe(404)
      const carried = await postRevision(f, f.recipientCredential, plan.planId, {
        expectedRevision: 2,
        jobIds: [job.id],
      })
      expect(carried.status).toBe(201)
    })

    test('a roster change ends the reference for the removed reader and for them only', async () => {
      const f = await setup()
      const job = await publishedJob(f, 'Plan input', { artifact: false })
      const plan = await created(await postPlan(f, f.ownerCredential, [job.id]))
      expect((await getReferences(f, f.recipientCredential, plan.planId, 1)).status).toBe(200)
      const [channel] = await connection.db
        .select({ version: channels.version })
        .from(channels)
        .where(eq(channels.id, f.channel.id))
      await setChannelParticipants(
        connection.db,
        f.audience.id,
        f.channel.id,
        f.owner.principal,
        [f.owner.principal],
        channel!.version
      )
      const removed = await getReferences(f, f.recipientCredential, plan.planId, 1)
      expect(removed.status).toBe(404)
      expect(await removed.json()).toEqual(unavailableBody)
      // The roster change also ends the channel revision the publication was bound to, so the
      // remaining participant sees it unavailable too: the publication gate fails closed.
      const remaining = (await (
        await getReferences(f, f.ownerCredential, plan.planId, 1)
      ).json()) as ReferencesView
      expect(remaining.references).toEqual([unavailableReference(job.id)])
    })

    test('a grant revoked while a plan is being written orders before it or after it, never between', async () => {
      for (let round = 0; round < 2; round += 1) {
        const f = await setup()
        const job = await publishedJob(f, 'Plan input')
        const [write] = await Promise.all([
          postPlan(f, f.recipientCredential, [job.id]),
          revokeArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, f.grantId),
        ])
        // The plan either saw the live grant or was refused; both are valid orderings.
        expect([201, 404]).toContain(write.status)
        if (write.status === 201) {
          const plan = (await write.json()) as PlanView
          const read = (await (
            await getReferences(f, f.recipientCredential, plan.planId, 1)
          ).json()) as ReferencesView
          expect(read.references).toEqual([unavailableReference(job.id)])
        } else expect(await planCount(f)).toBe(0)
      }
    })
  }
)
