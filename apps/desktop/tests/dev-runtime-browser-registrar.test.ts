// Production registrar composition: the shell can instantiate the browser/
// device runtime on a real channel authority with NO test-only dependencies
// — the host device engine (real simctl/adb/emulator tooling), the real
// bounded screenshot store, and stream grants minted by the authority
// against the caller's authenticated channel identity. The attach path is
// exercised end-to-end through a real handshake and a proven command frame.
import { createHmac } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  devCommandProofMessage,
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
} from '../../../packages/types/src/dev-runtime'

import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import { browserLaneProfileDirectory } from '../shell/src/dev-runtime/browser/engine'
import {
  createChromiumLaneCookieStore,
  encryptChromiumValue,
} from '../shell/src/dev-runtime/browser/lane-cookie-store'
import { deriveChromiumKey } from '../shell/src/dev-runtime/browser/cookie-sources'
import { registerBrowserDeviceRuntime } from '../shell/src/dev-runtime/browser/register'

const SECRET = 'registrar-profile-secret'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const

const BROWSER_DEVICE_OPERATIONS = Object.keys(devOperationDefinitions).filter(
  (operation) => operation.startsWith('dev.browser.') || operation.startsWith('dev.device.')
).length

function productionRuntime() {
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1',
    shellOrigin: 'https://127.0.0.1:4789',
  })
  const runtime = registerBrowserDeviceRuntime({ authority })
  return { authority, runtime }
}

function handshakeChannel(authority: ReturnType<typeof createChannelAuthority>) {
  const bootstrap = authority.issueLaunchBootstrap()
  const at = Date.now()
  const handshake = authority.handshake(
    {
      schemaVersion: 1,
      method: 'dev.runtime.handshake.v1',
      requestId: '00000000-0000-4000-8000-000000000004',
      bootstrap,
      supportedProtocolVersions: ['1'],
      nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
      issuedAt: new Date(at - 1000).toISOString(),
      expiresAt: new Date(at + 30_000).toISOString(),
    },
    { trusted: true }
  )
  if (!handshake.ok) throw new Error('handshake refused')
  const secret = Buffer.from(handshake.clientSecret, 'base64url')
  return {
    identity: {
      channelId: handshake.channelId,
      clientCredentialId: handshake.clientCredentialId,
    },
    secret,
  }
}

async function executeCommand(
  authority: ReturnType<typeof createChannelAuthority>,
  channel: ReturnType<typeof handshakeChannel>,
  command: DevCommand
) {
  const proof = createHmac('sha256', channel.secret)
    .update(
      devCommandProofMessage({
        channelId: channel.identity.channelId,
        clientCredentialId: channel.identity.clientCredentialId,
        command,
      }),
      'utf8'
    )
    .digest('base64url')
  return authority.execute(
    {
      channelId: channel.identity.channelId,
      clientCredentialId: channel.identity.clientCredentialId,
      command,
      proof,
    },
    { trusted: true }
  )
}

function browserCommand(
  operation: Extract<DevOperation, `dev.browser.${string}`>,
  body: Record<string, unknown>,
  laneId: string,
  generation: number,
  requestId = '00000000-0000-4000-8000-000000000005',
  nonce = 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM'
): DevCommand {
  const definition = devOperationDefinitions[operation]
  return {
    schemaVersion: 1,
    operation,
    requestId,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scope,
    capabilities: definition.capabilities,
    resource: { kind: 'browser_lane', id: laneId, generation },
    body,
  }
}

