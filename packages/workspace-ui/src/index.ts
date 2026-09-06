export { ConventionalWorkspaceShell } from "./conventional-workspace-shell";
export { WorkspaceViewToggle, type WorkspaceView } from "./workspace-view-toggle";
export { VirtualRoomControls } from "./virtual-room-controls";
export { VirtualUnavailable } from "./virtual-unavailable";
export { GlobalWorkspaceRail } from "./global-workspace-rail";
export { WorkspaceAboutDialog } from "./workspace-about-dialog";
export { PluginsDialog } from "./plugins-dialog";
export {
  createRegistryPluginsProvider,
  filterWorkspacePlugins,
  getPopularWorkspacePlugins,
  groupWorkspacePlugins,
  popularWorkspacePluginIds,
  workspacePluginCategoryOrder,
} from "./plugins";
export {
  canonicalDigest,
  canonicalJson,
  mapRegistryCatalog,
  MarketplaceCatalogError,
  parseCatalog,
  verifyRegistryArtifacts,
} from "./marketplace-catalog";
export { WorkspaceSettingsDialog } from "./workspace-settings";
export { mergeTranscription } from "./transcription";
export { canonicalNotificationHref, notificationPreview } from "./notifications";
export { createBrowserSettingsProvider, normalizeWorkspacePreferences } from "./preferences";
export type {
  PrivateContentResolver,
  TranscriptionProvider,
  TranscriptionSession,
  TranscriptionState,
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
} from "./platform";
export { defaultWorkspacePreferences } from "./platform";
