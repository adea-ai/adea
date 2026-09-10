import { env } from 'cloudflare:workers'
import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { createPreviewGateway } from './gateway.mjs'

type PreviewBindings = {
  ADEA_LEGACY_BACKEND?: { fetch(request: Request): Promise<Response> }
  ASSETS?: { fetch(request: Request): Promise<Response> }
}

export default createServerEntry({
  fetch(request) {
    const bindings = env as unknown as PreviewBindings
    return createPreviewGateway({
      backend: bindings.ADEA_LEGACY_BACKEND
        ? (input) => bindings.ADEA_LEGACY_BACKEND!.fetch(input)
        : undefined,
      assets: bindings.ASSETS ? (input) => bindings.ASSETS!.fetch(input) : undefined,
      application: (input) => handler.fetch(input),
    })(request)
  },
})
