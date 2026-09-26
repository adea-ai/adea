export { ConventionalWorkspaceShell } from './conventional-workspace-shell'
export { SidebarToggleButton } from './sidebar-toggle-button'
export type { WorkspaceView } from './workspace-view-toggle'
export { VirtualRoomControls } from './virtual-room-controls'
export {
  isDesktopRuntime,
  loadAgentSimEngine,
  resolveAgentSimEngine,
  type AgentSimEntitlement,
  type AgentSimRuntimeGlobal,
} from './agent-sim-engine'
export { VirtualView } from './virtual-view'
export { VirtualUnavailable } from './virtual-unavailable'
export { GlobalWorkspaceRail } from './global-workspace-rail'
export { WorkspaceAboutDialog } from './workspace-about-dialog'
export { PluginsDialog } from './plugins-dialog'
export {
  createRegistryPluginsProvider,
  appCategoryCounts,
  filterWorkspacePlugins,
  getPopularWorkspacePlugins,
  groupWorkspacePlugins,
  popularWorkspacePluginIds,
  workspacePluginCategoryOrder,
} from './plugins'
export {
  defaultRailPreferences,
  normalizeRailPreferences,
  railItemsForViews,
  readRailPreferences,
  reorderRailItems,
  resolveRailItems,
  setRailItemHidden,
  writeRailPreferences,
  type RailItem,
  type RailPreferencesV1,
} from './rail-preferences'
export {
  canonicalDigest,
  canonicalJson,
  mapRegistryCatalog,
  MarketplaceCatalogError,
  parseCatalog,
  verifyRegistryArtifacts,
} from './marketplace-catalog'
export { WorkspaceSettingsDialog } from './workspace-settings'
export { CapabilityCard, CapabilityList } from './capability-card'
export {
  capabilitiesNeedingAttention,
  capabilitySnapshotAge,
  presentCapability,
  presentCapabilityState,
  type CapabilityPresentation,
  type CapabilityTone,
} from './capability-status'
export { mergeTranscription } from './transcription'
export { canonicalNotificationHref, notificationPreview } from './notifications'
export { createBrowserSettingsProvider, normalizeWorkspacePreferences } from './preferences'
export type {
  CapabilityProvider,
  CapabilitySnapshot,
  CapabilityState,
  CapabilityStatus,
  PrivateContentResolver,
  TranscriptionProvider,
  TranscriptionSession,
  TranscriptionState,
  WorkspaceAppActivation,
  WorkspaceAppSurface,
  WorkspacePreferences,
  WorkspacePlatformServices,
  WorkspacePlugin,
  WorkspacePluginCategory,
  WorkspacePluginDefinition,
  WorkspacePluginsProvider,
  WorkspacePluginSurface,
  WorkspaceSettingsProvider,
  WorkspacePluginInstallationStatus,
  WorkspacePluginsProviderState,
} from './platform'
export { defaultWorkspacePreferences, workspaceAppActivation } from './platform'
