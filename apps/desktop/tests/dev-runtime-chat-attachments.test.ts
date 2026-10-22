import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  chatAttachmentLimits,
  decodeChatAttachment,
  decodeChatAttachmentOpenResult,
  type ChatAttachmentUpload,
} from '../../../packages/types/src/dev-runtime-attachments'
import { decodeRuntimeEvent, type Scope } from '../../../packages/types/src/dev-runtime'
import {
  AttachmentError,
  createChatAttachmentStore,
  type AttachmentBinding,
  type AttachmentStage,
} from '../shell/src/dev-runtime/attachments/store'
import { createSessionEventLog } from '../shell/src/dev-runtime/harness/events'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const binding = { runtimeSessionId: 'session-1', generation: 1 }
const upload = (
  text = 'private attachment body',
  name = 'private-name.txt'
): ChatAttachmentUpload => ({
  name,
  mediaType: 'text/plain',
  contentBase64: Buffer.from(text).toString('base64'),
})
function code(run: () => unknown, expected: string) {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(AttachmentError)
    expect((error as AttachmentError).code).toBe(expected)
    expect((error as Error).message).toBe(`attachment_${expected}`)
    return
  }
  throw new Error(`expected ${expected}`)
}
function fixture(run: (context: ReturnType<typeof context>) => void | Promise<void>) {
  const ctx = context()
  try {
    const result = run(ctx)
    if (result instanceof Promise) return result.finally(ctx.cleanup)
    ctx.cleanup()
  } catch (error) {
    ctx.cleanup()
    throw error
  }
}
function context() {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-1392-'))
  const secret = randomBytes(32)
  const events = createSessionEventLog({ dataDir, scope })
  let generation = 1
  let stage: AttachmentStage | undefined
  const assertBinding = (value: AttachmentBinding) => {
    if (value.runtimeSessionId !== binding.runtimeSessionId) throw new AttachmentError('not_found')
    if (value.generation !== generation) throw new AttachmentError('stale_generation')
  }
  const make = (otherScope = scope, readKey: () => Uint8Array | undefined = () => secret) =>
    createChatAttachmentStore({
      dataDir,
      scope: otherScope,
      events,
      readKey,
      assertBinding,
      onStage: (value) => {
        if (stage === value) throw new Error('simulated interruption')
      },
    })
  const store = make()
  const dbPath = () =>
    join(
      dataDir,
      'dev-runtime',
      'attachments',
      readdirSync(join(dataDir, 'dev-runtime', 'attachments')).find((name) =>
        name.endsWith('.sqlite3')
      )!
    )
  return {
    dataDir,
    events,
    secret,
    store,
    make,
    dbPath,
    setGeneration: (value: number) => {
      generation = value
    },
    interrupt: (value?: AttachmentStage) => {
      stage = value
    },
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  }
}

