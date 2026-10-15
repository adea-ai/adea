import { Database, constants } from 'bun:sqlite'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

import {
  chatAttachmentLimits,
  decodeChatAttachment,
  decodeChatAttachmentUpload,
  type ChatAttachment,
  type ChatAttachmentOpenResult,
  type ChatAttachmentReference,
  type ChatAttachmentUpload,
} from '../../../../../../packages/types/src/dev-runtime-attachments'
import type { DevErrorCode, Scope } from '../../../../../../packages/types/src/dev-runtime'
import { uuidPattern } from '../../../../../../packages/types/src/dev-runtime-validation-internal'
import type { SessionEventLog } from '../harness/events'

export class AttachmentError extends Error {
  readonly retryable = false
  constructor(readonly code: DevErrorCode) {
    super(`attachment_${code}`)
    this.name = 'AttachmentError'
  }
}
export type AttachmentBinding = Readonly<{ runtimeSessionId: string; generation: number }>
export type AttachmentStage =
  | 'before_initialization_commit'
  | 'before_commit'
  | 'after_commit'
  | 'before_publish'
  | 'after_publish'
type Row = {
  id: string
  binding: string
  upload_key: string
  fingerprint: string
  state: string
  byte_length: number
  sealed: Uint8Array
}
type Pending = {
  id: string
  binding: string
  generation: number
  session_id: string
  kind: 'attachment.added' | 'attachment.removed'
  payload: string
  occurred_at: string
  mac: string
  /** Authenticated publication state: prepared, delivered, or attempted. */
  delivered: 0 | 1 | 2
}
type SealedRecord = {
  attachment: ChatAttachment
  uploadKey: string
  fingerprint: string
  contentBase64?: string
}

