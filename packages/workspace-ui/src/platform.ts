import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { WorkspaceMemoryEntry, WorkspaceMemorySnapshot } from '@adea-ai/types'
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import type {
  CredentialRef,
  HarnessAccountFamily,
  HarnessAccountProfile,
  WorkspaceConnections,
} from '@adea-ai/types/dev-runtime'

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
  /**
   * The glass appearance setting mirrored for the native window: only
   * `'frosted'` creates the desktop window see-through (macOS), and the
   * value applies on relaunch — Electrobun sets transparency at creation.
   */
  windowSurface: 'theme' | 'frosted' | 'opaque'
  version: 1
}>

/**
 * Local capability health as the shell reports it. Mirrors the native
 * `CapabilityState` taxonomy: a prerequisite is either satisfied, absent with a
 * hint, refused by the host, or did not answer in time.
 */
export type CapabilityState =
  | Readonly<{ state: 'ready' }>
  | Readonly<{ state: 'missing'; hint: string }>
  | Readonly<{ state: 'permissionDenied'; hint: string }>
  | Readonly<{ state: 'timedOut'; hint: string }>

export type CapabilityStatus = Readonly<{
  id: string
  title: string
  state: CapabilityState
}>

export type CapabilitySnapshot = Readonly<{
  capabilities: readonly CapabilityStatus[]
  servedFromCache: boolean
  ageMs: number
  reProbeFloorMs: number
}>

export type CapabilityProvider = Readonly<{
  snapshot(options?: Readonly<{ force?: boolean }>): Promise<CapabilitySnapshot>
}>

export const defaultWorkspacePreferences: WorkspacePreferences = Object.freeze({
  dictationLocale: '',
  notifyMentions: true,
  notifyTasks: true,
  privateNotificationPreviews: false,
  windowSurface: 'theme',
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

/**
 * App Library manifest for a plugin that presents an `app` surface. Only a
 * bundled first-party entry may activate in M12 (Dev Runtime spec,
 * "Appearance and App Library"); every other field is presentational or a
 * declaration of what activation would require later.
 */
export type WorkspaceAppSurface = Readonly<{
  /** The bundled first-party entry identifier. Absent for catalog-only apps. */
  bundledEntryId?: string
  supportedPlatforms: readonly string[]
  capabilities: readonly string[]
  /** Permissions activation would require; declarative in M12. */
  requestedPermissions: readonly string[]
  /** Whether and how the app contributes a global rail entry. */
  railContribution: 'none' | 'optional'
  settingsRoute?: string
  version?: string
  digest?: string
}>

/**
 * Activation authority for app surfaces lives in `./app-library`: trust
 * resolves through the compiled first-party entry registry, then verified
 * catalog/install-plan integrity. The names are re-exported here for
 * existing consumers; nothing may activate on a manifest-supplied
 * `bundledEntryId` alone.
 */
export {
  resolveAppActivation,
  trustedFirstPartyAppEntries,
  workspaceAppActivation,
  type TrustedFirstPartyEntry,
  type WorkspaceAppActivation,
} from './app-library'

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
  /** Present when one of the plugin's surfaces is `app`. */
  appSurface?: WorkspaceAppSurface
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
    /**
     * The Control Plane installation handle for the current release, when the
     * Control Plane reported one; required to uninstall.
     */
    installationId?: string
  }>

export type WorkspacePluginsProvider = Readonly<{
  list(): Promise<readonly WorkspacePlugin[]>
  requestInstall(pluginId: string): Promise<readonly WorkspacePlugin[]>
  /** Uninstalls the workspace's installation of a plugin; absent when unsupported. */
  requestUninstall?(pluginId: string): Promise<readonly WorkspacePlugin[]>
  getState?(): WorkspacePluginsProviderState
}>

export type WorkspacePluginsProviderState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'stale'
  | 'verification-failure'
  | 'unavailable'

/**
 * Workspace memory (ADR 0012): the desktop store's trusted command family for
 * the authorized workspace. Omitted on surfaces without a desktop shell, where
 * the Memory settings section renders its typed unavailable state.
 */
export type WorkspaceMemoryService = Readonly<{
  list(workspaceId: string): Promise<WorkspaceMemorySnapshot>
  create(input: Readonly<{ workspaceId: string; text: string }>): Promise<WorkspaceMemoryEntry>
  update(
    input: Readonly<{
      workspaceId: string
      entryId: string
      expectedRevision: number
      text: string
    }>
  ): Promise<WorkspaceMemoryEntry>
  remove(
    input: Readonly<{ workspaceId: string; entryId: string; expectedRevision: number }>
  ): Promise<void>
  acceptProposal(
    input: Readonly<{ workspaceId: string; entryId: string; expectedRevision: number }>
  ): Promise<WorkspaceMemoryEntry>
  rejectProposal(
    input: Readonly<{ workspaceId: string; entryId: string; expectedRevision: number }>
  ): Promise<void>
  setInjectionEnabled(input: Readonly<{ workspaceId: string; enabled: boolean }>): Promise<boolean>
}>

/**
 * Workspace connections (ADR 0012): the active workspace's git hosting and
 * harness account bindings on this device. Ids only — the service never
 * carries secret material. Errors reject with a typed `{ code, message }`
 * Dev Runtime error; a host without the Dev Runtime omits the service and the
 * settings pane renders a typed unavailable state.
 */
export type WorkspaceConnectionsSnapshot = Readonly<{
  connections: WorkspaceConnections
  profiles: readonly HarnessAccountProfile[]
  credentialRefs: readonly CredentialRef[]
}>

export type WorkspaceConnectionsService = Readonly<{
  load(): Promise<WorkspaceConnectionsSnapshot>
  setGitHosting(
    input: Readonly<{ host: string; credentialRefId: string | null; expectedVersion: number }>
  ): Promise<WorkspaceConnections>
  setHarnessAccount(
    input: Readonly<{
      harnessId: HarnessAccountFamily
      profileId: string | null
      expectedVersion: number
    }>
  ): Promise<WorkspaceConnections>
  createAccountProfile(
    input: Readonly<{ harnessId: HarnessAccountFamily; label: string; credentialRefId: string }>
  ): Promise<HarnessAccountProfile>
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
  capabilities?: CapabilityProvider
  /** Workspace connections; omitted where no Dev Runtime exists (web). */
  connections?: WorkspaceConnectionsService
  devRuntime?: DevRuntimeService
  /** Desktop-only workspace memory; omitted on the web. */
  memory?: WorkspaceMemoryService
  privateContent?: PrivateContentResolver
  plugins?: WorkspacePluginsProvider
  settings?: WorkspaceSettingsProvider
  transcription?: TranscriptionProvider
  /** The desktop update channel; omitted on surfaces with no update service
   * (the web app updates by refresh, not by channel). */
  updates?: UpdatesService
}>

/** The update channel an installation follows. 'stable' is the batch-soaked
 * feed, 'pre-release' the daily builds, 'dev' every build of main. Kept as a
 * local literal union: the shell owns the authoritative type and this package
 * does not import from the shell. */
export type UpdateChannelSetting = 'stable' | 'pre-release' | 'dev'

export type UpdatesService = Readonly<{
  channel(): Promise<UpdateChannelSetting>
  setChannel(channel: UpdateChannelSetting): Promise<UpdateChannelSetting>
}>
