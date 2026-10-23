// Staging a local text file for a conversation (`dev.session.attachmentUpload` / `attachmentRemove`).
//
// The host stores the file on this device and answers with an opaque id. That is all this
// module claims:
//
// - Nothing here says the assistant received, opened or understood a file. The host has no
//   contract yet for tying a stored file to a sent message, so the surface says "stored".
// - Only what the host accepts is offered: non-empty UTF-8 text, `.txt` `.log` `.md` or
//   `.json`, at most 128 KiB. A file outside that is refused here in words before any bytes
//   are sent; the host still rechecks everything.
// - An upload whose answer was lost is retried under the same idempotency key, so the host
//   replays its decision instead of storing a second copy. A definite answer ends the key.
// - The tray is this surface's own memory of what it staged in one session generation. It is
//   not a list of the host's records: the host has no list operation, and a new generation
//   starts an empty tray.
// - An answer that arrives after the tray was disposed, or for a file that was removed or
//   dismissed meanwhile, changes nothing.
import type {
  ChatAttachment,
  ChatAttachmentUpload,
  DevError,
  Scope,
} from '@adea-ai/types/dev-runtime'
import {
  chatAttachmentLimits,
  decodeChatAttachment,
  decodeChatAttachmentUpload,
} from '@adea-ai/types/dev-runtime'

import type { DevRuntimeService } from '../../platform'
import { buildConversationCommand, ChatRuntimeError, executeChatCommand } from './commands'

export type AttachmentIdentity = Readonly<{ runtimeSessionId: string; generation: number }>

export type AttachmentPort = Readonly<{
  upload(
    identity: AttachmentIdentity,
    input: Readonly<{ upload: ChatAttachmentUpload; idempotencyKey: string }>
  ): Promise<ChatAttachment>
  remove(identity: AttachmentIdentity, attachmentId: string): Promise<ChatAttachment>
}>

export type AttachmentPortOptions = Readonly<{
  now?: () => Date
  randomId?: () => string
}>

export const ATTACHMENT_EXTENSIONS = ['.txt', '.log', '.md', '.json'] as const

/** The limits the picker states before a file is chosen, in the host's own terms. */
export const ATTACHMENT_LIMIT_TEXT = `Text files only (${ATTACHMENT_EXTENSIONS.join(', ')}), up to ${
  chatAttachmentLimits.maxBytes / 1024
} KiB.`

/** What a stored file does and does not mean. Shown whenever the tray has a file in it. */
export const ATTACHMENT_STORED_TEXT =
  'Stored on this device only. The assistant does not receive attachments yet.'

