import { FolderTree, GitBranch, History, Laptop, MonitorSmartphone, Users } from 'lucide-solid'

import { utilityPaneDefinitions } from './utility-preferences'
export {
  defaultLeftUtilitySize,
  defaultRightUtilitySize,
  defaultUtilityPreferences,
  layoutUtilityTuple,
  snapUtilitySize,
  utilitySizeSteps,
} from './utility-preferences'

const utilityIcons = {
  files: FolderTree,
  source_control: GitBranch,
  browser: Laptop,
  devices: MonitorSmartphone,
  agents: Users,
  history: History,
} as const

export const utilityItems = utilityPaneDefinitions.map((item) => ({
  ...item,
  icon: utilityIcons[item.pane],
}))
export const utilityItemByPane = new Map(utilityItems.map((item) => [item.pane, item]))
