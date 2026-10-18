import {
  segmentTurnEntries,
  type ChatTurn,
  type ChatTurnEntry,
  type ChatTurnProjection,
} from './turns'

/**
 * Presentation identity across the retention window.
 *
 * The transcript keeps the newest `CHAT_EVENT_RETENTION_LIMIT` events. A turn,
 * a streamed reply and a column of lines are each named by the id of the first
 * event they were built from, so when that event is evicted the name changes
 * (the prompt goes and the turn is called `lead`; the leading delta of a long
 * reply goes and the block takes the next delta's id) and a keyed list tears
 * the DOM down and builds it again: the reader's selection, focus and open
 * disclosures are lost, once per fragment for a reply that is longer than the
 * window.
 *
 * A key is a name for drawing, not an identity the runtime reported. It is
 * always an id of an event this session has delivered (or `lead`), reused for
 * as long as any event that thing was first built from is still retained, and
 * never invented. The memory holds one string per retained event per level, is
 * rebuilt from the current window on every pass so it cannot grow past it, and
 * is dropped with the session or generation (a new instance is made for each).
 */

export type PresentedEntry = ChatTurnEntry & Readonly<{ key: string }>

type ColumnType = 'activity' | 'call' | 'result' | 'reasoning' | 'method'
export type PresentedColumnEntry = Extract<PresentedEntry, { type: ColumnType }>
export type PresentedStandaloneEntry = Exclude<PresentedEntry, { type: ColumnType }>

export type PresentedSegment =
  | Readonly<{
      type: 'activity'
      id: string
      key: string
      entries: readonly PresentedColumnEntry[]
    }>
  | Readonly<{ type: 'entry'; id: string; key: string; entry: PresentedStandaloneEntry }>

export type PresentedTurn = Readonly<{
  /** The prompt's event id, or `lead`: the runtime-facing name. */
  id: string
  /** The name the DOM is keyed by. */
  key: string
  user?: ChatTurn['user']
  entries: readonly PresentedEntry[]
  segments: readonly PresentedSegment[]
}>

export type PresentedProjection = Readonly<{
  turns: readonly PresentedTurn[]
  entryByEventId: ChatTurnProjection['entryByEventId']
}>

export type ChatPresentationIdentity = Readonly<{
  /** Name the projection's turns, segments and entries, remembering the names for the next pass. */
  present: (projection: ChatTurnProjection) => PresentedProjection
}>

/** An event id → the key of the thing it was first built into, for one level. */
class Level {
  #known: ReadonlyMap<string, string> = new Map()
  #next = new Map<string, string>()
  #used = new Set<string>()

  begin() {
    this.#next = new Map()
    this.#used = new Set()
  }

  /** The key for a thing built from `eventIds`, which fall under `ownId` when none is known. */
  name(ownId: string, eventIds: readonly string[]): string {
    let key = ownId
    for (const id of eventIds) {
      const known = this.#known.get(id)
      if (known !== undefined) {
        key = known
        break
      }
    }
    // Two things must never share a key in one pass (a block split in two, say):
    // the second falls back to its own id, and then to a suffixed one.
    if (this.#used.has(key)) key = ownId
    for (let n = 2; this.#used.has(key); n += 1) key = `${ownId}#${n}`
    this.#used.add(key)
    for (const id of eventIds) this.#next.set(id, key)
    return key
  }

  end() {
    this.#known = this.#next
  }
}

function eventIdsOf(entry: ChatTurnEntry): readonly string[] {
  if (entry.type === 'call') return [...entry.eventIds, ...entry.children.flatMap(eventIdsOf)]
  return entry.type === 'text' ||
    entry.type === 'result' ||
    entry.type === 'reasoning' ||
    entry.type === 'method'
    ? entry.eventIds
    : [entry.id]
}

export function createChatPresentationIdentity(): ChatPresentationIdentity {
  const turns = new Level()
  const segments = new Level()
  const entries = new Level()

  return {
    present(projection) {
      turns.begin()
      segments.begin()
      entries.begin()
      const presented = projection.turns.map((turn): PresentedTurn => {
        const keyed = turn.entries.map((entry): PresentedEntry => ({
          ...entry,
          key: entries.name(entry.id, eventIdsOf(entry)),
        }))
        const turnEvents = [...(turn.user ? [turn.user.id] : []), ...keyed.flatMap(eventIdsOf)]
        const key = turns.name(turn.id, turnEvents)
        // The entries carry their keys, so the segments built from them hold the keyed objects.
        const laidOut = segmentTurnEntries(keyed).map((segment): PresentedSegment => {
          if (segment.type === 'activity') {
            const column = segment.entries as readonly PresentedColumnEntry[]
            return {
              type: 'activity',
              id: segment.id,
              key: segments.name(segment.id, column.flatMap(eventIdsOf)),
              entries: column,
            }
          }
          const entry = segment.entry as PresentedStandaloneEntry
          return {
            type: 'entry',
            id: segment.id,
            key: segments.name(segment.id, eventIdsOf(entry)),
            entry,
          }
        })
        return {
          id: turn.id,
          key,
          ...(turn.user ? { user: turn.user } : {}),
          entries: keyed,
          segments: laidOut,
        }
      })
      turns.end()
      segments.end()
      entries.end()
      return { turns: presented, entryByEventId: projection.entryByEventId }
    },
  }
}
