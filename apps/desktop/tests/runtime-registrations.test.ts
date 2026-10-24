// Recomposing the Dev Runtime host must never leave the previous runtime's
// command and stream providers callable. The shell's authority and gateway
// outlive every composition; before the registrar, a composition that failed
// (the OS credential store refused the vault) registered nothing new, so a
// fresh authorized handshake after an A -> B -> A scope switch could still run
// the stale runtime A closures with no host behind them.
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, test } from 'bun:test'

import {
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
  type DevReply,
} from '../../../packages/types/src/dev-runtime'

import {
  createChannelAuthority,
  INTERNAL_DISPATCH_MARKER,
} from '../shell/src/dev-runtime/channel/authority'
import { createChannelGateway } from '../shell/src/dev-runtime/channel/server'
import { createRuntimeRegistrar } from '../shell/src/bun/runtime-registrations'
import { scope } from './worktree-fixtures'

const SHELL_ORIGIN = 'https://127.0.0.1:4789'

function command(operation: DevOperation): DevCommand {
  const definition = devOperationDefinitions[operation]
  return {
    schemaVersion: 1,
    operation,
    requestId: randomUUID(),
    nonce: Buffer.from(randomBytes(16)).toString('base64url'),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scope,
    capabilities: [...definition.capabilities],
    body: {},
  }
}

function world() {
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1',
    shellOrigin: SHELL_ORIGIN,
  })
  const gateway = createChannelGateway({
    authority,
    invoke: () => ({ ok: true, value: null }),
    shellOrigin: SHELL_ORIGIN,
  })
  const registrar = createRuntimeRegistrar({ authority, gateway })
  const calls: string[] = []
  const dispatch = (operation: DevOperation): Promise<DevReply> =>
    authority.dispatchLocal(INTERNAL_DISPATCH_MARKER, command(operation))

  /** One host composition: registers a command and a stream under a label. */
  function composeRuntime(label: string, options: { refused?: boolean } = {}) {
    return registrar.compose(({ authority: registered, gateway: registeredGateway }) => {
      // The real composition registers its providers before it can fail
      // partway; the credential refusal happens while it opens the vault, so
      // a refused composition may register nothing or only some providers.
      if (options.refused) {
        registered.registerCommandProvider('dev.project.list', () => {
          calls.push(`${label}:partial`)
          return { items: [] }
        })
        throw new Error('credential store unavailable')
      }
      registered.registerCommandProvider('dev.project.list', () => {
        calls.push(`${label}:project.list`)
        return { items: [] }
      })
      registered.registerStreamProvider('terminal-bytes-v1')
      registeredGateway.registerStreamHandler('terminal-bytes-v1', () => {
        calls.push(`${label}:stream`)
      })
      return label
    })
  }
  return { authority, gateway, registrar, calls, dispatch, composeRuntime }
}

