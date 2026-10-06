// One lazy entry for the Control Plane-backed settings panes (ADR 0013):
// Skills and Connections › Cloud share their model and data hooks, so a
// single chunk carries both instead of one per pane.
export { default as CloudConnectionsPane } from './cloud-connections-pane'
export { default as SkillsPane } from './skills-pane'
