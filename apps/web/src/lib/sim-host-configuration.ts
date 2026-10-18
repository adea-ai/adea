/** A frame discarded during its configuration read has no host to notify. */
export async function readSimHostConfiguration(
  lifecycle: EventTarget & { readonly closed?: boolean },
  request: (input: string, init: RequestInit) => Promise<Response> = fetch
): Promise<{ parentOrigins?: unknown; allowLoopbackHttp?: unknown } | null> {
  if (lifecycle.closed) return null
  const controller = new AbortController()
  const dispose = () => controller.abort()
  lifecycle.addEventListener('pagehide', dispose, { once: true })
  try {
    const response = await request('/configuration', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
    const configuration = (await response.json()) as {
      parentOrigins?: unknown
      allowLoopbackHttp?: unknown
    }
    return controller.signal.aborted || lifecycle.closed ? null : configuration
  } catch (error) {
    if (controller.signal.aborted || lifecycle.closed) return null
    throw error
  } finally {
    lifecycle.removeEventListener('pagehide', dispose)
  }
}

/** Let the embedding app process the native load before starting network work. */
export function prepareSimHostDocument(lifecycle: Window): Promise<boolean> {
  return new Promise((resolveReady) => {
    let paint: number | undefined
    let fallback: number | undefined
    let finished = false
    const finish = (ready: boolean) => {
      if (finished) return
      finished = true
      lifecycle.removeEventListener('load', loaded)
      lifecycle.removeEventListener('pagehide', hidden)
      if (paint !== undefined) lifecycle.cancelAnimationFrame(paint)
      if (fallback !== undefined) lifecycle.clearTimeout(fallback)
      resolveReady(ready)
    }
    const loaded = () => {
      paint = lifecycle.requestAnimationFrame(() => finish(!lifecycle.closed))
      // Hidden documents can suspend paints. The next task still lets the
      // embedding app finish native load handling before configuration work.
      fallback = lifecycle.setTimeout(() => finish(!lifecycle.closed), 0)
    }
    const hidden = () => finish(false)
    lifecycle.addEventListener('pagehide', hidden, { once: true })
    if (lifecycle.closed) finish(false)
    else if (lifecycle.document.readyState === 'complete') loaded()
    else lifecycle.addEventListener('load', loaded, { once: true })
  })
}
