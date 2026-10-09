import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { startFactoryChild } from './lead-role-choices-connected-process.mjs'
import {
  verifyFactoryArchives,
  verifyFactorySource,
  verifyInstalledFactoryPackages,
} from './lead-role-choices-connected-preflight.mjs'

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const databaseClientEnvironmentKeys = [
  'ADEA_PUBLIC_DATABASE_URL',
  'ADEA_PUBLIC_DATABASE_URL_UNPOOLED',
  'ADEA_PUBLIC_DATABASE_MIGRATION_URL',
  'NEXT_PUBLIC_DATABASE_URL',
  'NEXT_PUBLIC_DATABASE_URL_UNPOOLED',
  'NEXT_PUBLIC_DATABASE_MIGRATION_URL',
  'VITE_DATABASE_URL',
  'VITE_DATABASE_URL_UNPOOLED',
  'VITE_DATABASE_MIGRATION_URL',
]
const safeHostFailures = new Set([
  'HOST_BINARY_MISSING',
  'HOST_BINARY_NOT_EXECUTABLE',
  'HOST_SPAWN_FAILED',
  'HOST_EXIT_BEFORE_READY',
  'HOST_EXIT_BEFORE_CONTROL_REPLY',
  'HOST_CONTROL_UNAVAILABLE',
  'HOST_LAUNCH_TIMEOUT',
  'HOST_CONTROL_TIMEOUT',
  'HOST_CLOSE_TIMEOUT',
  'HOST_REAP_TIMEOUT',
])
const safeStartupReason = (error) => {
  const message = typeof error?.message === 'string' ? error.message : undefined
  const databaseConfigurationMessages = new Map([
    ['DATABASE_URL is required', 'DATABASE_URL_REQUIRED'],
    ['DATABASE_URL must be a valid PostgreSQL URL', 'DATABASE_URL_INVALID'],
    ['DATABASE_URL must use the PostgreSQL protocol', 'DATABASE_URL_PROTOCOL_INVALID'],
    ['DATABASE_URL must include role, password, host, and database', 'DATABASE_URL_INCOMPLETE'],
  ])
  if (message && databaseConfigurationMessages.has(message))
    return databaseConfigurationMessages.get(message)
  if (
    message &&
    databaseClientEnvironmentKeys.some(
      (key) => message === `Database credentials must never be client-exposed through ${key}`
    )
  )
    return 'DATABASE_CLIENT_URL_ENV_PRESENT'
  if (error?.code === 'ERR_ASSERTION') return 'FIXTURE_ASSERTION_FAILED'
  if (safeHostFailures.has(error?.code)) return error.code
  if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND')
    return 'MODULE_NOT_FOUND'
  if (error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return 'PACKAGE_EXPORT_MISSING'
  if (error?.name === 'AssertionError') return 'FIXTURE_ASSERTION_FAILED'
  return 'FIXTURE_INITIALIZATION_FAILED'
}
const safeFailureClass = (error) =>
  /^[A-Za-z][A-Za-z0-9]{0,48}$/u.test(error?.name ?? '') ? error.name : 'Error'
const safeDiagnosticField = (value, pattern) =>
  typeof value === 'string' && pattern.test(value) ? value : undefined
const controlPlaneOperations = new Set([
  'model-connections.list',
  'model-defaults.get',
  'model-defaults.set',
  'model-selection.resolve',
  'model-selection.funding.get',
  'pi-durable.lead.prepare',
  'pi-durable.lead.lookup',
  'pi-durable.lead.dispatch',
  'pi-durable.lead.status',
  'pi-durable.lead.progress',
  'pi-durable.lead.cancel',
  'pi-durable.lead.publication.current',
])
const controlPlaneSchemaVersions = new Set([
  'pi-lead-dispatch/v1',
  'pi-lead-publication/v1',
  'model-funding-display/v1',
])
const safeMissingPackage = (error) => {
  const candidates = []
  for (const field of ['message', 'specifier', 'moduleName', 'path', 'file']) {
    let value
    try {
      value = error?.[field]
    } catch {
      continue
    }
    if (typeof value !== 'string') continue
    candidates.push(value)
    for (const match of value.matchAll(/['"]([^'"]+)['"]/gu)) candidates.push(match[1])
  }
  for (const candidate of candidates) {
    const safeName =
      candidate.startsWith('.') || candidate.startsWith('/')
        ? candidate.split(/[\\/]/u).at(-1)
        : candidate
    if (
      safeName &&
      /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/u.test(safeName)
    )
      return safeName
  }
  return undefined
}

/**
 * Joins the mounted chooser to the real model metadata/lead-turn handlers and
 * PostgreSQL admission/publication functions. The message HTTP shim below is
 * fixture-only: it applies the production principal/write guards, then calls
 * the same canonical createLeadTurn/listMessagesForUser DB operations.
 */
export async function startLeadRoleChoicesConnectedFixture() {
  let phase = 'configuration'
  let cpRoot
  let bun
  let expectedHead
  let manifestPath
  let databaseUrl
  let manifest
  let source
  let inheritedClientDatabaseAliases = 0
  try {
    assert.equal(typeof Bun, 'object', 'BUN_TEST_RUNTIME_REQUIRED')
    cpRoot = process.env.PI_FACTORY_CP_ROOT
    bun = process.env.PI_FACTORY_BUN
    expectedHead = process.env.PI_FACTORY_EXPECTED_HEAD
    manifestPath = process.env.PI_FACTORY_MANIFEST
    databaseUrl = process.env.DATABASE_URL
    assert.ok(cpRoot && bun && databaseUrl, 'OWNED_FIXTURE_CONFIGURATION_REQUIRED')
    assert.match(expectedHead ?? '', /^[a-f0-9]{40}$/u)
    assert.ok(manifestPath, 'VERIFIED_CANDIDATE_MANIFEST_REQUIRED')
    phase = 'candidate-archive-verification'
    manifest = verifyFactoryArchives(manifestPath, expectedHead)
    phase = 'candidate-source-verification'
    source = verifyFactorySource(cpRoot, manifest)
  } catch (error) {
    const safeError = new Error(
      `CONNECTED_FIXTURE_START_FAILED:${phase}:${safeStartupReason(error)}`
    )
    Object.defineProperty(safeError, 'connectedFixturePhase', { value: phase })
    Object.defineProperty(safeError, 'connectedFixtureClass', {
      value: safeFailureClass(error),
    })
    const missingPackage = safeMissingPackage(error)
    if (missingPackage)
      Object.defineProperty(safeError, 'connectedFixtureMissingPackage', { value: missingPackage })
    throw safeError
  }

  let connection
  let reader
  let host
  let api
  let readerRequests = 0
  let drainFailure = false
  const modelMetadataFailures = []
  let modelMetadataStage = 'idle'
  phase = 'module-loading'
  let preparationProjection
  let dispatchProjection
  let statusProjection
  let progressProjection
  const runtimeReadCounts = { latest: 0, status: 0, progress: 0 }
  const controlPlaneWire = []
  const publicationGate = {
    calls: 0,
    successes: 0,
    failures: [],
    responses: [],
    transportFailures: [],
    expected: null,
  }
  const fundingBindings = []
  const previousEnvironment = new Map()
  let previousFetch
  const managedEnvironment = [
    'NODE_ENV',
    'DATABASE_URL',
    'DATABASE_URL_UNPOOLED',
    ...databaseClientEnvironmentKeys,
    'ADEA_ALLOWED_EMAILS',
    'PI_DURABLE_LEAD_ENABLED',
    'PI_DURABLE_LEAD_TARGET',
    'PI_LEAD_PRODUCT_INTENT_LIFETIME_MS',
    'PI_LEAD_PRODUCT_TRUST',
    'CONTROL_PLANE_ORIGIN',
    'CONTROL_PLANE_SIGNING_KEY',
    'CONTROL_PLANE_SIGNING_KEY_ID',
    'CONTROL_PLANE_SIGNING_ISSUER',
  ]
  for (const key of managedEnvironment) previousEnvironment.set(key, process.env[key])
  const restoreEnvironment = () => {
    if (previousFetch) {
      globalThis.fetch = previousFetch
      previousFetch = undefined
    }
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  try {
    phase = 'runtime-configuration'
    process.env.NODE_ENV = 'test'
    process.env.DATABASE_URL = databaseUrl
    process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL_UNPOOLED || databaseUrl
    for (const key of databaseClientEnvironmentKeys) {
      if (process.env[key] !== undefined) inheritedClientDatabaseAliases++
      delete process.env[key]
    }
    delete process.env.ADEA_ALLOWED_EMAILS

    phase = 'db-package-import'
    const db = await import('@adea-ai/db')
    phase = 'db-driver-import'
    const databaseRequire = createRequire(
      new URL('../../../../packages/db/package.json', import.meta.url)
    )
    const { eq } = await import(pathToFileURL(databaseRequire.resolve('drizzle-orm')).href)
    phase = 'temporary-session-import'
    const { createTemporaryCredential, digestTemporaryCredential, readTemporaryCredential } =
      await import('../../src/server/temporary-session.ts')
    phase = 'reader-handler-import'
    const { createLeadProductReaderHandler } =
      await import('../../src/server/lead-product-reader.ts')
    phase = 'service-verifier-import'
    const { createLeadProductServiceVerifier } =
      await import('../../src/server/lead-product-service-auth.ts')
    phase = 'lead-product-composition-import'
    const { createLeadTurnProduct, configuredLeadTurnProductDependencies } =
      await import('../../src/server/lead-turn-product.ts')
    phase = 'application-database-import'
    const { applicationDatabase } = await import('../../src/server/database.ts')
    phase = 'request-scope-import'
    const { withRequestScope } = await import('../../src/server/request-scope.ts')
    phase = 'desktop-request-guard-import'
    const { guardDesktopWorkspaceRequest, withDesktopWorkspaceCors } =
      await import('../../src/server/desktop-workspace.ts')
    phase = 'workspace-response-import'
    const { workspaceJsonResponse, workspaceUnavailableResponse, workspaceInvalidRequestResponse } =
      await import('../../src/server/workspace-response.ts')
    phase = 'conversation-error-import'
    const { conversationErrorResponse } = await import('../../src/server/conversation-request.ts')
    phase = 'route-handlers-import'
    const { parseRequestedRoleModelSelections } = db
    const { handleModelMetadata } = await import('../../src/server/model-connections-routes.ts')
    phase = 'lead-target-import'
    const { configuredLeadExecutionTarget } =
      await import('../../src/server/lead-execution-target.ts')
    const { authorizeLeadTurnFundingBinding } = db
    phase = 'sdk-ports-import'
    const { installedLeadSdkPort } = await import('../../src/server/lead-turn-sdk-port.ts')
    const { installedModelMetadataPort } = await import('../../src/server/model-connections-sdk.ts')
    const { existsSync, realpathSync, readFileSync } = await import('node:fs')
    const { dirname, resolve } = await import('node:path')
    const webManifest = new URL('../../package.json', import.meta.url)
    const installed = await verifyInstalledFactoryPackages(
      manifest,
      webManifest,
      installedLeadSdkPort
    )
    assert.equal(installedModelMetadataPort.supported, true)
    const webRequire = createRequire(webManifest)
    const packagePaths = {}
    for (const name of ['@adea-ai/sdk', '@adea-ai/contracts', '@adea-ai/runtime-sdk']) {
      const entry = realpathSync(webRequire.resolve(name))
      let root = dirname(entry)
      while (!existsSync(resolve(root, 'package.json'))) root = dirname(root)
      const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
      packagePaths[name] = { entry, version: pkg.version }
    }

    phase = 'database-connection'
    connection = db.createDatabase(databaseUrl)
    phase = 'database-seed'
    const credential = createTemporaryCredential()
    const owner = await db.createTemporaryUserSession(connection.db, {
      credentialDigest: await digestTemporaryCredential(credential),
      displayName: 'Connected role fixture',
      expiresAt: new Date(Date.now() + 300_000),
    })
    const { workspace } = await db.createWorkspaceWithOwner(connection.db, {
      name: 'Connected role selection proof',
      owner: owner.principal,
      idempotencyKey: randomUUID(),
    })
    const lead = await db.ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    const topic = await db.createDirectAgentTopic(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      { title: 'Connected selected lead', idempotencyKey: randomUUID() }
    )
    const [mapped] = await connection.db
      .select()
      .from(db.workspaces)
      .where(eq(db.workspaces.id, workspace.id))
    assert.ok(mapped?.controlPlaneWorkspaceId)
    const workspaceId = mapped.controlPlaneWorkspaceId
    phase = 'product-reader-setup'
    const principalId = 'svc_agent-hq'
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    const keyId = 'synthetic-connected-role-key'
    const issuer = 'https://synthetic-connected-role.invalid'
    const trust = {
      issuer,
      keyId,
      publicJwk,
      principalId,
      workspaceIds: [workspaceId],
      revokedCredentialIds: [],
    }
    process.env.PI_LEAD_PRODUCT_TRUST = JSON.stringify(trust)
    process.env.PI_LEAD_PRODUCT_INTENT_LIFETIME_MS = '300000'
    phase = 'signed-reader-start'
    const productReader = createLeadProductReaderHandler({
      lifetimeMs: 300_000,
      verify: createLeadProductServiceVerifier({
        get PI_LEAD_PRODUCT_TRUST() {
          return process.env.PI_LEAD_PRODUCT_TRUST
        },
      }),
      withCurrent: (currentWorkspaceId, intentId, disclose) =>
        db.withCurrentLeadTurnProduct(connection.db, currentWorkspaceId, intentId, disclose),
    })
    reader = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        readerRequests++
        return productReader(request)
      },
    })
    const now = Date.now()
    const claims = {
      audience: 'adea-lead-product',
      credentialId: randomUUID(),
      credentialKind: 'service',
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 240_000).toISOString(),
      issuer,
      keyId,
      principalId,
      workspaceIds: [workspaceId],
      projectIds: [],
      scopes: ['execution:read'],
    }
    const unsigned = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: keyId })}.${encode(claims)}`
    const signature = await crypto.subtle.sign(
      'Ed25519',
      pair.privateKey,
      new TextEncoder().encode(unsigned)
    )
    const productAssertion = `${unsigned}.${Buffer.from(signature).toString('base64url')}`
    const hostConfig = {
      workspaceId,
      actorPrincipalId: `user:${owner.principal.userId}`,
      productProfilePin: {
        profileId: lead.profile.id,
        profileVersion: lead.profile.version,
        profileRevision: lead.profile.revision,
      },
      serviceTrust: {
        issuer,
        audience: 'control-plane',
        keyId,
        publicKey: publicJwk.x,
        expectedPrincipalId: principalId,
      },
      productReaderUrl: `http://127.0.0.1:${reader.port}/api/internal/pi-durable/lead-product/current`,
    }
    const hostEnvironment = {
      ...process.env,
      PI_PRODUCTION_FACTORY_TEST_CONFIG: JSON.stringify(hostConfig),
      PI_PRODUCTION_FACTORY_PRODUCT_ASSERTION: productAssertion,
    }
    delete hostEnvironment.NODE_OPTIONS
    delete hostEnvironment.BUN_OPTIONS
    phase = 'candidate-host-spawn'
    host = startFactoryChild(bun, ['scripts/pi-production-factory-candidate.mjs'], {
      cwd: cpRoot,
      env: hostEnvironment,
    })
    phase = 'candidate-host-ready'
    const metadata = await host.ready()
    phase = 'candidate-host-identity'
    assert.equal(metadata.sourceIdentity, expectedHead)
    phase = 'candidate-host-workspace'
    assert.equal(metadata.workspaceId, workspaceId)
    phase = 'candidate-host-principal'
    assert.equal(metadata.principalId, principalId)
    phase = 'candidate-host-profile'
    for (const field of ['profileId', 'profileVersion', 'profileRevision']) {
      phase = `candidate-profile-${field.toLowerCase()}`
      assert.equal(metadata[field], hostConfig.productProfilePin[field])
    }

    process.env.PI_DURABLE_LEAD_ENABLED = 'true'
    process.env.PI_DURABLE_LEAD_TARGET = JSON.stringify(metadata.target)
    process.env.CONTROL_PLANE_ORIGIN = metadata.baseUrl
    process.env.CONTROL_PLANE_SIGNING_KEY = JSON.stringify(privateJwk)
    process.env.CONTROL_PLANE_SIGNING_KEY_ID = keyId
    process.env.CONTROL_PLANE_SIGNING_ISSUER = issuer
    previousFetch = globalThis.fetch
    const controlPlaneOrigin = new URL(metadata.baseUrl).origin
    globalThis.fetch = async (input, init) => {
      let url
      try {
        url = new URL(
          typeof input === 'string' || input instanceof URL ? input : input.url,
          controlPlaneOrigin
        )
      } catch {
        return previousFetch(input, init)
      }
      if (url.origin !== controlPlaneOrigin) return previousFetch(input, init)

      let sent
      try {
        if (typeof init?.body === 'string') sent = JSON.parse(init.body)
      } catch {}
      const operation = controlPlaneOperations.has(sent?.operation) ? sent.operation : 'unknown'
      const sentRequestId = typeof sent?.requestId === 'string' ? sent.requestId : undefined
      const sentTraceId =
        typeof sent?.correlation?.traceId === 'string' ? sent.correlation.traceId : undefined
      const recordResponse = async (status, response) => {
        let received
        try {
          received = await response.clone().json()
        } catch {}
        const schemaVersion = controlPlaneSchemaVersions.has(received?.data?.schemaVersion)
          ? received.data.schemaVersion
          : undefined
        const code = safeDiagnosticField(
          received?.code ?? received?.data?.reasonCode,
          /^[A-Z][A-Z0-9_]{1,63}$/u
        )
        controlPlaneWire.push({
          operation,
          status,
          requestIdMatches: Boolean(sentRequestId && received?.requestId === sentRequestId),
          traceIdMatches: Boolean(sentTraceId && received?.correlation?.traceId === sentTraceId),
          ...(schemaVersion ? { schemaVersion } : {}),
          ...(code ? { responseCode: code } : {}),
        })
        if (operation === 'pi-durable.lead.publication.current') {
          const actual = received?.data?.publication
          const expected = publicationGate.expected
          const fields = [
            'intentId',
            'dispatchId',
            'preparationRef',
            'executionId',
            'attemptId',
            'runtimeSessionId',
            'selectionRef',
            'selectionRevision',
            'resultContentDigest',
          ]
          publicationGate.responses.push({
            schemaVersion: actual?.schemaVersion === 'pi-lead-publication/v1',
            mismatchedFields:
              actual && expected
                ? fields.filter((field) => actual[field] !== expected[field])
                : fields,
            workspaceMatches: actual?.workspaceId === sent?.workspaceId,
            actorMatches: actual?.canonicalActorPrincipalId === expected?.originalActorRef,
            authorityRevisionValid:
              Number.isSafeInteger(actual?.authorityRevision) && actual.authorityRevision > 0,
            expiryValid:
              typeof actual?.expiresAt === 'string' &&
              Number.isFinite(Date.parse(actual.expiresAt)) &&
              Date.parse(actual.expiresAt) > Date.now(),
          })
        }
        return response
      }
      try {
        const response = await previousFetch(input, init)
        return await recordResponse(response.status, response)
      } catch {
        controlPlaneWire.push({
          operation,
          status: 0,
          requestIdMatches: false,
          traceIdMatches: false,
          responseCode: 'CONTROL_PLANE_TRANSPORT_FAILED',
        })
        if (operation === 'pi-durable.lead.publication.current')
          publicationGate.transportFailures.push({ reason: 'CONTROL_PLANE_TRANSPORT_FAILED' })
        throw new Error('CONTROL_PLANE_TRANSPORT_FAILED')
      }
    }
    const fixtureResolution = async (request) => {
      const supplied = readTemporaryCredential(request)
      if (!supplied) return null
      const principal = await db.resolveTemporaryUserSession(
        connection.db,
        await digestTemporaryCredential(supplied)
      )
      if (!principal) return null
      return Object.freeze({
        clearTemporaryCredential: false,
        principal,
        sessionRotated: false,
        temporary: true,
      })
    }
    const fixtureAuthorized = (principal, permission, requestedWorkspaceId) =>
      requestedWorkspaceId === workspace.id &&
      principal?.kind === 'user' &&
      principal.userId === owner.principal.userId &&
      ['workspace.read', 'workspace.update', 'runtime.invoke'].includes(permission)
    const modelDependencies = {
      guard: guardDesktopWorkspaceRequest,
      resolvePrincipal: fixtureResolution,
      authorize: async (principal, permission, requestedWorkspaceId) =>
        fixtureAuthorized(principal, permission, requestedWorkspaceId),
      canManage: async (principal, requestedWorkspaceId) =>
        fixtureAuthorized(principal, 'workspace.update', requestedWorkspaceId),
      failure: (request, code, message, status) =>
        withDesktopWorkspaceCors(Response.json({ code, message }, { status }), request),
      hop: () => ({
        resolveControlPlaneScope: async () => ({ workspaceId }),
        environment: process.env,
        now: () => Date.now(),
        target: () => configuredLeadExecutionTarget(),
      }),
      json: workspaceJsonResponse,
      unavailable: workspaceUnavailableResponse,
      invalid: workspaceInvalidRequestResponse,
      authorizeFundingBinding: async (principal, id, binding) => {
        try {
          if (!fixtureAuthorized(principal, 'workspace.read', workspace.id)) return false
          return await authorizeLeadTurnFundingBinding(
            applicationDatabase(),
            id,
            principal,
            binding
          )
        } catch {
          return false
        }
      },
    }
    const observedModelDependencies = {
      ...modelDependencies,
      guard: (request) => {
        modelMetadataStage = 'guard'
        return modelDependencies.guard(request)
      },
      resolvePrincipal: async (request) => {
        modelMetadataStage = 'resolve-principal'
        return modelDependencies.resolvePrincipal(request)
      },
      authorize: async (principal, permission, requestedWorkspaceId) => {
        modelMetadataStage = 'authorize'
        return modelDependencies.authorize(principal, permission, requestedWorkspaceId)
      },
      canManage: async (principal, requestedWorkspaceId) => {
        modelMetadataStage = 'can-manage'
        return modelDependencies.canManage(principal, requestedWorkspaceId)
      },
      hop: (requestedWorkspaceId) => {
        modelMetadataStage = 'hop'
        const hop = modelDependencies.hop(requestedWorkspaceId)
        return {
          ...hop,
          resolveControlPlaneScope: async () => {
            modelMetadataStage = 'resolve-control-plane-scope'
            return hop.resolveControlPlaneScope()
          },
          target: () => {
            modelMetadataStage = 'target'
            return hop.target()
          },
        }
      },
      json: (...args) => {
        modelMetadataStage = 'response-json'
        return modelDependencies.json(...args)
      },
      failure: (...args) => {
        modelMetadataStage = 'response-failure'
        return modelDependencies.failure(...args)
      },
    }
    phase = 'application-database'
    const applicationDb = applicationDatabase()
    phase = 'lead-product-dependencies'
    const leadProductDependencies = await configuredLeadTurnProductDependencies(
      applicationDb,
      workspace.id,
      undefined
    )
    const assertPublicationCurrent = leadProductDependencies.adapter?.assertPublicationCurrent
    if (assertPublicationCurrent) {
      leadProductDependencies.adapter.assertPublicationCurrent = async (binding) => {
        publicationGate.calls++
        publicationGate.expected = binding
        try {
          await assertPublicationCurrent(binding)
          publicationGate.successes++
        } catch (error) {
          const code = safeDiagnosticField(error?.code, /^[A-Z][A-Z0-9_]{1,63}$/u)
          const reason = safeDiagnosticField(error?.message, /^[A-Z][A-Z0-9_]{1,63}$/u)
          const status = Number.isSafeInteger(error?.status) ? error.status : undefined
          const errorClass = safeDiagnosticField(error?.name, /^[A-Za-z][A-Za-z0-9]{0,48}$/u)
          publicationGate.failures.push({
            ...(errorClass ? { errorClass } : {}),
            ...(code ? { code } : {}),
            ...(safePublicationReasons.has(reason) ? { reason } : {}),
            ...(status ? { status } : {}),
          })
          throw error
        }
      }
    }
    phase = 'lead-product-composition'
    const leadProduct = createLeadTurnProduct(applicationDb, leadProductDependencies)

    async function admitMessage(request, requestedWorkspaceId, channelId) {
      const rejected = guardDesktopWorkspaceRequest(request)
      if (rejected) return rejected
      const resolution = await fixtureResolution(request)
      if (!resolution) return workspaceUnavailableResponse(request, 401)
      if (!fixtureAuthorized(resolution.principal, 'workspace.update', requestedWorkspaceId))
        return workspaceUnavailableResponse(request)
      let body
      try {
        body = await request.json()
      } catch {
        return Response.json(
          { code: 'invalid_request', message: 'Invalid request' },
          { status: 400 }
        )
      }
      const idempotencyKey = request.headers.get('idempotency-key')?.trim()
      if (body?.leadTurn !== true || !idempotencyKey || typeof body.bodyText !== 'string')
        return Response.json(
          { code: 'invalid_request', message: 'Invalid request' },
          { status: 400 }
        )
      let requestedModelSelections
      try {
        requestedModelSelections = parseRequestedRoleModelSelections(body.requestedModelSelections)
      } catch {
        return Response.json(
          { code: 'invalid_request', message: 'Invalid request' },
          { status: 400 }
        )
      }
      try {
        const payload = await db.createLeadTurn(
          applicationDatabase(),
          requestedWorkspaceId,
          channelId,
          resolution.principal,
          {
            bodyText: body.bodyText,
            idempotencyKey,
            requestedModelSelections,
            mentions: [],
          }
        )
        return workspaceJsonResponse(payload, resolution, request, { status: 201 })
      } catch (error) {
        return conversationErrorResponse(error, resolution, request)
      }
    }

    phase = 'fixture-api-start'
    api = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        const modelPath = new RegExp(`^/api/workspaces/${workspace.id}/model-connections$`, 'u')
        const messagePath = new RegExp(
          `^/api/v1/workspaces/${workspace.id}/channels/${topic.id}/messages$`,
          'u'
        )
        const latestPath = new RegExp(
          `^/api/v1/workspaces/${workspace.id}/channels/${topic.id}/lead-turn$`,
          'u'
        )
        const leadTurnPrefix = `/api/v1/workspaces/${workspace.id}/lead-turns/`
        try {
          if (modelPath.test(url.pathname)) {
            if (request.method === 'POST') {
              try {
                const body = await request.clone().json()
                if (body?.action === 'funding.get' && body.input)
                  fundingBindings.push({ ...body.input })
              } catch {}
            }
            try {
              modelMetadataStage = 'handler-entry'
              return await withRequestScope(() =>
                handleModelMetadata(request, workspace.id, observedModelDependencies)
              )
            } catch (error) {
              const errorRecord = error && typeof error === 'object' ? error : undefined
              const errorClass =
                errorRecord &&
                'name' in errorRecord &&
                typeof errorRecord.name === 'string' &&
                /^[A-Za-z][A-Za-z0-9]{0,48}$/u.test(errorRecord.name)
                  ? errorRecord.name
                  : 'Error'
              const code =
                errorRecord &&
                'code' in errorRecord &&
                typeof errorRecord.code === 'string' &&
                /^[A-Z][A-Z0-9_.-]{1,31}$/u.test(errorRecord.code)
                  ? errorRecord.code
                  : undefined
              modelMetadataFailures.push({
                stage: modelMetadataStage,
                errorClass,
                ...(code ? { code } : {}),
              })
              return Response.json({ code: 'fixture_unavailable' }, { status: 503 })
            }
          }
          if (messagePath.test(url.pathname)) {
            return await withRequestScope(async () => {
              if (request.method === 'POST') return admitMessage(request, workspace.id, topic.id)
              if (request.method === 'GET') {
                const rejected = guardDesktopWorkspaceRequest(request)
                if (rejected) return rejected
                const resolution = await fixtureResolution(request)
                if (!resolution) return workspaceUnavailableResponse(request, 401)
                if (!fixtureAuthorized(resolution.principal, 'workspace.read', workspace.id))
                  return workspaceUnavailableResponse(request)
                const page = await db.listMessagesForUser(
                  applicationDatabase(),
                  workspace.id,
                  topic.id,
                  resolution.principal,
                  { limit: 50 }
                )
                return workspaceJsonResponse(page, resolution, request, {
                  headers: { 'cache-control': 'private, no-store' },
                })
              }
              return Response.json(
                { code: 'invalid_request', message: 'Invalid request' },
                { status: 405 }
              )
            })
          }
          if (latestPath.test(url.pathname) && request.method === 'GET') {
            return await withRequestScope(async () => {
              const rejected = guardDesktopWorkspaceRequest(request)
              if (rejected) return rejected
              const resolution = await fixtureResolution(request)
              if (!resolution) return workspaceUnavailableResponse(request, 401)
              if (!fixtureAuthorized(resolution.principal, 'workspace.read', workspace.id))
                return workspaceUnavailableResponse(request)
              const leadTurn = await leadProduct.latest(
                workspace.id,
                topic.id,
                resolution.principal.userId
              )
              runtimeReadCounts.latest++
              return workspaceJsonResponse({ leadTurn }, resolution, request, {
                headers: { 'cache-control': 'private, no-store' },
              })
            })
          }
          if (url.pathname.startsWith(leadTurnPrefix)) {
            const suffix = url.pathname.slice(leadTurnPrefix.length)
            const parts = suffix.split('/')
            const intentId = parts[0]
            if (!intentId) return Response.json({ code: 'workspace_unavailable' }, { status: 404 })
            let operation
            if (parts.length === 1) operation = request.method === 'POST' ? 'dispatch' : 'status'
            else if (parts.length === 2 && parts[1] === 'prepare') operation = 'prepare'
            else if (parts.length === 2 && parts[1] === 'progress') operation = 'progress'
            else if (parts.length === 2 && parts[1] === 'cancel') operation = 'cancel'
            else return Response.json({ code: 'workspace_unavailable' }, { status: 404 })
            return await withRequestScope(async () => {
              const rejected = guardDesktopWorkspaceRequest(request)
              if (rejected) return rejected
              const resolution = await fixtureResolution(request)
              if (!resolution) return workspaceUnavailableResponse(request, 401)
              const mutation = ['prepare', 'dispatch', 'cancel'].includes(operation)
              const permission = mutation ? 'runtime.invoke' : 'workspace.read'
              if (!fixtureAuthorized(resolution.principal, permission, workspace.id))
                return workspaceUnavailableResponse(request)
              if (mutation) {
                try {
                  const body = await request.json()
                  if (
                    !body ||
                    typeof body !== 'object' ||
                    Array.isArray(body) ||
                    Object.keys(body).length
                  )
                    return workspaceInvalidRequestResponse(request)
                } catch {
                  return workspaceInvalidRequestResponse(request)
                }
              }
              const afterSequence = Number(url.searchParams.get('afterSequence') ?? 0)
              if (
                (operation === 'progress' &&
                  (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) ||
                [...url.searchParams.keys()].some(
                  (key) => operation !== 'progress' || key !== 'afterSequence'
                )
              )
                return workspaceInvalidRequestResponse(request)
              try {
                const scope = {
                  workspaceId: workspace.id,
                  intentId,
                  userId: resolution.principal.userId,
                }
                if (operation === 'status' || operation === 'progress')
                  runtimeReadCounts[operation]++
                const result =
                  operation === 'progress'
                    ? await leadProduct.progress(scope, afterSequence)
                    : await leadProduct[operation](scope)
                if (operation === 'prepare') preparationProjection = result
                if (operation === 'dispatch') dispatchProjection = result
                if (operation === 'status') statusProjection = result
                if (operation === 'progress')
                  progressProjection = {
                    state: result.leadTurn?.state,
                    eventTypes: Array.isArray(result.events)
                      ? result.events.map((event) => event.type)
                      : [],
                    nextSequence: result.nextSequence,
                  }
                if (operation === 'dispatch') {
                  try {
                    await host.control('drain')
                  } catch {
                    drainFailure = true
                  }
                }
                const payload = operation === 'progress' ? result : { leadTurn: result }
                return workspaceJsonResponse(payload, resolution, request, {
                  headers: { 'cache-control': 'private, no-store' },
                })
              } catch {
                return workspaceUnavailableResponse(request)
              }
            })
          }
          return Response.json({ code: 'workspace_unavailable' }, { status: 404 })
        } catch {
          return Response.json({ code: 'fixture_unavailable' }, { status: 503 })
        }
      },
    })

    return {
      apiBaseUrl: `http://127.0.0.1:${api.port}`,
      workspaceId: workspace.id,
      channelId: topic.id,
      credential,
      expectedHead,
      source,
      installed,
      packagePaths,
      hostSourceIdentity: metadata.sourceIdentity,
      async requestedSelections(intentId) {
        const [row] = await connection.db
          .select({ requestedModelSelections: db.leadTurnIntents.requestedModelSelections })
          .from(db.leadTurnIntents)
          .where(eq(db.leadTurnIntents.id, intentId))
        return row?.requestedModelSelections ?? null
      },
      async snapshot(intentId) {
        const [row] = intentId
          ? await connection.db
              .select({ requestedModelSelections: db.leadTurnIntents.requestedModelSelections })
              .from(db.leadTurnIntents)
              .where(eq(db.leadTurnIntents.id, intentId))
          : []
        const [runtimeRow] = intentId
          ? await connection.db
              .select({
                state: db.leadTurnRuntime.state,
                dispatchId: db.leadTurnRuntime.dispatchId,
                executionId: db.leadTurnRuntime.executionId,
                attemptId: db.leadTurnRuntime.attemptId,
                runtimeSessionId: db.leadTurnRuntime.runtimeSessionId,
                publishedMessageId: db.leadTurnRuntime.publishedMessageId,
              })
              .from(db.leadTurnRuntime)
              .where(eq(db.leadTurnRuntime.intentId, intentId))
          : []
        return {
          requestedModelSelections: row?.requestedModelSelections ?? null,
          preparationProjection,
          dispatchProjection,
          statusProjection,
          progressProjection,
          runtimeReadCounts: { ...runtimeReadCounts },
          publicationGate: {
            calls: publicationGate.calls,
            successes: publicationGate.successes,
            failures: [...publicationGate.failures],
            responses: [...publicationGate.responses],
            transportFailures: [...publicationGate.transportFailures],
          },
          controlPlaneWire: [...controlPlaneWire],
          runtimeRow: runtimeRow ?? null,
          fundingBindings: [...fundingBindings],
          readerRequests,
          databaseEnvironment: {
            inheritedClientAliasesRemoved: inheritedClientDatabaseAliases,
          },
          drainFailure,
          modelMetadataFailures: [...modelMetadataFailures],
        }
      },
      async evidence() {
        return host.control('evidence')
      },
      readerRequests: () => readerRequests,
      drainFailure: () => drainFailure,
      preparationProjection: () => preparationProjection,
      dispatchProjection: () => dispatchProjection,
      fundingBindings: () => [...fundingBindings],
      async close() {
        api?.stop(true)
        await host?.closeOwned()
        reader?.stop(true)
        await connection?.close()
        restoreEnvironment()
      },
    }
  } catch (error) {
    api?.stop(true)
    try {
      await host?.closeOwned()
    } catch {}
    reader?.stop(true)
    try {
      await connection?.close()
    } catch {}
    restoreEnvironment()
    const safeError = new Error(
      `CONNECTED_FIXTURE_START_FAILED:${phase}:${safeStartupReason(error)}`
    )
    Object.defineProperty(safeError, 'connectedFixturePhase', { value: phase })
    Object.defineProperty(safeError, 'connectedFixtureClass', {
      value: safeFailureClass(error),
    })
    const missingPackage = safeMissingPackage(error)
    if (missingPackage)
      Object.defineProperty(safeError, 'connectedFixtureMissingPackage', { value: missingPackage })
    throw safeError
  }
}