describe('local encrypted chat attachments (#1392)', () => {
  test('upload/open/remove uses opaque references, sealed private metadata and truthful transcript facts', () =>
    fixture((ctx) => {
      const attachment = ctx.store.upload(binding, upload(), 'upload-1')
      expect(decodeChatAttachment(attachment)).toEqual(attachment)
      const opened = ctx.store.open(binding, attachment.attachmentId)
      expect(decodeChatAttachmentOpenResult(opened)).toEqual(opened)
      expect(Buffer.from(opened.contentBase64, 'base64').toString()).toBe('private attachment body')
      expect(opened.disposition).toBe('inert_text')
      const raw = readFileSync(ctx.dbPath())
      expect(raw.includes(Buffer.from('private attachment body'))).toBe(false)
      expect(raw.includes(Buffer.from('private-name.txt'))).toBe(false)
      expect(raw.includes(Buffer.from(upload().contentBase64))).toBe(false)
      const added = ctx.events.events()[0]!
      expect(decodeRuntimeEvent(added, { source: 'host' }).kind).toBe('attachment.added')
      expect(added.payload).toEqual({
        attachment: {
          attachmentId: attachment.attachmentId,
          mediaType: 'text/plain',
          byteLength: attachment.byteLength,
          state: 'available',
        },
      })
      expect(JSON.stringify(added)).not.toContain(attachment.name)
      expect(JSON.stringify(added)).not.toContain(attachment.digestSha256)
      const removed = ctx.store.remove(binding, attachment.attachmentId)
      expect(removed.state).toBe('removed')
      code(() => ctx.store.open(binding, attachment.attachmentId), 'not_found')
      expect(ctx.events.events().map((event) => event.kind)).toEqual([
        'attachment.added',
        'attachment.removed',
      ])
    }))

  test('retries are stable across reopen and never resurrect a removed attachment', () =>
    fixture((ctx) => {
      const first = ctx.store.upload(binding, upload(), 'upload-1')
      expect(
        ctx
          .make()
          .upload(
            binding,
            { contentBase64: upload().contentBase64, mediaType: 'text/plain', name: upload().name },
            'upload-1'
          )
      ).toEqual(first)
      expect(ctx.events.events()).toHaveLength(1)
      code(
        () => ctx.make().upload(binding, upload('different bytes'), 'upload-1'),
        'idempotency_conflict'
      )
      const removed = ctx.store.remove(binding, first.attachmentId)
      expect(ctx.make().remove(binding, first.attachmentId)).toEqual(removed)
      expect(ctx.events.events()).toHaveLength(2)
      code(() => ctx.store.upload(binding, upload(), 'upload-1'), 'invalid_state')
    }))

  test('binds every operation to the live session and generation', () =>
    fixture((ctx) => {
      const attachment = ctx.store.upload(binding, upload(), 'upload-1')
      code(
        () => ctx.store.open({ ...binding, runtimeSessionId: 'foreign' }, attachment.attachmentId),
        'not_found'
      )
      ctx.setGeneration(2)
      for (const run of [
        () => ctx.store.upload(binding, upload(), 'again'),
        () => ctx.store.open(binding, attachment.attachmentId),
        () => ctx.store.remove(binding, attachment.attachmentId),
      ])
        code(run, 'stale_generation')
      code(
        () => ctx.store.open({ ...binding, generation: 2 }, attachment.attachmentId),
        'not_found'
      )
      const next = ctx.store.upload({ ...binding, generation: 2 }, upload(), 'upload-1')
      expect(next.attachmentId).not.toBe(attachment.attachmentId)
    }))

  test('foreign account/workspace/node scope and re-labelled encrypted databases cannot open bytes', () =>
    fixture((ctx) => {
      const attachment = ctx.store.upload(binding, upload(), 'upload-1')
      for (const field of ['accountId', 'workspaceId', 'runtimeNodeId'] as const) {
        const other = { ...scope, [field]: '00000000-0000-4000-8000-000000000099' }
        code(() => ctx.make(other).open(binding, attachment.attachmentId), 'not_found')
      }
      const other = { ...scope, workspaceId: '00000000-0000-4000-8000-000000000099' }
      const digest = createHash('sha256')
        .update(JSON.stringify([other.accountId, other.workspaceId, other.runtimeNodeId]))
        .digest('hex')
      const path = join(ctx.dataDir, 'dev-runtime', 'attachments', `${digest}.sqlite3`)
      copyFileSync(ctx.dbPath(), path)
      chmodSync(path, 0o600)
      code(() => ctx.make(other).open(binding, attachment.attachmentId), 'corrupt_state')
    }))

  test('traversal IDs and unsafe display metadata cannot reach host files', () =>
    fixture((ctx) => {
      const attachment = ctx.store.upload(binding, upload(), 'upload-1')
      for (const id of [
        '../desktop-state/device.key',
        '/etc/passwd',
        '..',
        'file:///tmp/x',
        'a\\b',
      ]) {
        code(() => ctx.store.open(binding, id), 'not_found')
        code(() => ctx.store.remove(binding, id), 'not_found')
      }
      for (const name of [
        '../secret.txt',
        '/secret.txt',
        'a\\b.txt',
        'a\n.txt',
        'a\0.txt',
        '.secret.txt',
        'a..txt',
        'NUL.txt',
        'name.txt ',
        'a'.repeat(129),
      ])
        code(
          () => ctx.store.upload(binding, upload('content', name), `bad-${name.length}`),
          'invalid_state'
        )
      expect(ctx.store.open(binding, attachment.attachmentId).attachment).toEqual(attachment)
    }))

  test('enforces exact bytes, canonical encoding, supported media, UTF-8 and inert text', () =>
    fixture((ctx) => {
      const maximum = ctx.store.upload(
        binding,
        upload('x'.repeat(chatAttachmentLimits.maxBytes), 'max.txt'),
        'max'
      )
      expect(maximum.byteLength).toBe(chatAttachmentLimits.maxBytes)
      for (const payload of [
        upload('x'.repeat(chatAttachmentLimits.maxBytes + 1)),
        { ...upload(), contentBase64: 'Zh==' },
        upload(''),
      ])
        code(() => ctx.store.upload(binding, payload, 'bad'), 'invalid_state')
      for (const payload of [
        { ...upload(), mediaType: 'image/svg+xml', name: 'active.svg' },
        upload('x', 'script.exe'),
        upload('x\0y'),
        upload('x\u001by'),
        { ...upload(), contentBase64: Buffer.from([255]).toString('base64') },
      ])
        code(() => ctx.store.upload(binding, payload, 'unsupported'), 'unsupported_capability')
      expect(ctx.events.events()).toHaveLength(1)
    }))

  test('missing device-key capability refuses without minting a credential or storing bytes', () =>
    fixture((ctx) => {
      const store = ctx.make(scope, () => undefined)
      code(() => store.upload(binding, upload(), 'upload-1'), 'capability_unavailable')
      expect(readdirSync(ctx.dataDir)).toEqual([])
      expect(ctx.events.events()).toHaveLength(0)
    }))

  test('production key reads preserve the existing key and refuse a key symlink', () =>
    fixture((ctx) => {
      const state = join(ctx.dataDir, 'desktop-state')
      mkdirSync(state, { mode: 0o700 })
      const keyPath = join(state, 'device.key')
      writeFileSync(keyPath, ctx.secret, { mode: 0o600 })
      const store = createChatAttachmentStore({
        dataDir: ctx.dataDir,
        scope,
        events: ctx.events,
        assertBinding: () => {},
      })
      store.upload(binding, upload(), 'upload-1')
      expect(readFileSync(keyPath)).toEqual(ctx.secret)
      rmSync(keyPath)
      symlinkSync(join(state, 'other-key'), keyPath)
      writeFileSync(join(state, 'other-key'), ctx.secret)
      code(() => store.upload(binding, upload(), 'upload-2'), 'capability_unavailable')
    }))

  test('rejects symlinked storage and unsafe owner modes before following a file', () =>
    fixture((ctx) => {
      mkdirSync(join(ctx.dataDir, 'dev-runtime'), { mode: 0o700 })
      const outside = join(ctx.dataDir, 'outside')
      mkdirSync(outside)
      symlinkSync(outside, join(ctx.dataDir, 'dev-runtime', 'attachments'))
      code(() => ctx.store.upload(binding, upload(), 'upload-1'), 'symlink_rejected')
      expect(readdirSync(outside)).toEqual([])
      rmSync(join(ctx.dataDir, 'dev-runtime', 'attachments'))
      mkdirSync(join(ctx.dataDir, 'dev-runtime', 'attachments'), { mode: 0o777 })
      chmodSync(join(ctx.dataDir, 'dev-runtime', 'attachments'), 0o777)
      code(() => ctx.store.upload(binding, upload(), 'upload-1'), 'ownership_unproven')
    }))

  for (const stage of ['before_commit', 'after_commit', 'after_publish'] as const) {
    test(`recovers an interruption ${stage} without duplicate bytes or transcript records`, () =>
      fixture((ctx) => {
        ctx.interrupt(stage)
        code(() => ctx.store.upload(binding, upload(), 'upload-1'), 'unavailable')
        expect(ctx.events.events()).toHaveLength(stage === 'after_publish' ? 1 : 0)
        const published = ctx.events.events()[0]
        ctx.interrupt()
        const attachment = ctx.make().upload(binding, upload(), 'upload-1')
        expect(ctx.make().upload(binding, upload(), 'upload-1')).toEqual(attachment)
        expect(ctx.events.events()).toHaveLength(1)
        if (published) expect(ctx.events.events()[0]).toEqual(published)
        expect(ctx.store.open(binding, attachment.attachmentId).attachment).toEqual(attachment)
      }))
  }

  test('open/remove races have a single ordering and never release bytes after a completed removal', async () =>
    fixture(async (ctx) => {
      const attachment = ctx.store.upload(binding, upload(), 'upload-1')
      const first = await Promise.all([
        Promise.resolve().then(() => ctx.store.open(binding, attachment.attachmentId)),
        Promise.resolve().then(() => ctx.store.remove(binding, attachment.attachmentId)),
      ])
      expect(first[0]).toMatchObject({ disposition: 'inert_text' })
      expect(first[1].state).toBe('removed')
      const after = await Promise.allSettled([
        Promise.resolve().then(() => ctx.store.remove(binding, attachment.attachmentId)),
        Promise.resolve().then(() => ctx.store.open(binding, attachment.attachmentId)),
      ])
      expect(after[0]!.status).toBe('fulfilled')
      expect(after[1]!.status).toBe('rejected')
      expect(ctx.events.events()).toHaveLength(2)
    }))

  test('authenticated workspace purge removes all generations and preserves another scope', () =>
    fixture((ctx) => {
      const first = ctx.store.upload(binding, upload(), 'upload-1')
      const other = { ...scope, workspaceId: '00000000-0000-4000-8000-000000000099' }
      const sibling = ctx.make(other)
      const second = sibling.upload(binding, upload(), 'upload-1')
      expect(ctx.store.validateWorkspacePurge()).toBe(1)
      expect(ctx.store.purgeWorkspace()).toBe(1)
      code(() => ctx.store.open(binding, first.attachmentId), 'not_found')
      expect(sibling.open(binding, second.attachmentId).attachment).toEqual(second)
    }))
})

