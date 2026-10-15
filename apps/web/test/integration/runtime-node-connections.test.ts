// RuntimeConnection discovery through the production route, typed API client,
// and TanStack data query (#37). The Control Plane is a scoped fake at the
// SDK fetch seam; authorization, workspace/node reads, HTTP Request/Response
// handling, client transport, and query composition remain real.
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { QueryClient } from '@tanstack/solid-query'
import { AgentHqApiClient } from '@adea-ai/api-client'
import { createHash, randomBytes } from 'node:crypto'
import {
  addWorkspaceMembership,
  createDatabase,
  createContentRef,
  createGroupChannel,
  createMessage,
  createRuntimeNodeChallenge,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  controlPlaneScopeIds,
  registerRuntimeNode,
  upsertContentReplica,
  type DatabaseConnection,
  type UserPrincipalRef,
} from '@adea-ai/db'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { resolve } from 'node:path'

import { messageQueryOptions } from '../../../../packages/data/src/index'
import { runtimeNodeQueryOptions } from '../../../../packages/data/src/runtime-nodes'
import {
  canonicalUrl,
  createCanonicalDatabase,
  MIGRATION_ROLE,
  RUNTIME_ROLE,
} from '../../../../packages/db/tests/fixtures/canonical-boundary'
import {
  createTemporaryCredential,
  digestTemporaryCredential,
} from '../../src/server/temporary-session'

// Do not replace the route's principal or authorization layer in this test.
// Only the file-route factory and the framework request context are unavailable
// in Bun; temporary credentials still resolve through the real server path.
mock.module('@tanstack/solid-router', () => ({
  createFileRoute: (path: string) => (options: unknown) => ({ path, options }),
}))
mock.module('@tanstack/solid-start/server', () => ({
  getRequest: () => {
    throw new Error('no Start request context in the route-flow test')
  },
  setCookie: () => {},
}))

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
if (!provisioningUrl)
  throw new Error(
    'MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is required: runtime connection route integration must use a disposable database and must not skip'
  )
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
const databaseName = `runtime_discovery_37_${suffix}`
const connectionRoute =
  '../../src/start/routes/api/v1/workspaces/$workspaceId/runtime-nodes/$runtimeNodeId/connections'
const messagesRoute =
  '../../src/start/routes/api/v1/workspaces/$workspaceId/channels/$channelId/messages'
const replicasRoute =
  '../../src/start/routes/api/v1/workspaces/$workspaceId/content-refs/$contentId/replicas'
const privateCanary = 'RUNTIME_DISCOVERY_PRIVATE_METADATA_CANARY'
const invalidDiagnostic = '/private/native/diagnostic message with spaces'

type Handler = (input: { request: Request; params: Record<string, string> }) => Promise<Response>
type RouteModule = { Route: { options: { server: { handlers: Record<string, Handler> } } } }
type RuntimeConnectionModel = Record<string, unknown> & {
  runtimeConnectionId: string
  runtimeDefinitionId: string
  node: Record<string, unknown>
  connection: Record<string, unknown>
  freshness: Record<string, unknown>
  access: Record<string, unknown>
  compatibility: Record<string, unknown>
  eligibility: Record<string, unknown>
}
type FakeMode = 'inventory' | 'invalid_diagnostic' | 'failure' | 'resolve_after_abort'

const routeModules = new Map<string, RouteModule>()
async function routeFor(path: string): Promise<RouteModule> {
  let module = routeModules.get(path)
  if (!module) {
    module = (await import(path)) as RouteModule
    routeModules.set(path, module)
  }
  return module
}

