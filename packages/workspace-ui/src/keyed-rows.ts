import { createMemo, createSignal, type Accessor } from 'solid-js'

/**
 * A stable list entry for `<For>`. The wrapper object never changes identity
 * once the key exists, so the control flow keeps the row's DOM; the row's
 * bindings update through `entry.item()` instead of remounting.
 */
export type KeyedRow<T> = Readonly<{ item: Accessor<T> }>

/**
 * Maps a reactive list to stable, key-indexed rows.
 *
 * Server-backed lists (query results, projections over them) produce fresh
 * object identities on every fetch. Feeding them straight into `<For>` remounts
 * every row on each refetch: open menus close, focus and hover state drop, and
 * the whole subtree's DOM is rebuilt. Keying on a stable id keeps each row's
 * DOM alive across refetches and pushes the update through that row's own
 * accessor, so only the bindings whose values actually changed touch the DOM.
 *
 * Removed keys drop their rows; reordered keys keep their rows and move the
 * DOM nodes. Keys must be unique within the list — a duplicate reuses the
 * first entry's row.
 *
 * `equals` decides whether a fresh item replaces the row's stored value; the
 * default treats every new object as a change. Pass a field-level comparator
 * (e.g. a version stamp) to skip redundant downstream updates entirely.
 */
export function keyedRows<T, K>(
  list: () => readonly T[],
  key: (item: T) => K,
  equals: false | ((previous: T, next: T) => boolean) = false
): Accessor<readonly KeyedRow<T>[]> {
  type Entry = { row: KeyedRow<T>; set(item: T): void }
  let entries = new Map<K, Entry>()
  return createMemo<readonly KeyedRow<T>[]>(() => {
    const items = list()
    const next = new Map<K, Entry>()
    const rows = items.map((item) => {
      const itemKey = key(item)
      let entry = next.get(itemKey) ?? entries.get(itemKey)
      if (!entry) {
        // The tuple wrapper keeps the item out of createSignal's
        // `Exclude<T, Function>` overload, which unconstrained generics cannot
        // satisfy, while giving the custom equality a stable shape to compare.
        const [holder, setHolder] = createSignal<readonly [T]>([item], {
          equals:
            equals === false
              ? false
              : (previousHolder, nextHolder) => equals(previousHolder[0], nextHolder[0]),
        })
        entry = { row: { item: () => holder()[0] }, set: (nextItem) => setHolder([nextItem]) }
      } else if (!next.has(itemKey)) {
        entry.set(item)
      }
      next.set(itemKey, entry)
      return entry.row
    })
    entries = next
    return rows
  })
}
