import type { WorkspaceView } from './workspace-view-toggle'

/**
 * Global rail customization (Dev Runtime spec, "Appearance and App Library"):
 * ordering and visibility of the rail's view entries, persisted as a
 * versioned record. Chat/Dev/Virtual are built-in core views — hideable only
 * while inactive and always recoverable via App Library or Reset Navigation;
 * optional app contributions ride the same record and are preserved even when
 * the contribution itself is unknown to this build.
 */

export type RailItemKind = 'core-view' | 'optional-app'

export type RailItem = Readonly<{
  id: string
  label: string
  kind: RailItemKind
}>

export type RailPreferencesV1 = Readonly<{
  version: 1
  /** Known item ids in display order, then any unknown preserved ids. */
  order: readonly string[]
  hidden: readonly string[]
}>

export const RAIL_PREFERENCES_STORAGE_KEY = 'adea:rail-preferences:v1'
/** Malformed/future records are quarantined instead of discarded. */
export const RAIL_PREFERENCES_QUARANTINE_KEY = 'adea:rail-preferences:quarantine:v1'

/**
 * The default rail: core views in the canonical rail order. Optional app
 * contributions append after them when they appear.
 */
export const defaultRailPreferences: RailPreferencesV1 = Object.freeze({
  version: 1,
  order: Object.freeze(['virtual', 'chat', 'dev']),
  hidden: Object.freeze([]),
})

export function railItemsForViews(
  views: readonly WorkspaceView[] = ['virtual', 'chat', 'dev']
): readonly RailItem[] {
  return views.map((view) => ({
    id: view,
    label: VIEW_LABELS[view] ?? view,
    kind: 'core-view',
  }))
}

const VIEW_LABELS: Record<string, string> = {
  virtual: 'Virtual view',
  chat: 'Chat view',
  dev: 'Dev view',
}

function normalizeRecord(raw: unknown): RailPreferencesV1 | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (record.version !== 1) return undefined
  if (!Array.isArray(record.order) || !Array.isArray(record.hidden)) return undefined
  const order = record.order.filter((id): id is string => typeof id === 'string')
  const hidden = record.hidden.filter((id): id is string => typeof id === 'string')
  // Every known item must survive normalization: a record missing a core id
  // (for example written by an older build) is completed from the defaults.
  const merged = [...order, ...defaultRailPreferences.order.filter((id) => !order.includes(id))]
  return {
    version: 1,
    order: Object.freeze(merged),
    hidden: Object.freeze([...new Set(hidden)]),
  }
}

export type NormalizedRailPreferences = Readonly<{
  value: RailPreferencesV1
  /** The unread raw record when it could not be normalized. Retained, never erased. */
  retainedRaw?: unknown
}>

/**
 * Parse a stored rail record. Unknown versions and malformed records fall
 * back to the defaults and keep the raw value for retention.
 */
export function normalizeRailPreferences(raw: unknown): NormalizedRailPreferences {
  const value = normalizeRecord(raw)
  return value ? { value } : { value: defaultRailPreferences, retainedRaw: raw }
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

export function readRailPreferences(storage: PreferenceStorage | undefined): RailPreferencesV1 {
  if (!storage) return defaultRailPreferences
  try {
    const raw = storage.getItem(RAIL_PREFERENCES_STORAGE_KEY)
    if (raw === null) return defaultRailPreferences
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Preserve malformed text byte-for-byte for diagnostics/recovery.
      storage.setItem(RAIL_PREFERENCES_QUARANTINE_KEY, raw)
      return defaultRailPreferences
    }
    const normalized = normalizeRailPreferences(parsed)
    if (normalized.retainedRaw !== undefined) {
      try {
        storage.setItem(RAIL_PREFERENCES_QUARANTINE_KEY, JSON.stringify(normalized.retainedRaw))
      } catch {
        // Storage remains best-effort; the active view still fails closed.
      }
    }
    return normalized.value
  } catch {
    return defaultRailPreferences
  }
}

export function writeRailPreferences(
  storage: PreferenceStorage | undefined,
  preferences: RailPreferencesV1
): void {
  if (!storage) return
  try {
    storage.setItem(RAIL_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Persistence is best-effort; the in-memory customization still applies.
  }
}

/**
 * Apply the customization to the live items: unknown contributions keep their
 * recorded position (appended when unrecorded), hidden items drop out, and a
 * hidden item that is currently active still renders — the active view can
 * never silently disappear.
 */
export function resolveRailItems(
  preferences: RailPreferencesV1,
  items: readonly RailItem[],
  activeItemId?: string
): readonly RailItem[] {
  const known = new Map(items.map((item) => [item.id, item]))
  const ordered: RailItem[] = []
  const placed = new Set<string>()
  const place = (id: string) => {
    if (placed.has(id)) return
    const item = known.get(id)
    if (!item) return
    ordered.push(item)
    placed.add(id)
  }
  for (const id of preferences.order) place(id)
  for (const item of items) place(item.id)

  const hidden = new Set(preferences.hidden)
  // A hidden item that is currently active still renders: the active view can
  // never silently disappear.
  return ordered.filter((item) => !hidden.has(item.id) || item.id === activeItemId)
}

/**
 * Move one visible item by one visible slot. Disabled and unknown entries
 * retain their recorded slots when the host supplies its live item ids.
 */
export function reorderRailItems(
  preferences: RailPreferencesV1,
  id: string,
  direction: 'down' | 'up',
  visibleIds: readonly string[] = preferences.order.filter(
    (item) => !preferences.hidden.includes(item)
  )
): RailPreferencesV1 {
  const visibleIndex = visibleIds.indexOf(id)
  if (visibleIndex === -1) return preferences
  const targetId = visibleIds[visibleIndex + (direction === 'up' ? -1 : 1)]
  if (targetId === undefined) return preferences
  const order = [...new Set([...preferences.order, ...visibleIds])]
  const index = order.indexOf(id)
  const target = order.indexOf(targetId)
  ;[order[index], order[target]] = [order[target]!, order[index]!]
  return { version: 1, order: Object.freeze(order), hidden: preferences.hidden }
}

/**
 * The next order after a rail drop: `id` is placed directly before or after
 * `targetId`. Dropping an item on itself, or on an unknown target, is a no-op.
 * Disabled and unknown entries keep their recorded slots.
 */
export function reorderRailItemsRelativeTo(
  preferences: RailPreferencesV1,
  id: string,
  targetId: string,
  position: 'after' | 'before' = 'before'
): RailPreferencesV1 {
  if (id === targetId) return preferences
  const without = preferences.order.filter((candidate) => candidate !== id)
  if (without.length === preferences.order.length) return preferences
  const index = without.indexOf(targetId)
  if (index === -1) return preferences
  const order = [...without]
  order.splice(position === 'before' ? index : index + 1, 0, id)
  return { version: 1, order: Object.freeze(order), hidden: preferences.hidden }
}

/**
 * The live-region announcement for one completed rail move. `position` is the
 * 1-based position after the move attempt; a no-op (boundary or unknown id)
 * says the view is already there instead of staying silent.
 */
export function railMoveAnnouncement(
  label: string,
  position: number,
  total: number,
  moved: boolean
): string {
  return moved
    ? `${label} moved to position ${position} of ${total}`
    : `${label} is already at position ${position} of ${total}`
}

export function setRailItemHidden(
  preferences: RailPreferencesV1,
  id: string,
  hidden: boolean
): RailPreferencesV1 {
  const next = new Set(preferences.hidden)
  if (hidden) next.add(id)
  else next.delete(id)
  return {
    version: 1,
    order: preferences.order,
    hidden: Object.freeze([...next]),
  }
}
