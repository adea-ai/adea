// Device session lifecycle and fixed argv templates.
//
// Every command is a fixed argv template whose only free element is an ID
// taken from verified inventory — never caller text. Start/stop follow the
// spec's process-authority rule: Adea records the launch (PID + start
// identity) and stops only a still-identity-matching process it launched;
// a device that was already booted is detached, never shut down (Orca's
// managed-session rule, MIT revision
// 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7).
import type {
  DeviceInventoryItem,
  DeviceSession,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import {
  adbEmuKillArgv,
  DeviceSessionError,
  emulatorBootArgv,
  simctlBootArgv,
  simctlShutdownArgv,
} from './inventory'

export { DeviceSessionError }

// ── Session registry ────────────────────────────────────────────────────────

export type DeviceProcessIdentity = Readonly<{
  pid: number
  /** PID start identity (e.g. /proc-ish birth fingerprint) captured at launch. */
  startIdentity: string
  argv: readonly string[]
  executable: string
}>

export type DeviceSessionRecord = DeviceSession &
  Readonly<{
    inventoryLabel: string
    /** True only when Adea started the underlying process this session owns. */
    startedByAdea: boolean
    process?: DeviceProcessIdentity
    responsive?: Readonly<{
      width: number
      height: number
      deviceScaleFactor: number
      mobile: boolean
    }>
    createdAt: string
  }>

export type VerifiedInventory = Readonly<{
  items: readonly (DeviceInventoryItem & {
    detail?: 'emulator' | 'device' | 'avd' | string
  })[]
  observedAt: string
}>

export type DeviceSessionRegistryOptions = Readonly<{
  now?: () => string
  randomId?: () => string
  /** Rechecks a launch record immediately before every stop; never PID alone. */
  probeProcess?: (identity: DeviceProcessIdentity) => boolean
}>

export function createDeviceSessionRegistry(options: DeviceSessionRegistryOptions = {}) {
  const now = options.now ?? (() => new Date().toISOString())
  const randomId = options.randomId ?? (() => crypto.randomUUID())
  const probeProcess =
    options.probeProcess ?? ((identity: DeviceProcessIdentity) => identity.pid > 0)
  const sessions = new Map<string, DeviceSessionRecord>()
  const inventoryGenerations = new Map<string, number>()

  function session(id: string): DeviceSessionRecord {
    const record = sessions.get(id)
    if (!record) throw new DeviceSessionError('not_found', `device session ${id} is unknown`)
    return record
  }

  function save(record: DeviceSessionRecord): DeviceSessionRecord {
    sessions.set(record.id, record)
    return record
  }

  return {
    session,

    list(filter: Readonly<{ runtimeSessionId?: string; kind?: DeviceSession['kind'] }> = {}) {
      return [...sessions.values()]
        .filter(
          (record) =>
            (filter.runtimeSessionId === undefined ||
              record.runtimeSessionId === filter.runtimeSessionId) &&
            (filter.kind === undefined || record.kind === filter.kind)
        )
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    },

    /** A responsive session is always creatable — it owns no process. */
    startResponsive(scope: Scope, runtimeSessionId: string): DeviceSessionRecord {
      const viewportDefaults = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
      return save({
        id: randomId(),
        scope,
        runtimeSessionId,
        inventoryId: 'responsive',
        inventoryLabel: 'Responsive viewport',
        kind: 'responsive',
        state: 'attached',
        generation: 1,
        startedByAdea: false,
        responsive: viewportDefaults,
        createdAt: now(),
      })
    },

    /**
     * Starts a simulator/emulator session from a VERIFIED inventory ID at the
     * expected inventory generation. Returns the launch record for the host
     * to execute; the caller reports back with `markLaunched`.
     */
    planStart(
      scope: Scope,
      input: Readonly<{
        runtimeSessionId: string
        inventoryId: string
        expectedGeneration: number
        inventory: VerifiedInventory
        platform: 'ios' | 'android'
      }>
    ): Readonly<{
      session: DeviceSessionRecord
      launch: Readonly<{ argv: readonly string[]; executable: string; inventoryId: string }>
    }> {
      const item = input.inventory.items.find((entry) => entry.id === input.inventoryId)
      if (!item)
        throw new DeviceSessionError(
          'identity_mismatch',
          `inventory id ${input.inventoryId} is not in the verified inventory`
        )
      if (inventoryGenerations.get(input.inventoryId) !== input.expectedGeneration)
        throw new DeviceSessionError('stale_generation', 'inventory generation moved')
      if (item.kind === 'physical')
        throw new DeviceSessionError(
          'unsupported_capability',
          'physical devices require a separate pairing grant'
        )
      if (input.platform === 'ios' && item.state !== 'available' && item.state !== 'offline')
        throw new DeviceSessionError('invalid_state', `device is ${item.state}`)
      const record: DeviceSessionRecord = {
        id: randomId(),
        scope,
        runtimeSessionId: input.runtimeSessionId,
        inventoryId: item.id,
        inventoryLabel: item.name,
        kind: input.platform === 'ios' ? 'ios_simulator' : 'android_emulator',
        state: 'starting',
        generation: 1,
        startedByAdea: true,
        createdAt: now(),
      }
      save(record)
      const launch =
        input.platform === 'ios'
          ? { argv: simctlBootArgv(item.id), executable: 'xcrun', inventoryId: item.id }
          : {
              argv: emulatorBootArgv(item.name),
              executable: 'emulator',
              inventoryId: item.id,
            }
      return { session: record, launch }
    },

    /** Host callback after the launch record executed: bind process identity. */
    markLaunched(
      sessionId: string,
      process: DeviceProcessIdentity | undefined
    ): DeviceSessionRecord {
      const record = session(sessionId)
      if (!process)
        // An already-booted device adopted without a launch record: detach
        // semantics — Adea may use it but may never shut it down.
        return save({ ...record, state: 'attached', startedByAdea: false })
      return save({ ...record, state: 'attached', process })
    },

    /**
     * Stop: only an Adea-launched, still-identity-matching process is ever
     * stopped. An unmanaged device detaches and stays alive.
     */
    planStop(
      sessionId: string,
      expectedGeneration: number,
      confirmationId?: string
    ): Readonly<{
      session: DeviceSessionRecord
      shutdownArgv?: readonly string[]
      executable?: string
    }> {
      const record = session(sessionId)
      if (record.generation !== expectedGeneration)
        throw new DeviceSessionError('stale_generation', 'session generation moved')
      if (record.state === 'stopped' || record.state === 'stopping') return { session: record }
      if (record.kind === 'responsive')
        throw new DeviceSessionError(
          'invalid_state',
          'responsive sessions have no device process to stop'
        )
      if (!record.startedByAdea || !record.process) {
        // Unmanaged (user-booted) device: detach only; never kill.
        return { session: save({ ...record, state: 'stopped' }) }
      }
      if (!probeProcess(record.process))
        throw new DeviceSessionError(
          'ownership_unproven',
          'launch identity no longer matches; the process will not be signalled'
        )
      if (!confirmationId)
        throw new DeviceSessionError('permission_denied', 'stopping a device requires confirmation')
      const shutdownArgv =
        record.kind === 'ios_simulator'
          ? simctlShutdownArgv(record.inventoryId)
          : adbEmuKillArgv(record.inventoryId)
      return {
        session: save({ ...record, state: 'stopping' }),
        shutdownArgv,
        executable: record.kind === 'ios_simulator' ? 'xcrun' : 'adb',
      }
    },

    markStopped(sessionId: string): DeviceSessionRecord {
      const record = session(sessionId)
      return save({ ...record, state: 'stopped', process: undefined })
    },

    setViewport(
      sessionId: string,
      viewport: Readonly<{
        width: number
        height: number
        deviceScaleFactor: number
        mobile: boolean
      }>
    ): DeviceSessionRecord {
      const record = session(sessionId)
      if (record.kind !== 'responsive')
        throw new DeviceSessionError(
          'unsupported_capability',
          'viewport emulation applies to responsive sessions'
        )
      return save({ ...record, responsive: viewport })
    },

    /** Inventory snapshots carry a generation so start can bind to verified facts. */
    setInventory(items: readonly DeviceInventoryItem[]): VerifiedInventory {
      for (const item of items) inventoryGenerations.set(item.id, item.generation)
      return { items, observedAt: now() }
    },
  }
}

export type DeviceSessionRegistry = ReturnType<typeof createDeviceSessionRegistry>
