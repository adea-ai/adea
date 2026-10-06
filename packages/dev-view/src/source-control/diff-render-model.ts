/*
 * Off-main-thread diff render boundary (#677 — the last open #399 residue
 * box). The Dev View bundle now owns one module worker that groups and
 * renders large diff pages; the client model in this file is the boundary's
 * contract:
 *
 * - the worker is constructed lazily through an injectable factory, so model
 *   tests drive success, error, timeout and refusal cases without a DOM;
 * - a worker that cannot be constructed, errors mid-flight, misses its
 *   deadline, or replies with a malformed frame degrades EXACTLY ONCE to the
 *   typed main-thread path — the same pure compute, so the fallback result is
 *   byte-identical to the worker's;
 * - `render` always resolves. There is no silent hang and no unhandled
 *   rejection: every failure lands in a typed outcome the surface can state.
 */
import type { DiffHunk } from '@adea-ai/types/dev-runtime'
import type { DiffRenderReply, DiffRenderRequest, RenderedFileGroup } from './diff-render-protocol'
import { isDiffRenderReply } from './diff-render-protocol'
import { renderUnifiedDiff, splitFileHunks } from './source-control-model'

/** The pure compute the worker performs: group the page into per-file hunk
 *  lists and render each hunk's line payload under the budget. Shared by the
 *  worker entry and the main-thread fallback so results cannot drift. */
export function computeDiffRender(
  request: Pick<DiffRenderRequest, 'hunks' | 'budgetLines'>
): readonly RenderedFileGroup[] {
  const groups = splitFileHunks(request.hunks)
  const flatIndex = new Map<DiffHunk, number>()
  request.hunks.forEach((hunk, index) => {
    if (!flatIndex.has(hunk)) flatIndex.set(hunk, index)
  })
  return groups.map((group) => ({
    path: group.path,
    hunks: group.hunks.map((hunk) => {
      const rendered = renderUnifiedDiff([hunk], request.budgetLines)
      const body = rendered.slice(1)
      // The header shares the budget, so a hunk truncates when its header
      // plus lines cannot fit — not when the render happens to fill it.
      return {
        index: flatIndex.get(hunk) ?? -1,
        lines: body,
        truncated: hunk.lines.length + 1 > request.budgetLines,
      }
    }),
  }))
}

/** How the last render was actually produced. `worker` is the off-thread
 *  path; `main-thread` is the typed degraded fallback (worker unavailable,
 *  errored, timed out, or refused). */
export type DiffRenderMode = 'worker' | 'main-thread'

export type DiffRenderOutcome = Readonly<{
  files: readonly RenderedFileGroup[]
  mode: DiffRenderMode
}>

/** The minimal worker surface the model needs. Duck-typed so tests and the
 *  production `Worker` wrapper share one shape (no DOM required). Replies
 *  arrive untyped: the model structurally validates every frame itself. */
export type DiffWorkerHandle = Readonly<{
  post(message: DiffRenderRequest): void
  onReply(handler: (reply: unknown) => void): void
  onError(handler: (error: unknown) => void): void
  terminate(): void
}>

export type DiffWorkerFactory = () => DiffWorkerHandle | undefined

/** Wraps a real module `Worker` into the duck-typed handle. Exported so the
 *  pane's default factory stays one line and tests never touch `Worker`. */
export function wrapBrowserWorker(worker: Worker): DiffWorkerHandle {
  // Worker.postMessage takes no targetOrigin (that parameter belongs to
  // Window.postMessage); the bound reference keeps that semantics in one place.
  const postMessage = worker.postMessage.bind(worker)
  return {
    post: (message) => postMessage(message),
    onReply: (handler) => {
      worker.addEventListener('message', (event: MessageEvent) => {
        handler(event.data)
      })
    },
    onError: (handler) => {
      worker.addEventListener('error', (event: ErrorEvent) => {
        handler(event.error ?? event.message)
        event.preventDefault()
      })
    },
    terminate: () => worker.terminate(),
  }
}

export function defaultDiffWorkerFactory(): DiffWorkerHandle | undefined {
  try {
    return wrapBrowserWorker(
      new Worker(new URL('./diff-render.worker.ts', import.meta.url), { type: 'module' })
    )
  } catch {
    // Construction can throw (CSP, no Worker on the platform): the typed
    // degraded path answers instead.
    return undefined
  }
}

/** The deadline a worker has to answer one diff page before the model
 *  degrades to the main thread. Long enough for page-sized diffs, short
 *  enough that a wedged worker can never hang a pane. */
