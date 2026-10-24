// The Dev Runtime host registers its command and stream providers on the
// shell's long-lived channel authority and gateway. Those two outlive every
// composition, so a provider the previous composition registered stays
// callable after that composition is gone: a recomposition that fails (the OS
// credential store refuses the vault) registers nothing new, and the old
// runtime's closures would keep serving a fresh, authorized handshake with no
// host behind them.
//
// This registrar owns exactly what the host composition registers. Before each
// recomposition it retires the previous composition's registrations, and it
// retires a failed composition's partial registrations too. Anything the shell
// registered outside a composition is never touched.
import type { DevOperation, DevStreamProtocol } from '../../../../../packages/types/src/dev-runtime'
import type { ChannelAuthority, StreamProviderRegistration } from '../dev-runtime/channel/authority'
import type { ChannelGateway } from '../dev-runtime/channel/server'

type CommandHandler = Parameters<ChannelAuthority['registerCommandProvider']>[1]
type StreamHandler = Parameters<ChannelGateway['registerStreamHandler']>[1]

/** What the composition is allowed to register on, and nothing it can retire itself. */
export interface RuntimeRegistrationSurface<
  A extends ChannelAuthority = ChannelAuthority,
  G extends ChannelGateway = ChannelGateway,
> {
  authority: A
  gateway: G
}

export function createRuntimeRegistrar<
  A extends ChannelAuthority = ChannelAuthority,
  G extends ChannelGateway = ChannelGateway,
>(shell: RuntimeRegistrationSurface<A, G>) {
  let active: { retire: () => void } | undefined

  function track(): { surface: RuntimeRegistrationSurface<A, G>; retire: () => void } {
    // Commands and stream handlers: last registration per key wins, matching the
    // maps they were written to. Stream capabilities are held per registration.
    const commands = new Map<DevOperation, CommandHandler>()
    // Each stream registration keeps its own token, so retiring removes exactly
    // what this composition registered and never a protocol another owner holds.
    const streamRegistrations: Array<{
      protocol: DevStreamProtocol
      registration: StreamProviderRegistration
    }> = []
    const streamHandlers = new Map<string, StreamHandler>()
    const authority: A = {
      ...shell.authority,
      registerCommandProvider: (operation: DevOperation, handler: CommandHandler) => {
        shell.authority.registerCommandProvider(operation, handler)
        commands.set(operation, handler)
      },
      registerStreamProvider: (protocol: DevStreamProtocol) => {
        const registration = shell.authority.registerStreamProvider(protocol)
        streamRegistrations.push({ protocol, registration })
        return registration
      },
    }
    const gateway: G = {
      ...shell.gateway,
      registerStreamHandler: (protocol: string, handler: StreamHandler) => {
        shell.gateway.registerStreamHandler(protocol, handler)
        streamHandlers.set(protocol, handler)
      },
    }
    return {
      surface: { authority, gateway },
      retire: () => {
        for (const [operation, handler] of commands)
          shell.authority.unregisterCommandProvider(operation, handler)
        for (const { protocol, registration } of streamRegistrations)
          shell.authority.unregisterStreamProvider(protocol, registration)
        for (const [protocol, handler] of streamHandlers)
          shell.gateway.unregisterStreamHandler(protocol, handler)
        commands.clear()
        streamRegistrations.length = 0
        streamHandlers.clear()
      },
    }
  }

  return {
    /**
     * Runs one composition. The previous composition's registrations are retired
     * first, so a composition that registers fewer operations than its
     * predecessor, or fails, leaves nothing of the old runtime callable. A
     * failure retires its own partial registrations and rethrows.
     */
    compose<T>(build: (surface: RuntimeRegistrationSurface<A, G>) => T): T {
      active?.retire()
      active = undefined
      const registration = track()
      try {
        const result = build(registration.surface)
        active = registration
        return result
      } catch (error) {
        registration.retire()
        throw error
      }
    },
    /** Retires the current composition's registrations, if any. */
    retire(): void {
      active?.retire()
      active = undefined
    },
  }
}
