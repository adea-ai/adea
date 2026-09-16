import { describe, expect, test } from 'bun:test'
import { createRoot, createSignal } from 'solid-js'

import { keyedRows } from '../../src/keyed-rows'

type Row = Readonly<{ id: string; version: number; label: string }>

const row = (id: string, label: string, version = 1): Row => ({ id, label, version })

describe('keyedRows', () => {
  test('keeps row identity across fresh list objects and pushes updates through the accessor', () => {
    createRoot((dispose) => {
      const [list, setList] = createSignal<readonly Row[]>([row('a', 'first'), row('b', 'second')])
      const rows = keyedRows(list, (item) => item.id)

      const [a, b] = rows()
      // A refetch returns brand-new objects for the same ids.
      setList([row('a', 'first-updated'), row('b', 'second')])

      expect(rows()).toHaveLength(2)
      expect(rows()[0]).toBe(a)
      expect(rows()[1]).toBe(b)
      expect(rows()[0]!.item().label).toBe('first-updated')
      expect(rows()[1]!.item().label).toBe('second')
      dispose()
    })
  })

  test('drops removed keys, appends new keys, and keeps survivors stable', () => {
    createRoot((dispose) => {
      const [list, setList] = createSignal<readonly Row[]>([row('a', 'first'), row('b', 'second')])
      const rows = keyedRows(list, (item) => item.id)
      const [a, b] = rows()

      setList([row('b', 'second'), row('c', 'third')])
      expect(rows()).toHaveLength(2)
      expect(rows()[0]).toBe(b)
      expect(rows()[1]).not.toBe(a)
      expect(rows()[1]!.item().id).toBe('c')
      dispose()
    })
  })

  test('honours the equality comparator and skips unchanged versions', () => {
    createRoot((dispose) => {
      const [list, setList] = createSignal<readonly Row[]>([row('a', 'first')])
      const rows = keyedRows(
        list,
        (item) => item.id,
        (previous, next) => previous.version === next.version
      )

      setList([row('a', 'first-renamed')])
      // Same version: the accessor keeps serving the previous item.
      expect(rows()[0]!.item().label).toBe('first')

      setList([row('a', 'first-renamed', 2)])
      expect(rows()[0]!.item().label).toBe('first-renamed')
      dispose()
    })
  })

  test('moves existing rows on reorder without recreating them', () => {
    createRoot((dispose) => {
      const [list, setList] = createSignal<readonly Row[]>([row('a', 'first'), row('b', 'second')])
      const rows = keyedRows(list, (item) => item.id)
      const [a, b] = rows()

      setList([row('b', 'second'), row('a', 'first')])
      expect(rows()).toEqual([b, a])
      dispose()
    })
  })
})
