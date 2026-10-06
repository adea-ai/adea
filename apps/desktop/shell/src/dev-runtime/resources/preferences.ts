// Resource preferences (spec "Machine-wide inventory and foreign stop"): the
// only resource settings in Adea, edited inside the runtime resources sheet
// and persisted per device in the shell's private data directory.
//
// Every numeric field is clamped to a documented range and every list is
// bounded. A stored document that fails to decode is not rejected wholesale:
// each field that cannot be read falls back to its default, so one bad value
// never resets the user's other choices.
import { join } from 'node:path'

import type {
  DevError,
  ResourcePreferences,
  ResourcePreferencesInput,
} from '../../../../../../packages/types/src/dev-runtime'
import { createDurableJsonStore } from '../host-store'
import { HARNESS_EXECUTABLES } from './machine-inventory'

const PREFERENCES_FILE = join('dev-runtime', 'resources', 'preferences.json')
const MAX_LIST = 32
const MiB = 1024 * 1024
const GiB = 1024 * MiB
const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Inclusive clamp ranges, mirrored in the spec. */
export const RESOURCE_PREFERENCE_LIMITS = Object.freeze({
  residentBytesAbove: { min: 256 * MiB, max: 64 * GiB },
  growthBytes: { min: 16 * MiB, max: 64 * GiB },
  growthWindowSeconds: { min: MINUTE, max: HOUR },
  snoozeSeconds: { min: 0, max: 7 * DAY },
  serverIdleSeconds: { min: 15 * MINUTE, max: 7 * DAY },
  suggestMergedWorktreesAfterSeconds: { min: 0, max: 90 * DAY },
  quarantineRetentionSeconds: { min: DAY, max: 30 * DAY },
  retainedDataRetentionSeconds: { min: DAY, max: 90 * DAY },
  visibleSeconds: { min: 2, max: MINUTE },
  backgroundSeconds: { min: 30, max: 10 * MINUTE },
})

export const DEFAULT_RESOURCE_PREFERENCES = Object.freeze<ResourcePreferencesInput>({
  coverage: 'machine',
  includeAutomationApps: true,
  recognizedHarnesses: ['Claude Code', 'Codex', 'OpenCode', 'Hermes', 'Cursor'],
  portRange: { from: 1024, to: 65_535 },
  alerts: {
    residentBytesAbove: String(2 * GiB),
    growthBytes: String(500 * MiB),
    growthWindowSeconds: 10 * MINUTE,
    notify: 'badge',
    snoozeSeconds: HOUR,
  },
  cleanup: {
    mode: 'ask',
    serverIdleSeconds: 4 * HOUR,
    suggestMergedWorktreesAfterSeconds: 3 * DAY,
    quarantineRetentionSeconds: 7 * DAY,
    retainedDataRetentionSeconds: 14 * DAY,
  },
  protectedExecutables: ['postgres', 'redis-server', 'mysqld', 'com.docker.*', 'ollama'],
  sampling: { visibleSeconds: 2, backgroundSeconds: MINUTE },
})

function clampInteger(
  value: unknown,
  fallback: number,
  range: { min: number; max: number }
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(range.max, Math.max(range.min, Math.round(value)))
}

function clampBytes(value: unknown, fallback: string, range: { min: number; max: number }): string {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return fallback
  const bytes = Number(value)
  return String(Math.min(range.max, Math.max(range.min, bytes)))
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback
}

function labels(
  value: unknown,
  fallback: readonly string[],
  allowed?: ReadonlySet<string>
): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const text = entry.trim()
    if (
      text.length === 0 ||
      text.length > 128 ||
      text.includes('/') ||
      !/^[\x20-\x7e]+$/.test(text)
    )
      continue
    if (allowed && !allowed.has(text)) continue
    if (!out.includes(text)) out.push(text)
    if (out.length >= MAX_LIST) break
  }
  return out
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

const KNOWN_HARNESSES = new Set(Object.keys(HARNESS_EXECUTABLES))

/** Normalizes any input (a stored document or a request) into a valid,
 * clamped preference document. Unknown fields are dropped. */
