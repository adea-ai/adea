// dev.device.* command providers and the device-frames-v1 stream mapping.
// Sessions and argv come from the devices module; the capability gate lives
// at the inventory boundary (missing xcrun/adb → typed unavailable with the
// actionable hint from inventory.ts). Start/stop/screenshot execute through
// the injected device engine — the real host-tooling seam — so a session
// never reports success without its launch record having run.
import type {
  DevCommand,
  DevErrorCode,
  DevStreamGrant,
} from '../../../../../../packages/types/src/dev-runtime'
import type { ChannelIdentity } from '../channel/authority'

import {
  DeviceSessionError,
  type DeviceSessionRegistry,
  type VerifiedInventory,
} from './device-sessions'
import type { DeviceEngine } from './engine'
import { DevCommandProviderError } from '../browser/providers'
import type { ScreenshotRecorder } from '../browser/providers'

export type DeviceProvidersInput = Readonly<{
  sessions: DeviceSessionRegistry
  mintStreamGrant?: (input: {
    identity: ChannelIdentity
    scope: DevCommand['scope']
    resource: { kind: 'device_session'; id: string; generation: number }
    direction: 'read' | 'write'
    fromSequence?: string
  }) => DevStreamGrant
  /** Latest verified inventory per platform; absent = capability unavailable. */
  verifiedInventory: () => Readonly<{
    ios?: VerifiedInventory
    android?: VerifiedInventory
  }>
  /** iOS input requires a helper that simctl does not provide. */
  iosInputHint: string
  /** Executes launches, shutdowns, captures, and gestures on real devices. */
  engine?: DeviceEngine
  screenshotRecorder: ScreenshotRecorder
}>

function body(command: DevCommand): Record<string, unknown> {
  return command.body as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new DevCommandProviderError('invalid_state', `body.${field} is required`)
  return value
}

const unavailableEngine = (): never => {
  throw new DevCommandProviderError(
    'capability_unavailable',
    'no device engine is attached for device sessions',
    true
  )
}

function assertScope(
  command: DevCommand,
  scope: { accountId: string; workspaceId: string; runtimeNodeId: string }
): void {
  if (
    scope.accountId !== command.scope.accountId ||
    scope.workspaceId !== command.scope.workspaceId ||
    scope.runtimeNodeId !== command.scope.runtimeNodeId
  )
    throw new DevCommandProviderError(
      'profile_scope_denied',
      'device session belongs to another scope'
    )
}