describe('Dev Runtime host registrations across recomposition', () => {
  test('a credential refusal after a successful composition retires the old runtime', async () => {
    const w = world()
    // Scope A composes and serves.
    w.composeRuntime('A')
    expect((await w.dispatch('dev.project.list')).ok).toBe(true)
    expect(w.calls).toEqual(['A:project.list'])
    expect(w.authority.hasStreamProvider('terminal-bytes-v1')).toBe(true)

    // Switching to scope B: the keychain now refuses. No host, nothing registered.
    expect(() => w.composeRuntime('B', { refused: true })).toThrow('credential store unavailable')

    // A fresh authorized dispatch can no longer reach A's closures, and nor can
    // B's partial registration: both operations refuse typed-unavailable.
    const refused = await w.dispatch('dev.project.list')
    expect(refused).toMatchObject({ ok: false, error: { code: 'capability_unavailable' } })
    expect(w.calls).toEqual(['A:project.list'])
    expect(w.authority.hasStreamProvider('terminal-bytes-v1')).toBe(false)
    expect(w.authority.registeredOperations()).toEqual([])

    // Switching back to A while the keychain still refuses stays closed.
    expect(() => w.composeRuntime('A2', { refused: true })).toThrow()
    expect(await w.dispatch('dev.project.list')).toMatchObject({ ok: false })
    expect(w.calls).toEqual(['A:project.list'])
  })

  test('recovery installs fresh providers, never the retired ones', async () => {
    const w = world()
    w.composeRuntime('A')
    expect(() => w.composeRuntime('B', { refused: true })).toThrow()

    // The keychain recovers: the next composition serves under its own closures.
    w.composeRuntime('A-recovered')
    expect((await w.dispatch('dev.project.list')).ok).toBe(true)
    expect(w.calls).toEqual(['A-recovered:project.list'])
    expect(w.authority.hasStreamProvider('terminal-bytes-v1')).toBe(true)
  })

  test('a composition that registers less than its predecessor leaves no stale operation', async () => {
    const w = world()
    w.composeRuntime('A')
    // B composes successfully but registers only a command, no stream.
    w.registrar.compose(({ authority: registered }) => {
      registered.registerCommandProvider('dev.project.list', () => {
        w.calls.push('B:project.list')
        return { items: [] }
      })
    })
    expect(w.authority.hasStreamProvider('terminal-bytes-v1')).toBe(false)
    expect((await w.dispatch('dev.project.list')).ok).toBe(true)
    expect(w.calls).toEqual(['B:project.list'])
  })

  test('a provider the shell registered outside a composition survives every retirement', async () => {
    const w = world()
    w.authority.registerCommandProvider('dev.capability.snapshot', () => {
      w.calls.push('shell:snapshot')
      return null
    })
    w.composeRuntime('A')
    expect(() => w.composeRuntime('B', { refused: true })).toThrow()
    w.registrar.retire()
    expect(w.authority.registeredOperations()).toEqual(['dev.capability.snapshot'])
    await w.dispatch('dev.capability.snapshot')
    expect(w.calls).toEqual(['shell:snapshot'])
  })

  test('retiring never removes a registration a later owner made', () => {
    const w = world()
    w.composeRuntime('A')
    const replacement = () => ({ items: [] })
    w.authority.registerCommandProvider('dev.project.list', replacement)
    w.registrar.retire()
    expect(w.authority.registeredOperations()).toEqual(['dev.project.list'])
  })

  describe('stream capability ownership on retirement', () => {
    test('a later registration for the same protocol survives the old composition retiring', () => {
      const w = world()
      w.composeRuntime('A')
      expect(w.authority.hasStreamProvider('terminal-bytes-v1')).toBe(true)

      // The shell (or anything outside the composition) registers the same protocol after A.
      w.authority.registerStreamProvider('terminal-bytes-v1')

      // A's retirement, by recomposition or by retire(), takes only what A registered.
      expect(() => w.composeRuntime('B', { refused: true })).toThrow()
      expect(w.authority.hasStreamProvider('terminal-bytes-v1')).toBe(true)
      w.registrar.retire()
      expect(w.authority.hasStreamProvider('terminal-bytes-v1')).toBe(true)
    })

    test('a stream registration that existed before the composition survives its retirement', () => {
      const w = world()
      w.authority.registerStreamProvider('terminal-bytes-v1')

      w.composeRuntime('A')
      expect(w.authority.hasStreamProvider('terminal-bytes-v1')).toBe(true)
      w.registrar.retire()

      expect(w.authority.hasStreamProvider('terminal-bytes-v1')).toBe(true)
    })

    test('a stream registration outside any composition survives a composition that registers none', () => {
      const w = world()
      w.authority.registerStreamProvider('terminal-bytes-v1')
      w.registrar.compose(() => {})
      expect(() =>
        w.registrar.compose(() => {
          throw new Error('credential store unavailable')
        })
      ).toThrow('credential store unavailable')
      expect(w.authority.hasStreamProvider('terminal-bytes-v1')).toBe(true)
    })

    test('stale-runtime cleanup still removes a stream nobody else owns', () => {
      const w = world()
      w.composeRuntime('A')
      w.authority.registerStreamProvider('browser-frames-v1')
      w.registrar.retire()
      // A's own protocol is gone; the other owner's is untouched.
      expect(w.authority.hasStreamProvider('terminal-bytes-v1')).toBe(false)
      expect(w.authority.hasStreamProvider('browser-frames-v1')).toBe(true)
    })

    test('retiring the same registration twice removes nothing it does not own', () => {
      const w = world()
      const first = w.authority.registerStreamProvider('terminal-bytes-v1')
      const second = w.authority.registerStreamProvider('terminal-bytes-v1')
      w.authority.unregisterStreamProvider('terminal-bytes-v1', first)
      w.authority.unregisterStreamProvider('terminal-bytes-v1', first)
      expect(w.authority.hasStreamProvider('terminal-bytes-v1')).toBe(true)
      w.authority.unregisterStreamProvider('terminal-bytes-v1', second)
      expect(w.authority.hasStreamProvider('terminal-bytes-v1')).toBe(false)
    })
  })
})
