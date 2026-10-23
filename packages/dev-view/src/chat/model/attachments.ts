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
//   replays its decision instead of storing a second copy. Only a definite refusal ends the key.
//   A lost answer, a timeout, a malformed receipt or a failure after the host may have committed
//   is "not confirmed", never "not stored": the file is kept in the tray until it is resolved.
// - The host can commit and then fail its own binding check (a conversation that moved on while
//   the file was being stored). That answer proves nothing about the write, and the old
//   generation can no longer be asked, so the item becomes "unreconciled" and says so.
// - A removal that did not answer is retried by attachment id, which the host treats as the same
//   request; it is never worded as "not removed" unless the host definitely refused.
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
  let buffer: ArrayBuffer
  try {
    buffer = await file.arrayBuffer()
  } catch {
    return {
      ok: false,
      reason:
        'This file could not be read. It may have been moved, renamed or made unavailable. Choose it again.',
    }
  }
  const bytes = new Uint8Array(buffer)
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
  unsupported_capability: 'This host cannot store that file.',
  capability_unavailable: 'This host cannot store attachments right now.',
  capability_denied: 'You are not allowed to attach files to this conversation.',
  limit_exceeded: 'This conversation has reached the host’s limit for stored attachments.',
  idempotency_conflict:
    'The host already holds a different file for this attempt. Attach it again.',
  recovery_required: 'The host needs to recover before it can store attachments here.',
}

/**
 * What can be said when the host refused or failed, in its own terms. The fallback never states
 * an outcome: for a refusal it says only that the host refused, and for an unknown outcome it
 * says only that no usable answer arrived, so it cannot contradict what may have been committed.
 */
export function attachmentFailureText(
  code: DevError['code'] | undefined,
  hostMessage: string,
  outcome: 'refused' | 'unknown' = 'unknown'
) {
  return (
    (code ? FAILURE_TEXT[code] : undefined) ??
    (hostMessage ||
      (outcome === 'refused'
        ? 'The host refused the request.'
        : 'The host did not give a usable answer.'))
  )
}

/**
 * Refusals that prove the host did not store (or remove) the file and cannot change on retry:
 * the key is spent and the person starts over. Nothing else is definite. In particular,
 * `stale_generation` and `not_found` can come from the host's binding check after it committed,
 * and `identity_mismatch` can be this surface rejecting a receipt for a write that happened.
 */
const DEFINITE_FAILURES: readonly DevError['code'][] = [
  'unsupported_capability',
  'capability_unavailable',
  'capability_denied',
  'unauthorized',
  'invalid_state',
  'limit_exceeded',
  'idempotency_conflict',
]

/** Answers that mean the old generation can no longer be asked, so a retry cannot settle it. */
const UNRECONCILABLE: readonly DevError['code'][] = ['stale_generation', 'not_found']

/** A second receipt that does not match this conversation is not worth asking for a third time. */
const MISMATCH_ATTEMPTS = 2

const UNRECONCILED_UPLOAD_TEXT =
  'We cannot confirm whether the host stored this file, and it cannot be checked from this conversation. It may still be stored on this device.'
const UNRECONCILED_REMOVAL_TEXT =
  'We cannot confirm whether the host removed this file, and it cannot be checked from this conversation. It may still be stored on this device.'
const UNCONFIRMED_REMOVAL_TEXT =
  'We could not confirm whether the file was removed. Remove it again to check; removing twice is safe.'

function errorCode(error: unknown): DevError['code'] | undefined {
  if (error instanceof ChatRuntimeError) return error.code
  if (typeof error === 'object' && error !== null && 'code' in error)
    return (error as { code: DevError['code'] }).code
  return undefined
}

export type TrayItem = Readonly<{
  /** This surface's own id; the host id appears only once the host has stored the file. */
  id: string
  name: string
  byteLength: number
  /**
   * `failed`: the host definitely did not store it. `unconfirmed`: the host may have stored it;
   * it stays here, and Try again replays the same key. `unreconciled`: the host may have stored
   * (or removed) it and this conversation can no longer ask, so it can only be dismissed.
   * `removalUnconfirmed`: the file was stored and a removal may have committed but its answer
   * never arrived; it is not "stored" any more, and removing it again (the same id) is safe.
   */
  state:
    | 'uploading'
    | 'stored'
    | 'removing'
    | 'failed'
    | 'unconfirmed'
    | 'removalUnconfirmed'
    | 'unreconciled'
  attachmentId?: string
  /** Why, in words, for an item that is not plainly stored; or a failed removal of a stored one. */
  message?: string
  /** An unconfirmed item may be tried again under the same key. */
  retryable?: boolean
}>

export type AttachmentTrayView = Readonly<{ items: readonly TrayItem[] }>