export function createDeviceProviders(input: DeviceProvidersInput) {
  let engine = input.engine

  function sessionFor(command: DevCommand) {
    const id = body(command).deviceSessionId
    if (typeof id !== 'string')
      throw new DevCommandProviderError('invalid_state', 'body.deviceSessionId is required')
    const session = input.sessions.session(id)
    assertScope(command, session.scope)
    return session
  }

  const providers: Partial<
    Record<string, (command: DevCommand, identity?: ChannelIdentity) => unknown | Promise<unknown>>
  > = {
    'dev.device.list': (command) => {
      const verified = input.verifiedInventory()
      const items = [...(verified.ios?.items ?? []), ...(verified.android?.items ?? [])]
      const req = body(command)
      const kind = typeof req.kind === 'string' ? req.kind : undefined
      return {
        items: (kind ? items.filter((item) => item.kind === kind) : items).slice(
          0,
          typeof req.limit === 'number' ? req.limit : 100
        ),
        observedAt: new Date().toISOString(),
      }
    },
    'dev.device.sessions': (command) => {
      const req = body(command)
      const items = input.sessions.list({
        runtimeSessionId:
          typeof req.runtimeSessionId === 'string' ? req.runtimeSessionId : undefined,
        kind: typeof req.kind === 'string' ? (req.kind as 'responsive') : undefined,
      })
      return { items, observedAt: new Date().toISOString() }
    },
    'dev.device.start': async (command) => {
      const req = body(command)
      const inventoryId = req.inventoryId
      const runtimeSessionId = req.runtimeSessionId
      if (typeof inventoryId !== 'string' || typeof runtimeSessionId !== 'string')
        throw new DevCommandProviderError(
          'invalid_state',
          'start requires inventory and session ids'
        )
      // The responsive lane never owns a process and is always available.
      if (inventoryId === 'responsive')
        return input.sessions.startResponsive(command.scope, runtimeSessionId)
      const platform = inventoryPlatformHint(inventoryId)
      const verified = input.verifiedInventory()
      const inventory = platform === 'ios' ? verified.ios : verified.android
      if (!inventory)
        throw new DevCommandProviderError(
          'capability_unavailable',
          platform === 'ios'
            ? 'Xcode Simulator tools are unavailable; install full Xcode and select it with xcode-select'
            : 'Android SDK not found; install Android Studio and set ANDROID_HOME',
          true
        )
      const { session, launch } = input.sessions.planStart(command.scope, {
        runtimeSessionId,
        inventoryId,
        expectedGeneration: Number(req.expectedGeneration ?? 0),
        inventory,
        platform,
      })
      if (!engine) {
        // Check before any state was committed beyond the plan row; roll the
        // planned session back so a missing engine cannot strand `starting`.
        input.sessions.markStopped(session.id)
        return unavailableEngine()
      }
      try {
        const identity = await engine.executeLaunch({
          ...launch,
          platform: session.kind === 'ios_simulator' ? 'ios' : 'android',
        })
        return input.sessions.markLaunched(session.id, identity)
      } catch (error) {
        // The launch never took effect: release the planned session so the
        // device can be started again instead of sitting in `starting`.
        input.sessions.markStopped(session.id)
        throw error
      }
    },
    'dev.device.stop': async (command) => {
      const session = sessionFor(command)
      const req = body(command)
      const expected = Number(req.expectedGeneration ?? session.generation)
      if (session.generation !== expected)
        throw new DevCommandProviderError(
          'stale_generation',
          `session generation moved to ${session.generation}`
        )
      if (session.kind === 'responsive') {
        // Responsive sessions own no device process; stopping is detachment.
        return input.sessions.markStopped(session.id)
      }
      if (!engine) return unavailableEngine()
      const { session: updated, shutdown } = input.sessions.planStop(
        session.id,
        expected,
        typeof req.confirmationId === 'string' ? req.confirmationId : undefined
      )
      if (shutdown === 'device') await engine.shutdown(updated)
      return input.sessions.markStopped(updated.id)
    },
    'dev.device.attach': (command, identity) => {
      const session = sessionFor(command)
      const requestBody = body(command)
      if (!identity || !input.mintStreamGrant)
        throw new DevCommandProviderError(
          'capability_unavailable',
          'channel stream grant unavailable',
          true
        )
      return input.mintStreamGrant({
        identity,
        scope: command.scope,
        resource: { kind: 'device_session', id: session.id, generation: session.generation },
        direction: 'read',
        fromSequence:
          typeof requestBody.fromSequence === 'string' ? requestBody.fromSequence : undefined,
      })
    },
    'dev.device.input': (command, identity) => {
      const session = sessionFor(command)
      const requestBody = body(command)
      if (session.kind === 'ios_simulator')
        throw new DevCommandProviderError(
          'unsupported_capability',
          `simulator input requires an automation helper; ${input.iosInputHint}`
        )
      if (session.kind === 'responsive')
        throw new DevCommandProviderError(
          'invalid_state',
          'responsive sessions accept viewport changes, not device gestures'
        )
      if (!identity || !input.mintStreamGrant)
        throw new DevCommandProviderError(
          'capability_unavailable',
          'channel stream grant unavailable',
          true
        )
      return input.mintStreamGrant({
        identity,
        scope: command.scope,
        resource: { kind: 'device_session', id: session.id, generation: session.generation },
        direction: 'write',
        fromSequence:
          typeof requestBody.fromSequence === 'string' ? requestBody.fromSequence : undefined,
      })
    },
    'dev.device.screenshot': async (command) => {
      const session = sessionFor(command)
      const req = body(command)
      if (session.state !== 'attached')
        throw new DevCommandProviderError('invalid_state', `session is ${session.state}`)
      const format = requireString(req.format, 'format') as 'png' | 'jpeg' | 'webp'
      const capture = engine ? await engine.screenshot(session, format) : unavailableEngine()
      return input.screenshotRecorder.record({
        bytes: capture.bytes,
        format,
        width: capture.width,
        height: capture.height,
        provenance: {
          ownerId: session.id,
          laneKind: 'device',
          // A device capture's origin is the verified inventory identity —
          // the device has no page URL. Device sessions derive no profile.
          origin: `device:${session.kind}:${session.inventoryId}`,
          viewport: {
            width: capture.width,
            height: capture.height,
            deviceScaleFactor: 1,
          },
          redacted: false,
        },
      })
    },
  }

  return {
    providers,
    /** Registrar composition seam: installs (or clears) the device engine. */
    setEngine(next: DeviceEngine | undefined): void {
      engine = next
    },
  }
}

function inventoryPlatformHint(inventoryId: string): 'ios' | 'android' {
  // iOS inventory IDs are UDIDs (UUID-shaped); Android serials/AVD names are not.
  return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(inventoryId)
    ? 'ios'
    : 'android'
}

export function deviceProviderError(error: unknown): DevCommandProviderError {
  if (error instanceof DevCommandProviderError) return error
  if (error instanceof DeviceSessionError)
    return new DevCommandProviderError(error.code as DevErrorCode, error.message)
  return new DevCommandProviderError('invalid_state', 'device provider failed', false)
}
