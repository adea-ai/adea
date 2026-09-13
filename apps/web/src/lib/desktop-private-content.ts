import type {
  ApiContentRefCreateInput,
  ApiContentRefResponse,
  ApiContentRefUpdateInput,
} from '@adea-ai/api-client'

import {
  localContentAuthority,
  type LocalContentCreateInput,
  type LocalContentRef,
} from './desktop-local-content'

export type CloudContentRefAuthority = Readonly<{
  createContentRef(
    workspaceId: string,
    input: ApiContentRefCreateInput
  ): Promise<ApiContentRefResponse>
  updateContentRef(
    workspaceId: string,
    contentId: string,
    input: ApiContentRefUpdateInput
  ): Promise<ApiContentRefResponse>
}>

export type PrivateContentAuthority = Readonly<{
  create(input: LocalContentCreateInput): Promise<LocalContentRef>
  read(
    input: Readonly<{ contentId: string; workspaceId: string }>
  ): Promise<Readonly<{ contentRef: LocalContentRef; plaintext: string }>>
}>

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function persistPrivateContent(
  cloud: CloudContentRefAuthority,
  input: Omit<LocalContentCreateInput, 'contentId'> & Readonly<{ contentId: string }>,
  local: PrivateContentAuthority = localContentAuthority
) {
  const digestSha256 = await sha256(input.plaintext)
  await cloud.createContentRef(input.workspaceId, {
    availability: 'missing',
    contentType: input.contentType,
    digestSha256,
    id: input.contentId,
    keyVersion: 1,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    schemaVersion: 1,
    sensitivity: input.sensitivity,
    storagePolicy: input.storagePolicy,
    synchronizationPolicy: input.synchronizationPolicy,
    ...(input.taskId ? { taskId: input.taskId } : {}),
  })
  const localRef = await local.create(input)
  const { contentRef } = await cloud.updateContentRef(input.workspaceId, input.contentId, {
    availability: localRef.availability,
    digestSha256: localRef.digestSha256,
    expectedRevision: localRef.revision,
    keyVersion: localRef.keyVersion,
    revision: localRef.revision,
  })
  return Object.freeze({ cloud: contentRef, local: localRef })
}

export async function resolveFutureExecutionInput(
  workspaceId: string,
  contentId: string,
  local: PrivateContentAuthority = localContentAuthority
) {
  return (await local.read({ contentId, workspaceId })).plaintext
}
