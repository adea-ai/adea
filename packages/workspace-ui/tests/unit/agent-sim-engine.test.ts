import { describe, expect, test } from 'bun:test'
import { loadAgentSimEngine, type AgentSimRuntimeGlobal } from '../../src/agent-sim-engine'

type RegistryWindow = typeof window & {
  __adeaAgentSim?: AgentSimRuntimeGlobal
  adeaAgentSimSurfaces?: Partial<Record<string, AgentSimRuntimeGlobal>>
}

const ORIGIN = 'https://adea.dev'

function fakeWindow(scriptUrls: string[], registry: Partial<RegistryWindow>) {
  const listeners = new Map<string, Array<() => void>>()
  const targetWindow = {
    document: {
      createElement() {
        return {
          set type(value: string) {
            void value
          },
          set src(value: string) {
            scriptUrls.push(value)
          },
          addEventListener(event: string, handler: () => void) {
            const forEvent = listeners.get(event) ?? []
            forEvent.push(handler)
            listeners.set(event, forEvent)
          },
        }
      },
      head: { appendChild() {} },
    },
    ...registry,
  }
  return {
    targetWindow: targetWindow as unknown as Pick<Window, 'document'>,
    emit(event: 'load' | 'error') {
      for (const handler of listeners.get(event) ?? []) handler()
    },
    registry,
  }
}

describe('loadAgentSimEngine', () => {
  test('loads the HQ entry and resolves window.__adeaAgentSim', async () => {
    const scriptUrls: string[] = []
    const fake = fakeWindow(scriptUrls, {
      __adeaAgentSim: { mount: async () => ({ unmount() {} }) },
    })
    const pending = loadAgentSimEngine(
      { entryUrl: `${ORIGIN}/assets/agent-sim/engine.js`, version: '0.13.2' },
      { targetWindow: fake.targetWindow }
    )
    fake.emit('load')
    expect(await pending).toBeFunction()
    expect(scriptUrls).toEqual([`${ORIGIN}/assets/agent-sim/engine.js`])
  })

  test('loads a designer surface from the manifest and its registry global', async () => {
    const scriptUrls: string[] = []
    const fake = fakeWindow(scriptUrls, {
      adeaAgentSimSurfaces: { 'room-designer': { mount: async () => ({ unmount() {} }) } },
    })
    const pending = loadAgentSimEngine(
      {
        entryUrl: `${ORIGIN}/assets/agent-sim/engine.js`,
        version: '0.13.2',
        surfaces: { 'room-designer': `${ORIGIN}/assets/agent-sim/room-designer.js` },
      },
      { targetWindow: fake.targetWindow, surface: 'room-designer' }
    )
    fake.emit('load')
    expect(await pending).toBeFunction()
    expect(scriptUrls).toEqual([`${ORIGIN}/assets/agent-sim/room-designer.js`])
  })

  test('rejects surfaces the pack does not ship', async () => {
    const scriptUrls: string[] = []
    const fake = fakeWindow(scriptUrls, {})
    await expect(
      loadAgentSimEngine(
        { entryUrl: `${ORIGIN}/assets/agent-sim/engine.js`, version: '0.13.1' },
        { targetWindow: fake.targetWindow, surface: 'character-designer' }
      )
    ).rejects.toThrow(/does not ship the character-designer surface/)
    expect(scriptUrls).toEqual([])
  })

  test('rejects the HQ entry when it never registers a mount API', async () => {
    const scriptUrls: string[] = []
    const fake = fakeWindow(scriptUrls, {})
    const pending = loadAgentSimEngine(
      { entryUrl: `${ORIGIN}/assets/agent-sim/engine.js`, version: '0.13.2' },
      { targetWindow: fake.targetWindow }
    )
    fake.emit('load')
    await expect(pending).rejects.toThrow(/did not register a mount API/)
  })
})