describe('attachment transaction and recovery hardening', () => {
  test('a generation change at the commit boundary rolls back both bytes and the transcript outbox', () =>
    fixture((ctx) => {
      const store = createChatAttachmentStore({
        dataDir: ctx.dataDir,
        scope,
        events: ctx.events,
        readKey: () => ctx.secret,
        assertBinding: (value) => {
          if (value.generation !== currentGeneration) throw new AttachmentError('stale_generation')
        },
        onStage: (stage) => {
          if (stage === 'before_commit') currentGeneration = 2
        },
      })
      let currentGeneration = 1
      code(() => store.upload(binding, upload(), 'upload-1'), 'stale_generation')
      const db = new Database(ctx.dbPath(), { readonly: true })
      try {
        expect(db.query('SELECT COUNT(*) AS count FROM attachments').get()).toEqual({ count: 0 })
        expect(db.query('SELECT COUNT(*) AS count FROM attachment_outbox').get()).toEqual({
          count: 0,
        })
      } finally {
        db.close(true)
      }
      expect(ctx.events.events()).toHaveLength(0)
    }))

  test('corrupt ciphertext and forged outbox metadata fail closed with scrubbed errors', () =>
    fixture((ctx) => {
      ctx.interrupt('after_commit')
      code(() => ctx.store.upload(binding, upload(), 'upload-1'), 'unavailable')
      ctx.interrupt()
      const db = new Database(ctx.dbPath())
      try {
        db.query('UPDATE attachment_outbox SET payload=?').run(
          JSON.stringify({ name: 'secret-path-name.txt' })
        )
      } finally {
        db.close(true)
      }
      code(() => ctx.store.upload(binding, upload(), 'upload-1'), 'corrupt_state')
      expect(ctx.events.events()).toHaveLength(0)
      const corrupt = new Database(ctx.dbPath())
      let id = ''
      try {
        const row = corrupt
          .query<{ id: string; sealed: Uint8Array }, []>('SELECT id,sealed FROM attachments')
          .get()!
        id = row.id
        const sealed = Buffer.from(row.sealed)
        sealed[20] = sealed[20]! ^ 1
        corrupt.query('UPDATE attachments SET sealed=? WHERE id=?').run(sealed, row.id)
      } finally {
        corrupt.close(true)
      }
      code(() => ctx.store.open(binding, id), 'corrupt_state')
      code(() => ctx.store.validateWorkspacePurge(), 'corrupt_state')
    }))

  for (const operation of ['upload', 'remove'] as const)
    test(`never-attempted ${operation} retries publish above an older retained floor`, () =>
      fixture((ctx) => {
        const attachment =
          operation === 'remove' ? ctx.store.upload(binding, upload(), 'initial') : undefined
        const bounded = createSessionEventLog({ dataDir: ctx.dataDir, scope, maxPerSession: 2 })
        for (let index = 0; index < 3; index += 1)
          bounded.append({ ...binding, kind: 'run.created', sourceEventId: `older-${index}` })
        const before = bounded.events()
        expect(BigInt(before[0]!.seq)).toBeGreaterThan(1n)
        const mutate = (store: ReturnType<typeof ctx.make>) =>
          attachment
            ? store.remove(binding, attachment.attachmentId)
            : store.upload(binding, upload(), 'upload-1')
        ctx.interrupt('after_commit')
        code(() => mutate(ctx.store), 'unavailable')
        ctx.interrupt()
        const recovered = mutate(ctx.make())
        const published = ctx.events.events().at(-1)!
        expect(published.kind).toBe(
          operation === 'upload' ? 'attachment.added' : 'attachment.removed'
        )
        expect(BigInt(published.seq)).toBe(BigInt(before.at(-1)!.seq) + 1n)
        expect(mutate(ctx.make())).toEqual(recovered)
        expect(ctx.events.events().at(-1)).toEqual(published)
      }))

  test('record quota counts tombstones, keeps retries working and refuses new identities', () =>
    fixture((ctx) => {
      const first = ctx.store.upload(binding, upload('x'), 'quota-0')
      for (let index = 1; index < chatAttachmentLimits.maxRecordsPerScope; index += 1)
        ctx.store.upload(binding, upload('x'), `quota-${index}`)
      expect(ctx.make().upload(binding, upload('x'), 'quota-0')).toEqual(first)
      code(() => ctx.store.upload(binding, upload('x'), 'overflow'), 'limit_exceeded')
      ctx.store.remove(binding, first.attachmentId)
      code(() => ctx.store.upload(binding, upload('x'), 'overflow'), 'limit_exceeded')
      expect(ctx.store.validateWorkspacePurge()).toBe(chatAttachmentLimits.maxRecordsPerScope)
    }))

  test('byte quota is checked transactionally and removal frees live byte budget', () =>
    fixture((ctx) => {
      const payload = upload('x'.repeat(chatAttachmentLimits.maxBytes))
      const count = chatAttachmentLimits.maxLiveBytesPerScope / chatAttachmentLimits.maxBytes
      const first = ctx.store.upload(binding, payload, 'bytes-0')
      for (let index = 1; index < count; index += 1)
        ctx.store.upload(binding, payload, `bytes-${index}`)
      code(() => ctx.store.upload(binding, payload, 'overflow'), 'limit_exceeded')
      ctx.store.remove(binding, first.attachmentId)
      expect(ctx.store.upload(binding, payload, 'after-remove').byteLength).toBe(
        chatAttachmentLimits.maxBytes
      )
    }))

  test('quota checks authenticate stored row metadata before trusting byte counts', () =>
    fixture((ctx) => {
      ctx.store.upload(binding, upload('original'), 'tampered-metadata')
      const db = new Database(ctx.dbPath())
      db.query("UPDATE attachments SET state='removed'").run()
      db.close(true)

      code(() => ctx.make().upload(binding, upload('another'), 'after-tamper'), 'corrupt_state')
      expect(ctx.events.events()).toHaveLength(1)
    }))

  test('quota checks refuse deleted rows while authenticated attachment events remain', () =>
    fixture((ctx) => {
      const attachment = ctx.store.upload(binding, upload('original'), 'deleted-row')
      const db = new Database(ctx.dbPath())
      db.query('DELETE FROM attachments WHERE id=?').run(attachment.attachmentId)
      db.close(true)

      code(() => ctx.make().upload(binding, upload('another'), 'after-delete'), 'corrupt_state')
      expect(ctx.events.events()).toHaveLength(1)
    }))

  test('quota checks refuse a row whose stored byte length no longer matches its sealed record', () =>
    fixture((ctx) => {
      ctx.store.upload(binding, upload('original'), 'tampered-length')
      const db = new Database(ctx.dbPath())
      db.query('UPDATE attachments SET byte_length=0').run()
      db.close(true)

      code(
        () => ctx.make().upload(binding, upload('another'), 'after-tamper-length'),
        'corrupt_state'
      )
      expect(ctx.events.events()).toHaveLength(1)
    }))

  test('a tampered sealed payload is refused after the record was cached', () =>
    fixture((ctx) => {
      // The second upload authenticates the first record, so the store holds a
      // verdict about it. Only the sealed payload changes below: the plaintext
      // columns stay exactly as the authentication left them, so a verdict that
      // is keyed on the columns alone would still be reused.
      const first = ctx.store.upload(binding, upload('original'), 'tampered-payload')
      ctx.store.upload(binding, upload('distinct'), 'distinct-payload')

      const db = new Database(ctx.dbPath())
      const row = db.query('SELECT sealed FROM attachments WHERE id=?').get(first.attachmentId)
      const sealed = Buffer.from(row.sealed)
      // One ciphertext byte, so the payload differs while the row's columns do not.
      sealed[sealed.length - 17] ^= 0xff
      db.query('UPDATE attachments SET sealed=? WHERE id=?').run(sealed, first.attachmentId)
      db.close(true)

      code(
        () => ctx.store.upload(binding, upload('another'), 'after-payload-tamper'),
        'corrupt_state'
      )
      code(() => ctx.store.validateWorkspacePurge(), 'corrupt_state')
    }))

  test('a tampered row is refused after the record was cached', () =>
    fixture((ctx) => {
      const first = ctx.store.upload(binding, upload('original'), 'tampered-columns')
      ctx.store.upload(binding, upload('distinct'), 'distinct-columns')

      const db = new Database(ctx.dbPath())
      db.query("UPDATE attachments SET state='removed' WHERE id=?").run(first.attachmentId)
      db.close(true)

      code(
        () => ctx.store.upload(binding, upload('another'), 'after-column-tamper'),
        'corrupt_state'
      )
      code(() => ctx.store.validateWorkspacePurge(), 'corrupt_state')
    }))

  test('a record cached under an earlier device key is not reused', () =>
    fixture((ctx) => {
      let key = ctx.secret
      const store = ctx.make(scope, () => key)
      store.upload(binding, upload('original'), 'rotated-key')

      key = randomBytes(32)

      code(() => store.upload(binding, upload('another'), 'rotated-key-upload'), 'corrupt_state')
    }))

  test('quota checks re-authenticate a record whose row changed under the same store', () =>
    fixture((ctx) => {
      // The same store instance already authenticated this record, so the
      // changed column must invalidate that verdict: a remembered
      // authentication is only valid for the row it was made against.
      ctx.store.upload(binding, upload('original'), 'tampered-same-store')
      const db = new Database(ctx.dbPath())
      // The row claims a tombstone its sealed record does not contain. Only
      // re-authenticating the row against its sealed record can see that: the
      // outbox still holds the matching available event, so the reconciliation
      // alone would not notice.
      db.query("UPDATE attachments SET state='removed'").run()
      db.close(true)

      code(
        () => ctx.store.upload(binding, upload('another'), 'after-tamper-same-store'),
        'corrupt_state'
      )
    }))

  test('workspace purge refuses additional account/node authority for the same workspace', () =>
    fixture((ctx) => {
      ctx.store.upload(binding, upload(), 'upload-1')
      ctx
        .make({ ...scope, accountId: '00000000-0000-4000-8000-000000000099' })
        .upload(binding, upload(), 'other')
      code(() => ctx.store.validateWorkspacePurge(), 'ownership_unproven')
      code(() => ctx.store.purgeWorkspace(), 'ownership_unproven')
      expect(ctx.events.events()).toHaveLength(2)
    }))
})