export function normalizeResourcePreferences(value: unknown): ResourcePreferencesInput {
  const item = record(value)
  const defaults = DEFAULT_RESOURCE_PREFERENCES
  const limits = RESOURCE_PREFERENCE_LIMITS
  const portRange = record(item.portRange)
  let from = clampInteger(portRange.from, defaults.portRange.from, { min: 1, max: 65_535 })
  let to = clampInteger(portRange.to, defaults.portRange.to, { min: 1, max: 65_535 })
  if (from > to) [from, to] = [to, from]
  const alerts = record(item.alerts)
  const cleanup = record(item.cleanup)
  const sampling = record(item.sampling)
  return {
    coverage: oneOf(item.coverage, ['adea', 'machine'] as const, defaults.coverage),
    includeAutomationApps:
      typeof item.includeAutomationApps === 'boolean'
        ? item.includeAutomationApps
        : defaults.includeAutomationApps,
    recognizedHarnesses: labels(
      item.recognizedHarnesses,
      defaults.recognizedHarnesses,
      KNOWN_HARNESSES
    ),
    portRange: { from, to },
    alerts: {
      residentBytesAbove: clampBytes(
        alerts.residentBytesAbove,
        defaults.alerts.residentBytesAbove,
        limits.residentBytesAbove
      ),
      growthBytes: clampBytes(alerts.growthBytes, defaults.alerts.growthBytes, limits.growthBytes),
      growthWindowSeconds: clampInteger(
        alerts.growthWindowSeconds,
        defaults.alerts.growthWindowSeconds,
        limits.growthWindowSeconds
      ),
      notify: oneOf(
        alerts.notify,
        ['badge', 'badge_and_notification'] as const,
        defaults.alerts.notify
      ),
      snoozeSeconds: clampInteger(
        alerts.snoozeSeconds,
        defaults.alerts.snoozeSeconds,
        limits.snoozeSeconds
      ),
    },
    cleanup: {
      mode: oneOf(cleanup.mode, ['off', 'ask', 'automatic'] as const, defaults.cleanup.mode),
      serverIdleSeconds: clampInteger(
        cleanup.serverIdleSeconds,
        defaults.cleanup.serverIdleSeconds,
        limits.serverIdleSeconds
      ),
      suggestMergedWorktreesAfterSeconds: clampInteger(
        cleanup.suggestMergedWorktreesAfterSeconds,
        defaults.cleanup.suggestMergedWorktreesAfterSeconds,
        limits.suggestMergedWorktreesAfterSeconds
      ),
      quarantineRetentionSeconds: clampInteger(
        cleanup.quarantineRetentionSeconds,
        defaults.cleanup.quarantineRetentionSeconds,
        limits.quarantineRetentionSeconds
      ),
      retainedDataRetentionSeconds: clampInteger(
        cleanup.retainedDataRetentionSeconds,
        defaults.cleanup.retainedDataRetentionSeconds,
        limits.retainedDataRetentionSeconds
      ),
    },
    protectedExecutables: labels(item.protectedExecutables, defaults.protectedExecutables),
    sampling: {
      visibleSeconds: clampInteger(
        sampling.visibleSeconds,
        defaults.sampling.visibleSeconds,
        limits.visibleSeconds
      ),
      backgroundSeconds: clampInteger(
        sampling.backgroundSeconds,
        defaults.sampling.backgroundSeconds,
        limits.backgroundSeconds
      ),
    },
  }
}

type StoredPreferences = ResourcePreferencesInput & { version: number; updatedAt: string }

export type ResourcePreferenceStore = Readonly<{
  current(): ResourcePreferences
  update(expectedVersion: number, input: ResourcePreferencesInput): ResourcePreferences
}>

function devError(code: DevError['code'], message: string, retryable = false): DevError {
  return { code, retryable, message }
}

/** In-memory store (tests, and hosts without a data directory). */
export function createMemoryResourcePreferenceStore(
  options: { now?: () => number; initial?: unknown } = {}
): ResourcePreferenceStore {
  const now = options.now ?? Date.now
  let stored: StoredPreferences = {
    ...normalizeResourcePreferences(options.initial),
    version: 0,
    updatedAt: new Date(now()).toISOString(),
  }
  return Object.freeze({
    current: () => stored,
    update(expectedVersion, input) {
      if (expectedVersion !== stored.version)
        throw devError('stale_version', 'resource settings changed since they were read', true)
      stored = {
        ...normalizeResourcePreferences(input),
        version: stored.version + 1,
        updatedAt: new Date(now()).toISOString(),
      }
      return stored
    },
  })
}

/** Durable per-device store under `<dataDir>/dev-runtime/resources/`. */
export function createResourcePreferenceStore(input: {
  dataDir: string
  now?: () => number
}): ResourcePreferenceStore {
  const now = input.now ?? Date.now
  const store = createDurableJsonStore<StoredPreferences>({
    file: join(input.dataDir, PREFERENCES_FILE),
    schemaVersion: 1,
    label: 'resource preferences',
  })
  let cached: StoredPreferences | undefined
  function load(): StoredPreferences {
    if (cached) return cached
    let raw: unknown
    try {
      raw = store.load().records[0]
    } catch {
      // A corrupt file is preserved aside by the store; start from defaults.
      raw = undefined
    }
    const item = record(raw)
    cached = {
      ...normalizeResourcePreferences(raw),
      version:
        typeof item.version === 'number' && Number.isSafeInteger(item.version) && item.version >= 0
          ? item.version
          : 0,
      updatedAt:
        typeof item.updatedAt === 'string' && !Number.isNaN(Date.parse(item.updatedAt))
          ? item.updatedAt
          : new Date(now()).toISOString(),
    }
    return cached
  }
  return Object.freeze({
    current: load,
    update(expectedVersion, value) {
      const current = load()
      if (expectedVersion !== current.version)
        throw devError('stale_version', 'resource settings changed since they were read', true)
      const next: StoredPreferences = {
        ...normalizeResourcePreferences(value),
        version: current.version + 1,
        updatedAt: new Date(now()).toISOString(),
      }
      store.save([next])
      cached = next
      return next
    },
  })
}
