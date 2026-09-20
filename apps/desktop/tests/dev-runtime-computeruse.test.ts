// #472 computer-use lanes. Lane lifecycle, consent gate, capability honesty,
// fixed-argv engine classification, and provider admission are pinned here
// with scripted runners only — CI never performs real capture or input
// (machine discipline; the packaged macOS smoke owns the real-TCC path).
// Donor outcome matrices: Orca PermissionStatusSnapshot /
// ScreenCapturePermissionPreflightSafety / ComputerSnapshotCachePolicy (MIT,
// revision 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7).
import { describe, expect, test } from 'bun:test'

import {
  decodeCbor,
  encodeCbor,
  type DevCommand,
  type DevStreamGrant,
  type MacPermissionsSnapshot,
} from '../../../packages/types/src/dev-runtime'
import {
  createComputerUseCapabilityService,
  CAPTURE_MISSING_PIECE,
  AX_TREE_MISSING_PIECE,
} from '../shell/src/dev-runtime/computeruse/capability'
import {
  ComputerUseGateError,
  createConsentGate,
} from '../shell/src/dev-runtime/computeruse/consent-gate'
import {
  ComputerUseEngineError,
  createHostComputerUseEngine,
  decodeComputerUseInputEvent,
  escapeAppleScriptString,
  keyCodeArgv,
  keystrokeTextArgv,
} from '../shell/src/dev-runtime/computeruse/engine'
import {
  ComputerUseLaneError,
  createComputerUseLaneRegistry,
} from '../shell/src/dev-runtime/computeruse/lane-registry'
import {
  computerUseProviderError,
  createComputerUseProviders,
} from '../shell/src/dev-runtime/computeruse/providers'
import {
  registerComputerUseRuntime,
  type ComputerUseRuntimeInput,
} from '../shell/src/dev-runtime/computeruse/register'
import type { ChannelAuthority, ChannelIdentity } from '../shell/src/dev-runtime/channel/authority'
import type { MacPermissionService } from '../shell/src/desktop-permissions'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const sessionId = '00000000-0000-4000-8000-0000000000b1'
const identity = {
  channelId: 'channel-1',
  clientCredentialId: 'credential-1',
} as const satisfies ChannelIdentity

function snapshotWith(
  accessibility: 'granted' | 'denied' | 'not_determined' | 'unavailable',
  hostPlatform: 'macos' | 'other' | 'unknown' = 'macos'
): MacPermissionsSnapshot {
  return {
    hostPlatform,
    permissions: [
      { id: 'accessibility', state: accessibility, probedAt: '2026-09-19T00:00:00.000Z' },
      {
        id: 'screen_recording',
        state: 'unavailable',
        unavailableReason: 'capability_unavailable',
        probedAt: '2026-09-19T00:00:00.000Z',
      },
      {
        id: 'notifications',
        state: 'unavailable',
        unavailableReason: 'capability_unavailable',
        probedAt: '2026-09-19T00:00:00.000Z',
      },
      {
        id: 'automation_apple_events',
        state: 'unavailable',
        unavailableReason: 'capability_unavailable',
        probedAt: '2026-09-19T00:00:00.000Z',
      },
      {
        id: 'microphone',
        state: 'unavailable',
        unavailableReason: 'capability_unavailable',
        probedAt: '2026-09-19T00:00:00.000Z',
      },
    ],
    probedAt: '2026-09-19T00:00:00.000Z',
  }
}

/** Scripted #471 permission service: always reports the given snapshot. */
function scriptedPermissions(
  initial: MacPermissionsSnapshot,
  options: { onSnapshot?: (calls: number) => void } = {}
): MacPermissionService & { set(next: MacPermissionsSnapshot): void } {
  let current = initial
  let calls = 0
  return {
    async snapshot(options) {
      calls += 1
      options?.onSnapshot?.(calls)
      return current
    },
    set(next) {
      current = next
    },
    onSnapshot: undefined,
    ...options,
    async openSettings(permissionId) {
      return { permissionId, settingsUrl: `x-apple.systempreferences:${permissionId}` }
    },
    settingsUrl(permissionId) {
      return `x-apple.systempreferences:${permissionId}`
    },
  } as MacPermissionService & { set(next: MacPermissionsSnapshot): void }
}

function commandFor(
  operation: string,
  body: Record<string, unknown>,
  resource?: { kind: string; id: string; generation: number },
  commandScope: typeof scope = scope
): DevCommand {
  return {
    schemaVersion: 1,
    operation: operation as DevCommand['operation'],
    requestId: '00000000-0000-4000-8000-0000000000c1',
    nonce: 'nonce_nonce_nonce_nonce_nonce',
    issuedAt: '2026-09-19T00:00:00.000Z',
    expiresAt: '2026-09-19T00:01:00.000Z',
    scope: commandScope,
    capabilities: [],
    ...(resource ? { resource } : {}),
    body,
  }
}