describe('production registrar composition', () => {
  test('the shell instantiates the runtime with no test-only dependencies', async () => {
    const { runtime } = productionRuntime()
    // Every contract operation for browser/device dispatches through the M10
    // gate; none is missing and none was double-registered.
    expect(runtime.registeredCommandCount).toBe(BROWSER_DEVICE_OPERATIONS)
    // The full lane registry flows work on the production composition.
    const lane = runtime.lanes.create({ scope, runtimeSessionId: 'session-1', kind: 'task_owned' })
    expect(lane.profileId).toMatch(/^adea-browser-profile-v1-[0-9a-f]{64}$/)
    runtime.lanes.navigate(lane.id)
    expect(runtime.lanes.markReady(lane.id).state).toBe('ready')
    // The real bounded screenshot store retains retrievable bytes.
    const ref = runtime.screenshots.record({
      bytes: new Uint8Array([137, 80, 78, 71]),
      format: 'png',
      width: 2,
      height: 2,
      provenance: {
        ownerId: lane.id,
        laneKind: 'task_owned',
        origin: 'http://127.0.0.1:5173/',
        viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        redacted: false,
      },
    })
    expect(runtime.screenshots.getBytes(ref.id)).toEqual(new Uint8Array([137, 80, 78, 71]))
    // The host device engine is real host tooling; inventory probing runs
    // against installed tools and never throws when they are absent.
    await runtime.refreshDevices()
    expect(typeof runtime.deviceEngine.probe).toBe('function')
    runtime.lanes.close(lane.id, runtime.lanes.get(lane.id).generation)
  })

  test('associates owned ports with the ready task lane for the same session', async () => {
    const authority = createChannelAuthority({
      shellHost: '127.0.0.1',
      shellOrigin: 'https://127.0.0.1:4789',
    })
    const runtime = registerBrowserDeviceRuntime({
      authority,
      scope,
      runLsof: async () => 'p1234\ncvite\nn127.0.0.1:5173 (LISTEN)',
      ownedServices: () => [
        {
          host: '127.0.0.1',
          port: 5173,
          ownerId: 'process-1',
          runtimeSessionId: 'session-1',
        },
      ],
    })
    const lane = runtime.lanes.create({ scope, runtimeSessionId: 'session-1', kind: 'task_owned' })
    runtime.lanes.navigate(lane.id)
    runtime.lanes.markReady(lane.id)

    const port = (await runtime.ports.snapshot()).ports.find((record) => record.port === 5173)
    expect(port?.preview).toEqual({
      browserLaneId: lane.id,
      url: 'http://127.0.0.1:5173/',
    })
  })

  test('attach grants are minted by the authority against the channel identity', async () => {
    const { authority, runtime } = productionRuntime()
    const channel = handshakeChannel(authority)
    const lane = runtime.lanes.create({ scope, runtimeSessionId: 'session-1', kind: 'task_owned' })
    runtime.lanes.navigate(lane.id)
    const ready = runtime.lanes.markReady(lane.id)
    const reply = await executeCommand(
      authority,
      channel,
      browserCommand(
        'dev.browser.attach',
        {
          browserLaneId: ready.id,
          expectedGeneration: ready.generation,
          direction: 'read',
        },
        ready.id,
        ready.generation
      )
    )
    expect(reply.ok).toBe(true)
    const grant = reply.value as {
      protocol: string
      channelId: string
      direction: string
      fromSequence: string
      expiresAt: string
      resource: { kind: string; id: string; generation: number }
    }
    expect(grant.protocol).toBe('browser-frames-v1')
    expect(grant.channelId).toBe(channel.identity.channelId)
    expect(grant.direction).toBe('read')
    expect(grant.resource).toEqual({
      kind: 'browser_lane',
      id: ready.id,
      generation: ready.generation,
    })
    expect(grant.fromSequence).toBe('0')
    expect(grant.expiresAt > new Date().toISOString()).toBe(true)
  })

  test('input grants mint write-direction grants bound to the same generation', async () => {
    const { authority, runtime } = productionRuntime()
    const channel = handshakeChannel(authority)
    const lane = runtime.lanes.create({ scope, runtimeSessionId: 'session-1', kind: 'task_owned' })
    runtime.lanes.navigate(lane.id)
    const ready = runtime.lanes.markReady(lane.id)
    const reply = await executeCommand(
      authority,
      channel,
      browserCommand(
        'dev.browser.input',
        {
          browserLaneId: ready.id,
          expectedGeneration: ready.generation,
          direction: 'write',
        },
        ready.id,
        ready.generation
      )
    )
    expect(reply.ok).toBe(true)
    const grant = reply.value as { protocol: string; direction: string }
    expect(grant.protocol).toBe('browser-frames-v1')
    expect(grant.direction).toBe('write')
  })

  test('device attach grants mint device-frames grants through the same path', async () => {
    const { authority, runtime } = productionRuntime()
    const channel = handshakeChannel(authority)
    const session = runtime.deviceSessions.startResponsive(scope, 'session-1')
    const definition = devOperationDefinitions['dev.device.attach']
    const command: DevCommand = {
      schemaVersion: 1,
      operation: 'dev.device.attach',
      requestId: '00000000-0000-4000-8000-000000000007',
      nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      scope,
      capabilities: definition.capabilities,
      resource: { kind: 'device_session', id: session.id, generation: session.generation },
      body: {
        deviceSessionId: session.id,
        expectedGeneration: session.generation,
        direction: 'read',
      },
    }
    const reply = await executeCommand(authority, channel, command)
    expect(reply.ok).toBe(true)
    const grant = reply.value as { protocol: string; channelId: string }
    expect(grant.protocol).toBe('device-frames-v1')
    expect(grant.channelId).toBe(channel.identity.channelId)
  })

  test('scope crossover and stale generations fail closed through the gate', async () => {
    const { authority, runtime } = productionRuntime()
    const channel = handshakeChannel(authority)
    const lane = runtime.lanes.create({ scope, runtimeSessionId: 'session-1', kind: 'task_owned' })
    const foreignScope = { ...scope, workspaceId: '00000000-0000-4000-8000-000000000099' }
    const definition = devOperationDefinitions['dev.browser.attach']
    const reply = await executeCommand(authority, channel, {
      schemaVersion: 1,
      operation: 'dev.browser.attach',
      requestId: '00000000-0000-4000-8000-000000000006',
      nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      scope: foreignScope,
      capabilities: definition.capabilities,
      resource: { kind: 'browser_lane', id: lane.id, generation: lane.generation },
      body: { browserLaneId: lane.id, expectedGeneration: lane.generation, direction: 'read' },
    })
    expect(reply.ok).toBe(false)
    expect(reply.error?.code).toBe('profile_scope_denied')
  })

  test('an engine-less host refuses an admitted navigation typed-unavailable and keeps the lane recoverable', async () => {
    const authority = createChannelAuthority({
      shellHost: '127.0.0.1',
      shellOrigin: 'https://127.0.0.1:4789',
    })
    // Production composition: the registrar always installs the default
    // engine; only the WebView backend is missing on this scripted host.
    const runtime = registerBrowserDeviceRuntime({
      authority,
      scope,
      webViewBackendProbe: () => false,
      resolveDns: async () => [{ address: '93.184.216.34', family: 4 }],
    })
    const channel = handshakeChannel(authority)
    const lane = runtime.lanes.create({ scope, runtimeSessionId: 'session-1', kind: 'task_owned' })
    // Attach mints its stream grant against the channel identity even while
    // the lane is still provisioning.
    const attach = await executeCommand(
      authority,
      channel,
      browserCommand(
        'dev.browser.attach',
        { browserLaneId: lane.id, expectedGeneration: lane.generation, direction: 'read' },
        lane.id,
        lane.generation,
        '00000000-0000-4000-8000-0000000000a1',
        'ZW5naW5lLWxlc3MtYXR0YWNoLW5vbmNlLXdpdGgtYXQtbGVhc3QtMTI4LWJpdHMtb2YtZW50cm9weQ'
      )
    )
    expect(attach.ok).toBe(true)
    // The provider admitted the URL; the engine's missing WebView backend
    // must refuse typed-unavailable, not surface the bare factory TypeError
    // as crash_loop.
    const navigate = await executeCommand(
      authority,
      channel,
      browserCommand(
        'dev.browser.navigate',
        {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation,
          url: 'https://example.test/',
        },
        lane.id,
        lane.generation,
        '00000000-0000-4000-8000-0000000000a2',
        'ZW5naW5lLWxlc3MtbmF2aWdhdGUtbm9uY2Utd2l0aC1hdC1sZWFzdC0xMjgtYml0cy1vZi1lbnRyb3B5'
      )
    )
    expect(navigate.ok).toBe(false)
    expect(navigate.error?.code).toBe('capability_unavailable')
    // Recoverable: the transient navigating state rolled back instead of the
    // lane being crashed by an environmental absence.
    expect(runtime.lanes.get(lane.id).state).toBe('ready')
    // And the retry stays typed-unavailable (still no backend), never
    // crash_loop, with the lane ready to recover once a backend exists.
    const attached = runtime.lanes.get(lane.id)
    const retry = await executeCommand(
      authority,
      channel,
      browserCommand(
        'dev.browser.navigate',
        {
          browserLaneId: lane.id,
          expectedGeneration: attached.generation,
          url: 'https://example.test/',
        },
        lane.id,
        attached.generation,
        '00000000-0000-4000-8000-0000000000a3',
        'ZW5naW5lLWxlc3MtcmV0cnktbm9uY2Utd2l0aC1hdC1sZWFzdC0xMjgtYml0cy1vZi1lbnRyb3B5'
      )
    )
    expect(retry.ok).toBe(false)
    expect(retry.error?.code).toBe('capability_unavailable')
    expect(runtime.lanes.get(lane.id).state).toBe('ready')
  })

  test('cookie import composes end to end through the production registrar (#610)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-cookie-registrar-'))
    const dataDir = join(root, 'data')
    const home = join(root, 'home')
    try {
      // A real source store on the machine the registrar scans: detection finds
      // the profile, the scripted Keychain decrypts it, and the import lands in
      // the profile the ENGINE derives for the lane — the path comes from one
      // shared formula, so this also guards against writing a store the browser
      // never reads.
      const sourceDir = join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default')
      mkdirSync(sourceDir, { recursive: true })
      const source = join(sourceDir, 'Cookies')
      const database = new Database(source)
      database.exec(`CREATE TABLE cookies (
        host_key TEXT, name TEXT, encrypted_value BLOB, value TEXT, path TEXT,
        expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER,
        top_frame_site_key TEXT, has_cross_site_ancestor INTEGER
      )`)
      database
        .prepare(
          'INSERT INTO cookies VALUES ($host, $name, $value, $plain, $path, $expires, $secure, $httpOnly, $sameSite, $top, $flag)'
        )
        .run({
          $host: '.example.com',
          $name: 'session',
          $value: encryptChromiumValue('imported-value', deriveChromiumKey(SECRET), '.example.com'),
          $plain: '',
          $path: '/',
          $expires: 13_400_000_000_000_000,
          $secure: 1,
          $httpOnly: 0,
          $sameSite: 1,
          $top: '',
          $flag: 0,
        })
      database.close()

      const authority = createChannelAuthority({
        shellHost: '127.0.0.1',
        shellOrigin: 'https://127.0.0.1:4789',
      })
      const runtime = registerBrowserDeviceRuntime({
        authority,
        dataDir,
        cookieSourceHomeDir: () => home,
        keychainSecret: () => SECRET,
        cookieImport: { keychainService: 'Test Safe Storage', laneKinds: ['user_context'] },
      })
      const channel = handshakeChannel(authority)
      const lane = runtime.lanes.create({
        scope,
        runtimeSessionId: 'session-cookie-1',
        kind: 'user_context',
      })

      const planned = await executeCommand(
        authority,
        channel,
        browserCommand(
          'dev.browser.cookieImportPlan',
          {
            browserLaneId: lane.id,
            expectedGeneration: lane.generation,
            sourceProfileId: 'chrome:Default',
            domains: ['example.com'],
          },
          lane.id,
          lane.generation,
          '00000000-0000-4000-8000-0000000000b1',
          'Y29va2llLWltcG9ydC1ub25jZS13aXRoLTEyOC1iaXRzLW9mLWVudHJvcHk'
        )
      )
      // The authority decodes the reply with the operation's own decoder, so a
      // pass here is the wire MutationPlan itself — value-free by contract.
      expect(planned.ok).toBe(true)
      const plan = planned.value as {
        id: string
        digest: string
        factVersions: Record<string, string>
      }
      expect(plan.factVersions).toMatchObject({
        sourceProfileId: 'chrome:Default',
        domains: 'example.com',
        stagedWrites: '1',
      })

      const committed = await executeCommand(
        authority,
        channel,
        browserCommand(
          'dev.browser.cookieImportCommit',
          // The wire body is exactly the plan and its digest: the lane travels
          // in the resource binding, so the frame carries no generation.
          { planId: plan.id, planDigest: plan.digest },
          lane.id,
          lane.generation,
          '00000000-0000-4000-8000-0000000000b2',
          'Y29va2llLWNvbW1pdC1ub25jZS13aXRoLTEyOC1iaXRzLW9mLWVudHJvcHk'
        )
      )
      expect(committed.ok, JSON.stringify(committed.error)).toBe(true)
      expect(committed.value).toMatchObject({
        browserLaneId: lane.id,
        imported: 1,
        rolledBack: false,
      })

      const listed = await createChromiumLaneCookieStore({
        profileDirectory: browserLaneProfileDirectory(lane, dataDir),
        keychainService: 'Test Safe Storage',
        keychainSecret: () => SECRET,
      }).list()
      expect(listed.map((cookie) => [cookie.name, cookie.value])).toEqual([
        ['session', 'imported-value'],
      ])

      // A lane kind the host did not name has no Chromium store, so the seam
      // answers typed-unavailable instead of writing a profile nothing reads.
      const taskLane = runtime.lanes.create({
        scope,
        runtimeSessionId: 'session-cookie-2',
        kind: 'task_owned',
      })
      const refused = await executeCommand(
        authority,
        channel,
        browserCommand(
          'dev.browser.cookieImportPlan',
          {
            browserLaneId: taskLane.id,
            expectedGeneration: taskLane.generation,
            sourceProfileId: 'chrome:Default',
            domains: ['example.com'],
          },
          taskLane.id,
          taskLane.generation,
          '00000000-0000-4000-8000-0000000000b3',
          'dGFzay1sYW5lLWNvb2tpZS1ub25jZS13aXRoLTEyOC1iaXRzLW9mLWVudHJvcHk'
        )
      )
      expect(refused.ok).toBe(false)
      expect(refused.error?.code).toBe('capability_unavailable')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
