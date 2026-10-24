// Local chat attachment DTOs. References carry no host path, bytes or filename.
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  exactKeys,
  fail,
  integerValue,
  literal,
  record,
  sha256Pattern,
  stringValue,
  timestamp,
  uuidPattern,
} from './dev-runtime-validation-internal'

export const chatAttachmentLimits = Object.freeze({
  maxBytes: 128 * 1024,
  maxBase64Chars: 174_764,
  maxNameChars: 128,
  maxRecordsPerScope: 256,
  maxLiveBytesPerScope: 16 * 1024 * 1024,
})
export const chatAttachmentMediaTypes = ['text/plain'] as const
export type ChatAttachmentUpload = Readonly<{
  name: string
  mediaType: string
  contentBase64: string
}>
export type ChatAttachmentReference = Readonly<{
  attachmentId: string
  mediaType: 'text/plain'
  byteLength: number
  state: 'available' | 'removed'
}>
export type ChatAttachment = ChatAttachmentReference &
  Readonly<{
    runtimeSessionId: string
    generation: number
    name: string
    digestSha256: string
    createdAt: string
    removedAt?: string
  }>
export type ChatAttachmentOpenResult = Readonly<{
  attachment: ChatAttachment
  contentBase64: string
  disposition: 'inert_text'
}>

function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}

function name(value: unknown, path: string): void {
  const text = stringValue(value, path, 1, chatAttachmentLimits.maxNameChars)
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(text) ||
    text.includes('..') ||
    /[. ]$/.test(text) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(text)
  )
    fail(path, 'expected a safe display filename')
}

export function decodeChatAttachmentBase64(
  value: unknown,
  path = 'attachment.contentBase64'
): string {
  const text = stringValue(value, path, 4, chatAttachmentLimits.maxBase64Chars)
  if (
    text.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  )
    fail(path, 'expected canonical base64')
  let binary: string
  try {
    binary = atob(text)
  } catch {
    fail(path, 'expected canonical base64')
  }
  if (btoa(binary) !== text || binary.length < 1 || binary.length > chatAttachmentLimits.maxBytes)
    fail(path, 'attachment byte limit or canonical base64 violated')
  return text
}

export function decodeChatAttachmentUpload(
  value: unknown,
  path = 'attachmentUpload'
): ChatAttachmentUpload {
  const item = record(value, path)
  exactKeys(item, ['name', 'mediaType', 'contentBase64'], [], path)
  name(item.name, `${path}.name`)
  const mediaType = stringValue(item.mediaType, `${path}.mediaType`, 3, 128)
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType))
    fail(`${path}.mediaType`, 'expected a canonical media type')
  decodeChatAttachmentBase64(item.contentBase64, `${path}.contentBase64`)
  return value as ChatAttachmentUpload
}

export function decodeChatAttachmentReference(
  value: unknown,
  path = 'attachmentReference'
): ChatAttachmentReference {
  const item = record(value, path)
  exactKeys(item, ['attachmentId', 'mediaType', 'byteLength', 'state'], [], path)
  if (!uuidPattern.test(stringValue(item.attachmentId, `${path}.attachmentId`)))
    fail(`${path}.attachmentId`, 'expected lowercase UUID')
  literal(item.mediaType, chatAttachmentMediaTypes, `${path}.mediaType`)
  integerValue(item.byteLength, `${path}.byteLength`, 1, chatAttachmentLimits.maxBytes)
  literal(item.state, ['available', 'removed'], `${path}.state`)
  return value as ChatAttachmentReference
}

export function decodeChatAttachment(value: unknown, path = 'attachment'): ChatAttachment {
  const item = record(value, path)
  exactKeys(
    item,
    [
      'attachmentId',
      'mediaType',
      'byteLength',
      'state',
      'runtimeSessionId',
      'generation',
      'name',
      'digestSha256',
      'createdAt',
    ],
    ['removedAt'],
    path
  )
  decodeChatAttachmentReference(
    {
      attachmentId: item.attachmentId,
      mediaType: item.mediaType,
      byteLength: item.byteLength,
      state: item.state,
    },
    path
  )
  stringValue(item.runtimeSessionId, `${path}.runtimeSessionId`, 1, 256)
  integerValue(item.generation, `${path}.generation`, 0)
  name(item.name, `${path}.name`)
  if (!sha256Pattern.test(stringValue(item.digestSha256, `${path}.digestSha256`)))
    fail(`${path}.digestSha256`, 'expected sha256')
  timestamp(item.createdAt, `${path}.createdAt`)
  if (item.state === 'removed') timestamp(item.removedAt, `${path}.removedAt`)
  else if (item.removedAt !== undefined)
    fail(`${path}.removedAt`, 'available attachment cannot be removed')
  return value as ChatAttachment
}

export function decodeChatAttachmentMutationResult(
  value: unknown,
  expectedState: ChatAttachmentReference['state']
): ChatAttachment {
  const attachment = decodeChatAttachment(value, 'reply.value')
  if (attachment.state !== expectedState) fail('reply.value.state', `expected ${expectedState}`)
  return attachment
}

export function decodeChatAttachmentOpenResult(value: unknown): ChatAttachmentOpenResult {
  const item = record(value, 'attachmentOpen')
  exactKeys(item, ['attachment', 'contentBase64', 'disposition'], [], 'attachmentOpen')
  const attachment = decodeChatAttachment(item.attachment)
  if (attachment.state !== 'available')
    fail('attachmentOpen.attachment.state', 'expected available')
  const content = decodeChatAttachmentBase64(item.contentBase64)
  const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0))
  if (bytes.length !== attachment.byteLength)
    fail('attachmentOpen.contentBase64', 'byte count mismatch')
  if (sha256Hex(bytes) !== attachment.digestSha256)
    fail('attachmentOpen.attachment.digestSha256', 'content digest mismatch')
  literal(item.disposition, ['inert_text'], 'attachmentOpen.disposition')
  return value as ChatAttachmentOpenResult
}

export function decodeChatAttachmentEventPayload(
  kind: 'attachment.added' | 'attachment.removed',
  value: unknown
): void {
  const item = record(value, 'event.payload')
  exactKeys(item, ['attachment'], [], 'event.payload')
  const attachment = decodeChatAttachmentReference(item.attachment, 'event.payload.attachment')
  if (attachment.state !== (kind === 'attachment.added' ? 'available' : 'removed'))
    fail('event.payload.attachment.state', 'does not match attachment event kind')
}
