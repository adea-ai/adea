/*
 * Pure view-model for the machine-wide janitor tab: sections in display
 * order, per-section totals, and the confirmation summary. The rules mirror
 * the host's safety contract: an unmeasured item stays unknown (never zero),
 * every item shows how it will be disposed of, and the confirmation names
 * what will be removed and the total size before anything runs.
 */
import type { JanitorItem } from '@adea-ai/types/dev-runtime'

export const JANITOR_SECTION_ORDER = ['derived_data', 'cache', 'logs', 'worktree', 'trash'] as const

export type JanitorSectionId = (typeof JANITOR_SECTION_ORDER)[number]

export const JANITOR_SECTION_TITLES: Record<JanitorSectionId, string> = {
  derived_data: 'Xcode Derived Data',
  cache: 'Caches',
  logs: 'Application logs',
  worktree: 'Git worktrees',
  trash: 'Trash',
}

export const JANITOR_DISPOSAL_LABELS: Record<JanitorItem['disposal'], string> = {
  trash: 'Moves to Trash',
  trash_empty: 'Empties the Trash entry permanently',
  prune: 'Prunes Git’s stale registry entry',
}

export type JanitorSectionView = Readonly<{
  id: JanitorSectionId
  title: string
  items: readonly JanitorItem[]
  /** Sum of measured bytes; absent while any item is unmeasured. */
  totalBytes?: number
}>

function bytes(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/** The scan report grouped into display sections; empty sections are absent. */
export function janitorSections(items: readonly JanitorItem[]): JanitorSectionView[] {
  const grouped = new Map<JanitorSectionId, JanitorItem[]>()
  for (const item of items) {
    if (!JANITOR_SECTION_ORDER.includes(item.section as JanitorSectionId)) continue
    const list = grouped.get(item.section as JanitorSectionId) ?? []
    list.push(item)
    grouped.set(item.section as JanitorSectionId, list)
  }
  return JANITOR_SECTION_ORDER.filter((section) => grouped.has(section)).map((section) => {
    const list = grouped.get(section) as JanitorItem[]
    const measured = list.map((item) => bytes(item.bytes))
    const total = measured.every((value) => value !== undefined)
      ? measured.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : undefined
    return {
      id: section,
      title: JANITOR_SECTION_TITLES[section],
      items: list,
      ...(total !== undefined ? { totalBytes: total } : {}),
    }
  })
}

export type JanitorSelectionSummary = Readonly<{
  count: number
  /** Total measured bytes of the selection; absent when any is unmeasured. */
  totalBytes?: number
  /** True when any selected item's cleanup is not a recoverable Trash move. */
  permanent: boolean
}>

/** The confirmation summary for a selection: what will be removed, how much,
 * and whether any part of it is not a recoverable Trash move. */
export function janitorSelectionSummary(items: readonly JanitorItem[]): JanitorSelectionSummary {
  const measured = items.map((item) => bytes(item.bytes))
  const allMeasured = measured.every((value) => value !== undefined)
  return {
    count: items.length,
    ...(allMeasured
      ? { totalBytes: measured.reduce<number>((sum, value) => sum + (value ?? 0), 0) }
      : {}),
    permanent: items.some((item) => item.disposal !== 'trash'),
  }
}

/** Items of one section bounded to a measure window: the sheet never asks the
 * host to size more than this many at once. */
export const JANITOR_MEASURE_WINDOW = 64

export function janitorMeasureIds(items: readonly JanitorItem[]): readonly string[] {
  return items
    .filter((item) => item.state === 'discovered' || item.state === 'stale')
    .slice(0, JANITOR_MEASURE_WINDOW)
    .map((item) => item.id)
}
