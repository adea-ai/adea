import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { findSimSessionContext, revokeSimSession } from '../../src/sim-launch-sessions'
import { simLaunchCodes, simSessions } from '../../src/schema'
import {
  createSimIssuerStores,
  createSimRedemptionStore,
  createSimSessionLookup,
} from '../../src/sim-launch-ports'
import { createSimApi } from '../../../../apps/web/src/server/sim-http'
import { createSimLaunchService } from '../../../../apps/web/src/server/sim-launch-service'
import { createSimHostService } from '../../../../apps/web/src/server/sim-host-service'
import { createSimPrivateAssetReader } from '../../../../apps/web/src/server/sim-private-assets'

// The integrated hosted-Sim acceptance over durable storage.
//
// The launch and the session exchange are joined over their real HTTP boundary, and the storage
// behind them is a disposable PostgreSQL instance: the launch code and the session it mints are
// written by the real store, and the session gate reads them back.
//
// Everything else is synthetic. The entitlement policy is a function over the scope, the private
// bytes are an in-memory map, and the principal is a header. No production store, no bucket, no
// credential and no deployment is involved.
//
// The composition is the approved one: the Adea side issues a code through the launch service and
// the HTTP API, and the hosted side redeems it and serves the private assets behind the session
// cookie. The hosted service and the private reader are the other owner's modules, imported here
// to join the path; they are not changed by this file.

const connectionUrl = process.env.DATABASE_URL

const parentOrigin = 'https://app.example'
const simOrigin = 'https://sim.example'
const bridgeId = 'bridge_nonce_123456789'
const entryFiles = {
  hq: 'engine.js',
  'room-designer': 'room-designer.js',
  'character-designer': 'character-designer.js',
}
const engine = { body: 'private-engine-bytes', contentType: 'text/javascript' }

const unique = () => crypto.randomUUID()

const post = (url: string, value: unknown, source: string, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: 'POST',
    headers: { origin: source, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value),
  })

const get = (url: string, cookie?: string) =>
  new Request(url, { headers: cookie ? { cookie } : {} })

/** The synthetic entitlement policy: every scope is entitled. */
const entitled = () => 'entitled'

/** The launch body the Adea side accepts. */
const launchBody = (workspaceId: string, surface = 'hq') => ({
  schemaVersion: 1,
  workspaceId,
  surface,
  platform: 'desktop',
  bridgeId,
})

/** The session value a set-cookie header carries. */
const cookieValue = (header: string) => header.split(';')[0]!

