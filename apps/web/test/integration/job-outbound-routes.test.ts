// Route → PostgreSQL proofs for cross-workspace job results (#1217).
//
// A job runs in a source workspace and publishes its result into a group channel
// of a separate audience workspace. The source grants the audience one artifact
// through a sharing grant, and the grant is revoked after the job starts. Every
// request below goes through the production route modules: the same handlers the
// server mounts, with the router's `createFileRoute` stubbed so the module loads
// under bun. Principals resolve through the real temporary-credential path.
// Fixtures (the runtime node, the artifact and its grant) are created through the
// canonical db functions, and the revocation is the canonical db call.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { eq } from 'drizzle-orm'

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
  createMessage,
  createWorkspaceWithOwner,
  enqueueTaskSubmission,
  messages,
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

import { encodeWorkspaceEventCursor } from '../../src/server/event-cursor'
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
    headers.set('idempotency-key', crypto.randomUUID())
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

describe.skipIf(!url)(
  'job outbound results across workspaces through the production routes',
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

    /** What the audience reads of its channel: its messages, through the production list route. */
    async function audienceMessages(f: Fixture) {
      const response = await call(`${WORKSPACE}/channels/$channelId/messages`, 'GET', {
        credential: f.recipientCredential,
        params: { workspaceId: f.audience.id, channelId: f.channel.id },
        query: { limit: '100' },
      })
      expect(response.status).toBe(200)
      return await response.text()
    }

    async function audienceSearch(f: Fixture, term: string) {
      const response = await call(`${WORKSPACE}/search`, 'GET', {
        credential: f.recipientCredential,
        params: { workspaceId: f.audience.id },
        query: { q: term },
      })
      expect(response.status).toBe(200)
      return await response.text()
    }

    async function audienceReadState(f: Fixture) {
      const response = await call(`${WORKSPACE}/read-state`, 'GET', {
        credential: f.recipientCredential,
        params: { workspaceId: f.audience.id },
      })
      expect(response.status).toBe(200)
      return (await response.json()) as {
        readState: {
          channelId: string
          threadUnreadCount: number
          threads: unknown[]
          unread: boolean
        }[]
      }
    }

    async function audienceSummary(f: Fixture) {
      const response = await call(`${ROUTES}/account/summary`, 'GET', {
        credential: f.recipientCredential,
        params: {},
      })
      expect(response.status).toBe(200)
      return (await response.json()) as {
        workspaces: { unreadChannels: number; workspaceId: string }[]
      }
    }

    async function audienceInboxEntry(f: Fixture) {
      const response = await call(`${ROUTES}/account/conversations`, 'GET', {
        credential: f.recipientCredential,
        params: {},
      })
      expect(response.status).toBe(200)
      const page = (await response.json()) as {
        conversations: { id: string; threadUnreadCount: number; unread: boolean }[]
      }
      return page.conversations.find((entry) => entry.id === f.channel.id)
    }

    /** The event frames the audience's stream sends from the start of the audience's log. */
    async function audienceEvents(f: Fixture) {
      const cursor = await encodeWorkspaceEventCursor({ sequence: 0, workspaceId: f.audience.id })
      expect(cursor).toBeTruthy()
      const controller = new AbortController()
      const response = await call(`${WORKSPACE}/events`, 'GET', {
        credential: f.recipientCredential,
        params: { workspaceId: f.audience.id },
        query: { cursor: cursor! },
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let text = ''
      const timer = setTimeout(() => controller.abort(), 1_500)
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          text += decoder.decode(value, { stream: true })
        }
      } catch {
        // The stream ends with the abort above; what arrived before it is the audience's view.
      } finally {
        clearTimeout(timer)
      }
      return text
    }

    /** The audience's own error for a message it cannot see, next to the error for one that does not exist. */
    async function unavailableMessage(f: Fixture, messageId: string) {
      const response = await call(`${WORKSPACE}/messages/$messageId`, 'GET', {
        credential: f.recipientCredential,
        params: { workspaceId: f.audience.id, messageId },
      })
      return { body: await response.json(), status: response.status }
    }

    test('a late result after its sharing grant is revoked is held: the job completes at source, nothing reaches the audience, and the artifact is never released', async () => {
      const f = await setup()
      const job = await createJob(f, 'Late job')
      const version = await startJob(f, job)
      // The grant is revoked after the job started, and before its result arrives.
      await revokeArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, f.grantId)

      const completed = await completeJob(f, job, version, {
        artifact: { artifactId: f.artifact.id, grantId: f.grantId },
        artifactPolicy: 'require',
        channelId: f.channel.id,
        summary: 'LATE_SUMMARY',
      })
      expect(completed.status).toBe(200)
      const outcome = (await completed.json()) as {
        outboundPublication: { action: string; messageId: string | null; reason: string }
        task: { lifecycleState: string }
      }
      expect(outcome.outboundPublication).toMatchObject({
        action: 'hold',
        messageId: null,
        reason: 'grant_revoked',
      })
      expect(outcome.task.lifecycleState).toBe('completed')

      // Ownership stays at source: the owner reads the job; the audience does not.
      expect((await sourceTask(f, job.id)).task.workspaceId).toBe(f.source.id)
      const asAudience = await call(`${WORKSPACE}/tasks/$taskId`, 'GET', {
        credential: f.recipientCredential,
        params: { taskId: job.id, workspaceId: f.audience.id },
      })
      expect(asAudience.status).toBe(404)

      // Positive control: an ordinary message in the same channel is visible to the audience in every surface.
      await createMessage(connection.db, f.audience.id, f.channel.id, f.owner.principal, {
        bodyText: 'ORDINARY_NOTE',
        idempotencyKey: `note-${crypto.randomUUID()}`,
        sender: { kind: 'user', userId: f.owner.principal.userId },
      })
      expect(await audienceMessages(f)).toContain('ORDINARY_NOTE')
      expect(await audienceSearch(f, 'ORDINARY_NOTE')).toContain('ORDINARY_NOTE')
      expect(await audienceEvents(f)).toContain('message.created')
      expect(
        (await audienceReadState(f)).readState.find((row) => row.channelId === f.channel.id)
      ).toMatchObject({
        topLevelUnreadCount: 1,
        unread: true,
      })

      // The audience sees no message, snippet, count or event carrying the result.
      expect(await audienceMessages(f)).not.toContain('LATE_SUMMARY')
      expect(await audienceSearch(f, 'LATE_SUMMARY')).not.toContain('LATE_SUMMARY')
      const state = await audienceReadState(f)
      // The only unread in the channel is the ordinary note: the held result adds no count.
      expect(state.readState.find((row) => row.channelId === f.channel.id)).toMatchObject({
        threadUnreadCount: 0,
        topLevelUnreadCount: 1,
      })
      expect(
        (await audienceSummary(f)).workspaces.find((row) => row.workspaceId === f.audience.id)
      ).toMatchObject({
        unreadChannels: 1,
      })
      expect(await audienceEvents(f)).not.toContain('LATE_SUMMARY')
    })

    test('a late result under the omit policy publishes its summary without the artifact: no artifact identity reaches the audience', async () => {
      const f = await setup()
      const job = await createJob(f, 'Omitted job')
      const version = await startJob(f, job)
      await revokeArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, f.grantId)

      const completed = await completeJob(f, job, version, {
        artifact: { artifactId: f.artifact.id, grantId: f.grantId },
        artifactPolicy: 'omit_unauthorized',
        channelId: f.channel.id,
        summary: 'OMIT_SUMMARY',
      })
      const outcome = (await completed.json()) as {
        outboundPublication: { action: string; messageId: string | null }
      }
      expect(outcome.outboundPublication.action).toBe('publish')
      expect(outcome.outboundPublication.messageId).toBeTruthy()

      const listed = await audienceMessages(f)
      expect(listed).toContain('OMIT_SUMMARY')
      for (const withheld of [f.artifact.id, f.grantId, CHECKSUM, 'SOURCE_FILE_SENTINEL'])
        expect(listed).not.toContain(withheld)
      expect(await audienceSearch(f, 'OMIT_SUMMARY')).toContain('OMIT_SUMMARY')
      expect(await audienceSearch(f, 'SOURCE_FILE_SENTINEL')).not.toContain('SOURCE_FILE_SENTINEL')
      const frames = await audienceEvents(f)
      expect(frames).toContain('message.created')
      expect(frames).not.toContain(f.artifact.id)
      expect(frames).not.toContain(f.grantId)
    })

    test('a result published before its grant is revoked leaves the audience at revocation, with its thread, counts and events; the replies stay stored', async () => {
      const f = await setup()
      const job = await createJob(f, 'Published job')
      const version = await startJob(f, job)
      const completed = await completeJob(f, job, version, {
        artifact: { artifactId: f.artifact.id, grantId: f.grantId },
        artifactPolicy: 'require',
        channelId: f.channel.id,
        summary: 'PUBLISHED_SUMMARY',
      })
      const published = (await completed.json()) as {
        outboundPublication: { action: string; messageId: string }
      }
      expect(published.outboundPublication.action).toBe('publish')
      const rootId = published.outboundPublication.messageId

      // The audience replies in the job's thread while the result is visible.
      const reply = await call(`${WORKSPACE}/channels/$channelId/messages`, 'POST', {
        credential: f.ownerCredential,
        params: { workspaceId: f.audience.id, channelId: f.channel.id },
        body: { bodyText: 'REPLY_SENTINEL', threadRootMessageId: rootId },
      })
      expect(reply.status).toBe(201)
      const replyId = ((await reply.json()) as { message: { id: string } }).message.id

      expect(await audienceMessages(f)).toContain('REPLY_SENTINEL')
      expect(await audienceSearch(f, 'PUBLISHED_SUMMARY')).toContain(rootId)
      expect(
        (await audienceReadState(f)).readState.find((row) => row.channelId === f.channel.id)
      ).toMatchObject({
        threadUnreadCount: 1,
      })
      expect((await audienceInboxEntry(f))!.threadUnreadCount).toBe(1)
      // Notifications carry identities, never bodies: the reply and its root are delivered by id.
      const delivered = await audienceEvents(f)
      expect(delivered).toContain(replyId)
      expect(delivered).toContain(rootId!)

      // The grant is revoked. The result is hidden from the audience, with its thread.
      await revokeArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, f.grantId)
      const listed = await audienceMessages(f)
      expect(listed).not.toContain('PUBLISHED_SUMMARY')
      expect(listed).not.toContain('REPLY_SENTINEL')
      expect(listed).not.toContain(rootId!)
      expect(await audienceSearch(f, 'PUBLISHED_SUMMARY')).not.toContain('PUBLISHED_SUMMARY')
      expect(await audienceSearch(f, 'REPLY_SENTINEL')).not.toContain('REPLY_SENTINEL')
      const state = await audienceReadState(f)
      const channelState = state.readState.find((row) => row.channelId === f.channel.id)!
      expect(channelState.threads).toEqual([])
      expect(channelState.threadUnreadCount).toBe(0)
      expect(JSON.stringify(state)).not.toContain(rootId!)
      expect((await audienceInboxEntry(f))!.threadUnreadCount).toBe(0)
      expect(
        (await audienceSummary(f)).workspaces.find((row) => row.workspaceId === f.audience.id)!
          .unreadChannels
      ).toBe(0)
      const frames = await audienceEvents(f)
      expect(frames).not.toContain('PUBLISHED_SUMMARY')
      expect(frames).not.toContain('REPLY_SENTINEL')
      expect(frames).not.toContain(rootId!)
      expect(frames).not.toContain(replyId)
      expect(frames).toContain('withheld')

      // A thread read and a message read for the hidden root are refused as a missing root is.
      const threadRead = await call(
        `${WORKSPACE}/read-state/threads/$threadRootMessageId`,
        'POST',
        {
          credential: f.ownerCredential,
          params: { workspaceId: f.audience.id, threadRootMessageId: rootId! },
          body: { action: 'read', channelId: f.channel.id },
        }
      )
      const missingRead = await call(
        `${WORKSPACE}/read-state/threads/$threadRootMessageId`,
        'POST',
        {
          credential: f.ownerCredential,
          params: { workspaceId: f.audience.id, threadRootMessageId: crypto.randomUUID() },
          body: { action: 'read', channelId: f.channel.id },
        }
      )
      expect(threadRead.status).toBe(404)
      expect(await threadRead.json()).toEqual(await missingRead.json())
      // The reader's view of the hidden thread is empty: no reply and no root id is listed.
      const threadView = await call(`${WORKSPACE}/channels/$channelId/messages`, 'GET', {
        credential: f.recipientCredential,
        params: { workspaceId: f.audience.id, channelId: f.channel.id },
        query: { limit: '100', threadRootMessageId: rootId! },
      })
      expect(await threadView.text()).toBe('{"messages":[]}')
      expect(await unavailableMessage(f, rootId!)).toEqual(
        await unavailableMessage(f, crypto.randomUUID())
      )

      // Stored, not deleted: the reply is still in the audience's channel.
      const [storedReply] = await connection.db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.id, replyId))
      expect(storedReply?.id).toBe(replyId)
      // The job is still the source's, and it is complete.
      expect((await sourceTask(f, job.id)).task.lifecycleState).toBe('completed')
    })

    test('audience attempts against the source job, and a completion that names a destination it cannot reach, are refused and change nothing', async () => {
      const f = await setup()
      const job = await createJob(f, 'Guarded job')
      const version = await startJob(f, job)
      const before = await sourceTask(f, job.id)
      const stranger = await createTemporaryUserSession(connection.db, {
        credentialDigest: await digestTemporaryCredential(createTemporaryCredential()),
        expiresAt: new Date(Date.now() + 60_000),
      })
      const { workspace: unrelated } = await createWorkspaceWithOwner(connection.db, {
        idempotencyKey: crypto.randomUUID(),
        name: 'Unrelated workspace',
        owner: stranger.principal,
      })
      const unrelatedChannel = await createGroupChannel(
        connection.db,
        unrelated.id,
        stranger.principal,
        {
          idempotencyKey: crypto.randomUUID(),
          title: 'Unrelated group',
        }
      )
      const sourceChannel = await createGroupChannel(
        connection.db,
        f.source.id,
        f.owner.principal,
        {
          idempotencyKey: crypto.randomUUID(),
          title: 'Source group',
        }
      )
      const unknownId = crypto.randomUUID()

      // The audience cannot start, complete, or read a job that is not in its workspace.
      const start = await call(`${WORKSPACE}/tasks/$taskId/start`, 'POST', {
        credential: f.recipientCredential,
        params: { taskId: job.id, workspaceId: f.audience.id },
        version,
        body: {},
      })
      const startUnknown = await call(`${WORKSPACE}/tasks/$taskId/start`, 'POST', {
        credential: f.recipientCredential,
        params: { taskId: unknownId, workspaceId: f.audience.id },
        version,
        body: {},
      })
      expect(start.status).toBe(startUnknown.status)
      expect(await start.json()).toEqual(await startUnknown.json())

      // Each of these completion attempts is refused before any effect.
      const attempts: Record<string, Response> = {
        'audience member completes the source job': await call(
          `${WORKSPACE}/tasks/$taskId/complete`,
          'POST',
          {
            credential: f.recipientCredential,
            params: { taskId: job.id, workspaceId: f.source.id },
            version,
            body: {},
          }
        ),
        'destination in an unrelated workspace': await completeJob(f, job, version, {
          artifact: null,
          artifactPolicy: 'require',
          channelId: unrelatedChannel.id,
          summary: 'UNRELATED_SUMMARY',
        }),
        'destination in the source workspace': await completeJob(f, job, version, {
          artifact: null,
          artifactPolicy: 'require',
          channelId: sourceChannel.id,
          summary: 'SOURCE_CHANNEL_SUMMARY',
        }),
        'artifact grant not registered in this source': await completeJob(f, job, version, {
          artifact: { artifactId: f.artifact.id, grantId: `grant-${crypto.randomUUID()}` },
          artifactPolicy: 'require',
          channelId: f.channel.id,
          summary: 'UNREGISTERED_SUMMARY',
        }),
      }
      for (const [label, response] of Object.entries(attempts)) {
        expect({ label, status: response.status }).toEqual({ label, status: 404 })
      }
      expect(await sourceTask(f, job.id)).toEqual(before)
      expect(await audienceMessages(f)).not.toContain('UNRELATED_SUMMARY')
      expect(await audienceMessages(f)).not.toContain('SOURCE_CHANNEL_SUMMARY')
      expect(await audienceMessages(f)).not.toContain('UNREGISTERED_SUMMARY')
    })
  }
)