for (const stage of ['before_commit', 'after_commit', 'after_publish'] as const) {
  test(`remove interruption ${stage} preserves one tombstone and one removal fact`, () =>
    fixture((ctx) => {
      const attachment = ctx.store.upload(binding, upload(), 'upload-1')
      ctx.interrupt(stage)
      code(() => ctx.store.remove(binding, attachment.attachmentId), 'unavailable')
      expect(ctx.events.events()).toHaveLength(stage === 'after_publish' ? 2 : 1)
      ctx.interrupt()
      const removed = ctx.make().remove(binding, attachment.attachmentId)
      expect(removed.state).toBe('removed')
      expect(ctx.make().remove(binding, attachment.attachmentId)).toEqual(removed)
      code(() => ctx.store.open(binding, attachment.attachmentId), 'not_found')
      expect(ctx.events.events()).toHaveLength(2)
    }))
}

test('an unsupported storage root refuses at use without breaking host construction', () =>
  fixture((ctx) => {
    const missing = join(ctx.dataDir, 'missing')
    const store = createChatAttachmentStore({
      dataDir: missing,
      scope,
      events: ctx.events,
      assertBinding: () => {},
      readKey: () => ctx.secret,
    })
    code(() => store.upload(binding, upload(), 'upload-1'), 'capability_unavailable')
  }))