/** The host envelope key: letters, digits, dot, underscore, colon or hyphen, 1-128 characters. */
function uploadKey(randomId: () => string): string {
  return `attach-${randomId()}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128)
}

const resource = (identity: AttachmentIdentity) => ({
  kind: 'runtime_session',
  id: identity.runtimeSessionId,
  generation: identity.generation,
})

export function createAttachmentPort(
  service: DevRuntimeService,
  scope: Scope,
  options: AttachmentPortOptions = {}
): AttachmentPort {
  const randomId = options.randomId ?? (() => crypto.randomUUID())
  return {
    async upload(identity, input) {
      const command = buildConversationCommand({
        operation: 'dev.session.attachmentUpload',
        scope,
        body: {
          runtimeSessionId: identity.runtimeSessionId,
          expectedGeneration: identity.generation,
          upload: input.upload,
        },
        resource: resource(identity),
        idempotencyKey: input.idempotencyKey,
        ...(options.now ? { now: options.now } : {}),
        randomId,
      })
      const attachment = decodeChatAttachment(await executeChatCommand<unknown>(service, command))
      assertBound(attachment, identity, 'available')
      return attachment
    },
    async remove(identity, attachmentId) {
      const command = buildConversationCommand({
        operation: 'dev.session.attachmentRemove',
        scope,
        body: {
          runtimeSessionId: identity.runtimeSessionId,
          expectedGeneration: identity.generation,
          attachmentId,
        },
        resource: resource(identity),
        ...(options.now ? { now: options.now } : {}),
        randomId,
      })
      const attachment = decodeChatAttachment(await executeChatCommand<unknown>(service, command))
      assertBound(attachment, identity, 'removed')
      if (attachment.attachmentId !== attachmentId)
        throw new ChatRuntimeError({
          code: 'identity_mismatch',
          retryable: false,
          message: 'The host answered for another attachment.',
        })
      return attachment
    },
  }
}

/** An answer about another session or generation, or in another state, is not this operation's. */
function assertBound(
  attachment: ChatAttachment,
  identity: AttachmentIdentity,
  state: ChatAttachment['state']
): void {
  if (
    attachment.runtimeSessionId !== identity.runtimeSessionId ||
    attachment.generation !== identity.generation ||
    attachment.state !== state
  )
    throw new ChatRuntimeError({
      code: 'identity_mismatch',
      retryable: false,
      message: 'The host answered for another session, generation or state.',
    })
}

export type AttachmentFile = Readonly<{
  name: string
  size: number
  arrayBuffer(): Promise<ArrayBuffer>
}>

export type PreparedAttachment =
  | Readonly<{ ok: true; upload: ChatAttachmentUpload; byteLength: number }>
  | Readonly<{ ok: false; reason: string }>

function hasForbiddenCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0)
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159))
      return true
  }
  return false
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

/**
 * Checks a chosen file against what the host accepts and, when it fits, encodes it for
 * upload. A refusal is a sentence the person can act on and never includes file content.
 */
export async function prepareAttachment(file: AttachmentFile): Promise<PreparedAttachment> {
  const lower = file.name.toLowerCase()
  if (!ATTACHMENT_EXTENSIONS.some((extension) => lower.endsWith(extension)))
    return { ok: false, reason: `Only text files can be attached. ${ATTACHMENT_LIMIT_TEXT}` }
  if (file.size < 1) return { ok: false, reason: 'This file is empty.' }
  if (file.size > chatAttachmentLimits.maxBytes)
    return {
      ok: false,
      reason: `This file is larger than ${chatAttachmentLimits.maxBytes / 1024} KiB.`,
    }
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length < 1 || bytes.length > chatAttachmentLimits.maxBytes)
    return { ok: false, reason: 'This file changed while it was being read.' }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, reason: 'This file is not valid UTF-8 text.' }
  }
  if (hasForbiddenCharacter(text))
    return { ok: false, reason: 'This file contains control characters, so it is not plain text.' }
  const upload: ChatAttachmentUpload = {
    name: file.name,
    mediaType: 'text/plain',
    contentBase64: base64(bytes),
  }
  try {
    decodeChatAttachmentUpload(upload)
  } catch {
    return {
      ok: false,
      reason:
        'This file name cannot be used. Use letters, digits, dot, space, underscore or hyphen, starting with a letter or digit.',
    }
  }
  return { ok: true, upload, byteLength: bytes.length }
}

const FAILURE_TEXT: Partial<Record<DevError['code'], string>> = {
  stale_generation:
    'This conversation moved on while the file was being stored. Open it again and attach the file once more.',
  unsupported_capability: 'This host cannot store that file.',
  capability_unavailable: 'This host cannot store attachments right now.',
  capability_denied: 'You are not allowed to attach files to this conversation.',
  limit_exceeded: 'This conversation has reached the host’s limit for stored attachments.',
  idempotency_conflict:
    'The host already holds a different file for this attempt. Attach it again.',
  recovery_required: 'The host needs to recover before it can store attachments here.',
}

/** What can be said when the host refused or failed, in its own terms and never as stored. */
export function attachmentFailureText(code: DevError['code'] | undefined, hostMessage: string) {
  return (code ? FAILURE_TEXT[code] : undefined) ?? (hostMessage || 'The file was not stored.')
}

/** Refusals that cannot change on retry: the key is spent and the person starts over. */
const DEFINITE_FAILURES: readonly DevError['code'][] = [
  'stale_generation',
  'unsupported_capability',
  'capability_unavailable',
  'capability_denied',
  'unauthorized',
  'not_found',
  'invalid_state',
  'limit_exceeded',
  'idempotency_conflict',
  'identity_mismatch',
]

export type TrayItem = Readonly<{
  /** This surface's own id; the host id appears only once the host has stored the file. */
  id: string
  name: string
  byteLength: number
  state: 'uploading' | 'stored' | 'removing' | 'failed'
  attachmentId?: string
  /** For a failed item: why, in words. For a stored one: a failed removal, if any. */
  message?: string
  /** A failed item whose outcome is unknown may be tried again under the same key. */
  retryable?: boolean
}>

export type AttachmentTrayView = Readonly<{ items: readonly TrayItem[] }>

export type AttachmentTray = Readonly<{
  view(): AttachmentTrayView
  subscribe(listener: (view: AttachmentTrayView) => void): () => void
  /** Checks the file and stages it. A file the host cannot take is refused here, in words. */
  add(file: AttachmentFile): Promise<{ ok: true } | { ok: false; reason: string }>
  retry(id: string): Promise<void>
  /** Removes a stored file from the host; a failed or unconfirmed item is only dismissed. */
  remove(id: string): Promise<void>
  dispose(): void
}>

export function createAttachmentTray(input: {
  port: AttachmentPort
  identity: AttachmentIdentity
  randomId?: () => string
}): AttachmentTray {
  const randomId = input.randomId ?? (() => crypto.randomUUID())
  const listeners = new Set<(view: AttachmentTrayView) => void>()
  const keys = new Map<string, string>()
  const uploads = new Map<string, ChatAttachmentUpload>()
  let items: TrayItem[] = []
  let disposed = false

  const view = (): AttachmentTrayView => ({ items })
  const publish = (next: TrayItem[]) => {
    items = next
    for (const listener of listeners) listener(view())
  }
  const patch = (id: string, change: (item: TrayItem) => TrayItem | undefined) => {
    if (disposed || !items.some((item) => item.id === id)) return
    publish(
      items.flatMap((item) => {
        if (item.id !== id) return [item]
        const next = change(item)
        return next ? [next] : []
      })
    )
  }
  const withoutMessage = (item: TrayItem): TrayItem => {
    const { message: _message, retryable: _retryable, ...rest } = item
    return rest
  }

  const send = async (id: string) => {
    const upload = uploads.get(id)
    const key = keys.get(id)
    if (!upload || !key) return
    patch(id, (item) => ({ ...withoutMessage(item), state: 'uploading' }))
    try {
      const attachment = await input.port.upload(input.identity, { upload, idempotencyKey: key })
      uploads.delete(id)
      keys.delete(id)
      patch(id, (item) => ({
        ...withoutMessage(item),
        state: 'stored',
        attachmentId: attachment.attachmentId,
      }))
    } catch (error) {
      const code =
        error instanceof ChatRuntimeError
          ? error.code
          : typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code: DevError['code'] }).code
            : undefined
      const definite = code !== undefined && DEFINITE_FAILURES.includes(code)
      if (definite) {
        uploads.delete(id)
        keys.delete(id)
      }
      patch(id, (item) => ({
        ...withoutMessage(item),
        state: 'failed',
        message: `${attachmentFailureText(code, error instanceof Error ? error.message : '')}${
          definite ? '' : ' Trying again will not store it twice.'
        }`,
        ...(definite ? {} : { retryable: true }),
      }))
    }
  }

  return {
    view,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async add(file) {
      if (disposed) return { ok: false, reason: 'This conversation is no longer open.' }
      const prepared = await prepareAttachment(file)
      if (!prepared.ok) return prepared
      if (disposed) return { ok: false, reason: 'This conversation is no longer open.' }
      const id = randomId()
      uploads.set(id, prepared.upload)
      keys.set(id, uploadKey(randomId))
      publish([
        ...items,
        { id, name: file.name, byteLength: prepared.byteLength, state: 'uploading' },
      ])
      void send(id)
      return { ok: true }
    },
    async retry(id) {
      const item = items.find((candidate) => candidate.id === id)
      if (item?.state === 'failed' && item.retryable) await send(id)
    },
    async remove(id) {
      const item = items.find((candidate) => candidate.id === id)
      if (!item || item.state === 'uploading' || item.state === 'removing') return
      if (item.state === 'failed' || item.attachmentId === undefined) {
        uploads.delete(id)
        keys.delete(id)
        patch(id, () => undefined)
        return
      }
      const attachmentId = item.attachmentId
      patch(id, (current) => ({ ...withoutMessage(current), state: 'removing' }))
      try {
        await input.port.remove(input.identity, attachmentId)
        patch(id, () => undefined)
      } catch (error) {
        const code =
          error instanceof ChatRuntimeError
            ? error.code
            : typeof error === 'object' && error !== null && 'code' in error
              ? (error as { code: DevError['code'] }).code
              : undefined
        // An answer for a file the host no longer holds ends it here.
        if (code === 'not_found') {
          patch(id, () => undefined)
          return
        }
        patch(id, (current) => ({
          ...withoutMessage(current),
          state: 'stored',
          message: `The file was not removed. ${attachmentFailureText(code, error instanceof Error ? error.message : '')}`,
        }))
      }
    },
    dispose() {
      disposed = true
      listeners.clear()
    },
  }
}
