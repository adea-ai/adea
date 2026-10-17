import {
  canonicalBridgeOrigin,
  createCharacterSaveClient,
  parseHostMessage,
  SIM_BRIDGE_CHANNEL,
  SIM_BRIDGE_VERSION,
  type SimFrameMessage,
  type SimHostMessage,
  type SimNavigateTarget,
} from '@adea-ai/spatial/sim-bridge'

type Mount = { unmount(): void }
type Launch = Extract<SimHostMessage, { type: 'host.launch' }>['payload']

/** Hosted-frame lifecycle. Private engine bytes are loaded only after session exchange. */
export function startSimFrame(options: {
  window: Window
  parentOrigins: readonly string[]
  allowLoopbackHttp?: boolean
  exchange: (body: unknown, signal: AbortSignal) => Promise<boolean>
  mount: (
    launch: Launch,
    scene: 'home' | 'work',
    close: () => void,
    actions: {
      saveCharacter(character: string): Promise<boolean>
      navigate(target: SimNavigateTarget): void
    }
  ) => Promise<Mount>
}) {
  const win = options.window
  const fragment = new URLSearchParams(win.location.hash.slice(1))
  const parentOrigin = canonicalBridgeOrigin(fragment.get('parentOrigin'), options)
  const bridgeId = fragment.get('bridgeId') ?? ''
  if (
    !parentOrigin ||
    !options.parentOrigins.includes(parentOrigin) ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(bridgeId) ||
    win.parent === win
  ) {
    return () => {}
  }
  // The fragment has no code or session, and is cleared once its context is captured.
  win.history.replaceState(null, '', win.location.pathname)
  let stopped = false
  let launched = false
  let handle: Mount | undefined
  const abort = new AbortController()
  const post = (message: SimFrameMessage) => {
    if (!stopped)
      win.parent.postMessage(
        { channel: SIM_BRIDGE_CHANNEL, version: SIM_BRIDGE_VERSION, bridgeId, ...message },
        parentOrigin
      )
  }
  const saves = createCharacterSaveClient({ post })
  let navigationId = 0
  const stop = () => {
    if (stopped) return
    stopped = true
    abort.abort()
    saves.dispose()
    handle?.unmount()
    win.removeEventListener('message', message)
    win.removeEventListener('pagehide', stop)
  }
  const message = async (event: MessageEvent) => {
    const parsed = parseHostMessage(event, { parentOrigin, parentWindow: win.parent, bridgeId })
    if (!parsed.ok) return
    saves.receive(parsed.message)
    if (parsed.message.type === 'host.dispose') {
      stop()
      return
    }
    if (parsed.message.type !== 'host.launch') return
    if (launched || stopped) return
    launched = true
    const launch = parsed.message.payload
    if (Date.parse(launch.expiresAt) <= Date.now()) {
      post({ type: 'frame.error', payload: { code: 'launch_rejected' } })
      return
    }
    try {
      const accepted = await options.exchange(
        { schemaVersion: 1, code: launch.code, bridgeId },
        abort.signal
      )
      if (stopped) return
      if (!accepted) {
        post({ type: 'frame.error', payload: { code: 'launch_rejected' } })
        return
      }
      const mounted = await options.mount(
        launch,
        fragment.get('scene') === 'work' ? 'work' : 'home',
        () => post({ type: 'frame.close', payload: {} }),
        {
          saveCharacter: (character) => saves.save(character),
          navigate: (target) =>
            post({
              type: 'frame.navigate',
              payload: { target, requestId: `navigate${++navigationId}` },
            }),
        }
      )
      if (stopped) {
        mounted.unmount()
        return
      }
      handle = mounted
      post({ type: 'frame.state', payload: { state: 'running' } })
    } catch {
      post({ type: 'frame.error', payload: { code: 'engine_failed' } })
    }
  }
  win.addEventListener('message', message)
  win.addEventListener('pagehide', stop)
  post({ type: 'frame.ready', payload: {} })
  return stop
}
