import type {
  DevCapability,
  DevUtilityPane,
  DevUtilityPreference,
  PaneLeaf,
} from '@adea-ai/types/dev-runtime'

import { createLayoutState, type DevLayoutState } from '../layout/operations'

export const utilityItems = [
  { pane: 'files', side: 'left', label: 'Files', title: 'Files' },
  {
    pane: 'source_control',
    side: 'left',
    label: 'Source control',
    title: 'Source Control',
  },
  { pane: 'browser', side: 'right', label: 'Browser', title: 'Browser' },
  { pane: 'devices', side: 'right', label: 'Devices', title: 'Devices' },
  { pane: 'agents', side: 'right', label: 'Agents', title: 'Agents' },
  { pane: 'history', side: 'right', label: 'History', title: 'History' },
] as const satisfies readonly Readonly<{
  pane: DevUtilityPane
  side: 'left' | 'right'
  label: string
  title: string
}>[]

export const utilityItemByPane = new Map(utilityItems.map((item) => [item.pane, item]))

export const paneCapability: Record<DevUtilityPane, DevCapability> = {
  files: 'dev.files.read',
  source_control: 'dev.git.read',
  browser: 'dev.browser.read',
  devices: 'dev.device.read',
  agents: 'dev.session.read',
  history: 'dev.session.read',
}

const defaultUtilitySize = 288
const defaultBrowserUtilitySize = 336

export const defaultUtilityPreferences = (): DevUtilityPreference[] =>
  utilityItems.map((item, order) => ({
    pane: item.pane,
    side: item.side,
    order,
    visible: item.pane === 'files',
    size: item.pane === 'browser' ? defaultBrowserUtilitySize : defaultUtilitySize,
    lastNonzeroSize: item.pane === 'browser' ? defaultBrowserUtilitySize : defaultUtilitySize,
    fullWidth: false,
  }))

export const initialDevLayout = (): DevLayoutState =>
  createLayoutState<PaneLeaf>({ kind: 'leaf', id: 'dev-terminal', pane: 'terminal' })

export function snapUtilitySize(size: number): number {
  const steps = [240, 288, 336, 384] as const
  if (!Number.isFinite(size)) return defaultUtilitySize
  return steps.reduce(
    (best, step) => (Math.abs(step - size) < Math.abs(best - size) ? step : best),
    steps[0]
  )
}
