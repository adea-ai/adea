import { invoke } from './platform/bridge'
import type { CapabilityProvider, CapabilitySnapshot } from '@adea-ai/workspace-ui'

/**
 * Local capability health as the native shell reports it. The shell caches the
 * snapshot behind a re-probe floor, so `force` is a user-visible refresh rather
 * than something a poll should pass.
 */
export const desktopCapabilityProvider: CapabilityProvider = Object.freeze({
  snapshot(options) {
    return invoke<CapabilitySnapshot>('capability_snapshot', { force: options?.force ?? false })
  },
})
