import { invoke } from './platform/bridge'

export type LocalContentType = 'message_body' | 'private_field' | 'task_input' | 'task_objective'

export type LocalContentRef = Readonly<{
  id: string
  workspaceId: string
  contentType: LocalContentType
  taskId?: string
  messageId?: string
  revision: number
  digestSha256: string
  sensitivity: 'restricted' | 'sensitive'
  storagePolicy: 'local_authority'
  synchronizationPolicy: 'e2e_optional' | 'local_only'
  availability: 'available' | 'deleted' | 'missing' | 'offline'
  schemaVersion: number
  keyVersion: number
  createdAt: string
  updatedAt: string
  deletedAt?: string
}>

export type LocalContentCreateInput = Readonly<{
  contentId?: string
  workspaceId: string
  contentType: LocalContentType
  taskId?: string
  messageId?: string
  plaintext: string
  sensitivity: LocalContentRef['sensitivity']
  storagePolicy: LocalContentRef['storagePolicy']
  synchronizationPolicy: LocalContentRef['synchronizationPolicy']
}>

export type LocalContentSearchResult = Readonly<{
  contentId: string
  contentType: LocalContentType
  messageId?: string
  taskId?: string
  snippet: string
}>

export const localContentAuthority = Object.freeze({
  authorizeWorkspace(workspaceId: string) {
    return invoke<void>('local_content_authorize_workspace', { workspaceId })
  },
  create(input: LocalContentCreateInput) {
    return invoke<LocalContentRef>('local_content_create', { input })
  },
  read(input: Readonly<{ contentId: string; workspaceId: string }>) {
    return invoke<Readonly<{ contentRef: LocalContentRef; plaintext: string }>>(
      'local_content_read',
      { input }
    )
  },
  search(input: Readonly<{ limit?: number; query: string; workspaceId: string }>) {
    return invoke<readonly LocalContentSearchResult[]>('local_content_search', { input })
  },
  update(
    input: Readonly<{
      contentId: string
      expectedRevision: number
      plaintext: string
      workspaceId: string
    }>
  ) {
    return invoke<LocalContentRef>('local_content_update', { input })
  },
  delete(input: Readonly<{ contentId: string; expectedRevision: number; workspaceId: string }>) {
    return invoke<LocalContentRef>('local_content_delete', { input })
  },
  health(workspaceId: string) {
    return invoke<
      Readonly<{ available: boolean; currentKeyVersion: number; rotationInProgress: boolean }>
    >('local_content_health', { workspaceId })
  },
  rotateKey(workspaceId: string, batchSize = 100) {
    return invoke<
      Readonly<{ complete: boolean; currentKeyVersion: number; migratedRecords: number }>
    >('local_content_rotate_key', { batchSize, workspaceId })
  },
})
