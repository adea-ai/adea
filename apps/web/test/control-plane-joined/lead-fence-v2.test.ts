/**
 * Joined #1220 × Control Plane fenced-rollback consumer proof (opt-in).
 *
 * Source-level proof that the control-plane consumer of the pinned `pi-lead-intent-fence/v2`
 * contract and Adea's signed current-product reader agree end to end. It is not production
 * qualification: see docs/evidence/m18-01-3-joined-consumer-proof.md for what this does and does
 * not establish. Only `bun run test:integration:control-plane-joined` loads this directory; the
 * default lanes never do, and a missing checkout or a revision mismatch fails instead of skipping.
 *
 * Real, Adea side: the PostgreSQL product database, the lead-turn lifecycle and rollback fence,
 * the signed current-product reader handler with its Ed25519 service verifier, the production lead
 * product (status, progress, cancel, prepare, dispatch) and the SDK runtime adapter.
 * Real, control-plane side, from the pinned checkout: the HTTP product reader, the production lead
 * product authority, the SQLite lead admission (ordinary workspace-scope admission, retained marker
 * and admission binding), the durable lead service with its receipt store, and the fence policy.
 * Both stores survive a restart: Adea opens a new connection, the control plane reopens its SQLite
 * files.
 *
 * Stubbed, disclosed: the runtime edge (the control-plane adapter that would start, observe and
 * cancel a Pi session) is a recording stub whose session outlives control-plane restarts. The
 * transport between Adea's SDK adapter and the control-plane service is a direct in-process call,
 * not HTTP. The product reader's TLS hop is an injected fetch into the real handler. Model
 * selection, funding and profile resolution are fixed stubs.
 *
 * Contract under test (existing fence-v2, no new resume path): while fenced, status, progress and
 * original-actor cancellation observe the retained handle; prepare, dispatch and lookup are
 * refused; resume and publication are refused by the policy table and by Adea.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceCredentialClaimsSchema } from '@adea-ai/contracts'
import {
  addWorkspaceMembership,
  channelParticipants,
  createDatabase,
  createDirectAgentTopic,
  createLeadTurn,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  ensureWorkspaceLead,
  fenceLeadTurnForRollback,
  markLeadTurnDispatchPending,
  observeLeadTurnRuntime,
  prepareLeadTurnRuntime,
  publishLeadTurnResult,
  readLeadTurnRollbackState,
  recoverLeadTurnRuntimeBinding,
  removeWorkspaceMembership,
  withCurrentLeadTurnProduct,
  workspaces,
} from '@adea-ai/db'
import { eq } from 'drizzle-orm'
import { createLeadProductReaderHandler } from '../../src/server/lead-product-reader'
import { createLeadProductServiceVerifier } from '../../src/server/lead-product-service-auth'
import { createLeadTurnProduct } from '../../src/server/lead-turn-product'
import { createLeadTurnSdkAdapter } from '../../src/server/lead-turn-sdk-adapter'
import { installedLeadSdkPort } from '../../src/server/lead-turn-sdk-port'

const connectionUrl = process.env.DATABASE_URL
const controlPlaneSource = process.env.ADEA_CONTROL_PLANE_SOURCE
if (!connectionUrl || !controlPlaneSource) {
  throw new Error(
    'The joined proof needs DATABASE_URL and ADEA_CONTROL_PLANE_SOURCE; run `bun run test:integration:control-plane-joined`'
  )
}

const pinned = JSON.parse(
  readFileSync(new URL('./control-plane-source.json', import.meta.url), 'utf8')
) as { repository: string; revision: string; cp1043Squash: string; leadFenceConsumer: string }
const git = (...args: string[]) =>
  Bun.spawnSync(['git', '-C', controlPlaneSource, ...args], { stdout: 'pipe', stderr: 'pipe' })
if (git('rev-parse', 'HEAD').stdout.toString().trim() !== pinned.revision) {
  throw new Error(`control-plane source is not the pinned revision ${pinned.revision}`)
}
if (git('status', '--porcelain', '--untracked-files=no').stdout.toString().trim() !== '') {
  throw new Error(
    'control-plane source has tracked changes; the proof needs the pinned revision exactly'
  )
}
if (git('merge-base', '--is-ancestor', pinned.leadFenceConsumer, 'HEAD').exitCode !== 0) {
  throw new Error(
    `control-plane source does not contain the fence-v2 consumer ${pinned.leadFenceConsumer}`
  )
}

const controlPlane = (path: string) => join(controlPlaneSource, path)
// Workspace packages resolve exactly as the control plane's own sources resolve them, so there is
// one module instance of each and no second copy loaded from this repository.
const fromControlPlane = (specifier: string) =>
  import(Bun.resolveSync(specifier, controlPlane('apps/control-api/src/pi-durable')))

const SERVICE_PRINCIPAL = 'svc_control-plane'
const ADMISSION_PRINCIPAL = 'svc_pi-admission'
const ISSUER = 'https://cp-fixture.invalid'
const KEY_ID = 'synthetic-joined-fence-key'
const READER_URL = 'https://adea.invalid/api/internal/pi-durable/lead-product/current'
const SELECTION = { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 }
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const base64url = (value: string | Uint8Array) => Buffer.from(value).toString('base64url')
const hex32 = () => randomUUID().replaceAll('-', '')
const crockford = (length: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => CROCKFORD[byte % 32]).join(
    ''
  )
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

let cp: any
let canonicalJsonStringify: (value: unknown) => string

type Handle = { handleId: string; attemptId: string; externalSessionId: string; startedAt: string }

/** Signs service tokens in memory for the real Adea verifier. Nothing touches operator configuration. */
async function signedService(cpWorkspaceId: string) {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const verify = createLeadProductServiceVerifier({
    PI_LEAD_PRODUCT_TRUST: JSON.stringify({
      issuer: ISSUER,
      keyId: KEY_ID,
      publicJwk,
      principalId: SERVICE_PRINCIPAL,
      workspaceIds: [cpWorkspaceId],
      revokedCredentialIds: [],
    }),
  })
  async function token() {
    const issued = Date.now() - 1_000
    const claims = ServiceCredentialClaimsSchema.parse({
      audience: 'adea-lead-product',
      credentialId: `synthetic-${crockford(26)}`,
      credentialKind: 'service',
      expiresAt: new Date(issued + 240_000).toISOString(),
      issuedAt: new Date(issued).toISOString(),
      issuer: ISSUER,
      keyId: KEY_ID,
      principalId: SERVICE_PRINCIPAL,
      projectIds: [],
      scopes: ['execution:read'],
      workspaceIds: [cpWorkspaceId],
    })
    const input = `${base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: KEY_ID }))}.${base64url(JSON.stringify(claims))}`
    const signature = await crypto.subtle.sign(
      'Ed25519',
      pair.privateKey,
      new TextEncoder().encode(input)
    )
    return `${input}.${base64url(new Uint8Array(signature))}`
  }
  return { verify, token }
}