export const DIFF_RENDER_TIMEOUT_MS = 4_000

/** The main-thread answer: the same pure compute the worker runs. */
function renderOnMainThread(hunks: readonly DiffHunk[], budgetLines: number): DiffRenderOutcome {
  return { files: computeDiffRender({ hunks, budgetLines }), mode: 'main-thread' }
}

export type DiffRenderModel = Readonly<{
  render(hunks: readonly DiffHunk[], budgetLines?: number): Promise<DiffRenderOutcome>
  /** How the most recent render was produced, or the current degradation. */
  mode(): DiffRenderMode
  dispose(): void
}>

export function createDiffRenderModel(options?: {
  spawnWorker?: DiffWorkerFactory
  timeoutMs?: number
}): DiffRenderModel {
  const spawnWorker = options?.spawnWorker ?? defaultDiffWorkerFactory
  const timeoutMs = options?.timeoutMs ?? DIFF_RENDER_TIMEOUT_MS

  let worker: DiffWorkerHandle | undefined
  let degraded = false
  let currentMode: DiffRenderMode = 'worker'
  let nextRequestId = 0
  let disposed = false

  const pending = new Map<
    number,
    {
      resolve: (outcome: DiffRenderOutcome) => void
      timer: ReturnType<typeof setTimeout>
      hunks: readonly DiffHunk[]
      budgetLines: number
    }
  >()

  /** A worker that failed (error, refusal, malformed frame) is terminated and
   *  never retried; every waiter — current and future — is answered from the
   *  typed main-thread path. */
  function degrade(): void {
    degraded = true
    currentMode = 'main-thread'
    if (worker) {
      try {
        worker.terminate()
      } catch {
        // Termination is best-effort; the degraded path is already live.
      }
      worker = undefined
    }
  }

  /** Resolves every in-flight request from the fallback. Map iteration is
   *  deletion-safe for the entry being visited, and degrade has already
   *  stopped new arrivals when this runs. */
  function flushPendingToMainThread(): void {
    for (const [id, waiting] of pending) {
      pending.delete(id)
      clearTimeout(waiting.timer)
      waiting.resolve(renderOnMainThread(waiting.hunks, waiting.budgetLines))
    }
  }

  function ensureWorker(): DiffWorkerHandle | undefined {
    if (degraded || disposed) return undefined
    if (worker) return worker
    const created = spawnWorker()
    if (!created) {
      degrade()
      return undefined
    }
    created.onReply((raw) => {
      if (!isDiffRenderReply(raw)) {
        // A malformed frame means whatever answered is not the render worker.
        degrade()
        flushPendingToMainThread()
        return
      }
      const reply: DiffRenderReply = raw
      const waiting = pending.get(reply.id)
      if (!waiting) return
      pending.delete(reply.id)
      clearTimeout(waiting.timer)
      if (reply.ok) {
        currentMode = 'worker'
        waiting.resolve({ files: reply.files, mode: 'worker' })
      } else {
        // The worker refused the page: degrade once, answer on the thread.
        degrade()
        waiting.resolve(renderOnMainThread(waiting.hunks, waiting.budgetLines))
      }
    })
    created.onError(() => {
      degrade()
      flushPendingToMainThread()
    })
    worker = created
    return worker
  }

  function render(hunks: readonly DiffHunk[], budgetLines = 4_000): Promise<DiffRenderOutcome> {
    const request: DiffRenderRequest = { id: nextRequestId++, hunks, budgetLines }
    const target = ensureWorker()
    if (disposed || !target) return Promise.resolve(renderOnMainThread(hunks, budgetLines))
    return new Promise<DiffRenderOutcome>((resolve) => {
      const timer = setTimeout(() => {
        // A wedged worker degrades the boundary permanently; this request
        // still answers, from the main thread, at the deadline.
        if (pending.delete(request.id)) {
          degrade()
          resolve(renderOnMainThread(hunks, budgetLines))
        }
      }, timeoutMs)
      pending.set(request.id, { resolve, timer, hunks, budgetLines })
      try {
        target.post(request)
      } catch {
        if (pending.delete(request.id)) {
          clearTimeout(timer)
          degrade()
          resolve(renderOnMainThread(hunks, budgetLines))
        }
      }
    })
  }

  return {
    render,
    mode: () => currentMode,
    dispose() {
      disposed = true
      degrade()
      // Dispose never strands a caller: in-flight renders answer from the
      // main-thread path so no await hangs after teardown.
      flushPendingToMainThread()
      pending.clear()
    },
  }
}