test('SQLite sidecar links are refused before open or cleanup can follow an outside target', () =>
  fixture((ctx) => {
    const attachment = ctx.store.upload(binding, upload(), 'upload-1')
    const outside = join(ctx.dataDir, 'outside-sentinel')
    writeFileSync(outside, 'preserve outside data')
    symlinkSync(outside, `${ctx.dbPath()}-journal`)
    code(() => ctx.store.open(binding, attachment.attachmentId), 'symlink_rejected')
    code(() => ctx.store.validateWorkspacePurge(), 'symlink_rejected')
    expect(readFileSync(outside, 'utf8')).toBe('preserve outside data')
  }))

test('workspace purge retains and refuses unknown attachment artifacts instead of guessing ownership', () =>
  fixture((ctx) => {
    const attachment = ctx.store.upload(binding, upload(), 'upload-1')
    const unknown = join(ctx.dataDir, 'dev-runtime', 'attachments', 'unowned-recovery-copy')
    writeFileSync(unknown, 'preserve recovery evidence')
    code(() => ctx.store.validateWorkspacePurge(), 'ownership_unproven')
    code(() => ctx.store.purgeWorkspace(), 'ownership_unproven')
    expect(readFileSync(unknown, 'utf8')).toBe('preserve recovery evidence')
    expect(ctx.store.open(binding, attachment.attachmentId).attachment).toEqual(attachment)
  }))

