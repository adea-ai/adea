// One lazy entry for the Control Plane-backed settings panes (ADR 0013):
// Skills, cloud connections, model setup and lead execution share one deferred entry rather
// than allocating another client chunk for each settings pane.
export { default as CloudConnectionsPane } from './cloud-connections-pane'
export { default as RuntimeNodesPane } from './runtime-nodes-pane'
export { default as SkillsPane } from './skills-pane'
export { default as LeadModelPane } from './lead-model-pane'
export { LeadTurnControls } from './lead-turn-controls'

export { createLeadModelRequestResolver } from './lead-model-request'