function databaseUrl(database: string): string {
  if (!provisioningUrl) throw new Error('MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is not set')
  const url = new URL(provisioningUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function opaqueToken(seed: string): string {
  return `${seed.toUpperCase()}${'A'.repeat(26 - seed.length)}`
}

function runtimeConnection(
  id: string,
  runtimeNodeRefId: string,
  nodeLocation: 'remote_host' | 'local_device' = 'remote_host',
  changes: Partial<RuntimeConnectionModel> = {}
) {
  const observedAt = new Date(Date.now() - 60_000).toISOString()
  return {
    runtimeConnectionId: `rtc_${opaqueToken(id)}`,
    runtimeDefinitionId: `rtd_${opaqueToken(id)}`,
    family: 'pi',
    connectionType: 'managed_local',
    // RuntimeConnectionDiscoveryReadModel only allows local_device or
    // agent_hq_cloud here. The registered node's independent location is
    // represented by node.location.
    location: 'local_device',
    status: 'available',
    node: {
      runtimeNodeRefId,
      location: nodeLocation,
      status: 'online',
      health: 'online',
      observedAt,
    },
    connection: { status: 'connected', health: 'healthy', availability: 'healthy' },
    freshness: { state: 'fresh', observedAt },
    versions: { adapter: '1.0.0', driver: '1.0.0', harness: '1.0.0' },
    capabilities: ['session.resume'],
    capabilityDetails: [{ name: 'session.resume', support: 'supported' }],
    compatibility: { state: 'compatible', limitations: [] },
    access: {
      localProjectGrant: { required: false, state: 'not_required' },
      entitlement: { state: 'allowed' },
    },
    eligibility: { state: 'eligible', reasons: [], degradations: [], remediation: [] },
    observedAt,
    limitations: [],
    ...changes,
  } as RuntimeConnectionModel
}

function jwtClaims(authorization: string | null): Record<string, unknown> | null {
  const token = authorization?.match(/^Bearer ([^\s]+)$/u)?.[1]
  if (!token) return null
  const payload = token.split('.')[1]
  return payload
    ? (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>)
    : null
}

async function dispatchApplicationRequest(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init)
  const url = new URL(request.url)
  let route: string
  let params: Record<string, string>
  if (url.pathname.endsWith('/connections')) {
    route = connectionRoute
    const match = url.pathname.match(/\/workspaces\/([^/]+)\/runtime-nodes\/([^/]+)\/connections$/u)
    if (!match) throw new Error(`Unrecognized runtime connection route ${url.pathname}`)
    params = {
      workspaceId: decodeURIComponent(match[1]!),
      runtimeNodeId: decodeURIComponent(match[2]!),
    }
  } else if (url.pathname.endsWith('/messages')) {
    route = messagesRoute
    const match = url.pathname.match(/\/workspaces\/([^/]+)\/channels\/([^/]+)\/messages$/u)
    if (!match) throw new Error(`Unrecognized conversation route ${url.pathname}`)
    params = {
      workspaceId: decodeURIComponent(match[1]!),
      channelId: decodeURIComponent(match[2]!),
    }
  } else if (url.pathname.endsWith('/replicas')) {
    route = replicasRoute
    const match = url.pathname.match(/\/workspaces\/([^/]+)\/content-refs\/([^/]+)\/replicas$/u)
    if (!match) throw new Error(`Unrecognized ContentReplica route ${url.pathname}`)
    params = {
      workspaceId: decodeURIComponent(match[1]!),
      contentId: decodeURIComponent(match[2]!),
    }
  } else {
    throw new Error(`Unrecognized application API route ${url.pathname}`)
  }
  const handler = (await routeFor(route)).Route.options.server.handlers[request.method]!
  return handler({ request, params })
}

describe('runtime connections: route to Control Plane to typed client and data query (#37)', () => {
  let admin: ReturnType<typeof createDatabase>
  let migration: DatabaseConnection
  let runtime: DatabaseConnection
  let remoteNode: Awaited<ReturnType<typeof registerRuntimeNode>>
  let localNode: Awaited<ReturnType<typeof registerRuntimeNode>>
  let workspaceId = ''
  let controlPlaneWorkspaceId = ''
  let channelId = ''
  let synchronizedContentRefId = ''
  let localOnlyContentRefId = ''
  let synchronizedCiphertext = ''
  let owner: UserPrincipalRef
  let ownerCredential = ''
  let outsiderCredential = ''
  let readerCredential = ''
  let client: AgentHqApiClient
  let queryClient: QueryClient
  let previousEnvironment: Record<string, string | undefined>
  let previousFetch: typeof fetch
  let fakeMode: FakeMode = 'inventory'
  let remotePage: RuntimeConnectionModel[]
  let localPage: RuntimeConnectionModel[]
  const upstreamRequests: Array<{
    authorization: string | null
    body: Record<string, unknown>
    signal: AbortSignal
  }> = []
  let holdStarted: Promise<void> = Promise.resolve()
  let notifyHoldStarted: (() => void) | undefined
  let signalAborted = false

  beforeAll(async () => {
    admin = createDatabase(databaseUrl('postgres'))
    await createCanonicalDatabase(admin.client, databaseUrl, databaseName)
    migration = createDatabase(
      canonicalUrl(databaseUrl(databaseName), databaseName, MIGRATION_ROLE)
    )
    runtime = createDatabase(canonicalUrl(databaseUrl(databaseName), databaseName, RUNTIME_ROLE))
    await migrate(migration.db, {
      migrationsFolder: resolve(import.meta.dir, '../../../../packages/db/drizzle'),
    })

    previousEnvironment = {
      DATABASE_URL: process.env.DATABASE_URL,
      NODE_ENV: process.env.NODE_ENV,
      CONTROL_PLANE_ORIGIN: process.env.CONTROL_PLANE_ORIGIN,
      CONTROL_PLANE_SIGNING_KEY: process.env.CONTROL_PLANE_SIGNING_KEY,
      CONTROL_PLANE_SIGNING_KEY_ID: process.env.CONTROL_PLANE_SIGNING_KEY_ID,
      CONTROL_PLANE_SIGNING_ISSUER: process.env.CONTROL_PLANE_SIGNING_ISSUER,
    }
    process.env.DATABASE_URL = canonicalUrl(databaseUrl(databaseName), databaseName, RUNTIME_ROLE)
    process.env.NODE_ENV = 'test'
    process.env.CONTROL_PLANE_ORIGIN = 'https://control-plane.fake.invalid'
    process.env.CONTROL_PLANE_SIGNING_KEY_ID = `runtime-discovery-${suffix}`
    process.env.CONTROL_PLANE_SIGNING_ISSUER = 'https://adea.fake.invalid'
    const signer = (await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const der = await crypto.subtle.exportKey('pkcs8', signer.privateKey)
    process.env.CONTROL_PLANE_SIGNING_KEY = [
      '-----BEGIN PRIVATE KEY-----',
      Buffer.from(der).toString('base64'),
      '-----END PRIVATE KEY-----',
    ].join('\n')

    ownerCredential = createTemporaryCredential()
    outsiderCredential = createTemporaryCredential()
    const expiresAt = new Date(Date.now() + 30 * 60_000)
    const ownerSession = await createTemporaryUserSession(runtime.db, {
      credentialDigest: await digestTemporaryCredential(ownerCredential),
      expiresAt,
    })
    owner = ownerSession.principal
    const outsider = await createTemporaryUserSession(runtime.db, {
      credentialDigest: await digestTemporaryCredential(outsiderCredential),
      expiresAt,
    })
    readerCredential = createTemporaryCredential()
    const reader = await createTemporaryUserSession(runtime.db, {
      credentialDigest: await digestTemporaryCredential(readerCredential),
      expiresAt,
    })
    const workspace = await createWorkspaceWithOwner(runtime.db, {
      idempotencyKey: `runtime-discovery-37-${suffix}`,
      name: 'Runtime discovery route fixture',
      owner,
    })
    workspaceId = workspace.workspace.id
    await addWorkspaceMembership(runtime.db, workspaceId, reader.principal, 'member')
    controlPlaneWorkspaceId = (await controlPlaneScopeIds(runtime.db, { workspaceId }))!.workspaceId

    remoteNode = await registerNode('remote_host', owner.userId, workspaceId, `remote-${suffix}`)
    localNode = await registerNode('local_device', owner.userId, workspaceId, `local-${suffix}`)
    const channel = await createGroupChannel(runtime.db, workspaceId, owner, {
      idempotencyKey: `runtime-discovery-history-${suffix}`,
      title: 'Synchronized conversation fixture',
    })
    channelId = channel.id
    synchronizedContentRefId = crypto.randomUUID()
    const synchronizedDigest = createHash('sha256')
      .update('synchronized private conversation text')
      .digest('hex')
    synchronizedCiphertext = randomBytes(48).toString('base64url')
    await createContentRef(runtime.db, workspaceId, owner, {
      availability: 'available',
      contentType: 'message_body',
      digestSha256: synchronizedDigest,
      id: synchronizedContentRefId,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'sensitive',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'agent_hq_e2ee_sync',
    })
    const synchronizedMessage = await createMessage(runtime.db, workspaceId, channelId, owner, {
      bodyContentRefId: synchronizedContentRefId,
      idempotencyKey: `runtime-discovery-message-${suffix}`,
      sender: owner,
    })
    await upsertContentReplica(runtime.db, workspaceId, synchronizedContentRefId, owner, {
      availability: 'available',
      ciphertext: synchronizedCiphertext,
      digestSha256: synchronizedDigest,
      nonce: randomBytes(12).toString('base64url'),
      replicaKind: 'self_hosted_authority',
      revision: 1,
      schemaVersion: 1,
    })
    expect(synchronizedMessage.bodyContentRefId).toBe(synchronizedContentRefId)

    localOnlyContentRefId = crypto.randomUUID()
    await createContentRef(runtime.db, workspaceId, owner, {
      availability: 'offline',
      contentType: 'message_body',
      digestSha256: 'b'.repeat(64),
      id: localOnlyContentRefId,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'sensitive',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'local_only',
    })
    await createMessage(runtime.db, workspaceId, channelId, owner, {
      bodyContentRefId: localOnlyContentRefId,
      idempotencyKey: `runtime-discovery-local-only-message-${suffix}`,
      sender: owner,
    })

    const staleAt = new Date(Date.now() - 6 * 60_000).toISOString()
    remotePage = [
      runtimeConnection(`${suffix}A`, remoteNode.controlPlaneRuntimeNodeRefId, 'remote_host', {
        freshness: { state: 'fresh', observedAt: staleAt },
        observedAt: staleAt,
      }),
      runtimeConnection(`${suffix}B`, remoteNode.controlPlaneRuntimeNodeRefId, 'remote_host', {
        status: 'unavailable',
        connection: { status: 'unavailable', health: 'unavailable', availability: 'offline' },
        access: {
          localProjectGrant: { required: true, state: 'missing' },
          entitlement: { state: 'unknown' },
        },
        eligibility: {
          state: 'ineligible',
          reasons: ['LOCAL_PROJECT_GRANT_REQUIRED'],
          degradations: [],
          remediation: [{ code: 'LOCAL_PROJECT_GRANT_REQUIRED', label: privateCanary }],
        },
      }),
      runtimeConnection(`${suffix}C`, remoteNode.controlPlaneRuntimeNodeRefId, 'remote_host', {
        status: 'revoked',
        connection: { status: 'revoked', health: 'unavailable', availability: 'revoked' },
        compatibility: { state: 'revoked', limitations: [] },
      }),
      runtimeConnection(`${suffix}D`, remoteNode.controlPlaneRuntimeNodeRefId, 'remote_host', {
        status: 'unavailable',
        connection: { status: 'unavailable', health: 'unavailable', availability: 'incompatible' },
        compatibility: { state: 'incompatible', limitations: ['RUNTIME_INCOMPATIBLE'] },
      }),
      runtimeConnection(`${suffix}E`, remoteNode.controlPlaneRuntimeNodeRefId, 'remote_host', {
        providerCredential: privateCanary,
        executableIdentity: '/private/native/runtime/path',
        node: {
          ...runtimeConnection(`${suffix}E`, remoteNode.controlPlaneRuntimeNodeRefId).node,
          endpoint: 'https://native-host.invalid/private',
        },
        connection: {
          ...runtimeConnection(`${suffix}E`, remoteNode.controlPlaneRuntimeNodeRefId).connection,
          processHandle: privateCanary,
          providerMessage: privateCanary,
        },
        access: {
          localProjectGrant: { required: false, state: 'not_required' },
          entitlement: { state: 'allowed', class: privateCanary },
        },
      }),
    ]
    localPage = [
      {
        ...runtimeConnection(`${suffix}G`, localNode.controlPlaneRuntimeNodeRefId, 'local_device'),
        location: 'local_device',
        node: {
          ...runtimeConnection(`${suffix}G`, localNode.controlPlaneRuntimeNodeRefId, 'local_device')
            .node,
          location: 'local_device',
          status: 'offline',
          health: 'online',
        },
      },
    ]

    previousFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (new URL(request.url).origin !== 'https://control-plane.fake.invalid')
        throw new Error('Unexpected network boundary in runtime discovery test')
      const body = (await request.json()) as Record<string, unknown>
      upstreamRequests.push({
        authorization: request.headers.get('authorization'),
        body,
        signal: request.signal,
      })
      if (fakeMode === 'failure') throw new TypeError(`upstream failure ${privateCanary}`)
      if (fakeMode === 'resolve_after_abort') {
        signalAborted = false
        await new Promise<void>((resolveOnAbort) => {
          const abort = () => {
            signalAborted = true
            resolveOnAbort()
          }
          if (request.signal.aborted) abort()
          else {
            request.signal.addEventListener('abort', abort, { once: true })
            notifyHoldStarted?.()
          }
        })
      }
      const parameters = body.parameters as Record<string, unknown>
      const isLocal = parameters.runtimeNodeRefId === localNode.controlPlaneRuntimeNodeRefId
      const items = isLocal ? localPage : remotePage
      const page = parameters.cursor ? [] : [...items]
      if (fakeMode === 'invalid_diagnostic' && !isLocal && page[0])
        page[0] = { ...page[0], limitations: [invalidDiagnostic] }
      return Response.json({
        contractVersion: body.contractVersion,
        requestId: body.requestId,
        correlation: body.correlation,
        data: {
          runtimeConnections: page,
          page: parameters.cursor ? {} : { nextCursor: 'cur_next123' },
        },
      })
    }) as typeof fetch

    client = new AgentHqApiClient({
      baseUrl: 'http://adea.test/api',
      getTemporaryCredential: () => ownerCredential,
      fetchImpl: async (input, init) => dispatchApplicationRequest(input, init),
    })
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } })
    // Load the real handlers only after the router adapter and runtime DB URL are in place.
    await routeFor(connectionRoute)
    await routeFor(messagesRoute)
    await routeFor(replicasRoute)
    // Keep the outsider alive for an authorization-denial request.
    expect(outsider.principal.userId).not.toBe(owner.userId)
  }, 300_000)

  afterAll(async () => {
    queryClient?.clear()
    if (previousFetch) globalThis.fetch = previousFetch
    if (previousEnvironment) {
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    await runtime?.close()
    await migration?.close()
    if (admin) {
      await admin.client.unsafe(`drop database if exists "${databaseName}" with (force)`)
      await admin.close()
    }
  })

  async function registerNode(
    kind: 'remote_host' | 'local_device',
    ownerUserId: string,
    workspace: string,
    keySuffix: string
  ) {
    const challenge = await createRuntimeNodeChallenge(runtime.db, {
      createdByUserId: ownerUserId,
      kind,
      nonce: crypto.randomUUID(),
      purpose: 'pair',
      workspaceId: workspace,
    })
    return registerRuntimeNode(runtime.db, {
      challengeId: challenge.challengeId,
      displayName: `Runtime ${kind}`,
      keys: [
        {
          algorithm: 'ed25519',
          publicKey: Buffer.alloc(32, keySuffix.length).toString('base64url'),
          role: 'signing',
        },
        {
          algorithm: 'x25519',
          publicKey: Buffer.alloc(32, keySuffix.length + 1).toString('base64url'),
          role: 'command_encryption',
        },
      ],
      kind,
      ownerUserId,
      platform: 'linux',
      softwareVersion: '1.0.0',
      trustMetadata: { credential: privateCanary, nativePath: '/private/native/trust/path' },
      workspaceId: workspace,
    })
  }

  function freshQueryClient() {
    queryClient?.clear()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } })
    return queryClient
  }

  test('authorizes and composes paged inventory without conflating readiness, health, or history', async () => {
    fakeMode = 'inventory'
    upstreamRequests.length = 0
    const cache = freshQueryClient()
    const historyOptions = messageQueryOptions.list(client, workspaceId, channelId)
    const firstPageOptions = runtimeNodeQueryOptions.connections(client, workspaceId, remoteNode.id)
    const firstPage = await cache.fetchQuery(firstPageOptions)
    expect(firstPage.discovery).toEqual({ state: 'available' })
    expect(firstPage.controlPlaneReadiness).toEqual({
      state: 'unknown',
      dependency: 'control_plane.runtime_connection_discovery.readiness',
    })
    expect(firstPage.node).toMatchObject({
      deviceOnline: { state: 'not_applicable' },
      hostReachability: {
        state: 'unknown',
        dependency: 'control_plane.runtime_connection_discovery.host_reachability',
      },
    })
    expect(firstPage.connections.map((connection) => connection.connection.availability)).toEqual([
      'healthy',
      'offline',
      'revoked',
      'incompatible',
      'healthy',
    ])
    expect(firstPage.connections[0]?.freshness.state).toBe('stale')
    expect(firstPage.connections[1]).toMatchObject({
      connection: { availability: 'offline' },
      access: { localProjectGrant: { required: true, state: 'missing' } },
      node: { status: 'online', health: 'online' },
    })
    expect(firstPage.connections[2]).toMatchObject({
      status: 'revoked',
      connection: { status: 'revoked', availability: 'revoked' },
    })
    expect(firstPage.connections[3]?.compatibility.state).toBe('incompatible')
    expect(firstPage.nextCursor).toBe('cur_next123')
    expect(upstreamRequests[0]?.body.parameters).toMatchObject({
      limit: 100,
      runtimeNodeRefId: remoteNode.controlPlaneRuntimeNodeRefId,
    })
    const claims = jwtClaims(upstreamRequests[0]?.authorization ?? null)
    expect(claims?.scopes).toEqual(['runtime:read'])
    expect(claims?.workspaceIds).toEqual([controlPlaneWorkspaceId])

    const secondPage = await cache.fetchQuery(
      runtimeNodeQueryOptions.connections(client, workspaceId, remoteNode.id, firstPage.nextCursor)
    )
    expect(secondPage.connections).toEqual([])
    expect(upstreamRequests[1]?.body.parameters).toMatchObject({ cursor: 'cur_next123' })

    const local = await cache.fetchQuery(
      runtimeNodeQueryOptions.connections(client, workspaceId, localNode.id)
    )
    expect(local.node.deviceOnline).toEqual({
      state: 'unknown',
      dependency: 'control_plane.runtime_connection_discovery.device_online',
    })
    expect(local.connections[0]?.node).toMatchObject({
      status: 'offline',
      health: 'online',
      deviceOnline: { state: 'offline' },
      hostReachability: { state: 'not_applicable' },
    })

    // The local device is offline, but the synchronized conversation still
    // points to an authorized encrypted replica on the cloud read boundary.
    const history = await cache.fetchQuery(historyOptions)
    expect(history.messages).toContainEqual(
      expect.objectContaining({ bodyContentRefId: synchronizedContentRefId })
    )
    const replicas = await client.listContentReplicas(workspaceId, synchronizedContentRefId)
    const transcriptReplica = replicas.contentReplicas[0]
    expect(replicas.contentReplicas).toHaveLength(1)
    expect(transcriptReplica).toMatchObject({
      availability: 'available',
      contentRefId: synchronizedContentRefId,
      ciphertext: synchronizedCiphertext,
      digestSha256: createHash('sha256')
        .update('synchronized private conversation text')
        .digest('hex'),
      replicaKind: 'self_hosted_authority',
    })
    expect(JSON.stringify(replicas)).not.toContain('synchronized private conversation text')
    await expect(
      client.listContentReplicas(workspaceId, localOnlyContentRefId)
    ).rejects.toMatchObject({
      status: 404,
    })

    const serialized = JSON.stringify({ firstPage, secondPage, local })
    expect(serialized).not.toContain(privateCanary)
    expect(serialized).not.toContain('/private/native')
    expect(serialized).not.toContain('native-host.invalid')
    expect(serialized).not.toContain(remoteNode.keys[0]!.publicKey)
    expect(cache.getQueryData(historyOptions.queryKey)).toEqual(history)
    expect(JSON.stringify(history)).toContain(synchronizedContentRefId)
    expect(JSON.stringify(replicas)).not.toContain(privateCanary)
    expect(upstreamRequests[0]?.body.workspaceId).toBe(controlPlaneWorkspaceId)
  })

  test('denies a non-member before any Control Plane request', async () => {
    fakeMode = 'inventory'
    upstreamRequests.length = 0
    const outsiderClient = new AgentHqApiClient({
      baseUrl: 'http://adea.test/api',
      getTemporaryCredential: () => outsiderCredential,
      fetchImpl: async (input, init) => dispatchApplicationRequest(input, init),
    })
    const options = runtimeNodeQueryOptions.connections(outsiderClient, workspaceId, remoteNode.id)
    await expect(freshQueryClient().fetchQuery(options)).rejects.toMatchObject({ status: 404 })
    expect(upstreamRequests).toEqual([])
  })

  test('denies a workspace member who is outside the conversation audience', async () => {
    const readerClient = new AgentHqApiClient({
      baseUrl: 'http://adea.test/api',
      getTemporaryCredential: () => readerCredential,
      fetchImpl: async (input, init) => dispatchApplicationRequest(input, init),
    })
    await expect(
      readerClient.listContentReplicas(workspaceId, synchronizedContentRefId)
    ).rejects.toMatchObject({ status: 404 })
  })

  test('turns upstream failure into sanitized unavailable discovery, not success', async () => {
    fakeMode = 'failure'
    upstreamRequests.length = 0
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message?: unknown) => warnings.push(String(message))
    try {
      const options = runtimeNodeQueryOptions.connections(
        client,
        workspaceId,
        remoteNode.id,
        'cur_failure'
      )
      const result = await freshQueryClient().fetchQuery(options)
      expect(result.discovery).toEqual({ state: 'unavailable', code: 'CONTROL_PLANE_UNAVAILABLE' })
      expect(result.controlPlaneReadiness).toEqual({
        state: 'unknown',
        dependency: 'control_plane.runtime_connection_discovery.readiness',
      })
      expect(result.connections).toEqual([])
      expect(JSON.stringify(result)).not.toContain(privateCanary)
      expect(warnings.join('\n')).not.toContain(privateCanary)
    } finally {
      console.warn = originalWarn
    }
  })

  test('rejects a diagnostic payload that violates the pinned code schema', async () => {
    fakeMode = 'invalid_diagnostic'
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message?: unknown) => warnings.push(String(message))
    try {
      const result = await freshQueryClient().fetchQuery(
        runtimeNodeQueryOptions.connections(client, workspaceId, remoteNode.id)
      )
      expect(result.discovery).toEqual({ state: 'unavailable', code: 'CONTROL_PLANE_UNAVAILABLE' })
      expect(result.connections).toEqual([])
      expect(JSON.stringify(result)).not.toContain(invalidDiagnostic)
      expect(warnings.join('\n')).not.toContain(invalidDiagnostic)
    } finally {
      console.warn = originalWarn
    }
  })

  test('pre-aborted and in-flight query cancellation never become an empty successful inventory', async () => {
    fakeMode = 'inventory'
    upstreamRequests.length = 0
    const preAbort = runtimeNodeQueryOptions.connections(
      client,
      workspaceId,
      remoteNode.id,
      'cur_preabort'
    )
    await expect(preAbort.queryFn!({ signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(upstreamRequests).toEqual([])

    // Simulate a fetch implementation that resolves a complete payload as
    // cancellation arrives; the route must still rethrow cancellation.
    fakeMode = 'resolve_after_abort'
    let notifyStarted!: () => void
    holdStarted = new Promise<void>((resolveStarted) => {
      notifyStarted = resolveStarted
    })
    notifyHoldStarted = notifyStarted
    signalAborted = false
    const options = runtimeNodeQueryOptions.connections(
      client,
      workspaceId,
      remoteNode.id,
      'cur_inflight'
    )
    const cache = freshQueryClient()
    const pending = cache.fetchQuery(options)
    const settled = pending.then(
      (value) => ({ state: 'fulfilled' as const, value }),
      (error: unknown) => ({ state: 'rejected' as const, error })
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        holdStarted,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Control Plane fake did not receive the query')),
            5_000
          )
        }),
      ])
      await cache.cancelQueries({ queryKey: options.queryKey, exact: true })
      const outcome = await settled
      expect(outcome.state).toBe('rejected')
      expect(signalAborted).toBe(true)
      expect(upstreamRequests.at(-1)?.signal.aborted).toBe(true)
      expect(cache.getQueryData(options.queryKey)).toBeUndefined()
    } finally {
      if (timer) clearTimeout(timer)
      await cache.cancelQueries({ queryKey: options.queryKey, exact: true })
    }
  })
})
