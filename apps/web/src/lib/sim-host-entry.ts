import { startSimFrame } from './sim-frame'
import { prepareSimHostDocument, readSimHostConfiguration } from './sim-host-configuration'

type Runtime = {
  mount(options: {
    container: HTMLElement
    engine: { entryUrl: string; version: string }
    scene: 'home' | 'work'
    character?: string
    onClose: () => void
    onCharacterSave: (character: string) => Promise<boolean>
    onOpenRoomDesigner: () => void
    onOpenCharacterDesigner: () => void
  }): Promise<{ unmount(): void }>
}

const root = document.getElementById('sim')
const configuration = (await prepareSimHostDocument(window))
  ? await readSimHostConfiguration(window)
  : null
if (
  root &&
  Array.isArray(configuration?.parentOrigins) &&
  configuration?.parentOrigins.every((value) => typeof value === 'string')
) {
  startSimFrame({
    window,
    parentOrigins: configuration.parentOrigins,
    // Only a host explicitly configured for loopback can opt into local HTTP.
    allowLoopbackHttp: configuration.allowLoopbackHttp === true,
    exchange: async (body, signal) => {
      const response = await fetch('/session', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) return false
      const result = (await response.json()) as { status?: unknown }
      return result.status === 'session'
    },
    mount: async (launch, scene, onClose, actions) => {
      const response = await fetch('/assets/agent-sim/engine.json', {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      })
      if (!response.ok) throw new Error('Engine unavailable')
      const manifest = (await response.json()) as {
        version?: unknown
        surfaces?: Record<string, unknown>
      }
      if (typeof manifest.version !== 'string' || !manifest.version)
        throw new Error('Invalid engine manifest')
      const entry = launch.surface === 'hq' ? 'engine.js' : manifest.surfaces?.[launch.surface]
      if (typeof entry !== 'string' || !/^[a-z-]+\.js$/.test(entry))
        throw new Error('Surface unavailable')
      const entryUrl = `/assets/agent-sim/${entry}`
      await import(/* @vite-ignore */ entryUrl)
      const runtimeWindow = window as unknown as {
        __adeaAgentSim?: Runtime
        adeaAgentSimSurfaces?: Record<string, Runtime>
      }
      const runtime =
        launch.surface === 'hq'
          ? runtimeWindow.__adeaAgentSim
          : runtimeWindow.adeaAgentSimSurfaces?.[launch.surface]
      if (!runtime?.mount) throw new Error('Engine did not register')
      return runtime.mount({
        container: root,
        engine: { entryUrl, version: manifest.version },
        scene,
        character: launch.character,
        onClose,
        onCharacterSave: actions.saveCharacter,
        onOpenRoomDesigner: () => actions.navigate('room-designer'),
        onOpenCharacterDesigner: () => actions.navigate('character-designer'),
      })
    },
  })
}
