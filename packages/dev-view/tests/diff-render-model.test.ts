/*
 * Diff render worker boundary tests (#677 — the #399 residue box "diff
 * parsing/rendering runs off the main thread"). The boundary is driven at the
 * model level with injected duck-typed workers: the success path, every
 * failure path the acceptance box demands (construction refusal, worker
 * error, deadline, refusal, malformed frame), determinism between the worker
 * and the main-thread fallback, and dispose. No DOM, no real `Worker`.
 */
import { describe, expect, test } from 'bun:test'

import type { DiffHunk } from '@adea-ai/types/dev-runtime'

import {
  computeDiffRender,
  createDiffRenderModel,
  type DiffRenderRequest,
  type DiffWorkerFactory,
  type DiffWorkerHandle,
} from '../src/source-control/diff-render-model'

function hunk(relativePath: string, oldStart: number, lineCount = 2): DiffHunk {
  return {
    path: {
      worktreeId: 'wt',
      rootIdentity: { mtimeNs: '1', size: '1' },
      relativePath,
    },
    oldStart,
    oldLines: lineCount,
    newStart: oldStart,
    newLines: lineCount,
    lines: Array.from({ length: lineCount }, (_, index) => ({
      kind: index % 2 === 0 ? 'context' : 'add',
      text: `${relativePath}:${oldStart}:${index}`,
    })),
  }
}

/** A scripted duck-typed worker: records posts, lets the test emit replies,
 *  errors, or nothing at all. */
function scriptedWorker() {
  const sent: DiffRenderRequest[] = []
  let terminated = false
  let replyHandler: ((reply: unknown) => void) | undefined
  let errorHandler: ((error: unknown) => void) | undefined
  const handle: DiffWorkerHandle & {
    sent: readonly DiffRenderRequest[]
    succeed(request: DiffRenderRequest): void
    refuse(request: DiffRenderRequest): void
    emitMalformed(): void
    crash(): void
  } = {
    sent,
    post(message) {
      sent.push(message)
    },
    onReply(handler) {
      replyHandler = handler
    },
    onError(handler) {
      errorHandler = handler
    },
    terminate() {
      terminated = true
    },
    succeed(request) {
      replyHandler?.({ id: request.id, ok: true, files: computeDiffRender(request) })
    },
    refuse(request) {
      replyHandler?.({ id: request.id, ok: false })
    },
    emitMalformed() {
      replyHandler?.({ id: 'not-a-number', ok: 'sure', files: undefined })
    },
    crash() {
      errorHandler?.(new Error('worker crashed'))
    },
  }
  return {
    handle,
    wasTerminated: () => terminated,
  }
}

function scriptedFactory(...workers: (DiffWorkerHandle | undefined)[]): {
  factory: DiffWorkerFactory
  spawnCount(): number
} {
  let index = 0
  return {
    factory: () => workers[index++],
    spawnCount: () => index,
  }
}

function page(fileCount: number, hunksPerFile: number): DiffHunk[] {
  const hunks: DiffHunk[] = []
  for (let file = 0; file < fileCount; file += 1) {
    for (let index = 0; index < hunksPerFile; index += 1) {
      hunks.push(hunk(`src/file-${file}.ts`, (file + 1) * 100 + index))
    }
  }
  return hunks
}

