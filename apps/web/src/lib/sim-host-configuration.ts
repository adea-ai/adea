/** A frame discarded during its configuration read has no host to notify. */
export async function readSimHostConfiguration(
  lifecycle: EventTarget,
  request: (input: string, init: RequestInit) => Promise<Response> = fetch
): Promise<{ parentOrigins?: unknown; allowLoopbackHttp?: unknown } | null> {
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
    return controller.signal.aborted ? null : configuration
  } catch (error) {
    if (controller.signal.aborted) return null
    throw error
  } finally {
    lifecycle.removeEventListener('pagehide', dispose)
  }
}