/** Scripted engine capturing injected events; optionally throws. */
function scriptedEngine(fail?: (event: unknown) => Error) {
  const injected: unknown[] = []
  const engine = {
    injectInput: async (event: unknown) => {
      injected.push(event)
      const failure = fail?.(event)
      if (failure) throw failure
    },
    capture: async () => {
      throw new ComputerUseEngineError('capability_unavailable', CAPTURE_MISSING_PIECE)
    },
    readAccessibilityTree: async () => {
      throw new ComputerUseEngineError('capability_unavailable', AX_TREE_MISSING_PIECE)
    },
  }
  return { engine: { ...engine, injected }, injected }
}

function harness(overrides: Partial<ComputerUseRuntimeInput> = {}) {
  const permissions = overrides.macPermissions ?? scriptedPermissions(snapshotWith('granted'))
  const registered = new Map<string, unknown>()
  const streams = new Set<string>()
  let streamHandler: ((session: never) => void) | undefined
  const authority = {
    registerCommandProvider: (operation: string, provider: unknown) => {
      registered.set(operation, provider)
    },
    registerStreamProvider: (protocol: string) => {
      streams.add(protocol)
    },
    mintStreamGrant: (req: {
      scope: typeof scope
      resource: { kind: string; id: string; generation: number }
      direction: 'read' | 'write'
      fromSequence?: string
    }): DevStreamGrant => ({
      schemaVersion: 1,
      grantId: 'grant-1',
      protocol: 'desktop-frames-v1',
      channelId: identity.channelId,
      scope: req.scope,
      resource: req.resource,
      direction: req.direction,
      fromSequence: req.fromSequence ?? '0',
      expiresAt: '2026-09-19T00:01:00.000Z',
      maxFrameBytes: 262_144,
    }),
  } as unknown as ChannelAuthority
  const gateway = {
    registerStreamHandler: (_protocol: string, handler: (session: never) => void) => {
      streamHandler = handler
    },
  }
  const runtime = registerComputerUseRuntime({
    authority,
    ...(Object.keys(overrides).length > 0 ? (overrides as ComputerUseRuntimeInput) : {}),
    macPermissions: permissions,
    gateway: gateway as never,
  })
  return {
    runtime,
    lanes: runtime.lanes,
    permissions,
    registered,
    streams,
    get streamHandler() {
      return streamHandler
    },
  }
}

