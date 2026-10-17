import { decodeRuntimeEnvelope, decodeRuntimeEvent, type RuntimeEvent } from './dev-runtime-wire'
import {
  exactKeys,
  fail,
  integerValue,
  literal,
  record,
  stringValue,
  uint64String,
} from './dev-runtime-validation-internal'

/** A backward page over one retained session generation; items ascend by seq. */
export type RuntimeEventHistoryPage = Readonly<{
  runtimeSessionId: string
  generation: number
  beforeSequence: string
  retainedFromSequence: string | null
  retainedThroughSequence: string | null
  historyStart: 'generation_start' | 'retention_boundary' | 'unavailable'
  items: readonly RuntimeEvent[]
  nextCursor?: string
}>

export function decodeRuntimeEventHistoryPage(value: unknown): RuntimeEventHistoryPage {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 224 * 1024)
    fail('history', 'encoded page exceeds 224 KiB')
  const page = record(value, 'history')
  exactKeys(
    page,
    [
      'runtimeSessionId',
      'generation',
      'beforeSequence',
      'retainedFromSequence',
      'retainedThroughSequence',
      'historyStart',
      'items',
    ],
    ['nextCursor'],
    'history'
  )
  stringValue(page.runtimeSessionId, 'history.runtimeSessionId', 1, 256)
  integerValue(page.generation, 'history.generation', 0)
  uint64String(page.beforeSequence, 'history.beforeSequence')
  for (const field of ['retainedFromSequence', 'retainedThroughSequence'] as const)
    if (page[field] !== null) uint64String(page[field], `history.${field}`)
  literal(
    page.historyStart,
    ['generation_start', 'retention_boundary', 'unavailable'],
    'history.historyStart'
  )
  if (page.nextCursor !== undefined) stringValue(page.nextCursor, 'history.nextCursor', 1, 2048)
  if (!Array.isArray(page.items) || page.items.length > 500)
    fail('history.items', 'expected bounded page')
  let previous: bigint | undefined
  for (const item of page.items) {
    const raw = record(item, 'history.event')
    // The authenticated host command is the provenance boundary for its stored log.
    literal(
      raw.source,
      ['host', 'native', 'acp', 'authenticated_hook', 'terminal_fallback'],
      'history.event.source'
    )
    // A withheld private body is an envelope, never a kind-specific fact.
    const withheld =
      (raw.classification === 'credential' || raw.classification === 'restricted_local') &&
      JSON.stringify(raw.payload) === '{}'
    const event = (withheld ? decodeRuntimeEnvelope : decodeRuntimeEvent)(raw, {
      source: raw.source as RuntimeEvent['source'],
    })
    const seq = BigInt(event.seq)
    if (
      event.runtimeSessionId !== page.runtimeSessionId ||
      event.generation !== page.generation ||
      seq >= BigInt(page.beforeSequence as string) ||
      seq < 1n ||
      (previous !== undefined && seq !== previous + 1n)
    )
      fail('history.event', 'identity or sequence mismatch')
    if (
      (event.classification === 'credential' || event.classification === 'restricted_local') &&
      JSON.stringify(event.payload) !== '{}'
    )
      fail('history.event', 'private payload is not a transcript projection')
    previous = seq
  }
  if (page.items.length === 0 && page.nextCursor !== undefined)
    fail('history.nextCursor', 'empty page cannot continue')
  if (page.historyStart === 'unavailable') {
    if (
      page.retainedFromSequence !== null ||
      page.retainedThroughSequence !== null ||
      page.items.length > 0
    )
      fail('history', 'unavailable history has no retained events')
  } else {
    if (
      page.retainedFromSequence === null ||
      page.retainedThroughSequence === null ||
      BigInt(page.retainedFromSequence as string) < 1n ||
      BigInt(page.retainedFromSequence as string) > BigInt(page.retainedThroughSequence as string)
    )
      fail('history', 'invalid retained bounds')
    if ((page.historyStart === 'generation_start') !== (page.retainedFromSequence === '1'))
      fail('history.historyStart', 'does not match retained floor')
    for (const event of page.items as RuntimeEvent[])
      if (
        BigInt(event.seq) < BigInt(page.retainedFromSequence as string) ||
        BigInt(event.seq) > BigInt(page.retainedThroughSequence as string)
      )
        fail('history.event', 'outside retained bounds')
    const items = page.items as RuntimeEvent[]
    if (BigInt(page.beforeSequence as string) > BigInt(page.retainedThroughSequence as string) + 1n)
      fail('history.beforeSequence', 'outside snapshot bounds')
    if (items.length > 0) {
      if (BigInt(items.at(-1)!.seq) + 1n !== BigInt(page.beforeSequence as string))
        fail('history.items', 'page does not reach its exclusive boundary')
      if ((page.nextCursor !== undefined) !== (items[0]!.seq !== page.retainedFromSequence))
        fail('history.nextCursor', 'does not match remaining retained history')
    } else if (BigInt(page.beforeSequence as string) > BigInt(page.retainedFromSequence as string))
      fail('history.items', 'empty page skips retained history')
  }
  return value as RuntimeEventHistoryPage
}
