import { describe, expect, test } from 'bun:test'

import type { ChatAttachment, DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService } from '../src/platform'
import {
  ATTACHMENT_LIMIT_TEXT,
  ChatRuntimeError,
  createAttachmentPort,
  createAttachmentTray,
  prepareAttachment,
  type AttachmentFile,
  type AttachmentPort,
  type AttachmentTrayView,
} from '../src/chat/model'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const IDENTITY = { runtimeSessionId: 'session-1', generation: 4 }
const ATTACHMENT_ID = '00000000-0000-4000-8000-0000000000aa'
const stored: ChatAttachment = {
  attachmentId: ATTACHMENT_ID,
  mediaType: 'text/plain',
  byteLength: 5,
  state: 'available',
  runtimeSessionId: 'session-1',
  generation: 4,
  name: 'notes.txt',
  digestSha256: 'a'.repeat(64),
  createdAt: '2026-10-23T10:00:00.000Z',
}
const removed: ChatAttachment = {
  ...stored,
  state: 'removed',
  removedAt: '2026-10-23T10:01:00.000Z',
}
const reject = (code: string, message = code) =>
  new ChatRuntimeError({ code, retryable: false, message } as never)

function file(name: string, content: string | Uint8Array): AttachmentFile {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  return {
    name,
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
  }
}

function service(reply: (command: DevCommand) => unknown) {
  const commands: DevCommand[] = []
  const fake = {
    execute: async (command: DevCommand): Promise<DevReply> => {
      commands.push(command)
      const value = reply(command)
      return value instanceof ChatRuntimeError
        ? ({
            ok: false,
            error: { code: value.code, retryable: false, message: value.message },
          } as never)
        : ({ ok: true, value } as never)
    },
  } as unknown as DevRuntimeService
  return { fake, commands }
}

const reasons = async (candidate: AttachmentFile) => {
  const result = await prepareAttachment(candidate)
  return result.ok ? undefined : result.reason
}

describe('attachment preparation', () => {
  test('accepts only what the host accepts, and says why otherwise', async () => {
    const ok = await prepareAttachment(file('notes.txt', 'hello'))
    expect(ok.ok).toBe(true)
    expect(ok.ok && ok.upload).toEqual({
      name: 'notes.txt',
      mediaType: 'text/plain',
      contentBase64: btoa('hello'),
    })
    expect((await prepareAttachment(file('NOTES.MD', '# hi'))).ok).toBe(true)

    expect(await reasons(file('photo.png', 'x'))).toContain(ATTACHMENT_LIMIT_TEXT)
    expect(await reasons(file('empty.txt', ''))).toContain('empty')
    expect(await reasons(file('big.txt', 'x'.repeat(128 * 1024 + 1)))).toContain('128 KiB')
    expect(await reasons(file('bad.txt', new Uint8Array([0xff, 0xfe, 0x41])))).toContain('UTF-8')
    expect(await reasons(file('nul.txt', 'a\u0000b'))).toContain('control characters')
    expect(await reasons(file('../x.txt', 'a'))).toContain('file name')
    expect(await reasons(file('.hidden.txt', 'a'))).toContain('file name')
  })

  test('the largest accepted file is exactly the host limit', async () => {
    expect((await prepareAttachment(file('max.log', 'x'.repeat(128 * 1024)))).ok).toBe(true)
  })

  test('a file that changed size while it was read is refused', async () => {
    const result = await prepareAttachment({
      name: 'a.txt',
      size: 3,
      arrayBuffer: async () => new ArrayBuffer(0),
    })
    expect(result.ok).toBe(false)
  })
})

describe('attachment port', () => {
  test('uploads bound to the session generation under the key it was given', async () => {
    const { fake, commands } = service(() => stored)
    const upload = { name: 'notes.txt', mediaType: 'text/plain', contentBase64: btoa('hello') }
    const result = await createAttachmentPort(fake, SCOPE).upload(IDENTITY, {
      upload,
      idempotencyKey: 'attach-1',
    })
    expect(result.attachmentId).toBe(ATTACHMENT_ID)
    expect(commands[0]!.operation).toBe('dev.session.attachmentUpload')
    expect(commands[0]!.body).toEqual({
      runtimeSessionId: 'session-1',
      expectedGeneration: 4,
      upload,
    })
    expect(commands[0]!.idempotencyKey).toBe('attach-1')
    expect(commands[0]!.resource).toEqual({
      kind: 'runtime_session',
      id: 'session-1',
      generation: 4,
    })
  })

  test('removes by the host id', async () => {
    const { fake, commands } = service(() => removed)
    await createAttachmentPort(fake, SCOPE).remove(IDENTITY, ATTACHMENT_ID)
    expect(commands[0]!.operation).toBe('dev.session.attachmentRemove')
    expect(commands[0]!.body).toEqual({
      runtimeSessionId: 'session-1',
      expectedGeneration: 4,
      attachmentId: ATTACHMENT_ID,
    })
  })

  test('refuses an answer about another session, generation, state or attachment', async () => {
    const upload = { name: 'a.txt', mediaType: 'text/plain', contentBase64: btoa('hello') }
    for (const answer of [
      { ...stored, runtimeSessionId: 'other' },
      { ...stored, generation: 3 },
      removed,
    ]) {
      const { fake } = service(() => answer)
      await expect(
        createAttachmentPort(fake, SCOPE).upload(IDENTITY, { upload, idempotencyKey: 'k' })
      ).rejects.toThrow()
    }
    const { fake } = service(() => ({
      ...removed,
      attachmentId: '00000000-0000-4000-8000-0000000000bb',
    }))
    await expect(createAttachmentPort(fake, SCOPE).remove(IDENTITY, ATTACHMENT_ID)).rejects.toThrow(
      'another attachment'
    )
  })
})