export type AttachmentTray = Readonly<{
  view(): AttachmentTrayView
  subscribe(listener: (view: AttachmentTrayView) => void): () => void
  /** Checks the file and stages it. A file the host cannot take is refused here, in words. */
  add(file: AttachmentFile): Promise<{ ok: true } | { ok: false; reason: string }>
  retry(id: string): Promise<void>
  /**
   * Removes a stored file from the host. A failed or unreconciled item is only dismissed; an
   * unconfirmed upload cannot be dismissed, because that would drop the key that finds the file.
   */
  remove(id: string): Promise<void>
  /**
   * What this conversation could not settle, for the next generation of the same session to show
   * as unreconciled: uploads and removals whose outcome is unknown. Nothing definite is included.
   */
  unresolved(): readonly UnresolvedAttachment[]
  dispose(): void
}>

/** An attachment whose outcome the host never confirmed, carried across a generation switch. */
export type UnresolvedAttachment = Readonly<{
  name: string
  byteLength: number
  about: 'upload' | 'removal'
}>

export function createAttachmentTray(input: {
  port: AttachmentPort
  identity: AttachmentIdentity
  randomId?: () => string
  /** Outcomes the previous generation of this session could not settle; shown as unreconciled. */
  carried?: readonly UnresolvedAttachment[]
}): AttachmentTray {
  const randomId = input.randomId ?? (() => crypto.randomUUID())
  const listeners = new Set<(view: AttachmentTrayView) => void>()
  const keys = new Map<string, string>()
  const uploads = new Map<string, ChatAttachmentUpload>()
  const removalUncertain = new Set<string>()
  let items: TrayItem[] = (input.carried ?? []).map((entry) => {
    const id = randomId()
    if (entry.about === 'removal') removalUncertain.add(id)
    return {
      id,
      name: entry.name,
      byteLength: entry.byteLength,
      state: 'unreconciled',
      message: entry.about === 'removal' ? UNRECONCILED_REMOVAL_TEXT : UNRECONCILED_UPLOAD_TEXT,
    }
  })
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

  const mismatches = new Map<string, number>()
  // An upload whose outcome was ever unknown: the host may have committed it. Uncertainty only
  // ends with the host's own receipt (or a recovery that settles it), never with a later refusal.
  const possiblyStored = new Set<string>()
  const forget = (id: string) => {
    uploads.delete(id)
    keys.delete(id)
    mismatches.delete(id)
    possiblyStored.delete(id)
  }

  const send = async (id: string) => {
    const upload = uploads.get(id)
    const key = keys.get(id)
    if (!upload || !key) return
    patch(id, (item) => ({ ...withoutMessage(item), state: 'uploading' }))
    try {
      const attachment = await input.port.upload(input.identity, { upload, idempotencyKey: key })
      forget(id)
      patch(id, (item) => ({
        ...withoutMessage(item),
        state: 'stored',
        attachmentId: attachment.attachmentId,
      }))
    } catch (error) {
      const code = errorCode(error)
      const definite = code !== undefined && DEFINITE_FAILURES.includes(code)
      const reason = attachmentFailureText(
        code,
        error instanceof Error ? error.message : '',
        definite ? 'refused' : 'unknown'
      )
      if (definite && !possiblyStored.has(id)) {
        forget(id)
        patch(id, (item) => ({ ...withoutMessage(item), state: 'failed', message: reason }))
        return
      }
      possiblyStored.add(id)
      if (definite) {
        // A refusal of the retry says nothing about the attempt before it.
        patch(id, (item) => ({
          ...withoutMessage(item),
          state: 'unconfirmed',
          message: `${reason} That does not show the earlier attempt failed: we still could not confirm whether the file was stored, so trying again will not store it twice.`,
          retryable: true,
        }))
        return
      }
      const seen = code === 'identity_mismatch' ? (mismatches.get(id) ?? 0) + 1 : 0
      mismatches.set(id, seen)
      if ((code !== undefined && UNRECONCILABLE.includes(code)) || seen >= MISMATCH_ATTEMPTS) {
        // The attempt (name, bytes, key) stays in memory, but nothing can settle it: the old
        // generation is the only place the host would answer for it.
        patch(id, (item) => ({
          ...withoutMessage(item),
          state: 'unreconciled',
          message: UNRECONCILED_UPLOAD_TEXT,
        }))
        return
      }
      patch(id, (item) => ({
        ...withoutMessage(item),
        state: 'unconfirmed',
        message: `${reason} We could not confirm whether it was stored, so trying again will not store it twice.`,
        retryable: true,
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
      if (item?.state === 'unconfirmed' && item.retryable) await send(id)
    },
    async remove(id) {
      const item = items.find((candidate) => candidate.id === id)
      if (!item || item.state === 'uploading' || item.state === 'removing') return
      // Dropping an unconfirmed upload would drop the only key that can find the file.
      if (item.state === 'unconfirmed') return
      if (
        item.state === 'failed' ||
        item.state === 'unreconciled' ||
        item.attachmentId === undefined
      ) {
        forget(id)
        patch(id, () => undefined)
        return
      }
      const attachmentId = item.attachmentId
      // An earlier removal whose outcome was unknown stays possible whatever a retry answers.
      const earlierUnknown = removalUncertain.has(id)
      removalUncertain.add(id)
      patch(id, (current) => ({ ...withoutMessage(current), state: 'removing' }))
      try {
        await input.port.remove(input.identity, attachmentId)
        patch(id, () => undefined)
      } catch (error) {
        const code = errorCode(error)
        // `not_found` is either "no such file" or the host's binding check failing after the
        // removal committed; the two cannot be told apart, so neither is claimed.
        if (code !== undefined && UNRECONCILABLE.includes(code)) {
          patch(id, (current) => ({
            ...withoutMessage(current),
            state: 'unreconciled',
            message: UNRECONCILED_REMOVAL_TEXT,
          }))
          return
        }
        // Only a definite refusal of a first attempt is "not removed"; anything else may have
        // committed, and the host treats a repeated removal of the same id as the same request.
        const refused = code !== undefined && DEFINITE_FAILURES.includes(code)
        const reason = attachmentFailureText(
          code,
          error instanceof Error ? error.message : '',
          refused ? 'refused' : 'unknown'
        )
        if (refused && !earlierUnknown) {
          removalUncertain.delete(id)
          patch(id, (current) => ({
            ...withoutMessage(current),
            state: 'stored',
            message: `The file was not removed. ${reason}`,
          }))
          return
        }
        patch(id, (current) => ({
          ...withoutMessage(current),
          state: 'removalUnconfirmed',
          message: refused
            ? `${reason} That does not show the earlier removal failed. ${UNCONFIRMED_REMOVAL_TEXT}`
            : UNCONFIRMED_REMOVAL_TEXT,
        }))
      }
    },
    unresolved() {
      return items.flatMap((item): UnresolvedAttachment[] => {
        if (item.state === 'stored' || item.state === 'failed') return []
        return [
          {
            name: item.name,
            byteLength: item.byteLength,
            about:
              item.state === 'removing' ||
              item.state === 'removalUnconfirmed' ||
              removalUncertain.has(item.id)
                ? 'removal'
                : 'upload',
          },
        ]
      })
    },
    dispose() {
      disposed = true
      listeners.clear()
    },
  }
}

/**
 * Stages every file of a selection. One file that cannot be read or staged never stops the rest,
 * and what could not be attached comes back as words (never file contents), or `undefined`.
 */
export async function stageSelection(
  tray: Pick<AttachmentTray, 'add'>,
  files: readonly AttachmentFile[]
): Promise<string | undefined> {
  const refusals: string[] = []
  for (const file of files) {
    try {
      const result = await tray.add(file)
      if (!result.ok) refusals.push(`${file.name}: ${result.reason}`)
    } catch {
      refusals.push(`${file.name}: This file could not be attached.`)
    }
  }
  return refusals.length > 0 ? refusals.join(' ') : undefined
}

type TrayEntry = { generation: number; tray: AttachmentTray; subscribers: number }

/** The tray of each session's current generation, per port. */
const trays = new WeakMap<AttachmentPort, Map<string, TrayEntry>>()

/**
 * Finds or creates the tray of a session generation. The tray outlives the view that uses it, so
 * selecting another conversation and coming back, or remounting the surface, finds the same tray
 * with its upload keys, bytes and removal ids: an attempt stays resumable. Only a real generation
 * advance retires a tray, and what it could not settle is carried into the next generation as
 * unreconciled, because the old generation can no longer be asked. `release` is called when a
 * view is gone; a view that is gone has unsubscribed, so a late answer lands in the tray and never
 * in a stale view. A tray with nothing staged and no viewers is dropped.
 */
export function acquireAttachmentTray(
  port: AttachmentPort,
  identity: AttachmentIdentity
): { tray: AttachmentTray; release(): void } {
  const sessions = trays.get(port) ?? new Map<string, TrayEntry>()
  trays.set(port, sessions)
  const session = identity.runtimeSessionId
  let entry = sessions.get(session)
  if (!entry || entry.generation !== identity.generation) {
    const carried = entry?.tray.unresolved()
    entry?.tray.dispose()
    entry = {
      generation: identity.generation,
      tray: createAttachmentTray({ port, identity, carried }),
      subscribers: 0,
    }
    sessions.set(session, entry)
  }
  const held = entry
  held.subscribers += 1
  let released = false
  return {
    tray: held.tray,
    release() {
      if (released) return
      released = true
      held.subscribers -= 1
      if (
        held.subscribers === 0 &&
        held.tray.view().items.length === 0 &&
        sessions.get(session) === held
      ) {
        sessions.delete(session)
        held.tray.dispose()
      }
    },
  }
}
