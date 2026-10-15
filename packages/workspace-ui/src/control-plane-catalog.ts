// Lazy entry for the Control Plane catalog and vault panes (ADR 0013): Skills and Cloud
// connections read the same catalog and vault queries and share one confirm-dialog stack.
export { default as SkillsPane } from './skills-pane'
export { default as CloudConnectionsPane } from './cloud-connections-pane'
