import type { DevRuntimeService } from '@adea-ai/dev-view/platform'

/**
 * Non-authoritative M12 seam. The generic desktop invoke bridge is explicitly
 * not a Dev Runtime authorization boundary, so this remains unavailable until
 * the M10/M11 authenticated command channel is integrated. Its implementation
 * is imported only if Dev asks for a capability/command, preserving the cold
 * Chat/Virtual graph.
 */
export function createDesktopDevRuntimeService(): DevRuntimeService {
  const unavailable = async () => {
    const { createUnavailableDevRuntimeService } = await import('@adea-ai/dev-view/platform')
    return createUnavailableDevRuntimeService({ reason: 'channel_unauthenticated' })
  }
  return {
    state: () => ({ status: 'unavailable', reason: 'channel_unauthenticated' }),
    capabilitySnapshot: async (scope) => (await unavailable()).capabilitySnapshot(scope),
    execute: async (command) => (await unavailable()).execute(command),
  }
}
