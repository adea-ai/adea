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
  settings?: WorkspaceSettingsProvider
  transcription?: TranscriptionProvider
}>
