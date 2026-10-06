import type {
  DevLayoutPreferencesV2,
  DevUtilityPane,
  DevUtilityPreference,
} from '@adea-ai/types/dev-runtime'

export const utilityPaneDefinitions = [
  { pane: 'files', side: 'left', label: 'Files', title: 'Files' },
  {
    pane: 'source_control',
    side: 'left',
    label: 'Source control',
    title: 'Source Control',
  },
  { pane: 'browser', side: 'right', label: 'Browser', title: 'Browser' },
  {
    pane: 'devices',
    side: 'right',
    label: 'Devices',
    title: 'Devices',
  },
  { pane: 'agents', side: 'right', label: 'Agents', title: 'Agents' },
  { pane: 'history', side: 'right', label: 'History', title: 'History' },
] as const satisfies readonly Readonly<{
  pane: DevUtilityPane
  side: 'left' | 'right'
  label: string
  title: string
}>[]

export const utilityPaneById = new Map(utilityPaneDefinitions.map((item) => [item.pane, item]))

export const utilitySizeSteps = {
  left: [240, 288, 336, 384],
  right: [240, 288, 336, 384, 448, 512, 600],
} as const
export const defaultLeftUtilitySize = 336
// The right host (Browser/Devices/Agents/History) opens clearly wider than the
// 336 left anchor: 600 is the shared top resize step, so the default never
// pins the pane below the widest size the handle offers. Stored widths always
// win (decode keeps any stored size >= 0), so this moves only first-run and
// reset layouts — except the one tolerant migration: the v0.83.0 build wrote
// its 512 default into stored documents on first run, so decode resolves a
// stored right-side 512 to 600 (see layout/persistence.ts).
export const defaultRightUtilitySize = 600

export const defaultUtilityPreferences = (): DevUtilityPreference[] =>
  utilityPaneDefinitions.map((item, order) => ({
    pane: item.pane,
    side: item.side,
    order,
    visible: item.pane === 'files',
    size: item.side === 'left' ? defaultLeftUtilitySize : defaultRightUtilitySize,
    lastNonzeroSize: item.side === 'left' ? defaultLeftUtilitySize : defaultRightUtilitySize,
    fullWidth: false,
  }))

export function snapUtilitySize(size: number, side: 'left' | 'right'): number {
  const steps = utilitySizeSteps[side]
  const fallback = side === 'left' ? defaultLeftUtilitySize : defaultRightUtilitySize
  if (!Number.isFinite(size)) return fallback
  return steps.reduce(
    (best, step) => (Math.abs(step - size) < Math.abs(best - size) ? step : best),
    steps[0]
  )
}

/** Check the fixed document cardinality before publishing utility preferences. */
export function layoutUtilityTuple(
  items: readonly DevUtilityPreference[]
): DevLayoutPreferencesV2['utility'] {
  const [first, second, third, fourth, fifth, sixth] = items
  if (items.length !== 6 || !first || !second || !third || !fourth || !fifth || !sixth)
    throw new TypeError('corrupt_state: utility preferences require six panes')
  return [first, second, third, fourth, fifth, sixth]
}