test('an existing unrelated SQLite file is preserved rather than adopted or reconfigured', () =>
  fixture((ctx) => {
    const directory = join(ctx.dataDir, 'dev-runtime', 'attachments')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const digest = createHash('sha256')
      .update(JSON.stringify([scope.accountId, scope.workspaceId, scope.runtimeNodeId]))
      .digest('hex')
    const path = join(directory, `${digest}.sqlite3`)
    const unrelated = new Database(path)
    unrelated.exec(
      "CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('preserve unrelated data')"
    )
    unrelated.close(true)
    chmodSync(path, 0o600)
    const before = createHash('sha256').update(readFileSync(path)).digest('hex')
    code(() => ctx.store.upload(binding, upload(), 'upload-1'), 'corrupt_state')
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(before)
  }))

test('interrupted first-use initialization rolls back the schema and authentic owner header together', () =>
  fixture((ctx) => {
    ctx.interrupt('before_initialization_commit')
    code(() => ctx.store.upload(binding, upload(), 'upload-1'), 'unavailable')
    ctx.interrupt()
    const attachment = ctx.store.upload(binding, upload(), 'upload-1')
    expect(ctx.store.open(binding, attachment.attachmentId).attachment).toEqual(attachment)
    expect(ctx.events.events()).toHaveLength(1)
  }))