/** One scope-local database; all bytes and display metadata are sealed. No caller path is accepted. */
export function createChatAttachmentStore(input: {
  dataDir: string
  scope: Scope
  events?: SessionEventLog
  /** Re-check the authoritative live session at every mutation and before releasing bytes. */
  assertBinding(binding: AttachmentBinding): void
  /** Tests inject fresh keys; production reads the existing device key without minting or rotating it. */
  readKey?: () => Uint8Array | undefined
  now?: () => string
  onStage?: (stage: AttachmentStage) => void
}) {
  const now = input.now ?? (() => new Date().toISOString())
  const scopeText = JSON.stringify([
    input.scope.accountId,
    input.scope.workspaceId,
    input.scope.runtimeNodeId,
  ])
  const scopeHash = createHash('sha256').update(scopeText).digest('hex')
  const requestedRoot = resolve(input.dataDir)
  let root = requestedRoot
  try {
    root = realpathSync(requestedRoot)
  } catch {
    /* Refuse the capability at use, never during host composition. */
  }
  function assertRoot(): void {
    try {
      const stats = lstatSync(requestedRoot)
      if (stats.isSymbolicLink() || !stats.isDirectory() || realpathSync(requestedRoot) !== root)
        throw new AttachmentError('symlink_rejected')
    } catch {
      throw new AttachmentError('symlink_rejected')
    }
  }
  const directory = join(root, 'dev-runtime', 'attachments')
  const file = join(directory, `${scopeHash}.sqlite3`)
  const bind = (binding: AttachmentBinding) =>
    JSON.stringify([binding.runtimeSessionId, binding.generation])
  const aad = (id: string, binding: string) =>
    Buffer.from(JSON.stringify(['adea-chat-attachment', 2, scopeText, binding, id]))

  function key(): Buffer {
    try {
      assertRoot()
      if (input.readKey) {
        const value = input.readKey()
        if (!value || value.byteLength !== 32) throw new AttachmentError('capability_unavailable')
        return Buffer.from(value)
      }
      const path = join(root, 'desktop-state', 'device.key')
      const state = lstatSync(join(root, 'desktop-state'))
      if (!state.isDirectory() || state.isSymbolicLink())
        throw new AttachmentError('capability_unavailable')
      const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      try {
        const stats = fstatSync(fd)
        if (
          !stats.isFile() ||
          stats.size !== 32 ||
          stats.nlink !== 1 ||
          (stats.mode & 0o077) !== 0 ||
          (process.getuid && stats.uid !== process.getuid())
        )
          throw new AttachmentError('capability_unavailable')
        return readFileSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch {
      throw new AttachmentError('capability_unavailable')
    }
  }
  function seal(value: unknown, secret: Buffer, id: string, binding: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', secret, iv)
    cipher.setAAD(aad(id, binding))
    return Buffer.concat([
      iv,
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ])
  }
  function unseal(value: Uint8Array, secret: Buffer, id: string, binding: string): unknown {
    try {
      const bytes = Buffer.from(value)
      const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12))
      decipher.setAAD(aad(id, binding))
      decipher.setAuthTag(bytes.subarray(-16))
      return JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8')
      )
    } catch {
      throw new AttachmentError('corrupt_state')
    }
  }
  function paths(create: boolean): void {
    assertRoot()
    for (const path of [join(root, 'dev-runtime'), directory]) {
      if (!existsSync(path)) {
        if (!create) throw new AttachmentError('not_found')
        mkdirSync(path, { mode: 0o700 })
      }
      const stats = lstatSync(path)
      if (!stats.isDirectory() || stats.isSymbolicLink())
        throw new AttachmentError('symlink_rejected')
      if ((stats.mode & 0o077) !== 0) throw new AttachmentError('ownership_unproven')
    }
    for (const path of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
      const stats = lstatSync(path, { throwIfNoEntry: false })
      if (stats && (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1))
        throw new AttachmentError('symlink_rejected')
    }
    if (!create && !existsSync(file)) throw new AttachmentError('not_found')
  }
  function initializeDatabase(db: Database, secret: Buffer): void {
    db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;')
    try {
      const version = db
        .query<{ user_version: number }, []>('PRAGMA user_version')
        .get()!.user_version
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .all()
        .map((entry) => entry.name)
      if (version === 0 && tables.length === 0) {
        db.exec(
          'CREATE TABLE store_meta (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, sealed BLOB NOT NULL); CREATE TABLE attachments (id TEXT PRIMARY KEY, binding TEXT NOT NULL, upload_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, state TEXT NOT NULL, byte_length INTEGER NOT NULL, sealed BLOB NOT NULL); CREATE TABLE attachment_outbox (id TEXT PRIMARY KEY, binding TEXT NOT NULL, generation INTEGER NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, occurred_at TEXT NOT NULL, mac TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);'
        )
        db.query('INSERT INTO store_meta(id,owner,sealed) VALUES(1,?,?)').run(
          scopeText,
          seal(scopeText, secret, 'store', 'scope')
        )
        db.exec('PRAGMA user_version=2')
        input.onStage?.('before_initialization_commit')
      } else {
        if (version !== 2)
          throw new AttachmentError(version === 0 ? 'corrupt_state' : 'unsupported_version')
        if (
          JSON.stringify(tables) !==
          JSON.stringify(['attachment_outbox', 'attachments', 'store_meta'])
        )
          throw new AttachmentError('corrupt_state')
        const meta = db
          .query<{ owner: string; sealed: Uint8Array }, []>(
            'SELECT owner,sealed FROM store_meta WHERE id=1'
          )
          .get()
        if (
          !meta ||
          meta.owner !== scopeText ||
          unseal(meta.sealed, secret, 'store', 'scope') !== scopeText
        )
          throw new AttachmentError('corrupt_state')
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    // Configure persistent storage only after its owner header authenticates.
    db.exec('PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;')
  }
  function database<T>(create: boolean, action: (db: Database, secret: Buffer) => T): T {
    const deviceKey = key()
    const secret = Buffer.from(
      hkdfSync('sha256', deviceKey, 'adea-chat-attachment:v1', scopeText, 32)
    )
    deviceKey.fill(0)
    let db: Database | undefined
    let failed = false
    let failure: unknown
    let result: T | undefined
    try {
      paths(create)
      const existingFile = lstatSync(file, { throwIfNoEntry: false })
      if (
        existingFile &&
        ((existingFile.mode & 0o077) !== 0 ||
          (process.getuid && existingFile.uid !== process.getuid()))
      )
        throw new AttachmentError('ownership_unproven')
      db = new Database(
        file,
        constants.SQLITE_OPEN_READWRITE |
          constants.SQLITE_OPEN_CREATE |
          constants.SQLITE_OPEN_NOFOLLOW
      )
      if (!existingFile) chmodSync(file, 0o600)
      initializeDatabase(db, secret)
      result = action(db, secret)
    } catch (error) {
      failed = true
      failure = error
    } finally {
      try {
        db?.close(true)
      } catch (error) {
        if (!failed) {
          failed = true
          failure = error
        }
      }
      secret.fill(0)
    }
    if (failed)
      throw failure instanceof AttachmentError ? failure : new AttachmentError('unavailable')
    return result as T
  }
  function transaction<T>(
    db: Database,
    binding: AttachmentBinding | undefined,
    action: () => T
  ): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      input.onStage?.('before_commit')
      if (binding) input.assertBinding(binding)
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  function record(row: Row, secret: Buffer): SealedRecord {
    const value = unseal(row.sealed, secret, row.id, row.binding) as SealedRecord
    const attachment = decodeChatAttachment(value?.attachment)
    if (
      attachment.attachmentId !== row.id ||
      bind(attachment) !== row.binding ||
      attachment.state !== row.state ||
      attachment.byteLength !== row.byte_length ||
      typeof value.uploadKey !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.uploadKey) ||
      value.uploadKey !== row.upload_key ||
      typeof value.fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.fingerprint) ||
      value.fingerprint !== row.fingerprint
    )
      throw new AttachmentError('corrupt_state')
    if (attachment.state === 'available') {
      if (typeof value.contentBase64 !== 'string') throw new AttachmentError('corrupt_state')
      const bytes = Buffer.from(value.contentBase64, 'base64')
      if (
        bytes.toString('base64') !== value.contentBase64 ||
        bytes.length !== attachment.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== attachment.digestSha256
      )
        throw new AttachmentError('corrupt_state')
    } else if (value.contentBase64 !== undefined) throw new AttachmentError('corrupt_state')
    return value
  }
  function lookup(db: Database, binding: AttachmentBinding, attachmentId: string): Row {
    if (!uuidPattern.test(attachmentId)) throw new AttachmentError('not_found')
    const row = db
      .query<Row, [string, string]>('SELECT * FROM attachments WHERE id=? AND binding=?')
      .get(attachmentId, bind(binding))
    if (!row) throw new AttachmentError('not_found')
    return row
  }
  function mac(value: string, secret: Buffer): string {
    const authenticationKey = createHmac('sha256', secret)
      .update('adea-chat-attachment:authentication:v1')
      .digest()
    try {
      return createHmac('sha256', authenticationKey).update(value).digest('hex')
    } finally {
      authenticationKey.fill(0)
    }
  }
  function eventMac(event: Omit<Pending, 'mac'>, secret: Buffer): string {
    return mac(
      JSON.stringify([
        'outbox-v2',
        scopeText,
        event.id,
        event.binding,
        event.generation,
        event.session_id,
        event.kind,
        event.payload,
        event.occurred_at,
        event.delivered,
      ]),
      secret
    )
  }

  function enqueue(
    db: Database,
    binding: AttachmentBinding,
    attachment: ChatAttachment,
    secret: Buffer
  ): void {
    const kind = attachment.state === 'available' ? 'attachment.added' : 'attachment.removed'
    const id = `host:attachment:${attachment.attachmentId}:${attachment.state}`
    const reference: ChatAttachmentReference = {
      attachmentId: attachment.attachmentId,
      mediaType: attachment.mediaType,
      byteLength: attachment.byteLength,
      state: attachment.state,
    }
    const event: Omit<Pending, 'mac'> = {
      id,
      binding: bind(binding),
      generation: binding.generation,
      session_id: binding.runtimeSessionId,
      kind,
      payload: JSON.stringify({ attachment: reference }),
      occurred_at: attachment.removedAt ?? attachment.createdAt,
      delivered: 0,
    }
    db.query(
      'INSERT INTO attachment_outbox(id,binding,generation,session_id,kind,payload,occurred_at,mac) VALUES(?,?,?,?,?,?,?,?)'
    ).run(
      id,
      event.binding,
      event.generation,
      event.session_id,
      event.kind,
      event.payload,
      event.occurred_at,
      eventMac(event, secret)
    )
  }
  function authenticatedOutbox(db: Database, secret: Buffer): Pending[] {
    const rows = db.query<Pending, []>('SELECT * FROM attachment_outbox ORDER BY rowid').all()
    // Authenticate selectors before filtering, just as delivery state before skipping.
    for (const event of rows)
      if (![0, 1, 2].includes(event.delivered) || event.mac !== eventMac(event, secret))
        throw new AttachmentError('corrupt_state')
    return rows
  }
  function flush(db: Database, binding: AttachmentBinding, secret: Buffer): void {
    const pending = authenticatedOutbox(db, secret).filter(
      (event) => event.binding === bind(binding)
    )
    for (const event of pending) {
      input.assertBinding(binding)
      if (!input.events) throw new AttachmentError('capability_unavailable')
      if (event.delivered === 1) continue
      const retained = input.events
        .events()
        .filter(
          (item) =>
            item.runtimeSessionId === binding.runtimeSessionId &&
            item.generation === binding.generation
        )
      const existing = retained.some(
        (item) => item.source === 'host' && item.sourceEventId === event.id
      )
      // Authenticated prepared rows have never attempted publication, regardless
      // of the retained floor. Only an attempted row needs retained dedupe proof.
      if (!existing && event.delivered === 2) throw new AttachmentError('recovery_required')
      // Persist an authenticated attempt BEFORE crossing the separate event-log
      // commit boundary. A missing retained fact after an attempt is ambiguous,
      // including when retention has removed every event in this generation.
      const attempted = { ...event, delivered: 2 as const }
      db.query('UPDATE attachment_outbox SET delivered=?,mac=? WHERE id=?').run(
        attempted.delivered,
        eventMac(attempted, secret),
        event.id
      )
      input.onStage?.('before_publish')
      input.events.append({
        runtimeSessionId: event.session_id,
        generation: event.generation,
        kind: event.kind,
        source: 'host',
        confidence: 'authoritative',
        classification: 'workspace_private',
        sourceEventId: event.id,
        payload: JSON.parse(event.payload),
        occurredAt: event.occurred_at,
      })
      input.onStage?.('after_publish')
      const delivered = { ...event, delivered: 1 as const }
      db.query('UPDATE attachment_outbox SET delivered=?,mac=? WHERE id=?').run(
        delivered.delivered,
        eventMac(delivered, secret),
        event.id
      )
    }
  }
  function upload(
    binding: AttachmentBinding,
    value: ChatAttachmentUpload,
    idempotencyKey: string
  ): ChatAttachment {
    if (!input.events) throw new AttachmentError('capability_unavailable')
    input.assertBinding(binding)
    let request: ChatAttachmentUpload
    try {
      request = decodeChatAttachmentUpload(value)
    } catch {
      throw new AttachmentError('invalid_state')
    }
    if (request.mediaType !== 'text/plain' || !/\.(?:txt|log|md|json)$/i.test(request.name))
      throw new AttachmentError('unsupported_capability')
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) throw new AttachmentError('invalid_state')
    const bytes = Buffer.from(request.contentBase64, 'base64')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new AttachmentError('unsupported_capability')
    }
    if (
      Array.from(text).some((character) => {
        const code = character.charCodeAt(0)
        return (
          (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)
        )
      })
    )
      throw new AttachmentError('unsupported_capability')
    const digest = createHash('sha256').update(bytes).digest('hex')
    return database(true, (db, secret) => {
      flush(db, binding, secret)
      const uploadKey = mac(JSON.stringify(['request', bind(binding), idempotencyKey]), secret)
      const fingerprint = mac(
        JSON.stringify(['content', request.name, request.mediaType, digest]),
        secret
      )
      const attachment = transaction(db, binding, () => {
        input.assertBinding(binding)
        const existing = db
          .query<Row, [string]>('SELECT * FROM attachments WHERE upload_key=?')
          .get(uploadKey)
        if (existing) {
          const previous = record(existing, secret).attachment
          if (existing.fingerprint !== fingerprint || existing.binding !== bind(binding))
            throw new AttachmentError('idempotency_conflict')
          if (previous.state !== 'available') throw new AttachmentError('invalid_state')
          return previous
        }
        const quota = db
          .query<{ count: number; bytes: number }, []>(
            "SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN state='available' THEN byte_length ELSE 0 END),0) AS bytes FROM attachments"
          )
          .get()!
        if (
          quota.count >= chatAttachmentLimits.maxRecordsPerScope ||
          quota.bytes + bytes.length > chatAttachmentLimits.maxLiveBytesPerScope
        )
          throw new AttachmentError('limit_exceeded')
        const next: ChatAttachment = {
          attachmentId: randomUUID(),
          runtimeSessionId: binding.runtimeSessionId,
          generation: binding.generation,
          name: request.name,
          mediaType: 'text/plain',
          byteLength: bytes.length,
          digestSha256: digest,
          state: 'available',
          createdAt: now(),
        }
        const sealed = seal(
          { attachment: next, uploadKey, fingerprint, contentBase64: request.contentBase64 },
          secret,
          next.attachmentId,
          bind(binding)
        )
        db.query(
          'INSERT INTO attachments(id,binding,upload_key,fingerprint,state,byte_length,sealed) VALUES(?,?,?,?,?,?,?)'
        ).run(
          next.attachmentId,
          bind(binding),
          uploadKey,
          fingerprint,
          next.state,
          next.byteLength,
          sealed
        )
        enqueue(db, binding, next, secret)
        return next
      })
      input.onStage?.('after_commit')
      input.assertBinding(binding)
      flush(db, binding, secret)
      return attachment
    })
  }
  function open(binding: AttachmentBinding, attachmentId: string): ChatAttachmentOpenResult {
    input.assertBinding(binding)
    return database(false, (db, secret) =>
      transaction(db, binding, () => {
        const value = record(lookup(db, binding, attachmentId), secret)
        if (value.attachment.state !== 'available') throw new AttachmentError('not_found')
        input.assertBinding(binding)
        return {
          attachment: value.attachment,
          contentBase64: value.contentBase64!,
          disposition: 'inert_text',
        }
      })
    )
  }
  function remove(binding: AttachmentBinding, attachmentId: string): ChatAttachment {
    if (!input.events) throw new AttachmentError('capability_unavailable')
    input.assertBinding(binding)
    return database(false, (db, secret) => {
      flush(db, binding, secret)
      const attachment = transaction(db, binding, () => {
        input.assertBinding(binding)
        const row = lookup(db, binding, attachmentId)
        const previous = record(row, secret).attachment
        if (previous.state === 'removed') return previous
        const next: ChatAttachment = { ...previous, state: 'removed', removedAt: now() }
        db.query('UPDATE attachments SET state=?,sealed=? WHERE id=? AND binding=?').run(
          next.state,
          seal(
            { attachment: next, uploadKey: row.upload_key, fingerprint: row.fingerprint },
            secret,
            next.attachmentId,
            bind(binding)
          ),
          next.attachmentId,
          bind(binding)
        )
        enqueue(db, binding, next, secret)
        return next
      })
      input.onStage?.('after_commit')
      input.assertBinding(binding)
      flush(db, binding, secret)
      return attachment
    })
  }
  function assertWorkspaceOwnership(): void {
    assertRoot()
    const runtime = lstatSync(join(root, 'dev-runtime'), { throwIfNoEntry: false })
    if (runtime && (runtime.isSymbolicLink() || !runtime.isDirectory()))
      throw new AttachmentError('symlink_rejected')
    const parent = lstatSync(directory, { throwIfNoEntry: false })
    if (!parent) return
    if (parent.isSymbolicLink() || !parent.isDirectory())
      throw new AttachmentError('symlink_rejected')
    if ((parent.mode & 0o077) !== 0 || (runtime && (runtime.mode & 0o077) !== 0))
      throw new AttachmentError('ownership_unproven')
    const names = readdirSync(directory)
    if (names.some((name) => !/^[0-9a-f]{64}\.sqlite3(?:-(?:wal|shm|journal))?$/.test(name)))
      throw new AttachmentError('ownership_unproven')
    if (
      names.some(
        (name) =>
          name.includes('.sqlite3-') && !names.includes(name.split('.sqlite3-')[0]! + '.sqlite3')
      )
    )
      throw new AttachmentError('ownership_unproven')
    if (names.length > 1536) throw new AttachmentError('limit_exceeded')
    for (const name of names.filter((entry) => entry.endsWith('.sqlite3'))) {
      if (!/^[0-9a-f]{64}\.sqlite3$/.test(name)) throw new AttachmentError('ownership_unproven')
      const path = join(directory, name)
      for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
        const stats = lstatSync(candidate, { throwIfNoEntry: false })
        if (stats && (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1))
          throw new AttachmentError('symlink_rejected')
      }
      let sibling: Database | undefined
      let closeFailed = false
      try {
        sibling = new Database(
          path,
          constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW
        )
        const meta = sibling
          .query<{ owner: string }, []>('SELECT owner FROM store_meta WHERE id=1')
          .get()
        const owner: unknown = JSON.parse(meta?.owner ?? 'null')
        if (
          !Array.isArray(owner) ||
          owner.length !== 3 ||
          owner.some((id) => typeof id !== 'string') ||
          `${createHash('sha256').update(JSON.stringify(owner)).digest('hex')}.sqlite3` !== name
        )
          throw new AttachmentError('ownership_unproven')
        if (
          owner[1] === input.scope.workspaceId &&
          (owner[0] !== input.scope.accountId || owner[2] !== input.scope.runtimeNodeId)
        )
          throw new AttachmentError('ownership_unproven')
      } catch (error) {
        if (error instanceof AttachmentError) throw error
        throw new AttachmentError('corrupt_state')
      } finally {
        try {
          sibling?.close(true)
        } catch {
          closeFailed = true
        }
      }
      if (closeFailed) throw new AttachmentError('unavailable')
    }
  }
  function workspacePurge(validateOnly: boolean): number {
    try {
      return checkedWorkspacePurge(validateOnly)
    } catch (error) {
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError('corrupt_state')
    }
  }
  function checkedWorkspacePurge(validateOnly: boolean): number {
    assertWorkspaceOwnership()
    if (!lstatSync(directory, { throwIfNoEntry: false })) return 0
    try {
      paths(false)
    } catch (error) {
      if (error instanceof AttachmentError && error.code === 'not_found') return 0
      throw error
    }
    return database(false, (db, secret) =>
      transaction(db, undefined, () => {
        const rows = db.query<Row, []>('SELECT * FROM attachments').all()
        rows.forEach((row) => record(row, secret))
        authenticatedOutbox(db, secret)
        if (!validateOnly) db.exec('DELETE FROM attachment_outbox; DELETE FROM attachments;')
        return rows.length
      })
    )
  }
  return Object.freeze({
    upload,
    open,
    remove,
    validateWorkspacePurge: () => workspacePurge(true),
    purgeWorkspace: () => workspacePurge(false),
  })
}
