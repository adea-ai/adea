import type { AgentHqApiClient } from '@adea-ai/api-client'

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
  | 'cancelled'
  | 'error'
  | 'idle'
  | 'listening'
  | 'processing'
  | 'unavailable'

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
  | (string & {})

export type WorkspacePluginSurface = 'agent' | 'app' | 'command' | 'hook' | 'mcp' | 'skill'

export type WorkspacePluginDefinition = Readonly<{
  auth: 'api-key' | 'oauth' | 'workspace'
  authenticationPolicy?: 'on-install' | 'on-use'
  category: WorkspacePluginCategory
  categories?: readonly string[]
  capabilities: readonly string[]
  description: string
  iconKey: string
  iconUrl?: string
  id: string
  installationPolicy?: 'available' | 'installed-by-default' | 'not-available'
  kind: 'connector' | 'skill'
  license?: string
  licenseMetadata?: Readonly<Record<string, unknown>>
  name: string
  ownership: 'public' | 'team'
  publisher: string
  source: string
  sourceId?: string
  sourceRevision?: string
  sourceUrl?: string
  surfaces: readonly WorkspacePluginSurface[]
  pluginId?: string
  releaseId?: string
  canonicalContentDigest?: string
  productGroupingKey?: string
  authors?: readonly string[]
  homepage?: string
  icons?: readonly string[]
  keywords?: readonly string[]
  harnessCompatibility?: Readonly<Record<string, unknown>>
  securityClassification?: Readonly<Record<string, unknown>>
  requiredConnectors?: readonly string[]
  requiredCredentials?: readonly string[]
  provenance?: Readonly<Record<string, unknown>>
  updateMetadata?: Readonly<Record<string, unknown>>
  /** Agent Plugins normalization status; this is descriptive, not activation authority. */
  agentPluginsStatus?: 'portable' | 'partial' | 'unavailable'
  packageDigest?: string
  installationPlan?: Readonly<{
    planVersion: 2
    strategy: 'native-agent-plugin' | 'component-adapter' | 'unavailable'
    compatibility: 'full' | 'partial' | 'unsupported'
    allowedToActivate: false
    approvalRequired: true
  }>
  contentResolution?: 'complete' | 'metadata-only'
}>

export type WorkspacePluginInstallationStatus =
  | 'available'
  | 'pending-authorization'
  | 'unavailable'
  | 'rejected-by-policy'
  | 'installed'
  | 'superseded'

export type WorkspacePlugin = WorkspacePluginDefinition &
  Readonly<{
    installed: boolean
    installationStatus: WorkspacePluginInstallationStatus
  }>

export type WorkspacePluginsProvider = Readonly<{
  list(): Promise<readonly WorkspacePlugin[]>
  requestInstall(pluginId: string): Promise<readonly WorkspacePlugin[]>
  getState?(): WorkspacePluginsProviderState
}>

export type WorkspacePluginsProviderState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'stale'
  | 'verification-failure'
  | 'unavailable'

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
