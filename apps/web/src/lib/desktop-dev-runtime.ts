import {
  createUnavailableDevRuntimeService,
  type DevRuntimeService,
} from '@adea-ai/dev-view/platform'

/**
 * Non-authoritative M12 seam. The generic desktop invoke bridge is explicitly
 * not a Dev Runtime authorization boundary, so this remains unavailable until
 * the M10/M11 authenticated command channel is integrated.
 */
export function createDesktopDevRuntimeService(): DevRuntimeService {
  return createUnavailableDevRuntimeService({ reason: 'channel_unauthenticated' })
}