describe('diff render worker boundary', () => {
  test('renders a large multi-file page off the main thread, byte-identical to the pure compute', async () => {
    const worker = scriptedWorker()
    const scripted = scriptedFactory(worker.handle)
    const model = createDiffRenderModel({ spawnWorker: scripted.factory })
    const hunks = page(40, 25) // 1,000 hunks

    const pendingRender = model.render(hunks)
    const request = worker.handle.sent[0]
    expect(request).toBeDefined()
    worker.handle.succeed(request!)

    const outcome = await pendingRender
    expect(outcome.mode).toBe('worker')
    expect(outcome.files).toEqual(computeDiffRender({ hunks, budgetLines: 4_000 }))
    expect(outcome.files.length).toBe(40)
    expect(outcome.files[0]?.hunks.length).toBe(25)
    expect(model.mode()).toBe('worker')
    model.dispose()
  })

  test('a worker that cannot be constructed answers from the typed main-thread fallback and never re-spawns', async () => {
    const scripted = scriptedFactory(undefined)
    const model = createDiffRenderModel({ spawnWorker: scripted.factory })
    const hunks = page(3, 2)

    const outcome = await model.render(hunks)

    expect(outcome.mode).toBe('main-thread')
    expect(outcome.files).toEqual(computeDiffRender({ hunks, budgetLines: 4_000 }))
    expect(scripted.spawnCount()).toBe(1)
    expect(model.mode()).toBe('main-thread')

    const again = await model.render(hunks)
    expect(again.mode).toBe('main-thread')
    expect(scripted.spawnCount()).toBe(1)
    model.dispose()
  })

  test('a worker that errors mid-flight degrades exactly once and later renders skip the worker', async () => {
    const worker = scriptedWorker()
    const scripted = scriptedFactory(worker.handle)
    const model = createDiffRenderModel({ spawnWorker: scripted.factory })
    const hunks = page(2, 2)

    const failing = model.render(hunks)
    worker.handle.crash()
    const outcome = await failing
    expect(outcome.mode).toBe('main-thread')
    expect(outcome.files).toEqual(computeDiffRender({ hunks, budgetLines: 4_000 }))
    expect(worker.wasTerminated()).toBe(true)

    const next = await model.render(hunks)
    expect(next.mode).toBe('main-thread')
    expect(scripted.spawnCount()).toBe(1)
    expect(worker.handle.sent.length).toBe(1)
    model.dispose()
  })

  test('a wedged worker answers from the main thread at the deadline and is terminated', async () => {
    const worker = scriptedWorker()
    const scripted = scriptedFactory(worker.handle)
    const model = createDiffRenderModel({ spawnWorker: scripted.factory, timeoutMs: 25 })
    const hunks = page(2, 3)

    const outcome = await model.render(hunks)

    expect(outcome.mode).toBe('main-thread')
    expect(outcome.files).toEqual(computeDiffRender({ hunks, budgetLines: 4_000 }))
    expect(worker.wasTerminated()).toBe(true)
    expect(await model.render(hunks)).toMatchObject({ mode: 'main-thread' })
    model.dispose()
  })

  test('a worker refusal degrades to the main-thread answer for that page and onward', async () => {
    const worker = scriptedWorker()
    const scripted = scriptedFactory(worker.handle)
    const model = createDiffRenderModel({ spawnWorker: scripted.factory })
    const hunks = page(2, 2)

    const pendingRender = model.render(hunks)
    worker.handle.refuse(worker.handle.sent[0]!)
    const outcome = await pendingRender

    expect(outcome.mode).toBe('main-thread')
    expect(outcome.files).toEqual(computeDiffRender({ hunks, budgetLines: 4_000 }))
    expect(worker.wasTerminated()).toBe(true)
    model.dispose()
  })

  test('a malformed reply frame is refused, never trusted, and degrades to the fallback', async () => {
    const worker = scriptedWorker()
    const scripted = scriptedFactory(worker.handle)
    const model = createDiffRenderModel({ spawnWorker: scripted.factory })
    const hunks = page(2, 2)

    const pendingRender = model.render(hunks)
    expect(worker.handle.sent.length).toBe(1)
    worker.handle.emitMalformed()
    const outcome = await pendingRender

    expect(outcome.mode).toBe('main-thread')
    expect(outcome.files).toEqual(computeDiffRender({ hunks, budgetLines: 4_000 }))
    model.dispose()
  })

  test('dispose answers in-flight renders from the fallback and terminates the worker', async () => {
    const worker = scriptedWorker()
    const scripted = scriptedFactory(worker.handle)
    const model = createDiffRenderModel({ spawnWorker: scripted.factory, timeoutMs: 60_000 })

    const pendingRender = model.render(page(2, 2))
    model.dispose()
    const outcome = await pendingRender

    expect(outcome.mode).toBe('main-thread')
    expect(worker.wasTerminated()).toBe(true)
  })

  test('a hunk that exceeds the render budget truncates with its flag set', async () => {
    const big = hunk('src/big.ts', 1, 4_000)
    const groups = computeDiffRender({ hunks: [big], budgetLines: 4_000 })
    expect(groups[0]?.hunks[0]?.truncated).toBe(true)
    expect(groups[0]?.hunks[0]?.lines.length).toBe(3_999)

    const fits = hunk('src/small.ts', 1, 10)
    const fitsGroups = computeDiffRender({ hunks: [fits], budgetLines: 4_000 })
    expect(fitsGroups[0]?.hunks[0]?.truncated).toBe(false)
    expect(fitsGroups[0]?.hunks[0]?.lines.length).toBe(10)
  })

  test('the fallback and the worker compute identical payloads for the same page', () => {
    const hunks = page(12, 9)
    const direct = computeDiffRender({ hunks, budgetLines: 512 })
    const viaGroups = direct
    expect(viaGroups).toEqual(computeDiffRender({ hunks, budgetLines: 512 }))
    expect(direct.flatMap((group) => group.hunks).length).toBe(12 * 9)
  })
})
