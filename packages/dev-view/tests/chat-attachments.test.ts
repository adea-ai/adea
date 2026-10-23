import { describe, expect, test } from 'bun:test'

import type { ChatAttachment, DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService } from '../src/platform'
import {
  acquireAttachmentTray,
  ATTACHMENT_LIMIT_TEXT,
  attachmentFailureText,
  ChatRuntimeError,
  createAttachmentPort,
  createAttachmentTray,
  prepareAttachment,
  stageSelection,
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

  test('a lost answer is unconfirmed and retried under the same key; a definite refusal is not', async () => {
    const { tray, uploads, latest } = scripted([
      reject('timeout', 'The host did not answer.'),
      stored,
      reject('limit_exceeded'),
    ])
    await tray.add(file('notes.txt', 'hello'))
    await settle()
    const first = latest().items[0]!
    expect(first.state).toBe('unconfirmed')
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

  test('a reply lost after the host committed is found again under the same key, once', async () => {
    const { tray, uploads, latest } = scripted([reject('timeout'), reject('timeout'), stored])
    await tray.add(file('notes.txt', 'hello'))
    await settle()
    await tray.retry('id1')
    expect(latest().items[0]!.state).toBe('unconfirmed')
    await tray.retry('id1')
    expect(latest().items.map((item) => item.state)).toEqual(['stored'])
    expect(new Set(uploads.map((upload) => upload.idempotencyKey)).size).toBe(1)
    expect(uploads).toHaveLength(3)
  })

  test('an unconfirmed upload cannot be dismissed, because that would drop the key', async () => {
    const { tray, latest } = scripted([reject('timeout'), stored])
    await tray.add(file('notes.txt', 'hello'))
    await settle()
    await tray.remove('id1')
    expect(latest().items.map((item) => item.state)).toEqual(['unconfirmed'])
    await tray.retry('id1')
    expect(latest().items.map((item) => item.state)).toEqual(['stored'])
  })

  test('a post-commit stale_generation or not_found is unreconciled, never "not stored"', async () => {
    for (const code of ['stale_generation', 'not_found']) {
      const { tray, uploads, latest } = scripted([reject(code)])
      await tray.add(file('notes.txt', 'hello'))
      await settle()
      const item = latest().items[0]!
      expect(item.state).toBe('unreconciled')
      expect(item.retryable).toBeUndefined()
      expect(item.message).toContain('cannot confirm whether the host stored')
      expect(item.message).not.toContain('not stored')
      // Retrying cannot settle it, so it is not offered, and nothing is sent.
      await tray.retry('id1')
      expect(uploads).toHaveLength(1)
      // It can be dismissed, in words that said it may still be stored.
      await tray.remove('id1')
      expect(latest().items).toHaveLength(0)
    }
  })

  test('a receipt that does not match is asked for once more, then unreconciled', async () => {
    const { tray, uploads, latest } = scripted([
      reject('identity_mismatch'),
      reject('identity_mismatch'),
    ])
    await tray.add(file('notes.txt', 'hello'))
    await settle()
    expect(latest().items[0]!.state).toBe('unconfirmed')
    await tray.retry('id1')
    expect(latest().items[0]!.state).toBe('unreconciled')
    expect(uploads[1]!.idempotencyKey).toBe(uploads[0]!.idempotencyKey)
  })

  test('a malformed receipt from the port is never shown as stored', async () => {
    const real = createAttachmentPort(service(() => ({ ...stored, generation: 3 })).fake, SCOPE)
    const tray = createAttachmentTray({ port: real, identity: IDENTITY, randomId: () => 'x' })
    await tray.add(file('notes.txt', 'hello'))
    await settle()
    expect(tray.view().items[0]!.state).toBe('unconfirmed')
    expect(tray.view().items[0]!.attachmentId).toBeUndefined()
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

  test('a refused removal says "not removed"; a lost one does not claim it', async () => {
    const { tray, latest } = scripted(
      [stored],
      [reject('capability_unavailable'), reject('timeout'), removed]
    )
    await tray.add(file('notes.txt', 'hello'))
    await settle()
    await tray.remove('id1')
    const refused = latest().items[0]!
    expect(refused.state).toBe('stored')
    expect(refused.message).toContain('not removed')
    await tray.remove('id1')
    const unknown = latest().items[0]!
    expect(unknown.state).toBe('stored')
    expect(unknown.message).not.toContain('not removed')
    expect(unknown.message).toContain('could not confirm')
    expect(unknown.attachmentId).toBe(ATTACHMENT_ID)
    // The same removal is simply asked again, and the host answers it as the same request.
    await tray.remove('id1')
    expect(latest().items).toHaveLength(0)
  })

  test('a removal the old generation can no longer answer is unreconciled', async () => {
    for (const code of ['stale_generation', 'not_found']) {
      const { tray, latest } = scripted([stored], [reject(code)])
      await tray.add(file('notes.txt', 'hello'))
      await settle()
      await tray.remove('id1')
      const item = latest().items[0]!
      expect(item.state).toBe('unreconciled')
      expect(item.message).toContain('cannot confirm whether the host removed')
      await tray.remove('id1')
      expect(latest().items).toHaveLength(0)
    }
  })

  test('a file that cannot be read is refused in words, with no contents and no throw', async () => {
    const unreadable: AttachmentFile = {
      name: 'gone.txt',
      size: 4,
      arrayBuffer: async () => {
        throw new Error('NotReadableError: secret-contents')
      },
    }
    const result = await prepareAttachment(unreadable)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('could not be read')
    expect(!result.ok && result.reason).not.toContain('secret')
    const { tray, uploads, latest } = scripted([])
    expect((await tray.add(unreadable)).ok).toBe(false)
    expect(uploads).toHaveLength(0)
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

  test('a file cannot be dismissed while it is storing, and one that lost its answer stays', async () => {
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
    expect(tray.view().items[0]!.state).toBe('unconfirmed')
    await tray.remove(tray.view().items[0]!.id)
    expect(tray.view().items).toHaveLength(1)
  })
})

describe('attachments across a generation switch', () => {
  test('only what the host never confirmed is carried, and it arrives unreconciled', async () => {
    const hold = new Promise<ChatAttachment>(() => {})
    let call = 0
    const port: AttachmentPort = {
      upload: async () => {
        call += 1
        if (call === 1) return stored
        if (call === 2) throw reject('limit_exceeded')
        if (call === 3) throw reject('timeout')
        return hold
      },
      remove: async () => {
        throw reject('timeout')
      },
    }
    let n = 0
    const tray = createAttachmentTray({ port, identity: IDENTITY, randomId: () => `id${++n}` })
    await tray.add(file('kept.txt', 'hello'))
    await settle()
    await tray.add(file('refused.txt', 'x'))
    await settle()
    await tray.add(file('lost.txt', 'x'))
    await settle()
    await tray.add(file('inflight.txt', 'x'))
    await settle()
    await tray.remove('id1')
    await settle()
    expect(tray.unresolved().map((entry) => [entry.name, entry.about])).toEqual([
      ['kept.txt', 'removal'],
      ['lost.txt', 'upload'],
      ['inflight.txt', 'upload'],
    ])

    const next = createAttachmentTray({
      port,
      identity: { runtimeSessionId: 'session-1', generation: 5 },
      carried: tray.unresolved(),
    })
    const items = next.view().items
    expect(items.map((item) => [item.name, item.state])).toEqual([
      ['kept.txt', 'unreconciled'],
      ['lost.txt', 'unreconciled'],
      ['inflight.txt', 'unreconciled'],
    ])
    expect(items[0]!.message).toContain('whether the host removed')
    expect(items[1]!.message).toContain('whether the host stored')
    // They can be dismissed, and a dismissed one is not carried again.
    await next.remove(items[0]!.id)
    expect(next.unresolved().map((entry) => entry.name)).toEqual(['lost.txt', 'inflight.txt'])
  })

  test('a removal the host answered definitively is not carried', async () => {
    const port: AttachmentPort = {
      upload: async () => stored,
      remove: async () => {
        throw reject('capability_unavailable')
      },
    }
    const tray = createAttachmentTray({ port, identity: IDENTITY, randomId: () => 'id' })
    await tray.add(file('kept.txt', 'hello'))
    await settle()
    await tray.remove('id')
    expect(tray.view().items[0]!.state).toBe('stored')
    expect(tray.unresolved()).toEqual([])
  })
})

const lostThenStored = () => {
  const uploads: string[] = []
  let call = 0
  const port: AttachmentPort = {
    upload: async (_identity, input) => {
      uploads.push(input.idempotencyKey)
      call += 1
      if (call === 1) throw reject('timeout')
      return stored
    },
    remove: async () => removed,
  }
  return { port, uploads }
}
const at = (generation: number, runtimeSessionId = 'session-1') => ({
  runtimeSessionId,
  generation,
})

describe('attachment trays across remounts and conversation switches', () => {
  test('a same-generation remount finds the same resumable attempt, not unreconciled metadata', async () => {
    const { port, uploads } = lostThenStored()
    const first = acquireAttachmentTray(port, at(4))
    await first.tray.add(file('notes.txt', 'hello'))
    await settle()
    expect(first.tray.view().items[0]!.state).toBe('unconfirmed')
    first.release()

    const again = acquireAttachmentTray(port, at(4))
    expect(again.tray).toBe(first.tray)
    const item = again.tray.view().items[0]!
    expect(item.state).toBe('unconfirmed')
    expect(item.retryable).toBe(true)
    await again.tray.retry(item.id)
    expect(again.tray.view().items.map((candidate) => candidate.state)).toEqual(['stored'])
    expect(uploads).toHaveLength(2)
    expect(uploads[1]).toBe(uploads[0])
  })

  test("A -> B -> A at the same generation keeps A's attempt and never shows it in B", async () => {
    const { port, uploads } = lostThenStored()
    const a = acquireAttachmentTray(port, at(4, 'A'))
    await a.tray.add(file('notes.txt', 'hello'))
    await settle()
    a.release()
    const b = acquireAttachmentTray(port, at(7, 'B'))
    expect(b.tray.view().items).toEqual([])
    b.release()
    const back = acquireAttachmentTray(port, at(4, 'A'))
    expect(back.tray.view().items.map((item) => item.state)).toEqual(['unconfirmed'])
    await back.tray.retry(back.tray.view().items[0]!.id)
    expect(back.tray.view().items.map((item) => item.state)).toEqual(['stored'])
    expect(uploads[1]).toBe(uploads[0])
  })

  test('another port (scope) never shares a tray', () => {
    const one = lostThenStored().port
    const two = lostThenStored().port
    expect(acquireAttachmentTray(one, at(4)).tray).not.toBe(acquireAttachmentTray(two, at(4)).tray)
  })

  test('an answer that lands while no view is watching is there on return, and writes no view', async () => {
    let release!: (value: ChatAttachment) => void
    const port: AttachmentPort = {
      upload: () => new Promise((resolve) => (release = resolve)),
      remove: async () => removed,
    }
    const first = acquireAttachmentTray(port, at(4))
    const views: AttachmentTrayView[] = []
    const unsubscribe = first.tray.subscribe((view) => views.push(view))
    await first.tray.add(file('notes.txt', 'hello'))
    unsubscribe()
    first.release()
    const before = views.length
    release(stored)
    await settle()
    expect(views).toHaveLength(before)
    const back = acquireAttachmentTray(port, at(4))
    expect(back.tray.view().items.map((item) => item.state)).toEqual(['stored'])
  })

  test('only a real generation advance retires the tray, carrying what it could not settle', async () => {
    const { port } = lostThenStored()
    const old = acquireAttachmentTray(port, at(4))
    await old.tray.add(file('notes.txt', 'hello'))
    await settle()
    const next = acquireAttachmentTray(port, at(5))
    expect(next.tray).not.toBe(old.tray)
    expect(next.tray.view().items.map((item) => [item.name, item.state])).toEqual([
      ['notes.txt', 'unreconciled'],
    ])
    // The retired tray accepts nothing more.
    expect((await old.tray.add(file('late.txt', 'x'))).ok).toBe(false)
    // Releasing the old view does not drop the new generation's tray.
    old.release()
    expect(acquireAttachmentTray(port, at(5)).tray).toBe(next.tray)
  })

  test('an empty tray with no viewers is dropped', () => {
    const { port } = lostThenStored()
    const first = acquireAttachmentTray(port, at(4))
    first.release()
    expect(acquireAttachmentTray(port, at(4)).tray).not.toBe(first.tray)
  })
})

describe('failure wording never states an outcome it does not know', () => {
  test('the fallback for an unknown outcome is outcome-neutral', () => {
    expect(attachmentFailureText(undefined, '')).not.toContain('not stored')
    expect(attachmentFailureText('timeout', '')).toBe('The host did not give a usable answer.')
    expect(attachmentFailureText('timeout', '', 'refused')).toBe('The host refused the request.')
    expect(attachmentFailureText('limit_exceeded', '', 'refused')).toContain('limit')
  })

  test('a thrown value with no code and no message is "not confirmed", not "not stored"', async () => {
    for (const thrown of [new Error(''), 'boom', undefined, {}]) {
      const port: AttachmentPort = {
        upload: async () => {
          throw thrown
        },
        remove: async () => removed,
      }
      const tray = createAttachmentTray({ port, identity: IDENTITY, randomId: () => 'x' })
      await tray.add(file('notes.txt', 'hello'))
      await settle()
      const item = tray.view().items[0]!
      expect(item.state).toBe('unconfirmed')
      expect(item.message).not.toContain('not stored')
      expect(item.message).toContain('could not confirm')
    }
  })

  test('a definite refusal without a message does not claim an outcome either', async () => {
    const { tray, latest } = scripted([reject('unauthorized', '')], [])
    await tray.add(file('notes.txt', 'hello'))
    await settle()
    expect(latest().items[0]!.state).toBe('failed')
    expect(latest().items[0]!.message).toBe('The host refused the request.')
    const removal = scripted([stored], [reject('invalid_state', '')])
    await removal.tray.add(file('notes.txt', 'hello'))
    await settle()
    await removal.tray.remove('id1')
    expect(removal.latest().items[0]!.message).toBe(
      'The file was not removed. The host refused the request.'
    )
  })
})

describe('attachment selection', () => {
  test('one file that cannot be read never stops the rest of the selection', async () => {
    const port: AttachmentPort = { upload: async () => stored, remove: async () => removed }
    const tray = createAttachmentTray({ port, identity: IDENTITY })
    const unreadable: AttachmentFile = {
      name: 'gone.txt',
      size: 4,
      arrayBuffer: async () => {
        throw new Error('NotReadableError')
      },
    }
    const throwing = {
      name: 'odd.txt',
      size: 1,
      arrayBuffer: () => {
        throw new Error('boom')
      },
    } as unknown as AttachmentFile
    const notice = await stageSelection(tray, [unreadable, throwing, file('ok.txt', 'hello')])
    await settle()
    expect(tray.view().items.map((item) => item.name)).toEqual(['ok.txt'])
    expect(notice).toContain('gone.txt: This file could not be read.')
    expect(notice).toContain('odd.txt')
    expect(notice).not.toContain('NotReadableError')
    expect(await stageSelection(tray, [file('b.txt', 'x')])).toBeUndefined()
  })
})
