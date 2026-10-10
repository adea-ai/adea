// API → job acceptance for artifact-reference sharing grants (#1216, #1217).
//
// The sharing grant is created through the grant create route, the job publishes
// through the existing task start and complete routes, the grant is revoked and
// regranted through the grant routes, and the canonical delivery path (the outbound
// store service's `deliver`) is replayed at each step. Every request goes through the
// production route modules. Revision checks are the only thing that decides whether a
// publication bound to an earlier revision may be released again.

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
  createAgent,
  createArtifact,
  createDatabase,
  createGroupChannel,
  createJobOutboundStoreService,
  createProject,
  createRuntimeNodeChallenge,
  createTask,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  enqueueTaskSubmission,
  messages,
  registerRuntimeNode,
  setChannelParticipants,
  type DatabaseConnection,
  type TaskSubmissionInput,
  workspaceMemberships,
} from '@adea-ai/db'
import type { UserPrincipalRef } from '@adea-ai/types'
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
    'DATABASE_URL is required for the artifact-grant job lane: run it through `bun run test:integration`'
  )

const ROUTES = '../../src/start/routes/api/v1'
const WORKSPACE = `${ROUTES}/workspaces/$workspaceId`
const GRANTS = `${WORKSPACE}/artifact-grants`
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

/** One production POST as the mounted route receives it. `idempotencyKey` replays a request. */
async function post(
  path: string,
  options: Readonly<{
    body?: unknown
    credential?: string
    idempotencyKey?: string
    params: Record<string, string>
    version?: number
  }>
): Promise<Response> {
  const handler = (await routeFor(path)).Route.options.server.handlers.POST!
  const location = `http://adea.test${path.replace(/^.*\/api\/v1/, '/api/v1').replace(/\$(\w+)/g, (_, name: string) => options.params[name] ?? '')}`
  const headers = new Headers({
    'content-type': 'application/json',
    'idempotency-key': options.idempotencyKey ?? crypto.randomUUID(),
    'x-request-id': crypto.randomUUID(),
  })
  if (options.credential) headers.set('authorization', `Temporary ${options.credential}`)
  if (options.version !== undefined) headers.set('if-match', String(options.version))
  const request = new Request(location, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: 'POST',
  })
  return handler({ request, params: options.params })
}

/** One production GET as the mounted route receives it. */
async function get(
  path: string,
  options: Readonly<{
    credential?: string
    params: Record<string, string>
    query?: Record<string, string>
  }>
): Promise<Response> {
  const handler = (await routeFor(path)).Route.options.server.handlers.GET!
  const search = new URLSearchParams(options.query ?? {}).toString()
  const location = `http://adea.test${path.replace(/^.*\/api\/v1/, '/api/v1').replace(/\$(\w+)/g, (_, name: string) => options.params[name] ?? '')}${search ? `?${search}` : ''}`
  const headers = new Headers()
  if (options.credential) headers.set('authorization', `Temporary ${options.credential}`)
  return handler({
    request: new Request(location, { headers, method: 'GET' }),
    params: options.params,
  })
}

type Person = Readonly<{ credential: string; principal: UserPrincipalRef }>