describe('computer-use lane registry', () => {
  test('lanes are session-scoped and start idle at generation 1', () => {
    const lanes = createComputerUseLaneRegistry()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    expect(lane.state).toBe('idle')
    expect(lane.automationOwner).toBe('agent')
    expect(lane.generation).toBe(1)
    expect(lanes.list({ scope }).items).toHaveLength(1)
  })

  test('activation binds the consent and increments the generation', () => {
    const lanes = createComputerUseLaneRegistry()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    const activated = lanes.activate(lane.id, {
      consentId: '00000000-0000-4000-8000-0000000000d1',
      computerUseLaneId: lane.id,
      runtimeSessionId: sessionId,
      scope,
      generation: 2,
      permissionDigest: 'a'.repeat(64),
      createdAt: '2026-09-19T00:00:00.000Z',
      expiresAt: '2026-09-19T00:01:00.000Z',
    })
    expect(activated.state).toBe('granted')
    expect(activated.generation).toBe(2)
    expect(activated.consent?.consentId).toBe('00000000-0000-4000-8000-0000000000d1')
  })

  test('activation refuses a consent bound to another lane or generation', () => {
    const lanes = createComputerUseLaneRegistry()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    const mismatch = {
      consentId: '00000000-0000-4000-8000-0000000000d2',
      computerUseLaneId: 'other-lane',
      runtimeSessionId: sessionId,
      scope,
      generation: 2,
      permissionDigest: 'a'.repeat(64),
      createdAt: '2026-09-19T00:00:00.000Z',
      expiresAt: '2026-09-19T00:01:00.000Z',
    } as const
    expect(() => lanes.activate(lane.id, mismatch)).toThrow(ComputerUseLaneError)
  })

  test('takeover suspends agent input instantly and fences old generations', () => {
    const lanes = createComputerUseLaneRegistry()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    const taken = lanes.takeover(lane.id, 1)
    expect(taken.state).toBe('suspended')
    expect(taken.automationOwner).toBe('human_takeover')
    expect(taken.generation).toBe(2)
    expect(() =>
      lanes.admit(taken, { principal: 'agent', action: 'input', generation: 1 })
    ).toThrow(/generation moved/)
    expect(() =>
      lanes.admit(taken, { principal: 'agent', action: 'input', generation: 2 })
    ).toThrow(/suspended during human takeover/)
    // Stale generations never mutate state.
    expect(lanes.get(lane.id).generation).toBe(2)
  })

  test('release returns authority but requires fresh consent', () => {
    const lanes = createComputerUseLaneRegistry()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    lanes.takeover(lane.id, 1)
    const released = lanes.release(lane.id, 2)
    expect(released.automationOwner).toBe('agent')
    expect(released.state).toBe('idle')
    expect(released.consent).toBeUndefined()
    expect(() =>
      lanes.admit(released, { principal: 'agent', action: 'input', generation: 3 })
    ).toThrow(/live consent record/)
  })

  test('close is the kill switch: consent drops and nothing is admitted', () => {
    const lanes = createComputerUseLaneRegistry()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    const closed = lanes.close(lane.id, 1)
    expect(closed.state).toBe('closed')
    expect(closed.automationOwner).toBe('none')
    expect(closed.consent).toBeUndefined()
    expect(() =>
      lanes.admit(closed, { principal: 'agent', action: 'input', generation: 2 })
    ).toThrow(/lane is closed/)
    // Idempotent on closed lanes.
    expect(lanes.close(lane.id, 2).state).toBe('closed')
  })

  test('expired consent records stop admitting input', () => {
    let at = 0
    const lanes = createComputerUseLaneRegistry({ now: () => new Date(at).toISOString() })
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    at = 1_000
    lanes.activate(lane.id, {
      consentId: '00000000-0000-4000-8000-0000000000d3',
      computerUseLaneId: lane.id,
      runtimeSessionId: sessionId,
      scope,
      generation: 2,
      permissionDigest: 'a'.repeat(64),
      createdAt: '2026-09-19T00:00:00.000Z',
      expiresAt: new Date(60_000).toISOString(),
    })
    expect(() =>
      lanes.admit(lanes.get(lane.id), { principal: 'agent', action: 'input', generation: 2 })
    ).not.toThrow()
    at = 61_000
    expect(() =>
      lanes.admit(lanes.get(lane.id), { principal: 'agent', action: 'input', generation: 2 })
    ).toThrow(/live consent record/)
  })

  test('closeForSession kills every lane of the session (grants die with the run)', () => {
    const lanes = createComputerUseLaneRegistry()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    lanes.closeForSession(sessionId)
    expect(lanes.get(lane.id).state).toBe('closed')
    expect(lanes.get(lane.id).automationOwner).toBe('none')
  })
})

