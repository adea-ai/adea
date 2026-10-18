import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import type { RuntimeEvent, Scope } from '../../../../../../packages/types/src/dev-runtime'
import type { RuntimeEventHistoryPage } from '../../../../../../packages/types/src/dev-runtime-history'
import { createDurableJsonStore } from '../host-store'
import { transcriptEvent } from './transcript-content'

export type RuntimeHistoryRead = Readonly<{
  generation: number
  beforeSequence?: string
  cursor?: string
  limit?: number
}>
const PAGE_BYTES = 192 * 1024
type Cursor = {
  version: 1
  scope: Scope
  session: string
  generation: number
  before: string
  floor: string
  floorId: string
  through: string
  limit: number
}
function refuse(code: 'invalid_state' | 'resync_required'): never {
  throw {
    code,
    retryable: code === 'resync_required',
    message:
      code === 'resync_required'
        ? 'Transcript retention changed; attach a fresh event window.'
        : 'Invalid transcript history cursor or bounds.',
  }
}
const uint64 = /^(?:0|[1-9]\d{0,19})$/
function validSequence(value: unknown): value is string {
  return (
    typeof value === 'string' && uint64.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n
  )
}

export function createSessionHistoryReader(input: {
  dataDir: string
  scope: Scope
  readAll: () => readonly RuntimeEvent[]
}) {
  const scopeKey = JSON.stringify([
    input.scope.accountId,
    input.scope.workspaceId,
    input.scope.runtimeNodeId,
  ])
  const keys = createDurableJsonStore<{ key: string }>({
    file: join(
      input.dataDir,
      'dev-runtime',
      'harness',
      `history-cursor-${createHash('sha256').update(scopeKey).digest('hex')}.json`
    ),
    schemaVersion: 1,
    label: 'transcript cursor key',
  })
  const key = () => {
    const records = keys.load().records
    if (records.length === 1 && /^[a-f0-9]{64}$/.test(records[0]!.key)) return records[0]!.key
    if (records.length > 0) refuse('resync_required')
    const generated = randomBytes(32).toString('hex')
    keys.save([{ key: generated }])
    return generated
  }
  const sign = (payload: string) => createHmac('sha256', key()).update(payload).digest('base64url')
  const encode = (cursor: Cursor) => {
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url')
    return `${payload}.${sign(payload)}`
  }
  function decode(token: string): Cursor {
    if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))
      refuse('invalid_state')
    const [payload, signature] = token.split('.') as [string, string]
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload))))
      refuse('invalid_state')
    try {
      return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Cursor
    } catch {
      return refuse('invalid_state')
    }
  }
  return (runtimeSessionId: string, options: RuntimeHistoryRead): RuntimeEventHistoryPage => {
    if (
      !Number.isSafeInteger(options.generation) ||
      options.generation < 0 ||
      (options.limit !== undefined &&
        (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500)) ||
      (options.beforeSequence !== undefined && !validSequence(options.beforeSequence))
    )
      refuse('invalid_state')
    const records = input
      .readAll()
      .filter(
        (event) =>
          event.runtimeSessionId === runtimeSessionId && event.generation === options.generation
      )
      .toSorted((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1))
    const first = records[0]
    const last = records.at(-1)
    let cursor: Cursor
    if (options.cursor !== undefined) {
      cursor = decode(options.cursor)
      if (
        cursor.version !== 1 ||
        cursor.scope.accountId !== input.scope.accountId ||
        cursor.scope.workspaceId !== input.scope.workspaceId ||
        cursor.scope.runtimeNodeId !== input.scope.runtimeNodeId ||
        cursor.session !== runtimeSessionId ||
        cursor.generation !== options.generation ||
        options.beforeSequence !== undefined ||
        (options.limit !== undefined && cursor.limit !== options.limit)
      )
        refuse('invalid_state')
      if (!first || first.seq !== cursor.floor || first.eventId !== cursor.floorId)
        refuse('resync_required')
    } else {
      const before = options.beforeSequence ?? (last ? (BigInt(last.seq) + 1n).toString() : '1')
      if (last && BigInt(before) > BigInt(last.seq) + 1n) refuse('resync_required')
      cursor = {
        version: 1,
        scope: input.scope,
        session: runtimeSessionId,
        generation: options.generation,
        before,
        floor: first?.seq ?? '0',
        floorId: first?.eventId ?? '',
        through: last?.seq ?? '0',
        limit: options.limit ?? 100,
      }
    }
    const candidates = records.filter(
      (event) =>
        BigInt(event.seq) < BigInt(cursor.before) && BigInt(event.seq) >= BigInt(cursor.floor)
    )
    const selected: RuntimeEvent[] = []
    let bytes = 0
    let expected = BigInt(cursor.before) - 1n
    for (const event of candidates.toReversed()) {
      if (BigInt(event.seq) !== expected) refuse('resync_required')
      const projected = transcriptEvent(event)
      const size = new TextEncoder().encode(JSON.stringify(projected)).byteLength
      const bounded =
        size > PAGE_BYTES
          ? { ...projected, payload: { omitted: 'history_payload_limit' } }
          : projected
      const cost =
        size > PAGE_BYTES ? new TextEncoder().encode(JSON.stringify(bounded)).byteLength : size
      if (selected.length >= cursor.limit || bytes + cost > PAGE_BYTES) break
      selected.unshift(bounded)
      bytes += cost
      expected -= 1n
    }
    if (first && BigInt(cursor.before) > BigInt(first.seq) && selected.length === 0)
      refuse('resync_required')
    const oldest = selected[0]
    return {
      runtimeSessionId,
      generation: options.generation,
      beforeSequence: cursor.before,
      retainedFromSequence: first ? cursor.floor : null,
      retainedThroughSequence: first ? cursor.through : null,
      historyStart: !first
        ? 'unavailable'
        : cursor.floor === '1'
          ? 'generation_start'
          : 'retention_boundary',
      items: selected,
      ...(oldest && BigInt(oldest.seq) > BigInt(cursor.floor)
        ? { nextCursor: encode({ ...cursor, before: oldest.seq }) }
        : {}),
    }
  }
}
