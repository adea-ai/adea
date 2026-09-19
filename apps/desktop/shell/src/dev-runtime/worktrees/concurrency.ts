// Bounded-parallelism helpers for worktree scans and admin-file walks
// (adea#490: hot paths never walk sequentially and never queue unbounded
// filesystem probes onto the fs threadpool at once).
//
// Portions substantially translated from Orca (https://github.com/stablyai/orca)
// `src/shared/map-with-concurrency.ts`, pinned revision 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7,
// MIT License. Copyright (c) 2026 Stably AI, Inc.

export function concurrencyWorkerCount(limit: number, itemCount: number): number {
  return Math.max(1, Math.min(limit, itemCount))
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const workerCount = concurrencyWorkerCount(limit, items.length)
  if (items.length <= workerCount) {
    return Promise.all(items.map(fn))
  }

  const results: R[] = []
  let nextIndex = 0
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await fn(items[index], index)
      }
    })
  )
  return results
}
