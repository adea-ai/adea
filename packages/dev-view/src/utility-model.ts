import type { DevUtilityPane, DevUtilityPreference } from '@adea-ai/types/dev-runtime'
import {
  Files,
  GitBranch,
  History,
  Laptop,
  MonitorSmartphone,
  Users,
} from 'lucide-solid'

export const utilityItems = [
  { pane: 'files', side: 'left', label: 'Files', title: 'Files', icon: Files },
  {
    pane: 'source_control',
    side: 'left',
    label: 'Source control',
    title: 'Source Control',
    icon: GitBranch,
  },
  { pane: 'browser', side: 'right', label: 'Browser', title: 'Browser', icon: Laptop },
  {
    pane: 'devices',
    side: 'right',
    label: 'Devices',
    title: 'Devices',
    icon: MonitorSmartphone,
  },
  { pane: 'agents', side: 'right', label: 'Agents', title: 'Agents', icon: Users },
  { pane: 'history', side: 'right', label: 'History', title: 'History', icon: History },
] as const satisfies readonly Readonly<{
  pane: DevUtilityPane
  side: 'left' | 'right'
  label: string
  title: string
  icon: typeof Files
}>[]

export const utilityItemByPane = new Map(utilityItems.map((item) => [item.pane, item]))
export const utilitySizeSteps = [240, 288, 336, 384] as const
export const defaultLeftUtilitySize = 336
export const defaultRightUtilitySize = 384

export const defaultUtilityPreferences = (): DevUtilityPreference[] =>
  utilityItems.map((item, order) => ({
    pane: item.pane,
    side: item.side,
    order,
    visible: item.pane === 'files',
    size: item.side === 'left' ? defaultLeftUtilitySize : defaultRightUtilitySize,
    lastNonzeroSize: item.side === 'left' ? defaultLeftUtilitySize : defaultRightUtilitySize,
    fullWidth: false,
  }))

export function snapUtilitySize(size: number): number {
  if (!Number.isFinite(size)) return defaultLeftUtilitySize
  return utilitySizeSteps.reduce(
    (best, step) => (Math.abs(step - size) < Math.abs(best - size) ? step : best),
    utilitySizeSteps[0]
  )
}
