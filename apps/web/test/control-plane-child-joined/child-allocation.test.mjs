// Opt-in joined backend proof. CP runs in its own pinned Bun/compiler context.
// Scope/account/tool policy/provider ports are scripted, never live qualification.
import { beforeAll, afterAll, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
const root = process.env.ADEA_CONTROL_PLANE_SOURCE
const binary = process.env.PI_FACTORY_BUN
const url = process.env.DATABASE_URL && new URL(process.env.DATABASE_URL)
if (!root || !binary || !url || url.hostname !== '127.0.0.1' || url.port !== '55432')
  throw new Error('EXPLICIT_LOCAL_ADEA_DATABASE_AND_CP_RUNTIME_REQUIRED')
const pin = JSON.parse(readFileSync(new URL('./source.json', import.meta.url), 'utf8'))
const git = (...args) => {
  const r = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error('CP_SOURCE_VERIFICATION_FAILED')
  return r.stdout.toString().trim()
}
if (git('rev-parse', 'HEAD') !== pin.revision || git('status', '--porcelain') !== '')
  throw new Error('CLEAN_PINNED_CP_SOURCE_REQUIRED')
const db = await import('@adea-ai/db')
const requireDb = createRequire(new URL('../../../../packages/db/package.json', import.meta.url))
const { eq } = await import(requireDb.resolve('drizzle-orm'))
const { createLeadProductReaderHandler } = await import('../../src/server/lead-product-reader.ts')
const { createLeadProductServiceVerifier } =
  await import('../../src/server/lead-product-service-auth.ts')
const originalFetch = globalThis.fetch
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
let connection, reader, owner, workspace, intentId, prepared, child, choices, assertion
const pending = new Map()
let productRequests = 0,
  deniedReads = 0,
  closed
async function control(command) {
  const id = randomUUID()
  let timer
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    timer = setTimeout(() => reject(new Error(`HOST_CONTROL_TIMEOUT:${command}`)), 15000)
  })
  child.stdin.write(JSON.stringify({ id, command, intentId }) + '\n')
  try {
    return await promise
  } finally {
    clearTimeout(timer)
    pending.delete(id)
  }
}
beforeAll(async () => {
  connection = db.createDatabase(process.env.DATABASE_URL)
  owner = await db.createTemporaryUserSession(connection.db, {
    credentialDigest: randomUUID(),
    expiresAt: new Date(Date.now() + 300_000),
  })
  ;({ workspace } = await db.createWorkspaceWithOwner(connection.db, {
    name: '1211 connected child source proof',
    owner: owner.principal,
    idempotencyKey: randomUUID(),
  }))
  const lead = await db.ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
  const topic = await db.createDirectAgentTopic(
    connection.db,
    workspace.id,
    lead.id,
    owner.principal,
    {
      title: 'Connected production child',
      idempotencyKey: randomUUID(),
    }
  )
  const [{ controlPlaneWorkspaceId: workspaceId }] = await connection.db
    .select()
    .from(db.workspaces)
    .where(eq(db.workspaces.id, workspace.id))
  const principalId = 'svc_agent-hq'
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const keyId = '1211-ephemeral-reader',
    issuer = 'https://1211-source-proof.invalid'
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
  assertion = `${unsigned}.${Buffer.from(await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(unsigned))).toString('base64url')}`
  const handler = createLeadProductReaderHandler({
    lifetimeMs: 300_000,
    verify: createLeadProductServiceVerifier({
      PI_LEAD_PRODUCT_TRUST: JSON.stringify({
        issuer,
        keyId,
        publicJwk,
        principalId,
        workspaceIds: [workspaceId],
        revokedCredentialIds: [],
      }),
    }),
    withCurrent: (ws, intent, disclose) =>
      db.withCurrentLeadTurnProduct(connection.db, ws, intent, disclose),
  })
  reader = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      productRequests++
      return handler(request)
    },
  })

  let resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const config = {
    workspaceId,
    actorPrincipalId: `user:${owner.principal.userId}`,
    principalId,
    productProfilePin: {
      profileId: lead.profile.id,
      profileVersion: lead.profile.version,
      profileRevision: lead.profile.revision,
    },
    assertion,
    readerUrl: new URL('/api/internal/pi-durable/lead-product/current', reader.url).href,
  }
  const env = { ...process.env, ADEA_CHILD_FACTORY_CONFIG: JSON.stringify(config) }
  delete env.NODE_OPTIONS
  delete env.BUN_OPTIONS
  child = spawn(binary, [join(import.meta.dirname, 'host.mjs')], {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  closed = new Promise((resolve) => child.once('close', resolve))
  child.on('error', rejectReady)
  child.on('exit', () => {
    rejectReady(new Error('HOST_EXIT_BEFORE_READY'))
    for (const wait of pending.values()) wait.reject(new Error('HOST_EXIT_BEFORE_REPLY'))
  })
  child.stderr.on('data', () => {})
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const value = JSON.parse(line)
      if (value.ready) resolveReady(value)
      else if (pending.has(value.id)) {
        if (value.error) pending.get(value.id).reject(new Error(value.error))
        else pending.get(value.id).resolve(value.data)
      }
    } catch {}
  })
  let timer
  try {
    choices = await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('HOST_STARTUP_TIMEOUT')), 10000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  const admitted = await db.createLeadTurn(connection.db, workspace.id, topic.id, owner.principal, {
    bodyText: 'Explicit lead and child roles',
    idempotencyKey: randomUUID(),
    requestedModelSelections: choices.requestedModelSelections,
  })
  intentId = admitted.leadTurn.intentId
}, 30000)
afterAll(async () => {
  try {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      let timer
      try {
        await Promise.race([
          closed,
          new Promise((resolve) => {
            timer = setTimeout(() => {
              console.error(
                JSON.stringify({
                  schemaVersion: 'adea-child-host-cleanup/v1',
                  forcedTermination: true,
                })
              )
              child.kill('SIGKILL')
              resolve()
            }, 5000)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
      await closed
    }
    if (choices?.directory?.startsWith(`${tmpdir()}/pi-real-production-factory-`))
      await rm(choices.directory, { recursive: true, force: true })
  } finally {
    reader?.stop(true)
    try {
      if (workspace) await db.archiveWorkspace(connection.db, workspace.id, owner.principal)
    } finally {
      await connection?.close()
    }
  }
}, 10000)

test('signed product reads reject another host workspace', async () => {
  const response = await originalFetch(
    new URL('/api/internal/pi-durable/lead-product/current', reader.url),
    {
      method: 'POST',
      headers: { authorization: `Bearer ${assertion}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG',
        intentId,
        principalId: 'svc_agent-hq',
      }),
    }
  )
  expect(response.status).toBe(404)
  deniedReads++
})
test('Adea canonical requested roles reach CP production preparation without inference', async () => {
  const result = await control('prepare')
  prepared = result.prepared
  expect(prepared.selectionRef).toBe(choices.requestedModelSelections.lead.selectionRef)
  expect(prepared.selectionRevision).toBe(choices.requestedModelSelections.lead.selectionRevision)
  expect(prepared.selectionRef).not.toBe(choices.requestedModelSelections.child.selectionRef)
  expect(result.canonical).toMatchObject({ executions: 1, attempts: 1, budgets: 1 })
  expect(result.physicalSends).toBe(0)
  expect(result.secretResolutions).toBe(0)
  expect(result.productReads + deniedReads).toBe(productRequests)
}, 20000)
test('child location refusal and revoked payer block without fallback', async () => {
  const result = await control('constraints')
  expect(result.locationDenied).toBe(true)
  expect(result.fundingState).toBe('blocked')
  expect(result.physicalSends).toBe(0)
  expect(result.secretResolutions).toBe(0)
  expect(result.canonical).toMatchObject({ executions: 1, attempts: 1, budgets: 1 })
}, 20000)
test('prepared Adea lead allocates its selected child through the canonical factory', async () => {
  const result = await control('allocate')
  if (!result.ok)
    console.error(
      JSON.stringify({
        schemaVersion: 'adea-child-allocation-blocker/v1',
        cpHead: pin.revision,
        ...result,
        childRuntimeProven: false,
        candidateManifestQualified: false,
      })
    )
  expect(result.ok).toBe(true)
  expect(result.canonical).toMatchObject({ executions: 2, attempts: 2, budgets: 2 })
}, 20000)