describe('attachment independent-review regressions (#1407)', () => {
  test('swapped retry metadata cannot return another valid attachment or its bytes', () =>
    fixture((ctx) => {
      const first = ctx.store.upload(binding, upload('first private body', 'first.txt'), 'first')
      const second = ctx.store.upload(
        binding,
        upload('second private body', 'second.txt'),
        'second'
      )
      const db = new Database(ctx.dbPath())
      try {
        const rows = db
          .query<{ id: string; upload_key: string; fingerprint: string }, []>(
            'SELECT id,upload_key,fingerprint FROM attachments ORDER BY rowid'
          )
          .all()
        db.query('UPDATE attachments SET upload_key=? WHERE id=?').run(
          'temporary-swap',
          first.attachmentId
        )
        db.query('UPDATE attachments SET upload_key=?,fingerprint=? WHERE id=?').run(
          rows[0]!.upload_key,
          rows[0]!.fingerprint,
          second.attachmentId
        )
        db.query('UPDATE attachments SET upload_key=?,fingerprint=? WHERE id=?').run(
          rows[1]!.upload_key,
          rows[1]!.fingerprint,
          first.attachmentId
        )
      } finally {
        db.close(true)
      }
      code(
        () => ctx.make().upload(binding, upload('first private body', 'first.txt'), 'first'),
        'corrupt_state'
      )
      code(
        () => ctx.make().upload(binding, upload('second private body', 'second.txt'), 'second'),
        'corrupt_state'
      )
      code(() => ctx.store.open(binding, second.attachmentId), 'corrupt_state')
      code(() => ctx.store.validateWorkspacePurge(), 'corrupt_state')
    }))

  test('a forged delivered marker cannot silently suppress a committed transcript fact', () =>
    fixture((ctx) => {
      ctx.interrupt('after_commit')
      code(() => ctx.store.upload(binding, upload(), 'upload-1'), 'unavailable')
      ctx.interrupt()
      const db = new Database(ctx.dbPath())
      try {
        db.exec('UPDATE attachment_outbox SET delivered=1')
      } finally {
        db.close(true)
      }
      code(() => ctx.make().upload(binding, upload(), 'upload-1'), 'corrupt_state')
      expect(ctx.events.events()).toHaveLength(0)
    }))

  test('a published but unmarked fact fails closed after its entire generation leaves retention', () =>
    fixture((ctx) => {
      ctx.events.append({ ...binding, kind: 'run.created', sourceEventId: 'initial' })
      ctx.interrupt('after_publish')
      code(() => ctx.store.upload(binding, upload(), 'upload-1'), 'unavailable')
      ctx.interrupt()
      const published = ctx.events.events().find((event) => event.kind === 'attachment.added')!
      expect(published.seq).toBe('2')
      const bounded = createSessionEventLog({
        dataDir: ctx.dataDir,
        scope,
        maxPerSession: 2,
        maxTotal: 2,
      })
      for (let index = 0; index < 4; index += 1)
        bounded.append({
          runtimeSessionId: 'other-session',
          generation: 2,
          kind: 'run.created',
          sourceEventId: `other-${index}`,
        })
      expect(
        bounded.events().filter((event) => event.runtimeSessionId === binding.runtimeSessionId)
      ).toHaveLength(0)
      code(() => ctx.make().upload(binding, upload(), 'upload-1'), 'recovery_required')
      expect(
        bounded.events().some((event) => event.sourceEventId === published.sourceEventId)
      ).toBe(false)
    }))
})