function scripted(
  upload: Array<ChatAttachment | Error>,
  remove: Array<ChatAttachment | Error> = []
) {
  const uploads: Array<{ idempotencyKey: string; name: string }> = []
  const gates: Array<() => void> = []
  const port: AttachmentPort = {
    upload: async (_identity, input) => {
      uploads.push({ idempotencyKey: input.idempotencyKey, name: input.upload.name })
      const next = upload.shift()
      if (next === undefined) throw new Error('unscripted')
      if (next instanceof Error) throw next
      return next
    },
    remove: async () => {
      const next = remove.shift()
      if (next === undefined) throw new Error('unscripted')
      if (next instanceof Error) throw next
      return next
    },
  }
  let n = 0
  const tray = createAttachmentTray({ port, identity: IDENTITY, randomId: () => `id${++n}` })
  let latest: AttachmentTrayView = tray.view()
  tray.subscribe((view) => (latest = view))
  return { tray, uploads, gates, latest: () => latest }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('attachment tray', () => {
  test('a stored file carries the host id and nothing claims it was sent', async () => {
    const { tray, latest } = scripted([stored])
    expect(await tray.add(file('notes.txt', 'hello'))).toEqual({ ok: true })
    await settle()
    expect(latest().items).toEqual([
      {
        id: 'id1',
        name: 'notes.txt',
        byteLength: 5,
        state: 'stored',
        attachmentId: ATTACHMENT_ID,
      },
    ])
  })

  test('a refused file never reaches the host and is not staged', async () => {
    const { tray, uploads, latest } = scripted([])
    const result = await tray.add(file('photo.png', 'x'))
    expect(result.ok).toBe(false)
    expect(uploads).toHaveLength(0)
    expect(latest().items).toHaveLength(0)
  })

  test('a lost answer is retried under the same key; a definite refusal is not', async () => {
    const { tray, uploads, latest } = scripted([
      reject('timeout', 'The host did not answer.'),
      stored,
      reject('limit_exceeded'),
    ])
    await tray.add(file('notes.txt', 'hello'))
    await settle()
    const first = latest().items[0]!
    expect(first.state).toBe('failed')
    expect(first.retryable).toBe(true)
    expect(first.message).toContain('will not store it twice')
    await tray.retry('id1')
    expect(uploads[1]!.idempotencyKey).toBe(uploads[0]!.idempotencyKey)
    expect(latest().items[0]!.state).toBe('stored')

    await tray.add(file('more.txt', 'again'))
    await settle()
    const refused = latest().items[1]!
    expect(refused.state).toBe('failed')
    expect(refused.retryable).toBeUndefined()
    expect(refused.message).toContain('limit')
    await tray.retry(refused.id)
    expect(uploads).toHaveLength(3)
  })

  test('removing a stored file asks the host; a failed file is only dismissed', async () => {
    const { tray, latest } = scripted([stored, reject('limit_exceeded')], [removed])
    await tray.add(file('notes.txt', 'hello'))
    await settle()
    await tray.add(file('more.txt', 'again'))
    await settle()
    await tray.remove('id3')
    expect(latest().items.map((item) => item.name)).toEqual(['notes.txt'])
    await tray.remove('id1')
    expect(latest().items).toHaveLength(0)
  })

  test('a failed removal keeps the file and says so; a file the host no longer holds is dropped', async () => {
    const { tray, latest } = scripted(
      [stored, stored],
      [reject('capability_unavailable'), reject('not_found')]
    )
    await tray.add(file('notes.txt', 'hello'))
    await settle()
    await tray.remove('id1')
    const kept = latest().items[0]!
    expect(kept.state).toBe('stored')
    expect(kept.message).toContain('not removed')
    await tray.remove('id1')
    expect(latest().items).toHaveLength(0)
  })

  test('an answer that arrives after dispose changes nothing', async () => {
    let release!: (value: ChatAttachment) => void
    const port: AttachmentPort = {
      upload: () => new Promise((resolve) => (release = resolve)),
      remove: async () => removed,
    }
    const tray = createAttachmentTray({ port, identity: IDENTITY })
    const views: AttachmentTrayView[] = []
    tray.subscribe((view) => views.push(view))
    await tray.add(file('notes.txt', 'hello'))
    const before = views.length
    tray.dispose()
    release(stored)
    await settle()
    expect(views).toHaveLength(before)
    expect(tray.view().items[0]!.state).toBe('uploading')
    expect(await tray.add(file('later.txt', 'x'))).toEqual({
      ok: false,
      reason: 'This conversation is no longer open.',
    })
  })

  test('a file dismissed while its upload is unconfirmed cannot come back', async () => {
    let fail!: (error: Error) => void
    const port: AttachmentPort = {
      upload: () => new Promise((_resolve, rejectWith) => (fail = rejectWith)),
      remove: async () => removed,
    }
    const tray = createAttachmentTray({ port, identity: IDENTITY })
    await tray.add(file('notes.txt', 'hello'))
    // Not removable while storing.
    await tray.remove(tray.view().items[0]!.id)
    expect(tray.view().items).toHaveLength(1)
    fail(reject('timeout'))
    await settle()
    expect(tray.view().items[0]!.state).toBe('failed')
    await tray.remove(tray.view().items[0]!.id)
    expect(tray.view().items).toHaveLength(0)
  })
})
