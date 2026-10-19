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

/**
 * The number of pre-attach URLs the channel holds. A callback URL is short and
 * a burst before the receiver exists is at most a few duplicates of one
 * attempt, so a small bound is generous; anything beyond it is dropped rather
 * than buffered without limit.
 */
export const DESKTOP_AUTH_CALLBACK_MAX_BUFFERED = 8
/**
 * The longest URL the channel will accept. A real callback is well under this;
 * the bound keeps an oversized or hostile `open-url` payload from being held or
 * parsed.
 */
export const DESKTOP_AUTH_CALLBACK_MAX_URL_LENGTH = 2048

export interface DesktopAuthCallbackChannel {
  /** Attach the receiver; URLs captured before now (cold launch) drain first. */
  attach(receive: (rawUrl: string) => void): void
  dispose(): void
}

/**
 * Subscribe to Electrobun's `open-url` event and forward callback URLs to the
 * receiver attached with `attach`.
 *
 * URLs are ingested on a bounded buffer: a URL longer than
 * `DESKTOP_AUTH_CALLBACK_MAX_URL_LENGTH` is dropped, and once
 * `DESKTOP_AUTH_CALLBACK_MAX_BUFFERED` URLs are held, further pre-attach URLs
 * are dropped (the buffer never grows). Dropping is safe because duplicate
 * deliveries of one attempt are already refused as replay downstream.
 */
export function createDesktopAuthCallbackChannel(
  app: DesktopAuthCallbackOpenUrlApp
): DesktopAuthCallbackChannel {
  const pending: string[] = []
  let receive: ((rawUrl: string) => void) | undefined

  const unsubscribe = app.on('open-url', (payload) => {
    const url = typeof payload?.url === 'string' ? payload.url : ''
    if (url === '' || url.length > DESKTOP_AUTH_CALLBACK_MAX_URL_LENGTH) return
    if (receive) {
      receive(url)
      return
    }
    if (pending.length >= DESKTOP_AUTH_CALLBACK_MAX_BUFFERED) return
    pending.push(url)
  })

  return {
    attach(next) {
      receive = next
      while (pending.length > 0) next(pending.shift()!)
    },
    dispose() {
      receive = undefined
      pending.length = 0
      if (typeof unsubscribe === 'function') unsubscribe()
    },
  }
}