describe('computer-use capability report', () => {
  test('granted accessibility means input is available; capture and AX-tree are honestly unavailable', async () => {
    const capabilities = createComputerUseCapabilityService({
      permissions: scriptedPermissions(snapshotWith('granted')),
    })
    const report = await capabilities.report()
    expect(report.hostPlatform).toBe('macos')
    const byId = new Map(report.capabilities.map((row) => [row.id, row]))
    expect(byId.get('input')?.state).toBe('available')
    expect(byId.get('capture')?.state).toBe('unavailable')
    expect(byId.get('capture')?.missingPiece).toBe(CAPTURE_MISSING_PIECE)
    expect(byId.get('ax_tree')?.missingPiece).toBe(AX_TREE_MISSING_PIECE)
  }, 2000)

  test('denied, pending, and unprobeable accessibility mirror the probe', async () => {
    for (const [state, expected] of [
      ['denied', 'denied'],
      ['not_determined', 'not_determined'],
      ['unavailable', 'unavailable'],
    ] as const) {
      const capabilities = createComputerUseCapabilityService({
        permissions: scriptedPermissions(snapshotWith(state)),
      })
      const report = await capabilities.report()
      expect(report.capabilities.find((row) => row.id === 'input')?.state).toBe(expected)
    }
  }, 2000)

  test('a non-macOS host reports unsupported_platform, never a fake row', async () => {
    const capabilities = createComputerUseCapabilityService({
      permissions: scriptedPermissions(snapshotWith('unavailable', 'other')),
      platform: 'linux',
    })
    const report = await capabilities.report()
    expect(report.hostPlatform).toBe('other')
    for (const row of report.capabilities) {
      expect(row.state).toBe('unavailable')
      expect(row.unavailableReason).toBe('unsupported_platform')
    }
  }, 2000)

  test('the permission digest separates states and is stable', () => {
    const capabilities = createComputerUseCapabilityService({
      permissions: scriptedPermissions(snapshotWith('granted')),
    })
    const granted = capabilities.permissionDigest(snapshotWith('granted'))
    const denied = capabilities.permissionDigest(snapshotWith('denied'))
    expect(granted).not.toBe(denied)
    expect(granted).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('computer-use consent gate', () => {
  function gateFor(permissions: MacPermissionService, clock: { now: number } = { now: 0 }) {
    const capabilities = createComputerUseCapabilityService({ permissions })
    return createConsentGate({
      permissions,
      capabilities,
      now: () => clock.now,
      nowIso: () => new Date(clock.now).toISOString(),
    })
  }

  test('issuance requires an owner confirmation', async () => {
    const gate = gateFor(scriptedPermissions(snapshotWith('granted')))
    await expect(
      gate.issue({
        scope,
        lane: { id: 'lane', runtimeSessionId: sessionId, generation: 1 },
        confirmationId: '',
      })
    ).rejects.toThrow(/owner confirmation/)
  }, 2000)

  test('denied accessibility refuses with the Settings remediation', async () => {
    const gate = gateFor(scriptedPermissions(snapshotWith('denied')))
    const error = await gate
      .issue({
        scope,
        lane: { id: 'lane', runtimeSessionId: sessionId, generation: 1 },
        confirmationId: 'confirm',
      })
      .catch((error: unknown) => error as ComputerUseGateError)
    expect(error).toBeInstanceOf(ComputerUseGateError)
    expect(error.code).toBe('permission_denied')
    expect(error.remediation).toEqual({
      action: 'open_settings',
      parameters: { permissionId: 'accessibility' },
    })
  }, 2000)

  test('pending consent prompt refuses with the request remediation', async () => {
    const gate = gateFor(scriptedPermissions(snapshotWith('not_determined')))
    const error = await gate
      .issue({
        scope,
        lane: { id: 'lane', runtimeSessionId: sessionId, generation: 1 },
        confirmationId: 'confirm',
      })
      .catch((error: unknown) => error as ComputerUseGateError)
    expect(error.remediation?.action).toBe('request_permission')
  }, 2000)

  test('unprobeable permission state refuses with the exact missing piece', async () => {
    const gate = gateFor(scriptedPermissions(snapshotWith('unavailable')))
    const error = await gate
      .issue({
        scope,
        lane: { id: 'lane', runtimeSessionId: sessionId, generation: 1 },
        confirmationId: 'confirm',
      })
      .catch((error: unknown) => error as ComputerUseGateError)
    expect(error.code).toBe('capability_unavailable')
  }, 2000)

  test('granted state issues a single-use, expiring, scope/generation-bound record', async () => {
    const clock = { now: 1_000_000 }
    const gate = gateFor(scriptedPermissions(snapshotWith('granted')), clock)
    const consent = await gate.issue({
      scope,
      lane: { id: 'lane-1', runtimeSessionId: sessionId, generation: 4 },
      confirmationId: 'confirm',
    })
    expect(consent.generation).toBe(5)
    expect(consent.expiresAt > consent.createdAt).toBe(true)
    // Single use.
    gate.consume({ consentId: consent.consentId, scope, laneId: 'lane-1', generation: 5 })
    expect(() =>
      gate.consume({ consentId: consent.consentId, scope, laneId: 'lane-1', generation: 5 })
    ).toThrow(/single-use/)
    // Scope-bound.
    const foreign = await gate.issue({
      scope,
      lane: { id: 'lane-2', runtimeSessionId: sessionId, generation: 1 },
      confirmationId: 'confirm',
    })
    expect(() =>
      gate.consume({
        consentId: foreign.consentId,
        scope: { ...scope, workspaceId: '00000000-0000-4000-8000-000000000009' },
        laneId: 'lane-2',
        generation: 2,
      })
    ).toThrow(/another scope/)
    // Generation-bound.
    expect(() =>
      gate.consume({ consentId: foreign.consentId, scope, laneId: 'lane-2', generation: 99 })
    ).toThrow(/generation/)
    // Expiry.
    clock.now += 120_000
    expect(() =>
      gate.consume({ consentId: foreign.consentId, scope, laneId: 'lane-2', generation: 2 })
    ).toThrow(/expired/)
  }, 2000)

  test('verifyFresh refuses when the permission state moved off the recorded digest', async () => {
    const clock = { now: 0 }
    const permissions = scriptedPermissions(snapshotWith('granted'))
    const gate = gateFor(permissions, clock)
    const consent = await gate.issue({
      scope,
      lane: { id: 'lane', runtimeSessionId: sessionId, generation: 1 },
      confirmationId: 'confirm',
    })
    gate.consume({ consentId: consent.consentId, scope, laneId: 'lane', generation: 2 })
    clock.now += 100_000 // freshness window elapsed
    await gate.verifyFresh(consent.consentId)
    permissions.set(snapshotWith('denied'))
    clock.now += 100_000
    await expect(gate.verifyFresh(consent.consentId)).rejects.toThrow(/accessibility grant/)
  }, 2000)

  test('revokeForLane drops records immediately (kill switch support)', async () => {
    const gate = gateFor(scriptedPermissions(snapshotWith('granted')))
    const consent = await gate.issue({
      scope,
      lane: { id: 'lane', runtimeSessionId: sessionId, generation: 1 },
      confirmationId: 'confirm',
    })
    gate.revokeForLane('lane')
    expect(() =>
      gate.consume({ consentId: consent.consentId, scope, laneId: 'lane', generation: 2 })
    ).toThrow(/unknown or already dropped/)
    expect(gate.rejections().length).toBeGreaterThan(0)
  }, 2000)
})

describe('computer-use engine (fixed argv, scripted runner)', () => {
  function runner(outcomes: Record<string, unknown> = {}) {
    const calls: string[][] = []
    return {
      calls,
      runner: async (argv: readonly string[]) => {
        calls.push([...argv])
        return {
          exitCode: outcomes.exitCode === undefined ? 0 : (outcomes.exitCode as number | null),
          stdout: (outcomes.stdout as string) ?? '',
          stderr: (outcomes.stderr as string) ?? '',
          timedOut: (outcomes.timedOut as boolean) ?? false,
          spawnFailed: (outcomes.spawnFailed as boolean) ?? false,
        }
      },
    }
  }

  test('text is escaped into an inert AppleScript literal (no argv injection)', () => {
    expect(escapeAppleScriptString('before" & do shell script "pwned')).toBe(
      'before\\" & do shell script \\"pwned'
    )
    const argv = keystrokeTextArgv('before" & do shell script "pwned')
    expect(argv[0]).toBe('/usr/bin/osascript')
    expect(argv[1]).toBe('-e')
    expect(argv[2]).toBe(
      'tell application "System Events" to keystroke "before\\" & do shell script \\"pwned"'
    )
    expect(argv).toHaveLength(3)
  })

  test('key codes and modifiers use fixed tokens only', () => {
    const argv = keyCodeArgv(5, ['shift', 'command'])
    expect(argv[2]).toBe(
      'tell application "System Events" to key code 5 using {command down, shift down}'
    )
  })

  test('input event decoding rejects injection attempts and out-of-range codes', () => {
    expect(decodeComputerUseInputEvent({ kind: 'text', text: 'hello' })).toEqual({
      kind: 'text',
      text: 'hello',
    })
    expect(() => decodeComputerUseInputEvent({ kind: 'text', text: 'a\u0001b' })).toThrow(
      /control characters/
    )
    expect(() => decodeComputerUseInputEvent({ kind: 'text', text: 'x'.repeat(4097) })).toThrow(
      /4096/
    )
    expect(() => decodeComputerUseInputEvent({ kind: 'key', code: 999 })).toThrow(/0\.\.127/)
    expect(() => decodeComputerUseInputEvent({ kind: 'key', code: 5, modifiers: ['cpu'] })).toThrow(
      /unknown key modifier/
    )
    expect(() => decodeComputerUseInputEvent({ kind: 'click', x: 1 })).toThrow(/unsupported/)
    expect(() => decodeComputerUseInputEvent({ kind: 'text', text: 'ok', extra: true })).toThrow(
      /unknown input field/
    )
  })

  test('injectInput classifies host outcomes honestly', async () => {
    const ok = runner()
    await createHostComputerUseEngine(ok.runner).injectInput({ kind: 'text', text: 'ok' })
    expect(ok.calls[0]?.[0]).toBe('/usr/bin/osascript')

    const denied = runner({
      exitCode: 1,
      stderr: 'execution error: Not authorized to send Apple events',
    })
    await expect(
      createHostComputerUseEngine(denied.runner).injectInput({ kind: 'key', code: 5 })
    ).rejects.toThrow(ComputerUseEngineError)

    const assistive = runner({
      exitCode: 1,
      stderr: 'osascript is not allowed assistive access. (-1719)',
    })
    let code: string | undefined
    try {
      await createHostComputerUseEngine(assistive.runner).injectInput({ kind: 'text', text: 'x' })
    } catch (error) {
      code = (error as ComputerUseEngineError).code
    }
    expect(code).toBe('permission_denied')

    const missing = runner({ exitCode: null, spawnFailed: true })
    const unavailable = createHostComputerUseEngine(missing.runner)
    await expect(unavailable.injectInput({ kind: 'key', code: 5 })).rejects.toThrow(
      /input tool is unavailable/
    )

    const stuck = runner({ exitCode: null, timedOut: true })
    await expect(
      createHostComputerUseEngine(stuck.runner).injectInput({ kind: 'key', code: 5 })
    ).rejects.toThrow(/did not answer/)
  })

  test('capture and AX-tree reading are typed-unavailable, never stubbed', async () => {
    const engine = createHostComputerUseEngine(runner().runner)
    await expect(engine.capture()).rejects.toThrow(CAPTURE_MISSING_PIECE)
    await expect(engine.readAccessibilityTree()).rejects.toThrow(AX_TREE_MISSING_PIECE)
  })
})

describe('dev.computeruse.* providers', () => {
  function providerHarness(options: { granted?: 'granted' | 'denied' } = {}) {
    const engine = scriptedEngine()
    const h = harness({
      macPermissions: scriptedPermissions(snapshotWith(options.granted ?? 'granted')),
      engine: engine.engine as never,
    })
    const providers = createComputerUseProviders({
      lanes: h.lanes,
      gate: h.runtime.gate,
      capabilities: () => h.runtime.capabilities.report(),
      engine: () => engine.engine as never,
      mintStreamGrant: (req) =>
        ({
          schemaVersion: 1,
          grantId: 'grant-1',
          protocol: 'desktop-frames-v1',
          channelId: identity.channelId,
          scope: req.scope,
          resource: req.resource,
          direction: req.direction,
          fromSequence: req.fromSequence ?? '0',
          expiresAt: '2026-09-19T00:01:00.000Z',
          maxFrameBytes: 262_144,
        }) satisfies DevStreamGrant,
      inputBudget: { maxInputPerSecond: 3 },
    })
    return { ...h, providers, engine }
  }

  test('commands outside the lane scope are refused (confused-deputy check)', async () => {
    const { lanes, providers } = providerHarness()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    const foreignScope = { ...scope, runtimeNodeId: '00000000-0000-4000-8000-0000000000ff' }
    await expect(
      providers.providers['dev.computeruse.laneClose']?.(
        commandFor(
          'dev.computeruse.laneClose',
          { computerUseLaneId: lane.id, expectedGeneration: 1 },
          { kind: 'computeruse_lane', id: lane.id, generation: 1 },
          foreignScope
        ),
        identity
      ) as Promise<unknown>
    ).rejects.toThrow(/another account/)
    expect(lanes.get(lane.id).state).toBe('idle')
  })

  test('stale generations are refused before any authority decision', async () => {
    const { lanes, providers } = providerHarness()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    await expect(
      providers.providers['dev.computeruse.takeover']?.(
        commandFor(
          'dev.computeruse.takeover',
          { computerUseLaneId: lane.id, expectedGeneration: 99 },
          { kind: 'computeruse_lane', id: lane.id, generation: 99 }
        )
      ) as Promise<unknown>
    ).rejects.toThrow(/generation/)
  })

  test('the consent flow issues, binds, and mints a fenced input grant', async () => {
    const { lanes, runtime, providers, engine } = providerHarness()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    const consent = (await providers.providers['dev.computeruse.consent']?.(
      commandFor(
        'dev.computeruse.consent',
        { computerUseLaneId: lane.id, expectedGeneration: 1, confirmationId: 'owner-says-ok' },
        { kind: 'computeruse_lane', id: lane.id, generation: 1 }
      )
    )) as { consentId: string }
    const activated = lanes.get(lane.id)
    expect(activated.state).toBe('granted')
    expect(activated.generation).toBe(2)

    const grant = (await providers.providers['dev.computeruse.input']?.(
      commandFor(
        'dev.computeruse.input',
        {
          computerUseLaneId: lane.id,
          expectedGeneration: 2,
          consentId: consent.consentId,
          direction: 'write',
        },
        { kind: 'computeruse_lane', id: lane.id, generation: 2 }
      ),
      identity
    )) as DevStreamGrant
    expect(grant.direction).toBe('write')
    expect(grant.resource).toEqual({ kind: 'computeruse_lane', id: lane.id, generation: 2 })

    // The consumed record cannot mint twice.
    await expect(
      providers.providers['dev.computeruse.input']?.(
        commandFor(
          'dev.computeruse.input',
          {
            computerUseLaneId: lane.id,
            expectedGeneration: 2,
            consentId: consent.consentId,
            direction: 'write',
          },
          { kind: 'computeruse_lane', id: lane.id, generation: 2 }
        )
      ) as Promise<unknown>
    ).rejects.toThrow(/single-use/)

    // An admitted input frame reaches the engine.
    const event = { kind: 'text', text: 'hello' }
    const result = await providers.admitInputFrame({
      laneId: lane.id,
      generation: 2,
      sequence: '1',
      bytes: encodeCbor(event),
    })
    expect(result.accepted).toBe(true)
    expect(engine.injected).toEqual([event])
    // The deliberately-provoked single-use refusal is counted for security
    // telemetry.
    expect(runtime.gate.rejections().map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['permission_denied'])
    )
  })

  test('consent is refused when accessibility is denied, with remediation', async () => {
    const { lanes, providers } = providerHarness({ granted: 'denied' })
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    const error = await providers.providers['dev.computeruse.consent']?.(
      commandFor(
        'dev.computeruse.consent',
        { computerUseLaneId: lane.id, expectedGeneration: 1, confirmationId: 'owner-says-ok' },
        { kind: 'computeruse_lane', id: lane.id, generation: 1 }
      )
    ).catch((error: unknown) => error)
    expect((error as ComputerUseGateError).code).toBe('permission_denied')
    expect(lanes.get(lane.id).state).toBe('idle')
  })

  test('input frames past the rate cap are refused without reaching the engine', async () => {
    const { lanes, runtime, providers, engine } = providerHarness()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    const consent = (await providers.providers['dev.computeruse.consent']?.(
      commandFor(
        'dev.computeruse.consent',
        { computerUseLaneId: lane.id, expectedGeneration: 1, confirmationId: 'owner-says-ok' },
        { kind: 'computeruse_lane', id: lane.id, generation: 1 }
      )
    )) as { consentId: string }
    await providers.providers['dev.computeruse.input']?.(
      commandFor(
        'dev.computeruse.input',
        {
          computerUseLaneId: lane.id,
          expectedGeneration: 2,
          consentId: consent.consentId,
          direction: 'write',
        },
        { kind: 'computeruse_lane', id: lane.id, generation: 2 }
      ),
      identity
    )
    const before = engine.injected.length
    for (let index = 0; index < 3; index += 1) {
      await providers.admitInputFrame({
        laneId: lane.id,
        generation: 2,
        sequence: String(index + 1),
        bytes: encodeCbor({ kind: 'key', code: index + 1 }),
      })
    }
    expect(engine.injected.length).toBe(before + 3)
    await expect(
      providers.admitInputFrame({
        laneId: lane.id,
        generation: 2,
        sequence: '9',
        bytes: encodeCbor({ kind: 'key', code: 50 }),
      })
    ).rejects.toThrow(/rate cap/)
    expect(engine.injected.length).toBe(before + 3)
    expect(runtime.gate.rejections().some((entry) => entry.code === 'rate_limited')).toBe(false)
  })

  test('stale-generation input is inert at the ledger', async () => {
    const { lanes, providers, engine } = providerHarness()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    lanes.takeover(lane.id, 1) // generation → 2
    await expect(
      providers.admitInputFrame({
        laneId: lane.id,
        generation: 1,
        sequence: '1',
        bytes: encodeCbor({ kind: 'text', text: 'stale' }),
      })
    ).rejects.toThrow(ComputerUseLaneError)
    expect(engine.injected).toHaveLength(0)
  })

  test('a TCC refusal during injection kills the lane immediately', async () => {
    const failing = scriptedEngine(
      () =>
        new ComputerUseEngineError(
          'permission_denied',
          'the accessibility grant refused the input tool'
        )
    )
    const h = harness({
      macPermissions: scriptedPermissions(snapshotWith('granted')),
      engine: failing.engine as never,
    })
    const providers = createComputerUseProviders({
      lanes: h.lanes,
      gate: h.runtime.gate,
      capabilities: () => h.runtime.capabilities.report(),
      engine: () => failing.engine as never,
      mintStreamGrant: (req) =>
        ({
          schemaVersion: 1,
          grantId: 'grant-1',
          protocol: 'desktop-frames-v1',
          channelId: identity.channelId,
          scope: req.scope,
          resource: req.resource,
          direction: req.direction,
          fromSequence: req.fromSequence ?? '0',
          expiresAt: '2026-09-19T00:01:00.000Z',
          maxFrameBytes: 262_144,
        }) satisfies DevStreamGrant,
    })
    const lane = h.lanes.create({ scope, runtimeSessionId: sessionId })
    const consent = (await providers.providers['dev.computeruse.consent']?.(
      commandFor(
        'dev.computeruse.consent',
        { computerUseLaneId: lane.id, expectedGeneration: 1, confirmationId: 'owner-says-ok' },
        { kind: 'computeruse_lane', id: lane.id, generation: 1 }
      )
    )) as { consentId: string }
    await providers.providers['dev.computeruse.input']?.(
      commandFor(
        'dev.computeruse.input',
        {
          computerUseLaneId: lane.id,
          expectedGeneration: 2,
          consentId: consent.consentId,
          direction: 'write',
        },
        { kind: 'computeruse_lane', id: lane.id, generation: 2 }
      ),
      identity
    )
    await expect(
      providers.admitInputFrame({
        laneId: lane.id,
        generation: 2,
        sequence: '1',
        bytes: encodeCbor({ kind: 'text', text: 'boom' }),
      })
    ).rejects.toThrow(/refused the input tool/)
    expect(h.lanes.get(lane.id).state).toBe('crashed')
    expect(h.lanes.get(lane.id).automationOwner).toBe('none')
  })

  test('takeover and laneClose revoke consent so late grants cannot mint', async () => {
    const { lanes, providers } = providerHarness()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    const consent = (await providers.providers['dev.computeruse.consent']?.(
      commandFor(
        'dev.computeruse.consent',
        { computerUseLaneId: lane.id, expectedGeneration: 1, confirmationId: 'owner-says-ok' },
        { kind: 'computeruse_lane', id: lane.id, generation: 1 }
      )
    )) as { consentId: string }
    await providers.providers['dev.computeruse.takeover']?.(
      commandFor(
        'dev.computeruse.takeover',
        { computerUseLaneId: lane.id, expectedGeneration: 2 },
        { kind: 'computeruse_lane', id: lane.id, generation: 2 }
      )
    )
    // The takeover dropped the unconsumed record; the old-consent input grant
    // is refused against the new generation too.
    await expect(
      providers.providers['dev.computeruse.input']?.(
        commandFor(
          'dev.computeruse.input',
          {
            computerUseLaneId: lane.id,
            expectedGeneration: 2,
            consentId: consent.consentId,
            direction: 'write',
          },
          { kind: 'computeruse_lane', id: lane.id, generation: 2 }
        )
      ) as Promise<unknown>
    ).rejects.toThrow()
  })

  test('provider errors map to typed DevError codes', () => {
    const mapped = computerUseProviderError(new ComputerUseLaneError('stale_generation', 'moved'))
    expect(mapped.code).toBe('stale_generation')
    const unknown = computerUseProviderError(new Error('mystery'))
    expect(unknown.code).toBe('invalid_state')
  })
})

describe('computer-use registration', () => {
  test('registers every dev.computeruse operation and the desktop-frames stream', () => {
    const h = harness()
    const operations = [...h.registered.keys()].toSorted()
    expect(operations).toEqual([
      'dev.computeruse.attach',
      'dev.computeruse.capabilities',
      'dev.computeruse.consent',
      'dev.computeruse.input',
      'dev.computeruse.laneClose',
      'dev.computeruse.laneCreate',
      'dev.computeruse.lanes',
      'dev.computeruse.release',
      'dev.computeruse.takeover',
    ])
    expect([...h.streams]).toEqual(['desktop-frames-v1'])
    expect(h.runtime.registeredCommandCount).toBe(9)
  })

  test('read-direction frame streams close typed-incompatible (capture helper deferred)', () => {
    const h = harness()
    expect(h.streamHandler).toBeTypeOf('function')
    const closed: { code: string; reason?: string }[] = []
    const session = {
      grant: {
        direction: 'read',
        resource: { kind: 'computeruse_lane', id: 'lane', generation: 1 },
      },
      close: (code: string, reason?: string) => closed.push({ code, reason }),
    }
    ;(h.streamHandler as (session: unknown) => void)(session)
    expect(closed[0]?.code).toBe('incompatible')
    expect(closed[0]?.reason).toContain('deferred')
  })

  test('write-direction frames route through the authority gate; refusals close the stream', async () => {
    const { lanes, streamHandler, runtime } = harness()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId })
    const outcomes: { code: string; reason?: string }[] = []
    const sent: unknown[] = []
    const session = {
      grant: {
        direction: 'write',
        resource: { kind: 'computeruse_lane', id: lane.id, generation: 1 },
      },
      close: (code: string, reason?: string) => outcomes.push({ code, reason }),
      send: (frame: unknown) => sent.push(frame),
    }
    ;(streamHandler as (session: unknown) => void)(session)
    // No consent record: the gate refuses and closes the stream revoked.
    const frame = {
      type: 'input',
      sequence: '1',
      generation: 1,
      bytes: encodeCbor({ kind: 'text', text: 'nope' }),
    }
    ;(session as unknown as { onFrame?: (frame: unknown) => void }).onFrame?.(frame)
    await Bun.sleep(5)
    expect(outcomes[0]?.code).toBe('revoked')
    expect(sent).toHaveLength(0)
  }, 2000)
})