describe.skipIf(!url)(
  'an artifact sharing grant, created and revoked through the routes, governs a job publication',
  () => {
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

    /** A granting (source) workspace with an owner and a live artifact, and an audience with a group channel. */
    async function setup() {
      const owner = await person()
      const recipient = await person()
      const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
        idempotencyKey: crypto.randomUUID(),
        name: 'Granting workspace',
        owner: owner.principal,
      })
      // The job's original actor writes the result into the audience, so that actor owns the audience.
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
      return { agent, artifact, audience, channel, owner, project, recipient, source }
    }

    type Fixture = Awaited<ReturnType<typeof setup>>

    /** Creates the grant through the production create route. */
    async function createGrantThroughRoute(f: Fixture) {
      const grantId = `grant-${crypto.randomUUID()}`
      const response = await post(GRANTS, {
        body: {
          artifactId: f.artifact.id,
          audienceWorkspaceId: f.audience.id,
          checksumSha256: CHECKSUM,
          expiresAt: null,
          grantId,
          version: f.artifact.version,
        },
        credential: f.owner.credential,
        params: { workspaceId: f.source.id },
      })
      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({
        grant: { grantId, revision: 1, revoked: false },
      })
      return grantId
    }

    /** Revokes through the production revoke route, as the granting owner. */
    async function revokeThroughRoute(f: Fixture, grantId: string) {
      const response = await post(`${GRANTS}/$grantId/revoke`, {
        credential: f.owner.credential,
        params: { grantId, workspaceId: f.source.id },
      })
      expect(response.status).toBe(200)
      return (await response.json()) as { grant: { revision: number; revoked: boolean } }
    }

    /** Regrants through the production regrant route at the expected revision. */
    async function regrantThroughRoute(f: Fixture, grantId: string, expectedRevision: number) {
      const response = await post(`${GRANTS}/$grantId/regrant`, {
        body: {
          artifactId: f.artifact.id,
          audienceWorkspaceId: f.audience.id,
          checksumSha256: CHECKSUM,
          expectedRevision,
          expiresAt: null,
          grantId,
          version: f.artifact.version,
        },
        credential: f.owner.credential,
        params: { grantId, workspaceId: f.source.id },
      })
      expect(response.status).toBe(200)
      return (await response.json()) as Record<string, unknown>
    }

    /** A task with one submission, ready to start. The runtime node is paired through the canonical functions. */
    async function createJob(f: Fixture, title: string) {
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

    /** Starts a job through the production start route and returns its version. */
    async function startJob(f: Fixture, job: { id: string; version: number }) {
      const response = await post(`${WORKSPACE}/tasks/$taskId/start`, {
        body: {},
        credential: f.owner.credential,
        params: { taskId: job.id, workspaceId: f.source.id },
        version: job.version,
      })
      expect(response.status).toBe(200)
      return ((await response.json()) as { task: { version: number } }).task.version
    }

    /** Completes a job through the production complete route, carrying an artifact reference. */
    async function completeJob(
      f: Fixture,
      job: { id: string },
      version: number,
      grantId: string,
      summary: string,
      idempotencyKey?: string
    ) {
      return post(`${WORKSPACE}/tasks/$taskId/complete`, {
        body: {
          outboundResult: {
            artifact: { artifactId: f.artifact.id, grantId },
            artifactPolicy: 'require',
            channelId: f.channel.id,
            summary,
          },
        },
        credential: f.owner.credential,
        idempotencyKey,
        params: { taskId: job.id, workspaceId: f.source.id },
        version,
      })
    }

    /** The audience's own view of the channel, through the production list route. */
    async function audienceChannelText(f: Fixture): Promise<string> {
      const response = await get(`${WORKSPACE}/channels/$channelId/messages`, {
        credential: f.recipient.credential,
        params: { channelId: f.channel.id, workspaceId: f.audience.id },
        query: { limit: '100' },
      })
      expect(response.status).toBe(200)
      return response.text()
    }

    /** The canonical messages a job wrote into the audience channel. */
    async function jobMessages(f: Fixture, jobId: string) {
      return connection.db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.channelId, f.channel.id), eq(messages.executionRef, jobId)))
    }

    /** The canonical delivery path, replayed for one publication. Returns the decision and whether anything was released. */
    async function deliverReplay(f: Fixture, job: { id: string }, messageId: string) {
      const service = createJobOutboundStoreService(connection.db)
      let released = 0
      const decision = await service.deliver(
        { jobId: job.id, messageId, recipientUserId: f.recipient.principal.userId },
        async () => {
          released += 1
        }
      )
      return { decision, released }
    }

    test('a grant created through the route publishes a job result; its revocation through the route withdraws it, and later and replayed publications are refused by revision', async () => {
      const f = await setup()
      const grantId = await createGrantThroughRoute(f)

      // The job publishes through the canonical completion route while the grant is live.
      const early = await createJob(f, 'Published before revocation')
      const earlyVersion = await startJob(f, early)
      const earlyKey = crypto.randomUUID()
      const published = await completeJob(
        f,
        early,
        earlyVersion,
        grantId,
        'API_PUBLISHED_SUMMARY',
        earlyKey
      )
      expect(published.status).toBe(200)
      const earlyOutcome = (await published.json()) as {
        outboundPublication: { action: string; messageId: string | null }
      }
      expect(earlyOutcome.outboundPublication).toMatchObject({ action: 'publish' })
      const earlyMessageId = earlyOutcome.outboundPublication.messageId!
      expect(await jobMessages(f, early.id)).toHaveLength(1)
      expect(await audienceChannelText(f)).toContain('API_PUBLISHED_SUMMARY')
      const beforeReleases = await deliverReplay(f, early, earlyMessageId)
      expect(beforeReleases).toMatchObject({ decision: { action: 'deliver' }, released: 1 })

      // The granting owner revokes through the route. The published result leaves the audience.
      expect(await revokeThroughRoute(f, grantId)).toMatchObject({
        grant: { grantId, revision: 1, revoked: true, sourceWorkspaceId: f.source.id },
      })
      expect(await audienceChannelText(f)).not.toContain('API_PUBLISHED_SUMMARY')

      // A later job's result is held at completion: nothing is published, nothing reaches the audience.
      const later = await createJob(f, 'Completed after revocation')
      const laterVersion = await startJob(f, later)
      const held = await completeJob(f, later, laterVersion, grantId, 'API_LATER_SUMMARY')
      expect(held.status).toBe(200)
      expect(await held.json()).toMatchObject({
        outboundPublication: { action: 'hold', messageId: null, reason: 'grant_revoked' },
      })
      expect(await audienceChannelText(f)).not.toContain('API_LATER_SUMMARY')

      // The canonical delivery path, replayed for the early publication, refuses it at revision 1.
      const revoked = await deliverReplay(f, early, earlyMessageId)
      expect(revoked).toMatchObject({
        decision: { action: 'deny', reason: 'grant_revoked' },
        released: 0,
      })

      // The owner regrants through the route at the current revision. The grant is live again, at revision 2.
      expect(await regrantThroughRoute(f, grantId, 1)).toMatchObject({
        grant: { grantId, revision: 2, revoked: false },
        outcome: 'registered',
      })

      // The early publication stays withheld: it is bound to revision 1, and the current revision is 2.
      // A superseded revision reads as absent to the canonical reader, so the denial is `grant_not_registered`.
      const stale = await deliverReplay(f, early, earlyMessageId)
      expect(stale).toMatchObject({
        decision: { action: 'deny', gate: 'artifact', reason: 'grant_not_registered' },
        released: 0,
      })
      expect(await audienceChannelText(f)).not.toContain('API_PUBLISHED_SUMMARY')

      // A completion replayed with the original key is not a second publication, and the audience still does not see it.
      const replayed = await completeJob(
        f,
        early,
        earlyVersion,
        grantId,
        'API_PUBLISHED_SUMMARY',
        earlyKey
      )
      // The replay converges on the publication already written: the same message id, and no second message.
      expect(replayed.status).toBe(200)
      expect(
        ((await replayed.json()) as { outboundPublication: { messageId: string } })
          .outboundPublication.messageId
      ).toBe(earlyMessageId)
      expect(await jobMessages(f, early.id)).toHaveLength(1)
      expect(await audienceChannelText(f)).not.toContain('API_PUBLISHED_SUMMARY')

      // Positive control: a job completed under the regranted revision publishes, and reaches the audience.
      const after = await createJob(f, 'Completed after regrant')
      const afterVersion = await startJob(f, after)
      const released = await completeJob(f, after, afterVersion, grantId, 'API_REGRANTED_SUMMARY')
      expect(await released.json()).toMatchObject({ outboundPublication: { action: 'publish' } })
      expect(await audienceChannelText(f)).toContain('API_REGRANTED_SUMMARY')
    }, 60_000)
  }
)
