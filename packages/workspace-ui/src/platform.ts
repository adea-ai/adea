import type { AgentHqApiClient } from '@agent-hq/api-client'

export type PrivateContentResolver = Readonly<{
  health?(
    workspaceId: string
  ): Promise<
    Readonly<{ available: boolean; currentKeyVersion: number; rotationInProgress: boolean }>
  >
  read(input: Readonly<{ contentId: string; workspaceId: string }>): Promise<
    Readonly<{
      plaintext: string
    }>
  >
  search?(input: Readonly<{ limit?: number; query: string; workspaceId: string }>): Promise<
    readonly Readonly<{
      contentId: string
      contentType: 'message_body' | 'private_field' | 'task_input' | 'task_objective'
      messageId?: string
      snippet: string
      taskId?: string
    }>[]
  >
}>

export type TranscriptionState =
  'cancelled' | 'error' | 'idle' | 'listening' | 'processing' | 'unavailable'

export type TranscriptionSession = Readonly<{
  cancel(): void
  completion: Promise<Readonly<{ text: string }>>
}>

export type TranscriptionProvider = Readonly<{
  id: string
  label: string
  requestPermission(): Promise<'denied' | 'granted' | 'prompt' | 'unavailable'>
  start(input?: Readonly<{ locale?: string }>): Promise<TranscriptionSession>
}>

export type WorkspacePreferences = Readonly<{
  dictationLocale: string
  notifyMentions: boolean
  notifyTasks: boolean
  privateNotificationPreviews: boolean
  version: 1
}>

export const defaultWorkspacePreferences: WorkspacePreferences = Object.freeze({
  dictationLocale: '',
  notifyMentions: true,
  notifyTasks: true,
  privateNotificationPreviews: false,
  version: 1,
})

export type WorkspaceSettingsProvider = Readonly<{
  load(): Promise<WorkspacePreferences>
  save(preferences: WorkspacePreferences): Promise<WorkspacePreferences>
}>

export type WorkspacePluginCategory =
  | 'Business & Operations'
  | 'Communication'
  | 'Creativity'
  | 'Data & Analytics'
  | 'Developer Tools'
  | 'Education & Research'
  | 'Finance'
  | 'Productivity'
  | 'Scientific Research'
  | 'Security'

export type WorkspacePluginSurface = 'agent' | 'app' | 'command' | 'hook' | 'mcp' | 'skill'

export type WorkspacePluginDefinition = Readonly<{
  auth: 'api-key' | 'oauth' | 'workspace'
  authenticationPolicy?: 'on-install' | 'on-use'
  category: WorkspacePluginCategory
  capabilities: readonly string[]
  description: string
  iconKey: string
  id: string
  installationPolicy?: 'available' | 'installed-by-default' | 'not-available'
  kind: 'connector' | 'skill'
  license?: string
  name: string
  ownership: 'public' | 'team'
  publisher: string
  source: 'agent-hq' | 'codex-official' | 'open-grok'
  sourceRevision?: string
  sourceUrl?: string
  surfaces: readonly WorkspacePluginSurface[]
}>

export type WorkspacePlugin = WorkspacePluginDefinition & Readonly<{ installed: boolean }>

export type WorkspacePluginsProvider = Readonly<{
  list(): Promise<readonly WorkspacePlugin[]>
  setInstalled(pluginId: string, installed: boolean): Promise<readonly WorkspacePlugin[]>
}>

export type WorkspacePlatformServices = Readonly<{
  account?: Readonly<{
    authenticated?: boolean
    busy?: boolean
    label?: string
    onSignIn(): void
    onSignOut(): void | Promise<void>
  }>
  app?: Readonly<{
    name: string
    platform: 'desktop' | 'web'
    version?: string
  }>
  client?: AgentHqApiClient
  privateContent?: PrivateContentResolver
  plugins?: WorkspacePluginsProvider
  settings?: WorkspaceSettingsProvider
  transcription?: TranscriptionProvider
}>