const now = () => new Date().toISOString()

/** A runtime edge that survives control-plane restarts. One session per attempt, every call recorded. */
function createRuntime() {
  const sessions = new Map<string, Handle>()
  const calls = {
    start: [] as unknown[],
    status: [] as Handle[],
    progress: [] as Handle[],
    cancel: [] as { handle: Handle; options: { idempotencyKey: string } }[],
  }
  const faults = { loseStartResult: false }
  let state = 'running'
  const adapter = {
    start: async (request: { attemptId: string }) => {
      calls.start.push(request)
      let handle = sessions.get(request.attemptId)
      if (!handle) {
        handle = {
          handleId: `hEC${crockford(27)}`,
          attemptId: request.attemptId,
          externalSessionId: `ses_${crockford(26)}`,
          startedAt: now(),
        }
        sessions.set(request.attemptId, handle)
      }
      // The effect happened (a session exists); only the answer is lost.
      if (faults.loseStartResult) throw new Error('RUNTIME_RESULT_LOST')
      return structuredClone(handle)
    },
    status: async (handle: Handle) => {
      calls.status.push(structuredClone(handle))
      return { handle, state, observedAt: now() }
    },
    progress: async function* (handle: Handle) {
      calls.progress.push(structuredClone(handle))
      yield {
        handleId: handle.handleId,
        sequence: 1,
        occurredAt: now(),
        type: 'status',
        data: { state },
      }
    },
    cancel: async (handle: Handle, options: { idempotencyKey: string }) => {
      calls.cancel.push({ handle: structuredClone(handle), options: { ...options } })
      state = 'cancelling'
      return { handle, state, observedAt: now() }
    },
  }
  return {
    adapter,
    calls,
    faults,
    sessions,
    effects: () => ({
      start: calls.start.length,
      status: calls.status.length,
      progress: calls.progress.length,
      cancel: calls.cancel.length,
    }),
  }
}
type Runtime = ReturnType<typeof createRuntime>

/** Fault seams on the HTTP hop between the control-plane reader and Adea's signed handler. */
type Hop = {
  reads: number
  /** Replaces the transport result; `undefined` leaves the real handler's response. */
  intercept?: (response: Response) => Promise<Response> | Response
  /** Makes the transport fail before Adea is reached. */
  fail?: 'network' | 'unavailable'
}

const webOrigin = connectionUrl
let primary: ReturnType<typeof createDatabase>
const spare: ReturnType<typeof createDatabase>[] = []

/** The slice of a running admission that the no-effect check drives. */
interface NoEffectRun {
  host: {
    status: (dispatchId: string) => Promise<unknown>
    progress: (dispatchId: string) => Promise<unknown>
    cancel: (dispatchId: string, key: string) => Promise<unknown>
    dispatch: (key: string) => Promise<unknown>
    resolve: (operation?: string) => Promise<unknown>
    counts: () => Promise<unknown>
  }
  runtime: { effects: () => unknown }
  response: { dispatchId: string }
}

/** Every consumer operation fails and none reaches the runtime or the control-plane stores. */
async function expectNoEffect(run: NoEffectRun) {
  const { host, runtime, response } = run
  const effects = runtime.effects()
  const counts = await host.counts()
  await expect(host.status(response.dispatchId)).rejects.toThrow()
  await expect(host.progress(response.dispatchId)).rejects.toThrow()
  await expect(host.cancel(response.dispatchId, `transport:${randomUUID()}`)).rejects.toThrow()
  await expect(host.dispatch(`transport:${randomUUID()}`)).rejects.toThrow()
  await expect(host.resolve('prepare')).rejects.toThrow()
  expect(runtime.effects()).toEqual(effects)
  expect(await host.counts()).toEqual(counts)
}

