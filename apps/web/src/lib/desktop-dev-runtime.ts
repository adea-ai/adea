import { buildDevCommand } from '@adea-ai/dev-view/browser'
import {
  createUnavailableDevRuntimeService,
  type DevRuntimeService,
} from '@adea-ai/dev-view/platform'
import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'

type DesktopBridge = {
  devExecute?: (command: DevCommand) => Promise<DevReply>
}

declare global {
  interface Window {
    __adeaDesktop?: DesktopBridge
    __ADEA_DEV_SCOPE__?: Scope
  }
}

/**
 * Binds Dev View to the shell's authenticated channel. The bridge is injected
 * only into the packaged desktop window; a normal web tab remains explicitly
 * unavailable rather than attempting a direct loopback connection.
 */
export function createDesktopDevRuntimeService(options: { scope?: Scope } = {}): DevRuntimeService {
  const unavailable = createUnavailableDevRuntimeService({ reason: 'channel_unauthenticated' })
  const bridge = typeof window === 'undefined' ? undefined : window.__adeaDesktop
  const execute = bridge?.devExecute
  const scope =
    options.scope ?? (typeof window === 'undefined' ? undefined : window.__ADEA_DEV_SCOPE__)

  if (!execute) return unavailable

  return {
    state: () => ({ status: 'ready' }),
    preferenceScope: () => scope,
    capabilitySnapshot: async (requestedScope) => {
      const command = buildDevCommand({
        operation: 'dev.capability.snapshot',
        scope: requestedScope,
        body: {},
      })
      return readSnapshot(await execute(command), requestedScope)
    },
    execute: async (command) => {
      try {
        return await execute(command)
      } catch (error) {
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: false,
          error: {
            code: 'channel_unauthenticated',
            retryable: true,
            message:
              error instanceof Error ? error.message : 'authenticated desktop channel failed',
            observedAt: new Date().toISOString(),
          },
        }
      }
    },
  }
}

function readSnapshot(reply: DevReply, scope: Scope) {
  if (!reply.ok) {
    return {
      scope,
      granted: [],
      unavailable: [],
      channelGeneration: 0,
      observedAt: new Date().toISOString(),
    }
  }
  return reply.value as Awaited<ReturnType<DevRuntimeService['capabilitySnapshot']>>
}
