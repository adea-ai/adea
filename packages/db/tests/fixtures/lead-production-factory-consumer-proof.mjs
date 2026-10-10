import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import {
  createDatabase,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  ensureWorkspaceLead,
  createDirectAgentTopic,
  createLeadTurn,
  withCurrentLeadTurnProduct,
  workspaces,
  messages,
  workspaceMemberships,
} from '@adea-ai/db'
import { createLeadProductReaderHandler } from '../../../../apps/web/src/server/lead-product-reader.ts'
import { createLeadProductServiceVerifier } from '../../../../apps/web/src/server/lead-product-service-auth.ts'
import { createLeadTurnProduct } from '../../../../apps/web/src/server/lead-turn-product.ts'
import { createConfiguredLeadTurnDependencies } from '../../../../apps/web/src/server/lead-turn-composition.ts'
import {
  verifyFactoryArchives,
  verifyFactorySource,
  verifyInstalledFactoryPackages,
} from './lead-production-factory-preflight.mjs'
import { installedLeadSdkPort } from '../../../../apps/web/src/server/lead-turn-sdk-port.ts'
import { startFactoryChild, runFactoryProof } from './lead-production-factory-process.mjs'
let connection, reader, host, metadata
let readerRequests = 0
let phase = 'preflight'
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
process.exitCode = await runFactoryProof(
  async () => {
    const cpRoot = process.env.PI_FACTORY_CP_ROOT
    const bun = process.env.PI_FACTORY_BUN
    if (!cpRoot || !bun || !process.env.DATABASE_URL)
      throw Error('OWNED_FIXTURE_CONFIGURATION_REQUIRED')
    const expectedHead = process.env.PI_FACTORY_EXPECTED_HEAD
    if (!/^[a-f0-9]{40}$/.test(expectedHead ?? ''))
      throw Error('VERIFIED_IMMUTABLE_HOST_HEAD_REQUIRED')
    const manifestPath = process.env.PI_FACTORY_MANIFEST
    if (!manifestPath) throw Error('VERIFIED_CANDIDATE_MANIFEST_REQUIRED')
    const manifest = verifyFactoryArchives(manifestPath, expectedHead)
    const source = verifyFactorySource(cpRoot, manifest)
    const installed = await verifyInstalledFactoryPackages(
      manifest,
      new URL('../../../../apps/web/package.json', import.meta.url),
      installedLeadSdkPort
    )
    connection = createDatabase(process.env.DATABASE_URL)
    phase = 'setup'
    assert.equal(installedLeadSdkPort.supported, true)
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 300_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      name: 'Installed production factory proof',
      owner: owner.principal,
      idempotencyKey: crypto.randomUUID(),
    })
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    const topic = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      { title: 'Actual installed publication', idempotencyKey: crypto.randomUUID() }
    )
    const admitted = await createLeadTurn(connection.db, workspace.id, topic.id, owner.principal, {
      bodyText: 'Canonical synthetic proof question',
      idempotencyKey: crypto.randomUUID(),
    })
    const [mapped] = await connection.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id))
    assert.ok(mapped.controlPlaneWorkspaceId)
    const workspaceId = mapped.controlPlaneWorkspaceId,
      principalId = 'svc_agent-hq'
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey),
      privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    const keyId = 'synthetic-production-consumer-key',
      issuer = 'https://synthetic-production-consumer.invalid'
    const trust = {
      issuer,
      keyId,
      publicJwk,
      principalId,
      workspaceIds: [workspaceId],
      revokedCredentialIds: [],
    }
    const readerEnv = { PI_LEAD_PRODUCT_TRUST: JSON.stringify(trust) }
    const handler = createLeadProductReaderHandler({
      lifetimeMs: 300_000,
      verify: createLeadProductServiceVerifier(readerEnv),
      withCurrent: (ws, intent, disclose) =>
        withCurrentLeadTurnProduct(connection.db, ws, intent, disclose),
    })
    reader = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        readerRequests++
        return handler(request)
      },
    })
    const now = Date.now(),
      claims = {
        audience: 'adea-lead-product',
        credentialId: crypto.randomUUID(),
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
    const config = {
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
    assert.ok(Number.isInteger(config.productProfilePin.profileRevision))
    phase = 'host-launch'
    const env = {
      ...process.env,
      PI_PRODUCTION_FACTORY_TEST_CONFIG: JSON.stringify(config),
      PI_PRODUCTION_FACTORY_PRODUCT_ASSERTION: productAssertion,
    }
    delete env.NODE_OPTIONS
    delete env.BUN_OPTIONS
    host = startFactoryChild(bun, ['scripts/pi-production-factory-candidate.mjs'], {
      cwd: cpRoot,
      env,
    })
    metadata = await host.ready()
    const control = host.control
    assert.equal(metadata.sourceIdentity, expectedHead)
    assert.equal(metadata.workspaceId, workspaceId)
    assert.equal(metadata.principalId, principalId)
    for (const key of ['profileId', 'profileVersion', 'profileRevision'])
      assert.equal(metadata[key], config.productProfilePin[key])
    const dependencies = await createConfiguredLeadTurnDependencies({
      environment: {
        NODE_ENV: 'test',
        PI_DURABLE_LEAD_ENABLED: 'true',
        PI_DURABLE_LEAD_TARGET: JSON.stringify(metadata.target),
        CONTROL_PLANE_ORIGIN: metadata.baseUrl,
        CONTROL_PLANE_SIGNING_KEY: JSON.stringify(privateJwk),
        CONTROL_PLANE_SIGNING_KEY_ID: keyId,
        CONTROL_PLANE_SIGNING_ISSUER: issuer,
      },
      resolveControlPlaneScope: async () => ({ workspaceId }),
    })
    assert.ok(dependencies.adapter)
    const product = createLeadTurnProduct(connection.db, dependencies),
      scope = {
        workspaceId: workspace.id,
        intentId: admitted.leadTurn.intentId,
        userId: owner.principal.userId,
      }
    phase = 'prepare'
    const prepared = await product.prepare(scope)
    assert.equal(prepared.state, 'prepared', `PREPARE_${prepared.reasonCode}`)
    const before = await control('evidence')
    assert.equal(before.physicalSends, 0)
    assert.ok(Number.isSafeInteger(before.productReads))
    assert.equal(before.productReads, readerRequests)
    phase = 'dispatch'
    const started = await product.dispatch(scope)
    assert.ok(
      ['starting', 'running'].includes(started.state),
      `DISPATCH_${started.state}_${started.reasonCode}`
    )
    assert.equal(started.reasonCode, undefined)
    assert.ok(started.dispatchId)
    assert.ok(started.runtimeSessionId)
    phase = 'drain'
    await control('drain')
    phase = 'publication'
    const completed = await product.status(scope)
    assert.equal(completed.state, 'completed', `STATUS_${completed.reasonCode}`)
    assert.ok(completed.publishedMessageId)
    const replay = await product.status(scope)
    assert.equal(replay.publishedMessageId, completed.publishedMessageId)
    for (const pin of [
      'dispatchId',
      'executionId',
      'attemptId',
      'runtimeSessionId',
      'selectionRef',
      'selectionRevision',
      'preparationRef',
    ]) {
      assert.ok(completed[pin])
      assert.equal(replay[pin], completed[pin])
    }
    const rows = await connection.db.select().from(messages).where(eq(messages.channelId, topic.id))
    assert.equal(rows.length, 2)
    const output = rows.find((row) => row.id === completed.publishedMessageId)
    assert.equal(output.bodyText, 'Actual production factory answer\n')
    assert.equal(output.senderAgentId, lead.id)
    assert.equal(output.executionRef, completed.executionId)
    assert.equal(output.externalSessionRef, completed.runtimeSessionId)
    const after = await control('evidence')
    assert.equal(after.physicalSends, 1)
    assert.equal(after.productReads, readerRequests)
    assert.ok(after.publicationChecks >= 2)
    assert.equal(after.canonical.executions, 1)
    assert.equal(after.canonical.attempts, 1)
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id))
    await assert.rejects(() => product.status(scope), /unavailable/)
    const denied = await control('evidence')
    assert.equal(denied.physicalSends, 1)
    assert.deepEqual(denied.canonical, after.canonical)
    assert.equal(denied.productReads, after.productReads)
    assert.equal(readerRequests, after.productReads)
    assert.equal(
      (await connection.db.select().from(messages).where(eq(messages.channelId, topic.id))).length,
      2
    )
    console.log(
      JSON.stringify({
        schemaVersion: 'adea-installed-production-factory-proof/v1',
        consumerSource: 'repository fixture; see retained checkpoint for qualified head',
        hostTree: source.tree,
        sourceDigest: source.sourceDigest,
        publicPackageVersions: {
          sdk: installed.sdk.version,
          contracts: installed.contracts.version,
          runtimeSdk: installed.runtimeSdk.version,
        },
        hostHead: metadata.sourceIdentity,
        actualInstalledSdk: true,
        actualProductionFactory: true,
        actualSqlitePublicationReader: true,
        initialDispatchState: started.state,
        originalDbActor: true,
        currentSignedPgReader: true,
        exactTrailingNewline: true,
        oneAppend: true,
        stableReplay: true,
        exactAllReplayPins: true,
        revokedOriginalActorDenied: true,
        noRedispatchAfterRevocation: true,
        physicalSends: after.physicalSends,
        productReads: after.productReads,
        publicationChecks: after.publicationChecks,
        canonical: after.canonical,
        transport: 'scripted-provider-and-test-https-to-loopback',
        live: false,
        tlsQualified: false,
        deviceOrRestart: false,
      })
    )
  },
  {
    phase: () => phase,
    readerRequests: () => readerRequests,
    actions: [() => host?.closeOwned(), () => reader?.stop(true), () => connection?.close()],
  }
)