describe('joined #1220 × control-plane fence-v2 consumer proof', () => {
  beforeAll(async () => {
    const [contracts, domain, executionPlan, testing, context, sqlite, catalog, ledger, worker] =
      await Promise.all([
        fromControlPlane('@control-plane/contracts'),
        fromControlPlane('@control-plane/domain'),
        fromControlPlane('@control-plane/execution-plan'),
        fromControlPlane('@control-plane/execution-plan/testing'),
        fromControlPlane('@control-plane/context'),
        fromControlPlane('@control-plane/sqlite-persistence'),
        fromControlPlane('@control-plane/sqlite-persistence/catalog'),
        fromControlPlane('@control-plane/usage-ledger'),
        fromControlPlane('@control-plane/workflow-worker'),
      ])
    cp = {
      contracts,
      domain,
      executionPlan,
      testing,
      context,
      sqlite,
      catalog,
      ledger,
      worker,
      admission: await import(controlPlane('apps/control-api/src/pi-durable/node-admission.ts')),
      service: await import(
        controlPlane('apps/control-api/src/pi-durable/pi-durable-lead.service.ts')
      ),
      authority: await import(
        controlPlane('apps/control-api/src/models/production-lead-product.ts')
      ),
      http: await import(controlPlane('apps/control-api/src/models/production-product-http.ts')),
      fence: await import(controlPlane('apps/control-api/src/models/lead-product-fence.ts')),
    }
    canonicalJsonStringify = contracts.canonicalJsonStringify
    primary = createDatabase(webOrigin)
  })
  afterAll(async () => {
    await primary?.close()
    for (const connection of spare) await connection.close()
  })

  /** One Adea tenant with one admitted direct lead turn, plus the signing identity for its reader. */
  async function adeaTenant() {
    const owner = await createTemporaryUserSession(primary.db, {
      credentialDigest: randomUUID(),
      expiresAt: new Date(Date.now() + 600_000),
    })
    const { workspace } = await createWorkspaceWithOwner(primary.db, {
      name: 'Joined fence proof',
      owner: owner.principal,
      idempotencyKey: randomUUID(),
    })
    const lead = await ensureWorkspaceLead(primary.db, workspace.id, owner.principal)
    const topic = await createDirectAgentTopic(primary.db, workspace.id, lead.id, owner.principal, {
      title: 'Joined fence',
      idempotencyKey: randomUUID(),
    })
    const actor = await createTemporaryUserSession(primary.db, {
      credentialDigest: randomUUID(),
      expiresAt: new Date(Date.now() + 600_000),
    })
    await addWorkspaceMembership(primary.db, workspace.id, actor.principal, 'admin')
    await primary.db.insert(channelParticipants).values({
      workspaceId: workspace.id,
      channelId: topic.id,
      principalKind: 'user',
      userId: actor.principal.userId,
    })
    const admitted = await createLeadTurn(primary.db, workspace.id, topic.id, actor.principal, {
      bodyText: 'Canonical question',
      idempotencyKey: randomUUID(),
    })
    const [canonical] = await primary.db
      .select({ controlPlaneWorkspaceId: workspaces.controlPlaneWorkspaceId })
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id))
    const cpWorkspaceId = canonical!.controlPlaneWorkspaceId
    const intentId = admitted.leadTurn.intentId
    const service = await signedService(cpWorkspaceId)
    const hop: Hop = { reads: 0 }
    const tenant = {
      owner,
      actor,
      workspace,
      topic,
      intentId,
      cpWorkspaceId,
      actorRef: `user:${actor.principal.userId}`,
      scope: { workspaceId: workspace.id, intentId, userId: actor.principal.userId },
      service,
      hop,
      /** The Adea process: a connection and a handler. A restart replaces both. */
      connection: primary,
      handler: undefined as unknown as (request: Request) => Promise<Response>,
    }
    tenant.handler = adeaHandler(tenant)
    return tenant
  }
  type Tenant = Awaited<ReturnType<typeof adeaTenant>>

  const adeaHandler = (tenant: Pick<Tenant, 'connection' | 'service'>) =>
    createLeadProductReaderHandler({
      lifetimeMs: 300_000,
      verify: tenant.service.verify,
      withCurrent: (workspaceId, intentId, disclose) =>
        withCurrentLeadTurnProduct(tenant.connection.db, workspaceId, intentId, disclose),
    })

  /** Adea restarts: a new database connection and a new handler over the same persisted state. */
  async function restartAdea(tenant: Tenant) {
    const fresh = createDatabase(webOrigin)
    spare.push(fresh)
    tenant.connection = fresh
    tenant.handler = adeaHandler(tenant)
  }

  /** The control-plane host: ordinary workspace admission over SQLite, reading Adea through the real reader. */
  async function controlPlaneHost(tenant: Tenant, runtime: Runtime) {
    const directory = await mkdtemp(join(tmpdir(), 'adea-joined-fence-'))
    const path = join(directory, 'node.sqlite')
    const at = now()
    const principal = {
      kind: 'agent_hq_service',
      principalId: SERVICE_PRINCIPAL,
      workspaceIds: [tenant.cpWorkspaceId],
      projectIds: [],
      scopes: ['execution:accept', 'execution:read', 'execution:cancel'],
    }
    let provider: any
    let database: DatabaseSync
    let repositories: any
    let published: any
    const plansByIntent = new Map<string, any>()
    const open = async () => {
      provider = new cp.sqlite.SqlitePersistenceProvider({ path })
      await provider.migrate()
      database = new DatabaseSync(path)
      repositories = {
        executions: new cp.sqlite.SqliteExecutionRepository(provider),
        plans: new cp.sqlite.SqliteExecutionPlanRepository(provider),
        contexts: new cp.sqlite.SqliteContextPackageRepository(provider),
        commands: new cp.sqlite.SqliteCommandAcceptanceRepository(provider, {
          budgetAdmission: true,
        }),
        catalog: new cp.catalog.SqliteVersionedCatalogRepository(provider),
        usage: new cp.sqlite.SqliteDurableUsageStore(provider),
      }
    }
    await open()
    const baseInputs = cp.testing.createExecutionPlanTestFixtureInputs()
    baseInputs.profile.definition.skills = []
    baseInputs.skills = []
    {
      const catalog = new cp.domain.VersionedCatalog(repositories.catalog, repositories.catalog)
      await catalog.createAgentProfile({
        profileId: baseInputs.profile.profileId,
        displayName: 'Joined fence proof profile',
        ownership: { scope: 'system' },
        createdAt: at,
      })
      const draft = await catalog.createAgentProfileDraft({
        profileId: baseInputs.profile.profileId,
        profileVersionId: baseInputs.profile.profileVersionId,
        version: baseInputs.profile.version,
        definition: baseInputs.profile.definition,
        createdAt: at,
      })
      published = await catalog.publishAgentProfileVersion({
        profileVersionId: draft.profileVersionId,
        expectedRevision: draft.revision,
        publishedAt: at,
      })
    }
    const scopeAuthority = {
      readCurrent: async (input: { callerPrincipalId: string }) => ({
        ...input,
        principalActive:
          input.callerPrincipalId === tenant.actorRef ||
          input.callerPrincipalId === ADMISSION_PRINCIPAL,
        grantActive: true,
        allowedPrincipalIds: [tenant.actorRef, ADMISSION_PRINCIPAL],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    }
    const resolvePlan = async (
      evidence: { intentId: string },
      ids: { requestId: string }
    ): Promise<any> => {
      const inputs = structuredClone(baseInputs)
      inputs.profile = published
      delete inputs.correlation.projectId
      inputs.correlation = {
        ...inputs.correlation,
        workspaceId: tenant.cpWorkspaceId,
        requestId: ids.requestId,
        executionScope: { schemaVersion: 1, kind: 'workspace' },
      }
      inputs.compiledAt = at
      inputs.contextPackage = new cp.context.ContextPackageCompiler('1.0.0').compileWorkspace({
        workspaceId: tenant.cpWorkspaceId,
        executionScope: inputs.correlation.executionScope,
        revision: 1,
        objective: 'Joined fence-v2 proof',
        artifacts: [],
        permissions: [],
        constraints: baseInputs.contextPackage.constraints,
        successCriteria: baseInputs.contextPackage.successCriteria,
        returnContract: baseInputs.contextPackage.returnContract,
        budgets: baseInputs.contextPackage.budgets,
        compiledAt: at,
      })
      await repositories.contexts.put(inputs.contextPackage)
      const plan = new cp.executionPlan.ExecutionPlanCompiler('1.0.0').compile(inputs)
      await repositories.plans.put(plan)
      plansByIntent.set(evidence.intentId, plan)
      return plan
    }
    const reader = () =>
      cp.http.createProductionProductHttpReader({
        endpoint: READER_URL,
        credentials: { getExistingCredential: async () => tenant.service.token() },
        fetch: async (_url: URL, init: RequestInit) => {
          tenant.hop.reads += 1
          if (tenant.hop.fail === 'network') throw new Error('TRANSPORT_DOWN')
          if (tenant.hop.fail === 'unavailable')
            return new Response('upstream unavailable', { status: 503 })
          const response = await tenant.handler(new Request(READER_URL, init))
          return tenant.hop.intercept ? tenant.hop.intercept(response) : response
        },
      })
    const build = () => {
      const product = cp.authority.createProductionLeadProductAuthority({
        database,
        product: reader(),
        profiles: {
          resolveImmutable: async (input: {
            profileId: string
            profileVersion: string
            profileRevision: number
          }) => ({
            ...input,
            profileVersionId: published.profileVersionId,
            profileContentDigest: published.contentDigest,
          }),
        },
        selections: {
          select: async () => SELECTION,
          resolveSelection: async () => SELECTION,
          assertReady: async () => {},
        },
        target: {
          location: 'remote_host',
          harness: 'pi_durable',
          harnessVersion: '1.1.0',
          providerBinding: 'pi_durable_models',
        },
        now,
      })
      const authority = new cp.admission.NodePiDurableLeadAdmission({
        database,
        product,
        resolvePlan,
        plans: repositories.plans,
        commandRepository: repositories.commands,
        planValidator: new cp.executionPlan.ExecutionPlanAcceptanceValidator(repositories.plans, {
          catalog: { profiles: repositories.catalog, skills: repositories.catalog },
          scopeAuthority,
          now,
        }),
        scopeAuthority,
        inspectRuntime: async () => ({
          health: 'healthy',
          capabilities: [{ name: 'execution.scope.workspace.v1', support: 'supported' }],
        }),
        assertProviderReady: async () => {},
        executions: repositories.executions,
        budgetAdmission: new cp.worker.DurableRuntimeBudgetAdmission({
          commands: repositories.commands,
          store: repositories.usage,
        }),
        admissionPrincipalId: ADMISSION_PRINCIPAL,
        now,
      })
      const receipts = new cp.service.SqlitePiDurableLeadReceiptStore(database)
      const service = new cp.service.DurablePiDurableLeadService({
        authority,
        receipts,
        adapter: runtime.adapter,
        now,
      })
      return { authority, receipts, service }
    }
    let current = build()
    const envelope = (operation: string, payload: unknown, idempotencyKey: string) => ({
      caller: { servicePrincipalId: principal.principalId },
      contractVersion: { major: 1, minor: 0 },
      requestId: 'req_01JABCDEF0123456789ABCDEFG',
      workspaceId: tenant.cpWorkspaceId,
      correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
      commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
      idempotencyKey,
      payloadHash: sha256(canonicalJsonStringify(payload)),
      operation,
      issuedAt: now(),
      payload,
    })
    const readEnvelope = (operation: string, parameters: unknown) => ({
      caller: { servicePrincipalId: principal.principalId },
      contractVersion: { major: 1, minor: 0 },
      requestId: 'req_01JABCDEF0123456789ABCDEFG',
      workspaceId: tenant.cpWorkspaceId,
      correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
      operation,
      requestedAt: now(),
      parameters,
    })
    const host = {
      principal,
      get authority() {
        return current.authority
      },
      get receipts() {
        return current.receipts
      },
      get service() {
        return current.service
      },
      get database() {
        return database
      },
      deterministicIds: () =>
        cp.admission.deterministicPiLeadIntentIds(tenant.cpWorkspaceId, tenant.intentId),
      marker: () => current.authority.store.marker(tenant.intentId),
      binding: () => current.authority.store.admissionBinding(tenant.intentId),
      dispatch: (key = 'transport:dispatch') =>
        current.service.dispatch(
          envelope('pi-durable.lead.dispatch', { intentId: tenant.intentId }, key),
          principal
        ),
      status: (dispatchId: string, as: unknown = principal) =>
        current.service.status(readEnvelope('pi-durable.lead.status', { dispatchId }), as),
      progress: (dispatchId: string) =>
        current.service.progress(
          readEnvelope('pi-durable.lead.progress', { dispatchId }),
          principal
        ),
      cancel: (dispatchId: string, key: string, as: unknown = principal) =>
        current.service.cancel(envelope('pi-durable.lead.cancel', { dispatchId }, key), as),
      lookup: () =>
        current.service.lookup(
          readEnvelope('pi-durable.lead.lookup', { intentId: tenant.intentId }),
          principal
        ),
      resolve: (operation?: string) =>
        current.authority.resolveIntent({
          workspaceId: tenant.cpWorkspaceId,
          intentId: tenant.intentId,
          principal,
          operation,
        }),
      counts: () =>
        provider.transaction(async (transaction: any) => ({
          commands: (await transaction.list('command-inbox')).length,
          executions: (await transaction.list('executions')).length,
        })),
      /** The control plane restarts: every SQLite handle closes and reopens over the same files. */
      async restart() {
        database.close()
        await provider.close()
        await open()
        current = build()
      },
      async close() {
        database.close()
        await provider.close()
        await rm(directory, { recursive: true, force: true })
      },
    }
    return host
  }
  type Host = Awaited<ReturnType<typeof controlPlaneHost>>

  /** Adea's real lead product, with the SDK adapter wired straight into the control-plane service. */
  function adeaProduct(tenant: Tenant, host: Host) {
    const adapter = createLeadTurnSdkAdapter({
      workspaceId: tenant.cpWorkspaceId,
      lookupResponseSchema: installedLeadSdkPort.lookupResponseSchema ?? undefined,
      lookup: () => host.lookup(),
      dispatch: async () => (await host.dispatch()).data,
      status: async (dispatchId) => (await host.status(dispatchId)).data,
      progress: async (dispatchId) => (await host.progress(dispatchId)).data,
      cancel: async (dispatchId) =>
        (await host.cancel(dispatchId, `lead-cancel:${dispatchId}`)).data,
    })
    return createLeadTurnProduct(tenant.connection.db, { adapter })
  }

  /** Adea's accepted selection for the control plane's deterministic attempt, as prepare would store it. */
  const pinFor = (tenant: Tenant, host: Host) => {
    const ids = host.deterministicIds()
    return {
      workspaceId: tenant.cpWorkspaceId,
      intentId: tenant.intentId,
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      ...SELECTION,
      preparationRef: `prep_${hex32()}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }
  }

  /** Adea prepares and marks the dispatch pending. The control plane has not been called yet. */
  async function prepareAndPend(tenant: Tenant, host: Host) {
    const pin = pinFor(tenant, host)
    const { db } = tenant.connection
    await prepareLeadTurnRuntime(
      db,
      tenant.workspace.id,
      tenant.intentId,
      tenant.actor.principal,
      pin
    )
    await markLeadTurnDispatchPending(
      db,
      tenant.workspace.id,
      tenant.intentId,
      tenant.actor.principal,
      pin
    )
    return pin
  }

  /** Ordinary admission and dispatch through the real service, then Adea records the answer it got. */
  async function dispatchAndBind(tenant: Tenant, host: Host) {
    const response = (await host.dispatch()).data
    const { db } = tenant.connection
    const binding = {
      intentId: tenant.intentId,
      executionId: response.executionId,
      attemptId: response.attemptId,
      dispatchId: response.dispatchId,
      runtimeSessionId: response.runtimeSessionId,
    }
    await recoverLeadTurnRuntimeBinding(
      db,
      tenant.workspace.id,
      tenant.intentId,
      tenant.actor.principal,
      binding
    )
    await observeLeadTurnRuntime(db, tenant.workspace.id, tenant.intentId, tenant.actor.principal, {
      ...binding,
      state: 'running',
      observedAt: new Date().toISOString(),
    })
    return { response, binding }
  }

  const fence = (tenant: Tenant) =>
    fenceLeadTurnForRollback(tenant.connection.db, tenant.workspace.id, tenant.intentId, {
      actor: { kind: 'user', principal: tenant.owner.principal },
      reason: 'rollback_cohort',
    })

  const rollbackState = (tenant: Tenant) =>
    readLeadTurnRollbackState(
      tenant.connection.db,
      tenant.workspace.id,
      tenant.intentId,
      tenant.actor.principal
    )

  /** What Adea emits over the real signed hop, read as the control-plane consumer would. */
  async function emitted(tenant: Tenant) {
    const response = await tenant.handler(
      new Request(READER_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${await tenant.service.token()}` },
        body: JSON.stringify({
          workspaceId: tenant.cpWorkspaceId,
          intentId: tenant.intentId,
          principalId: SERVICE_PRINCIPAL,
        }),
      })
    )
    return { status: response.status, body: (await response.json()) as Record<string, any> }
  }

  /** A fixture running one dispatched, bound, running admission that Adea has not fenced yet. */
  async function runningAdmission() {
    const tenant = await adeaTenant()
    const runtime = createRuntime()
    const host = await controlPlaneHost(tenant, runtime)
    await prepareAndPend(tenant, host)
    const unfenced = await emitted(tenant)
    const dispatched = await dispatchAndBind(tenant, host)
    return { tenant, runtime, host, unfenced, ...dispatched }
  }

  // ---- provenance ----------------------------------------------------------------------------

  test('provenance: the pinned control-plane revision carries the fence-v2 consumer and its exact policy table', () => {
    expect(git('rev-parse', 'HEAD').stdout.toString().trim()).toBe(pinned.revision)
    expect(cp.fence.fencedOperationPolicy('v2')).toEqual({
      prepare: 'refuse',
      dispatch: 'refuse',
      status: 'observe',
      progress: 'observe',
      cancel: 'cancel-as-actor',
      resume: 'refuse',
      publication: 'refuse',
    })
    expect(Object.values(cp.fence.fencedOperationPolicy('v1')).every((d) => d === 'refuse')).toBe(
      true
    )
  })

  // ---- ordinary admission, retained identity -------------------------------------------------

  test('retained identity: the control plane retains exactly the unfenced evidence Adea signed, and both sides hold one runtime identity', async () => {
    const { tenant, runtime, host, unfenced, response, binding } = await runningAdmission()
    try {
      expect(unfenced.status).toBe(200)
      expect(unfenced.body.schemaVersion).toBe('pi-lead-intent/v1')
      // The control plane retained the revision, scope, audience and actor Adea emitted.
      const marker = host.marker()
      expect(marker.state).toBe('ready')
      expect(marker.intent).toMatchObject({
        authorityRevision: unfenced.body.authorityRevision,
        scopeRef: unfenced.body.scopeRef,
        allowedPrincipalIds: unfenced.body.allowedPrincipalIds,
        canonicalActorPrincipalId: unfenced.body.canonicalActorPrincipalId,
      })
      const retained = host.binding()
      expect(retained).toMatchObject({
        executionId: binding.executionId,
        attemptId: binding.attemptId,
        authorityRevision: unfenced.body.authorityRevision,
        scopeRef: unfenced.body.scopeRef,
      })
      // One runtime session, started once, with the same identity in Adea, in the receipt and in the runtime.
      const receipt = await host.receipts.get(response.dispatchId)
      expect(receipt).toMatchObject({
        state: 'dispatched',
        executionId: binding.executionId,
        attemptId: binding.attemptId,
        admissionDigest: retained.admissionDigest,
        startDigest: retained.startDigest,
        deadlineAt: retained.deadlineAt,
        handle: { externalSessionId: binding.runtimeSessionId },
      })
      expect(runtime.sessions.get(binding.attemptId)).toEqual(receipt.handle)
      expect(runtime.effects().start).toBe(1)
      const adea = await rollbackState(tenant)
      expect(adea).toMatchObject({
        fenced: false,
        disposition: 'fence_required',
        runtime: {
          state: 'running',
          executionId: binding.executionId,
          attemptId: binding.attemptId,
          dispatchId: binding.dispatchId,
          runtimeSessionId: binding.runtimeSessionId,
        },
      })
    } finally {
      await host.close()
    }
  }, 60_000)

  // ---- continuation after fence and restart --------------------------------------------------

  test('continuation: after the fence and a restart of both sides, status, progress and original-actor cancel reach the original handle and start nothing', async () => {
    const { tenant, runtime, host, unfenced, response, binding } = await runningAdmission()
    try {
      const receiptBefore = await host.receipts.get(response.dispatchId)
      const countsBefore = await host.counts()
      expect((await fence(tenant)).disposition).toBe('in_flight_fenced')

      // Both sides restart: Adea gets a new connection and handler, the control plane reopens SQLite.
      await restartAdea(tenant)
      await host.restart()
      const fenced = await emitted(tenant)
      expect(fenced.status).toBe(200)
      expect(fenced.body).toMatchObject({
        schemaVersion: 'pi-lead-intent-fence/v2',
        dispatchPermitted: false,
        authorityRevision: unfenced.body.authorityRevision,
        scopeRef: unfenced.body.scopeRef,
        canonicalActorPrincipalId: unfenced.body.canonicalActorPrincipalId,
        allowedPrincipalIds: unfenced.body.allowedPrincipalIds,
      })
      // The retained admission survived the restart and still matches the fence pins.
      expect(host.marker().intent.scopeRef).toBe(fenced.body.scopeRef)
      expect(host.binding().authorityRevision).toBe(fenced.body.authorityRevision)

      // The real Adea product drives the control-plane consumer through the real signed hop.
      const product = adeaProduct(tenant, host)
      const hopBefore = tenant.hop.reads
      const status = await product.status(tenant.scope)
      expect(status).toMatchObject({
        availability: 'available',
        state: 'running',
        dispatchId: binding.dispatchId,
        runtimeSessionId: binding.runtimeSessionId,
      })
      const progress = await product.progress(tenant.scope, 0)
      expect(progress.events).toHaveLength(1)
      const cancelled = await product.cancel(tenant.scope)
      expect(cancelled).toMatchObject({ availability: 'available', state: 'cancelling' })
      // Each consumer call re-read Adea over the signed hop; none relied on a cached unfenced body.
      expect(tenant.hop.reads).toBeGreaterThan(hopBefore + 3)

      // Every effect reached the one original handle. Nothing was started, admitted or re-bound.
      const handle = runtime.sessions.get(binding.attemptId)!
      expect(handle.externalSessionId).toBe(binding.runtimeSessionId)
      expect(runtime.calls.status.at(-1)).toEqual(handle)
      expect(runtime.calls.progress.at(-1)).toEqual(handle)
      expect(runtime.calls.cancel).toHaveLength(1)
      expect(runtime.calls.cancel[0]).toMatchObject({
        handle,
        options: { idempotencyKey: `lead-cancel:${binding.dispatchId}` },
      })
      expect(runtime.effects().start).toBe(1)
      expect(await host.receipts.get(response.dispatchId)).toEqual(receiptBefore)
      expect(await host.counts()).toEqual(countsBefore)
      const after = await rollbackState(tenant)
      expect(after).toMatchObject({
        fenced: true,
        runtime: {
          executionId: binding.executionId,
          attemptId: binding.attemptId,
          dispatchId: binding.dispatchId,
          runtimeSessionId: binding.runtimeSessionId,
        },
      })

      // A retried cancel never opens a second identity: whatever reaches the runtime carries the
      // same handle and the same idempotency key.
      await product.cancel(tenant.scope)
      expect(runtime.calls.cancel.length).toBeGreaterThanOrEqual(1)
      for (const call of runtime.calls.cancel) {
        expect(call.handle).toEqual(handle)
        expect(call.options.idempotencyKey).toBe(`lead-cancel:${binding.dispatchId}`)
      }
      expect(runtime.effects().start).toBe(1)
    } finally {
      await host.close()
    }
  }, 60_000)

  test('continuation: the control plane principal outside the fence audience is refused and the runtime is not touched', async () => {
    const { tenant, runtime, host, response } = await runningAdmission()
    try {
      await fence(tenant)
      const before = runtime.effects()
      const stranger = { ...host.principal, principalId: 'svc_intruder' }
      await expect(host.status(response.dispatchId, stranger)).rejects.toThrow()
      await expect(
        host.cancel(response.dispatchId, 'transport:stranger', stranger)
      ).rejects.toThrow()
      expect(runtime.effects()).toEqual(before)
    } finally {
      await host.close()
    }
  }, 60_000)

  test('continuation: observation and cancel keep working after the evidence lifetime, because fence facts never expire into a dispatchable product', async () => {
    const { tenant, runtime, host, response, binding } = await runningAdmission()
    try {
      await fence(tenant)
      // The Adea handler's clock is ten minutes ahead of the 300 s evidence lifetime. An unfenced
      // product would be refused; fence facts are still emitted.
      const ahead = createLeadProductReaderHandler({
        lifetimeMs: 300_000,
        now: () => Date.now() + 600_000,
        verify: tenant.service.verify,
        withCurrent: (w, i, disclose) =>
          withCurrentLeadTurnProduct(tenant.connection.db, w, i, disclose),
      })
      tenant.handler = ahead
      await host.restart()
      const status = await host.status(response.dispatchId)
      expect(status.data).toMatchObject({
        dispatchId: binding.dispatchId,
        runtimeSessionId: binding.runtimeSessionId,
        state: 'running',
      })
      const cancelled = await host.cancel(response.dispatchId, 'transport:late-cancel')
      expect(cancelled.data.state).toBe('cancelling')
      expect(runtime.effects().start).toBe(1)
    } finally {
      await host.close()
    }
  }, 60_000)

  // ---- new effects stay refused --------------------------------------------------------------

  test('refusal: prepare, dispatch, lookup and publication are refused on both sides, with zero new effects, across a restart', async () => {
    const { tenant, runtime, host, response, binding } = await runningAdmission()
    try {
      const receiptBefore = await host.receipts.get(response.dispatchId)
      const countsBefore = await host.counts()
      const effectsBefore = runtime.effects()
      await fence(tenant)
      await restartAdea(tenant)
      await host.restart()

      // Control-plane consumer.
      for (const operation of [undefined, 'prepare', 'dispatch'])
        await expect(host.resolve(operation)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
      await expect(host.dispatch('transport:dispatch-again')).rejects.toThrow('PI_LEAD_UNAVAILABLE')
      await expect(host.lookup()).rejects.toThrow('PI_LEAD_UNAVAILABLE')

      // Adea product: no new preparation, dispatch or publication, before any control-plane call.
      const product = adeaProduct(tenant, host)
      await expect(product.prepare(tenant.scope)).rejects.toThrow('LEAD_TURN_FENCED')
      await expect(product.dispatch(tenant.scope)).rejects.toThrow('LEAD_TURN_FENCED')
      const { db } = tenant.connection
      await expect(
        prepareLeadTurnRuntime(db, tenant.workspace.id, tenant.intentId, tenant.actor.principal, {
          ...pinFor(tenant, host),
          executionId: `exe_${crockford(26)}`,
          attemptId: `att_${crockford(26)}`,
        })
      ).rejects.toThrow('LEAD_TURN_FENCED')
      await observeLeadTurnRuntime(
        db,
        tenant.workspace.id,
        tenant.intentId,
        tenant.actor.principal,
        {
          ...binding,
          state: 'completed',
          observedAt: new Date().toISOString(),
        }
      )
      await expect(
        publishLeadTurnResult(
          db,
          tenant.workspace.id,
          tenant.intentId,
          tenant.actor.principal,
          binding,
          'Answer',
          async () => {}
        )
      ).rejects.toThrow('LEAD_TURN_FENCED')

      expect(runtime.effects()).toEqual(effectsBefore)
      expect(await host.receipts.get(response.dispatchId)).toEqual(receiptBefore)
      expect(await host.counts()).toEqual(countsBefore)
      expect((await rollbackState(tenant)).fenced).toBe(true)
    } finally {
      await host.close()
    }
  }, 60_000)

  // ---- uncertain effect ----------------------------------------------------------------------

  test('uncertain effect: a started runtime whose result was lost stays fenced across restart and retry, and nothing is started again', async () => {
    const tenant = await adeaTenant()
    const runtime = createRuntime()
    const host = await controlPlaneHost(tenant, runtime)
    try {
      await prepareAndPend(tenant, host)
      // The control plane starts the runtime and crashes before it records the handle.
      runtime.faults.loseStartResult = true
      await expect(host.dispatch()).rejects.toThrow('PI_LEAD_UNAVAILABLE')
      runtime.faults.loseStartResult = false
      expect(runtime.effects().start).toBe(1)
      const attemptId = host.deterministicIds().attemptId
      const dispatchId = `dispatch_${sha256(canonicalJsonStringify([tenant.cpWorkspaceId, tenant.intentId])).slice(0, 32)}`
      const pending = await host.receipts.get(dispatchId)
      expect(pending).toMatchObject({ state: 'dispatching' })
      expect(pending.handle).toBeUndefined()
      // Adea holds the same uncertainty: dispatch pending, no binding.
      const uncertain = await rollbackState(tenant)
      expect(uncertain.runtime).toMatchObject({ state: 'dispatch_pending', attemptId })
      expect(uncertain.runtime?.dispatchId).toBeUndefined()

      expect((await fence(tenant)).disposition).toBe('reconcile_uncertain_effect')
      await restartAdea(tenant)
      await host.restart()
      const effectsFenced = runtime.effects()
      const countsFenced = await host.counts()

      // Retry of the dispatch, and every observation or cancel of the unproven handle, is refused.
      await expect(host.dispatch('transport:dispatch-retry-1')).rejects.toThrow(
        'PI_LEAD_UNAVAILABLE'
      )
      await expect(host.dispatch('transport:dispatch-retry-2')).rejects.toThrow(
        'PI_LEAD_UNAVAILABLE'
      )
      await expect(host.status(dispatchId)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
      await expect(host.progress(dispatchId)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
      await expect(host.cancel(dispatchId, 'transport:cancel-unproven')).rejects.toThrow(
        'PI_LEAD_UNAVAILABLE'
      )
      await expect(host.lookup()).rejects.toThrow('PI_LEAD_UNAVAILABLE')
      expect(runtime.effects()).toEqual(effectsFenced)
      expect(await host.counts()).toEqual(countsFenced)
      expect((await host.receipts.get(dispatchId))?.state).toBe('dispatching')

      // Adea's own reconciliation cannot resolve it either: the lookup it needs is refused while
      // fenced, so the admission stays unresolved and fenced. It is never inferred, never redispatched.
      const product = adeaProduct(tenant, host)
      const status = await product.status(tenant.scope)
      expect(status).toMatchObject({ availability: 'unavailable', state: 'dispatch_pending' })
      expect(status.dispatchId).toBeUndefined()
      await expect(product.dispatch(tenant.scope)).rejects.toThrow('LEAD_TURN_FENCED')
      const settled = await rollbackState(tenant)
      expect(settled).toMatchObject({ fenced: true, disposition: 'reconcile_uncertain_effect' })
      expect(settled.runtime?.dispatchId).toBeUndefined()
      expect(runtime.effects().start).toBe(1)
    } finally {
      await host.close()
    }
  }, 60_000)

  // ---- unknown, stale and unavailable evidence -----------------------------------------------

  describe('evidence that is not a valid current fence keeps ownership fenced', () => {
    test('unavailable: a transport failure or an upstream 5xx refuses everything, and the same fence applies once Adea is reachable again', async () => {
      const run = await runningAdmission()
      const { tenant, host, runtime, response } = run
      try {
        await fence(tenant)
        for (const fail of ['network', 'unavailable'] as const) {
          tenant.hop.fail = fail
          await expectNoEffect(run)
        }
        tenant.hop.fail = undefined
        expect((await host.status(response.dispatchId)).data.state).toBe('running')
        await expect(host.dispatch('transport:after-recovery')).rejects.toThrow(
          'PI_LEAD_UNAVAILABLE'
        )
        expect(runtime.effects().start).toBe(1)
      } finally {
        await host.close()
      }
    }, 60_000)

    test('unknown: an unknown fence schema, a fence with a dispatchable body, or a fence with extra fields is refused', async () => {
      const run = await runningAdmission()
      const { tenant, host, runtime, response } = run
      try {
        await fence(tenant)
        const rewrites: ((body: Record<string, any>) => Record<string, any>)[] = [
          (body) => ({ ...body, schemaVersion: 'pi-lead-intent-fence/v3' }),
          (body) => ({ ...body, dispatchPermitted: true }),
          (body) => ({ ...body, prompt: 'smuggled' }),
          (body) => ({ ...body, allowedPrincipalIds: [] }),
          (body) => ({
            ...body,
            rollbackFence: { ...body.rollbackFence, fencedAt: '2999-01-01T00:00:00.000Z' },
          }),
          (body) => ({ ...body, intentId: randomUUID() }),
        ]
        for (const rewrite of rewrites) {
          tenant.hop.intercept = async (real) =>
            Response.json(rewrite((await real.json()) as Record<string, any>), {
              status: real.status,
            })
          await expectNoEffect(run)
        }
        tenant.hop.intercept = undefined
        expect((await host.status(response.dispatchId)).data.state).toBe('running')
        expect(runtime.effects().start).toBe(1)
      } finally {
        await host.close()
      }
    }, 60_000)

    test('stale: a retained revision or scope that no longer matches the fence conflicts, and Adea refuses a participant change outright', async () => {
      const run = await runningAdmission()
      const { tenant, host, runtime } = run
      try {
        await fence(tenant)
        const effectsBefore = runtime.effects()
        // The control plane's retained marker is behind the fence: revision, then scope.
        const record = host.database
          .prepare('SELECT record FROM pi_lead_intent_admissions WHERE intent_id = ?')
          .get(tenant.intentId)
        const original = String(record!['record'])
        for (const [field, value] of [
          ['authorityRevision', 99],
          ['scopeRef', `adea-product:sha256:${'0'.repeat(64)}`],
        ] as const) {
          host.database
            .prepare(
              "UPDATE pi_lead_intent_admissions SET record = json_set(record, '$.intent.' || ?, ?) WHERE intent_id = ?"
            )
            .run(field, value, tenant.intentId)
          await expect(host.status(run.response.dispatchId)).rejects.toThrow(
            'PI_LEAD_AUTHORITY_CONFLICT'
          )
          await expect(
            host.cancel(run.response.dispatchId, `transport:${randomUUID()}`)
          ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
          host.database
            .prepare('UPDATE pi_lead_intent_admissions SET record = ? WHERE intent_id = ?')
            .run(original, tenant.intentId)
        }
        expect(runtime.effects()).toEqual(effectsBefore)

        // Adea's own authority moves under the fence: a participant joins, so the pinned audience
        // changes. The reader then refuses outright and the consumer learns nothing.
        const joiner = await createTemporaryUserSession(tenant.connection.db, {
          credentialDigest: randomUUID(),
          expiresAt: new Date(Date.now() + 600_000),
        })
        await addWorkspaceMembership(
          tenant.connection.db,
          tenant.workspace.id,
          joiner.principal,
          'member'
        )
        await tenant.connection.db.insert(channelParticipants).values({
          workspaceId: tenant.workspace.id,
          channelId: tenant.topic.id,
          principalKind: 'user',
          userId: joiner.principal.userId,
        })
        expect(await emitted(tenant)).toEqual({
          status: 404,
          body: { code: 'LEAD_PRODUCT_UNAVAILABLE' },
        })
        await expectNoEffect(run)
        // Adea's own pinned lifecycle also refuses to read through the changed audience.
        await expect(rollbackState(tenant)).rejects.toThrow('Lead turn version conflict')
      } finally {
        await host.close()
      }
    }, 60_000)

    test('revoked: removing the original actor makes the reader 404, so the consumer cannot observe or cancel, and the fence stays', async () => {
      const run = await runningAdmission()
      const { tenant, host, runtime } = run
      try {
        await fence(tenant)
        expect(
          await removeWorkspaceMembership(
            tenant.connection.db,
            tenant.workspace.id,
            tenant.actor.principal
          )
        ).toBe(true)
        expect(await emitted(tenant)).toEqual({
          status: 404,
          body: { code: 'LEAD_PRODUCT_UNAVAILABLE' },
        })
        // A 404 never reads as "not fenced": the control plane gets no product at all.
        await expectNoEffect(run)
        await restartAdea(tenant)
        await host.restart()
        await expectNoEffect(run)
        expect(runtime.effects().start).toBe(1)
      } finally {
        await host.close()
      }
    }, 60_000)
  })
})
