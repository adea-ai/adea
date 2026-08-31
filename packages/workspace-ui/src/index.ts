export { ConventionalWorkspaceShell } from './conventional-workspace-shell'
export { WorkspaceViewToggle, type WorkspaceView } from './workspace-view-toggle'
export { VirtualRoomControls } from './virtual-room-controls'
export { GlobalWorkspaceRail } from './global-workspace-rail'
export { PluginsDialog } from './plugins-dialog'
export {
  createBrowserPluginsProvider,
  filterWorkspacePlugins,
  getPopularWorkspacePlugins,
  groupWorkspacePlugins,
  popularWorkspacePluginIds,
  workspacePluginCategoryOrder,
} from './plugins'
export { WorkspaceSettingsDialog } from './workspace-settings'
export { mergeTranscription } from './transcription'
export { canonicalNotificationHref, notificationPreview } from './notifications'
export { createBrowserSettingsProvider, normalizeWorkspacePreferences } from './preferences'
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
} from './platform'
export { defaultWorkspacePreferences } from './platform'
