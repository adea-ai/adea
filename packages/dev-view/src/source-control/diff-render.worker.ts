/*
 * The diff render worker entry (#677). One message in, one message out; the
 * heavy work — grouping the diff page into per-file hunk lists and rendering
 * every hunk's line payload — runs here instead of on the UI thread. The
 * compute itself lives in `diff-render-model.ts` so the client can reproduce
 * the exact same result on the main thread as the typed fallback.
 */
import type { DiffRenderReply, DiffRenderRequest } from './diff-render-protocol'
import { computeDiffRender } from './diff-render-model'

// A dedicated worker answers through `self.postMessage`, which takes no
// targetOrigin (that parameter belongs to Window.postMessage); the bound
// reference keeps the worker-semantics call site in one place.
const postMessage = (self as unknown as Worker).postMessage.bind(self)

self.addEventListener('message', (event: MessageEvent<DiffRenderRequest>) => {
  const request = event.data
  let reply: DiffRenderReply
  try {
    reply = { id: request.id, ok: true, files: computeDiffRender(request) }
  } catch {
    // A compute failure is a typed refusal; the client falls back to the
    // main-thread path rather than treating silence as success.
    reply = { id: request.id, ok: false }
  }
  void Promise.resolve().then(() => {
    postMessage(reply)
  })
})