describe.skipIf(!connectionUrl)(
  'the hosted Sim launch, session and private asset path, joined over HTTP',
  () => {
    let connection: DatabaseConnection
    const createdWorkspaces = new Set<string>()

    beforeAll(() => {
      connection = createDatabase(connectionUrl!)
    })

    afterAll(async () => {
      // Sessions reference their launch codes, so they go first.
      const workspaceIds = [...createdWorkspaces]
      if (workspaceIds.length > 0) {
        await connection.db
          .delete(simSessions)
          .where(inArray(simSessions.workspaceId, workspaceIds))
        await connection.db
          .delete(simLaunchCodes)
          .where(inArray(simLaunchCodes.workspaceId, workspaceIds))
      }
      await connection.close()
    })

    /**
     * One composed hosted service over the durable store, with a synthetic policy and synthetic
     * private bytes. Every replica is constructed independently; they share the durable store and
     * nothing else.
     */
    function replica(options: {
      now: () => number
      policy: (scope: { workspaceId: string; surface: string }) => unknown
      principal?: (request: Request) => unknown
      objects?: Record<string, { body: string; contentType: string }>
    }) {
      const reads: { key: string; context: { workspaceId: string; surface: string } }[] = []
      const contexts: { workspaceId: string; surface: string }[] = []
      const reader = createSimPrivateAssetReader({
        location: 'agent-sim-export',
        read: async (request) => {
          reads.push({ key: request.key, context: contexts[contexts.length - 1]! })
          return options.objects?.[request.key] ?? null
        },
      })
      const host = createSimHostService({
        configuration: {
          origin: simOrigin,
          parentOrigins: [parentOrigin],
          assetPrefix: '/assets/agent-sim/',
          entryFiles,
        },
        store: createSimRedemptionStore(connection.db),
        sessions: createSimSessionLookup(connection.db, options.now),
        policy: options.policy as never,
        readAsset: async (path, context) => {
          contexts.push(context)
          return await reader(path)
        },
        frameScript: '// public bootstrap only',
        now: options.now,
      })
      return { host, reads, contexts }
    }

    /** The Adea side: the launch service behind the HTTP API, over the durable issuer stores. */
    function issuer(options: {
      now: () => number
      policy: (scope: { workspaceId: string; surface: string }) => unknown
      principal?: (request: Request) => unknown
      workspaces?: (principal: unknown) => string[]
      frameOrigin?: string | null
    }) {
      const stores = createSimIssuerStores(connection.db)
      const service = createSimLaunchService({
        frameOrigin: options.frameOrigin === undefined ? simOrigin : options.frameOrigin,
        createStore: (workspaceId) => stores(workspaceId),
        // The code lives as long as the contract allows, so a slow run cannot expire it.
        codeTtlMs: 120_000,
        ports: {
          resolvePrincipal: options.principal ?? (() => 'principal-one'),
          authorizeWorkspace: (principal, action, workspaceId) => {
            if (action !== 'workspace.read') return false
            return (options.workspaces?.(principal) ?? [workspaceId]).includes(workspaceId)
          },
          policy: options.policy as never,
        },
        now: options.now,
      })
      const api = createSimApi({
        frameOrigin: options.frameOrigin === undefined ? simOrigin : options.frameOrigin,
        trustedHostOrigins: [parentOrigin],
        issue: (request, body) => service(request, body),
      })
      return { api, service }
    }

    test('one token redeemed concurrently yields exactly one cookie and one session', async () => {
      const workspaceId = `ws-${unique()}`
      createdWorkspaces.add(workspaceId)
      const now = Date.now()
      const { api } = issuer({ now: () => now, policy: entitled })
      const first = replica({ now: () => now, policy: entitled })
      const second = replica({ now: () => now, policy: entitled })

      const granted = (await (
        await api.launch(
          post(`${parentOrigin}/api/sim/launch`, launchBody(workspaceId), parentOrigin)
        )
      ).json()) as { status: string; code: string }
      expect(granted.status).toBe('granted')

      // Two independently constructed replicas redeem the same token at the same time.
      const exchange = (host: typeof first.host) =>
        host(
          post(
            `${simOrigin}/session`,
            { schemaVersion: 1, code: granted.code, bridgeId },
            simOrigin
          )
        )
      const [one, two] = await Promise.all([exchange(first.host), exchange(second.host)])
      const answers = [one, two]
      const sessions = answers.filter((answer) => answer.headers.get('set-cookie') !== null)
      expect(sessions).toHaveLength(1)
      const cookies = answers.map((answer) => answer.headers.get('set-cookie'))
      expect(cookies.filter((cookie) => cookie !== null)).toHaveLength(1)
      const bodies = await Promise.all(answers.map((answer) => answer.json()))
      expect(
        bodies.filter((body) => (body as { status: string }).status === 'session')
      ).toHaveLength(1)
      expect(
        bodies.filter((body) => (body as { status: string }).status === 'rejected')
      ).toHaveLength(1)

      // One session row, for the workspace the code was bound to.
      const rows = await connection.db
        .select()
        .from(simSessions)
        .where(eq(simSessions.workspaceId, workspaceId))
      expect(rows).toHaveLength(1)
    })

    test('an asset read stays bound to the stored workspace and surface', async () => {
      const workspaceId = `ws-${unique()}`
      createdWorkspaces.add(workspaceId)
      const now = Date.now()
      const { api } = issuer({ now: () => now, policy: entitled })
      const hosted = replica({ now: () => now, policy: entitled, objects: { 'engine.js': engine } })

      const granted = (await (
        await api.launch(
          post(`${parentOrigin}/api/sim/launch`, launchBody(workspaceId), parentOrigin)
        )
      ).json()) as { code: string }
      const exchanged = await hosted.host(
        post(`${simOrigin}/session`, { schemaVersion: 1, code: granted.code, bridgeId }, simOrigin)
      )
      const cookie = cookieValue(exchanged.headers.get('set-cookie')!)

      // The stored row names the workspace and the surface. No request may change them.
      const hinted = await hosted.host(
        get(
          `${simOrigin}/assets/agent-sim/engine.js?workspaceId=ws-other&surface=room-designer`,
          cookie
        )
      )
      expect(hinted.status).toBe(200)
      expect(await hinted.text()).toBe('private-engine-bytes')
      expect(hosted.contexts).toEqual([{ workspaceId, surface: 'hq' }])

      // Another surface's entry is refused for this session.
      const other = await hosted.host(get(`${simOrigin}/assets/agent-sim/room-designer.js`, cookie))
      expect(other.status).toBe(403)
      expect(hosted.reads).toHaveLength(1)
    })

    test('a recreated handler keeps the intended persistence', async () => {
      const workspaceId = `ws-${unique()}`
      createdWorkspaces.add(workspaceId)
      const now = Date.now()
      const { api } = issuer({ now: () => now, policy: entitled })
      const first = replica({ now: () => now, policy: entitled, objects: { 'engine.js': engine } })

      const granted = (await (
        await api.launch(
          post(`${parentOrigin}/api/sim/launch`, launchBody(workspaceId), parentOrigin)
        )
      ).json()) as { code: string }
      const exchanged = await first.host(
        post(`${simOrigin}/session`, { schemaVersion: 1, code: granted.code, bridgeId }, simOrigin)
      )
      const cookie = cookieValue(exchanged.headers.get('set-cookie')!)

      // A new handler over the same durable store still resolves the session.
      const recreated = replica({
        now: () => now,
        policy: entitled,
        objects: { 'engine.js': engine },
      })
      const asset = await recreated.host(get(`${simOrigin}/assets/agent-sim/engine.js`, cookie))
      expect(asset.status).toBe(200)
      expect(await asset.text()).toBe('private-engine-bytes')
      expect(recreated.contexts).toEqual([{ workspaceId, surface: 'hq' }])

      // And the code stays spent across the restart.
      const replay = await recreated.host(
        post(`${simOrigin}/session`, { schemaVersion: 1, code: granted.code, bridgeId }, simOrigin)
      )
      expect(replay.headers.get('set-cookie')).toBeNull()
      expect(((await replay.json()) as { status: string }).status).toBe('rejected')
    })

    test('a revoked session, an expired session and a changed entitlement deny without reading', async () => {
      const workspaceId = `ws-${unique()}`
      createdWorkspaces.add(workspaceId)
      let now = Date.now()
      let verdict: unknown = 'entitled'
      const policy = () => verdict
      const { api } = issuer({ now: () => now, policy })
      const hosted = replica({ now: () => now, policy, objects: { 'engine.js': engine } })

      const granted = (await (
        await api.launch(
          post(`${parentOrigin}/api/sim/launch`, launchBody(workspaceId), parentOrigin)
        )
      ).json()) as { code: string }
      const exchanged = await hosted.host(
        post(`${simOrigin}/session`, { schemaVersion: 1, code: granted.code, bridgeId }, simOrigin)
      )
      const cookie = cookieValue(exchanged.headers.get('set-cookie')!)
      const value = cookie.slice(cookie.indexOf('=') + 1)

      // The entitlement changed after the session was minted.
      verdict = 'not_entitled'
      const denied = await hosted.host(get(`${simOrigin}/assets/agent-sim/engine.js`, cookie))
      expect(denied.status).toBe(403)
      expect(hosted.reads).toHaveLength(0)
      expect(hosted.contexts).toHaveLength(0)
      verdict = 'entitled'

      // The session was revoked.
      await revokeSimSession(connection.db, value, now)
      const revoked = await hosted.host(get(`${simOrigin}/assets/agent-sim/engine.js`, cookie))
      expect(revoked.status).toBe(401)
      expect(hosted.reads).toHaveLength(0)
      expect(hosted.contexts).toHaveLength(0)
    })

    test('an expired session denies without reading', async () => {
      const workspaceId = `ws-${unique()}`
      createdWorkspaces.add(workspaceId)
      let now = Date.now()
      const { api } = issuer({ now: () => now, policy: entitled })
      const hosted = replica({ now: () => now, policy: entitled, objects: { 'engine.js': engine } })

      const granted = (await (
        await api.launch(
          post(`${parentOrigin}/api/sim/launch`, launchBody(workspaceId), parentOrigin)
        )
      ).json()) as { code: string }
      const exchanged = await hosted.host(
        post(`${simOrigin}/session`, { schemaVersion: 1, code: granted.code, bridgeId }, simOrigin)
      )
      const cookie = cookieValue(exchanged.headers.get('set-cookie')!)

      // The session outlives its own expiry.
      now += 3600_001
      const expired = await hosted.host(get(`${simOrigin}/assets/agent-sim/engine.js`, cookie))
      expect(expired.status).toBe(401)
      expect(hosted.reads).toHaveLength(0)
      expect(hosted.contexts).toHaveLength(0)
    })

    test('a wrong origin, a wrong bridge, a replay, a missing session and another prefix all deny', async () => {
      const workspaceId = `ws-${unique()}`
      createdWorkspaces.add(workspaceId)
      const now = Date.now()
      const { api } = issuer({ now: () => now, policy: entitled })
      const hosted = replica({ now: () => now, policy: entitled, objects: { 'engine.js': engine } })

      // A code is spent by its first presentation, so every refusal gets its own.
      const grant = async () => {
        const answer = (await (
          await api.launch(
            post(`${parentOrigin}/api/sim/launch`, launchBody(workspaceId), parentOrigin)
          )
        ).json()) as { code: string }
        return answer.code
      }

      // A foreign origin cannot ask for a launch.
      const foreign = await api.launch(
        post(`${parentOrigin}/api/sim/launch`, launchBody(workspaceId), 'https://foreign.example')
      )
      expect(foreign.status).toBe(403)
      expect(hosted.reads).toHaveLength(0)

      // A foreign origin cannot exchange a code.
      const crossOrigin = await hosted.host(
        post(
          `${simOrigin}/session`,
          { schemaVersion: 1, code: await grant(), bridgeId },
          'https://foreign.example'
        )
      )
      expect(crossOrigin.status).toBe(403)
      expect(crossOrigin.headers.get('set-cookie')).toBeNull()

      // Another bridge cannot redeem a code, and the refusal mints no session.
      const otherBridge = await hosted.host(
        post(
          `${simOrigin}/session`,
          { schemaVersion: 1, code: await grant(), bridgeId: 'bridge_other_1234567890' },
          simOrigin
        )
      )
      expect(otherBridge.headers.get('set-cookie')).toBeNull()
      expect(((await otherBridge.json()) as { status: string }).status).toBe('rejected')

      // The right bridge redeems a code once.
      const granted = await grant()
      const exchanged = await hosted.host(
        post(`${simOrigin}/session`, { schemaVersion: 1, code: granted, bridgeId }, simOrigin)
      )
      expect(exchanged.headers.get('set-cookie')).not.toBeNull()
      const cookie = cookieValue(exchanged.headers.get('set-cookie')!)

      // The replay of the same code is refused.
      const replay = await hosted.host(
        post(`${simOrigin}/session`, { schemaVersion: 1, code: granted, bridgeId }, simOrigin)
      )
      expect(replay.headers.get('set-cookie')).toBeNull()
      expect(((await replay.json()) as { status: string }).status).toBe('rejected')

      // A missing session reads nothing.
      const anonymous = await hosted.host(get(`${simOrigin}/assets/agent-sim/engine.js`))
      expect(anonymous.status).toBe(401)
      expect(hosted.reads).toHaveLength(0)

      // Another prefix is not the asset prefix.
      const elsewhere = await hosted.host(get(`${simOrigin}/other/engine.js`, cookie))
      expect(elsewhere.status).toBe(404)
      expect(hosted.reads).toHaveLength(0)
    })

    test('a launch without a configured hosting origin issues nothing durable', async () => {
      const workspaceId = `ws-${unique()}`
      createdWorkspaces.add(workspaceId)
      const now = Date.now()
      const { api } = issuer({ now: () => now, policy: entitled, frameOrigin: null })
      const answer = await api.launch(
        post(`${parentOrigin}/api/sim/launch`, launchBody(workspaceId), parentOrigin)
      )
      expect(answer.status).toBe(200)
      expect(await answer.json()).toEqual({ status: 'unavailable', reason: 'not_configured' })
      const rows = await connection.db
        .select()
        .from(simSessions)
        .where(eq(simSessions.workspaceId, workspaceId))
      expect(rows).toHaveLength(0)
    })

    test('the stored session row carries the workspace and the surface the code was bound to', async () => {
      const workspaceId = `ws-${unique()}`
      createdWorkspaces.add(workspaceId)
      const now = Date.now()
      const { api } = issuer({ now: () => now, policy: entitled })
      const hosted = replica({ now: () => now, policy: entitled })

      const granted = (await (
        await api.launch(
          post(
            `${parentOrigin}/api/sim/launch`,
            launchBody(workspaceId, 'room-designer'),
            parentOrigin
          )
        )
      ).json()) as { code: string }
      const exchanged = await hosted.host(
        post(`${simOrigin}/session`, { schemaVersion: 1, code: granted.code, bridgeId }, simOrigin)
      )
      const cookie = cookieValue(exchanged.headers.get('set-cookie')!)
      const value = cookie.slice(cookie.indexOf('=') + 1)
      const stored = await findSimSessionContext(connection.db, value, now)
      expect(stored?.workspaceId).toBe(workspaceId)
      expect(stored?.surface).toBe('room-designer')
    })
  }
)
