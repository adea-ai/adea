import type { SimEntitlementPolicy } from './sim-entitlement'
import { createSimHostService, type SimHostServiceOptions } from './sim-host-service'

/**
 * The Worker entry for the separately hosted Agent Sim service. It is inert source.
 *
 * Nothing here names a storage engine, a hostname, a binding or a credential, and no deployment
 * configuration points at this module. The default export composes nothing, so every request is
 * `503 not_configured` and no private object is read. An operator who has made the decisions in
 * docs/plans/hosted-sim-approved-service-composition.md supplies a composition that turns the
 * Worker environment into the service ports.
 */

/**
 * The entitlement policy used when a composition supplies none. It answers `not_entitled` for
 * every workspace and surface, so a service composed without an explicit policy serves no private
 * asset.
 */
export const denyAllSimEntitlement: SimEntitlementPolicy = () => 'not_entitled'

/** The service ports a composition supplies. The entitlement policy may be left out; it then denies. */
export type SimHostWorkerPorts = Omit<SimHostServiceOptions, 'policy'> &
  Readonly<{ policy?: SimEntitlementPolicy }>

/**
 * Turns the Worker environment into the service ports. Returning nothing means the service is not
 * configured. Throwing is treated the same way, and the error text is never sent to the caller.
 */
export type SimHostWorkerComposition<Environment> = (
  environment: Environment
) => SimHostWorkerPorts | null | undefined

const HEADERS = {
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}

function notConfigured(): Response {
  return Response.json({ error: 'not_configured' }, { status: 503, headers: HEADERS })
}

/**
 * Builds the Worker. The composition runs for every request, so a bad or missing configuration
 * never leaves a half-built service behind. A malformed host configuration, a missing composition
 * or a throwing one all answer `503 not_configured` without a private read.
 */
export function createSimHostWorker<Environment = unknown>(
  compose: SimHostWorkerComposition<Environment> = () => null
): { fetch(request: Request, environment: Environment): Promise<Response> } {
  return {
    async fetch(request, environment) {
      let handler: (request: Request) => Promise<Response>
      try {
        const ports = compose(environment)
        if (!ports) return notConfigured()
        handler = createSimHostService({ ...ports, policy: ports.policy ?? denyAllSimEntitlement })
      } catch {
        return notConfigured()
      }
      return handler(request)
    },
  }
}

export default createSimHostWorker()
