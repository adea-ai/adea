import type { DevUtilityPane, DevUtilityPreference } from '@adea-ai/types/dev-runtime'
import {
  FolderTree,
  GitBranch,
  History,
  Laptop,
  MonitorSmartphone,
  Users,
} from 'lucide-solid'

export const utilityItems = [
  { pane: 'files', side: 'left', label: 'Files', title: 'Files', icon: FolderTree },
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
  icon: typeof FolderTree
}>[]

export const utilityItemByPane = new Map(utilityItems.map((item) => [item.pane, item]))
export const utilitySizeSteps = {
  left: [240, 288, 336, 384],
  right: [240, 288, 336, 384, 448],
} as const
export const defaultLeftUtilitySize = 336
export const defaultRightUtilitySize = 448

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

export function snapUtilitySize(size: number, side: 'left' | 'right'): number {
  const steps = utilitySizeSteps[side]
  const fallback = side === 'left' ? defaultLeftUtilitySize : defaultRightUtilitySize
  if (!Number.isFinite(size)) return fallback
  return steps.reduce(
    (best, step) => (Math.abs(step - size) < Math.abs(best - size) ? step : best),
    steps[0]
  )
}