test('an interrupted publication attempt with no retained fact requires recovery', () =>
  fixture((ctx) => {
    ctx.interrupt('before_publish')
    code(() => ctx.store.upload(binding, upload(), 'upload-1'), 'unavailable')
    ctx.interrupt()
    code(() => ctx.make().upload(binding, upload(), 'upload-1'), 'recovery_required')
    expect(ctx.events.events()).toHaveLength(0)
  }))

for (const [stage, forged] of [
  ['after_commit', 2],
  ['after_publish', 0],
  ['after_publish', 1],
  [undefined, 0],
  [undefined, 2],
] as const)
  test(`publication state tampering ${stage ?? 'delivered'} -> ${forged} is detected`, () =>
    fixture((ctx) => {
      ctx.interrupt(stage)
      if (stage) code(() => ctx.store.upload(binding, upload(), 'upload-1'), 'unavailable')
      else ctx.store.upload(binding, upload(), 'upload-1')
      ctx.interrupt()
      const db = new Database(ctx.dbPath())
      try {
        db.query('UPDATE attachment_outbox SET delivered=?').run(forged)
      } finally {
        db.close(true)
      }
      const retained = ctx.events.events()
      code(() => ctx.make().upload(binding, upload(), 'upload-1'), 'corrupt_state')
      expect(ctx.events.events()).toEqual(retained)
    }))

test('older draft format remains untouched and requires explicit recovery, never silent adoption', () =>
  fixture((ctx) => {
    ctx.store.upload(binding, upload(), 'upload-1')
    const db = new Database(ctx.dbPath())
    try {
      db.exec('PRAGMA user_version=1')
    } finally {
      db.close(true)
    }
    const original = readFileSync(ctx.dbPath())
    const key = Buffer.from(ctx.secret)
    code(() => ctx.make().upload(binding, upload(), 'upload-1'), 'unsupported_version')
    code(() => ctx.store.validateWorkspacePurge(), 'unsupported_version')
    expect(readFileSync(ctx.dbPath())).toEqual(original)
    expect(ctx.secret).toEqual(key)
    expect(ctx.events.events()).toHaveLength(1)
  }))

test('forged outbox binding cannot hide an unpublished fact from authentication or purge', () =>
  fixture((ctx) => {
    ctx.interrupt('after_commit')
    code(() => ctx.store.upload(binding, upload(), 'upload-1'), 'unavailable')
    ctx.interrupt()
    const db = new Database(ctx.dbPath())
    try {
      db.query('UPDATE attachment_outbox SET binding=?').run('["foreign-session",1]')
    } finally {
      db.close(true)
    }
    code(() => ctx.make().upload(binding, upload(), 'upload-1'), 'corrupt_state')
    code(() => ctx.store.validateWorkspacePurge(), 'corrupt_state')
    expect(ctx.events.events()).toHaveLength(0)
  }))

test('authenticated delivery remains idempotent after its complete generation leaves retention', () =>
  fixture((ctx) => {
    const attachment = ctx.store.upload(binding, upload(), 'upload-1')
    const bounded = createSessionEventLog({
      dataDir: ctx.dataDir,
      scope,
      maxPerSession: 2,
      maxTotal: 2,
    })
    for (let index = 0; index < 4; index += 1)
      bounded.append({
        runtimeSessionId: 'other-session',
        generation: 2,
        kind: 'run.created',
        sourceEventId: `other-${index}`,
      })
    const retained = bounded.events()
    expect(retained.every((event) => event.runtimeSessionId !== binding.runtimeSessionId)).toBe(
      true
    )
    expect(ctx.make().upload(binding, upload(), 'upload-1')).toEqual(attachment)
    expect(bounded.events()).toEqual(retained)
    expect(ctx.store.open(binding, attachment.attachmentId).contentBase64).toBe(
      upload().contentBase64
    )
  }))

test('an attempted fact missing from a partially retained generation still requires recovery', () =>
  fixture((ctx) => {
    ctx.interrupt('after_publish')
    code(() => ctx.store.upload(binding, upload(), 'upload-1'), 'unavailable')
    ctx.interrupt()
    const bounded = createSessionEventLog({ dataDir: ctx.dataDir, scope, maxPerSession: 2 })
    for (let index = 0; index < 3; index += 1)
      bounded.append({ ...binding, kind: 'run.created', sourceEventId: `later-${index}` })
    const retained = bounded.events()
    expect(retained).toHaveLength(2)
    expect(BigInt(retained[0]!.seq)).toBeGreaterThan(1n)
    code(() => ctx.make().upload(binding, upload(), 'upload-1'), 'recovery_required')
    expect(bounded.events()).toEqual(retained)
  }))
