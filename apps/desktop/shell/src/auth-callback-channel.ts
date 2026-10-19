// The native boundary for `adea://auth/callback` (docs/specs/desktop-auth.md
// "The callback"). Electrobun 2.0.1's main-process `app.on('open-url', ...)`
// hands the shell the URL the OS opened, for both a running app (warm delivery,
// including the single-instance reopen) and a launch that carries the URL
// (cold start). The native side buffers a URL that arrives before the shell
// registered its handler, so this channel also buffers anything delivered
// between subscription and the receiver being ready: the shell subscribes at
// the top of its entry (before the boot's awaits) and attaches the receiver
// once the command surface and gateway exist.
//
// The `app` seam is injected rather than imported so the desktop suite can
// exercise cold and warm delivery with a mocked native boundary and without an
// Electrobun runtime.
export type DesktopAuthCallbackOpenUrlApp = Readonly<{
  on(name: 'open-url', handler: (payload: { url?: unknown }) => void): unknown
}>

export interface DesktopAuthCallbackChannel {
  /** Attach the receiver; URLs captured before now (cold launch) drain first. */
  attach(receive: (rawUrl: string) => void): void
  dispose(): void
}

/**
 * Subscribe to Electrobun's `open-url` event and forward callback URLs to the
 * receiver attached with `attach`.
 */
export function createDesktopAuthCallbackChannel(
  app: DesktopAuthCallbackOpenUrlApp
): DesktopAuthCallbackChannel {
  const pending: string[] = []
  let receive: ((rawUrl: string) => void) | undefined

  const unsubscribe = app.on('open-url', (payload) => {
    const url = typeof payload?.url === 'string' ? payload.url : ''
    if (url === '') return
    if (receive) receive(url)
    else pending.push(url)
  })

  return {
    attach(next) {
      receive = next
      while (pending.length > 0) next(pending.shift()!)
    },
    dispose() {
      receive = undefined
      if (typeof unsubscribe === 'function') unsubscribe()
    },
  }
}
