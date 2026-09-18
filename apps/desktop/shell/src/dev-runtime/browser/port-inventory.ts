// Loopback port inventory for the preview Ports menu.
//
// Parse and probe structure follows t3code's PortScanner (MIT, revision
// 77bca8b2d76a1f42552e5eee7d277fcb1160347a): the `lsof -iTCP -sTCP:LISTEN -P
// -n -F pcn` field format, local-host token filtering, and a bounded HTTP
// probe that admits only HTML or a redirect to one. Adea hardening per
// issue #422: the scan is loopback-listeners only (no LAN surface, no
// common-port guessing fallback), owners come from Adea's own launch/session
// metadata (a PID alone never proves ownership), and entries observed in a
// previous snapshot that have vanished become `stale`, never silently
// deleted, with stale entries never probe-published as previewable.
import type { PortRecord, Scope } from '../../../../../../packages/types/src/dev-runtime'

export const LSOF_LOCAL_HOST_TOKENS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '*',
  '[::]',
  '[::1]',
])

export type DiscoveredLoopbackService = Readonly<{
  host: 'localhost'
  port: number
  processName: string | null
  pid: number | null
}>

/** lsof -F output: `p<pid>`, `c<command>`, `n<name>` lines (t3code). */
export function parseLsofOutput(raw: string): readonly DiscoveredLoopbackService[] {
  const seen = new Map<string, DiscoveredLoopbackService>()
  let pid: number | null = null
  let processName: string | null = null
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    const tag = line.charAt(0)
    const value = line.slice(1)
    if (tag === 'p') {
      const parsed = Number.parseInt(value, 10)
      pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null
      processName = null
      continue
    }
    if (tag === 'c') {
      processName = value.trim() || null
      continue
    }
    if (tag === 'n') {
      const port = parsePortFromLsofName(value)
      if (port === null) continue
      const key = `localhost:${port}`
      if (seen.has(key)) continue
      seen.set(key, { host: 'localhost', port, processName, pid })
    }
  }
  return [...seen.values()].toSorted((left, right) => left.port - right.port)
}

export function parsePortFromLsofName(name: string): number | null {
  // Examples: "*:5173", "127.0.0.1:5173", "[::1]:5173". Only local hosts count.
  const trimmed = name.split(' ', 1)[0]?.trim() ?? ''
  if (trimmed.length === 0) return null
  const lastColon = trimmed.lastIndexOf(':')
  if (lastColon < 0) return null
  const hostPart = trimmed.slice(0, lastColon)
  const portPart = trimmed.slice(lastColon + 1)
  if (!LSOF_LOCAL_HOST_TOKENS.has(hostPart)) return null
  const port = Number.parseInt(portPart, 10)
  if (!Number.isFinite(port) || port <= 0 || port >= 65_536) return null
  return port
}

export type PortInventoryOptions = Readonly<{
  scope: Scope
  now?: () => string
  randomId?: () => string
  /** Runs lsof (or a fixture); missing binaries surface as a typed refusal. */
  runLsof: () => Promise<string>
  /**
   * Adea-owned loopback services from launch/session metadata. This is the
   * primary inventory; the lsof scan only confirms ownership of listeners.
   */
  ownedServices: () => readonly AdeaOwnedPortService[]
}>

export type AdeaOwnedPortService = Readonly<{
  port: number
  processRecordId: string
  runtimeSessionId?: string
  ownerId: string
  label?: string
}>

export type PortInventorySnapshot = Readonly<{
  ports: readonly PortRecord[]
  services: readonly Readonly<{
    port: number
    owner: 'adea' | 'external'
    processName: string | null
    runtimeSessionId?: string
    processRecordId?: string
    health: 'listening' | 'unconfirmed'
  }>[]
  observedAt: string
}>

export function createPortInventory(options: PortInventoryOptions) {
  const now = options.now ?? (() => new Date().toISOString())
  const randomId = options.randomId ?? (() => crypto.randomUUID())
  let previous: Map<number, PortRecord> | undefined

  return {
    async snapshot(): Promise<PortInventorySnapshot> {
      const owned = options.ownedServices()
      const ownedByPort = new Map(owned.map((service) => [service.port, service]))
      let listeners: readonly DiscoveredLoopbackService[]
      try {
        listeners = parseLsofOutput(await options.runLsof())
      } catch {
        // OS inspection is optional; Adea-owned metadata remains the primary
        // inventory and is still reported, marked unconfirmed.
        listeners = []
      }
      const observedAt = now()
      const ports: PortRecord[] = []
      const services: {
        port: number
        owner: 'adea' | 'external'
        processName: string | null
        runtimeSessionId?: string
        processRecordId?: string
        health: 'listening' | 'unconfirmed'
      }[] = []
      const seen = new Set<number>()
      for (const listener of listeners) {
        seen.add(listener.port)
        const owner = ownedByPort.get(listener.port)
        const record: PortRecord = {
          id: randomId(),
          scope: options.scope,
          protocol: 'tcp',
          host: '127.0.0.1',
          port: listener.port,
          owner: owner ? 'adea' : 'unknown',
          ...(owner
            ? {
                processRecordId: owner.processRecordId,
                runtimeSessionId: owner.runtimeSessionId,
                generation: 1,
              }
            : {}),
          state: 'observed',
          observedAt,
        }
        ports.push(record)
        services.push({
          port: listener.port,
          owner: owner ? 'adea' : 'external',
          processName: listener.processName,
          ...(owner
            ? { runtimeSessionId: owner.runtimeSessionId, processRecordId: owner.processRecordId }
            : {}),
          health: 'listening',
        })
      }
      // Adea-owned services the scan could not confirm stay visible as
      // unconfirmed rather than disappearing.
      for (const service of owned) {
        if (seen.has(service.port)) continue
        services.push({
          port: service.port,
          owner: 'adea',
          processName: service.label ?? null,
          runtimeSessionId: service.runtimeSessionId,
          processRecordId: service.processRecordId,
          health: 'unconfirmed',
        })
      }
      // Ports in the previous snapshot that vanished become stale, never
      // silently deleted (the UI shows them greyed with a refresh hint).
      const next = new Map(ports.map((record) => [record.port, record]))
      if (previous) {
        for (const [port, record] of previous) {
          if (!next.has(port)) next.set(port, { ...record, state: 'stale', observedAt })
        }
      }
      const merged = [...next.values()].toSorted((left, right) => left.port - right.port)
      previous = new Map(
        merged
          .filter((record) => record.state === 'observed')
          .map((record) => [record.port, record])
      )
      services.sort((left, right) => left.port - right.port)
      return { ports: merged, services, observedAt }
    },

    /**
     * Preview admission: only a proven Adea-owned loopback service on this
     * runtime node is previewable. Unknown listeners are display-only.
     */
    previewableService(services: PortInventorySnapshot['services'], port: number): boolean {
      const service = services.find((entry) => entry.port === port)
      return service !== undefined && service.owner === 'adea' && service.health === 'listening'
    },
  }
}

export type PortInventory = ReturnType<typeof createPortInventory>
