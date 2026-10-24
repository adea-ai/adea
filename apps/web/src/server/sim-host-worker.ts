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

/**
 * The service ports a composition supplies. The entitlement policy may be left out; it then denies.
 * `dispose` releases what the composition opened for this request, such as a database connection.
 * It runs once the handler has answered, and a failure in it is never sent to the caller.
 */
export type SimHostWorkerPorts = Omit<SimHostServiceOptions, 'policy'> &
  Readonly<{ policy?: SimEntitlementPolicy; dispose?: () => Promise<void> | void }>

/** The part of the Worker execution context the entry uses. */
export type SimHostWorkerContext = Readonly<{ waitUntil(promise: Promise<unknown>): void }>

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
): {
  fetch(
    request: Request,
    environment: Environment,
    context?: SimHostWorkerContext
  ): Promise<Response>
} {
  return {
    async fetch(request, environment, context) {
      let handler: (request: Request) => Promise<Response>
      let dispose: SimHostWorkerPorts['dispose']
      try {
        const ports = compose(environment)
        if (!ports) return notConfigured()
        const { dispose: release, ...service } = ports
        dispose = release
        try {
          handler = createSimHostService({
            ...service,
            policy: service.policy ?? denyAllSimEntitlement,
          })
        } catch (error) {
          await settle(dispose, context)
          throw error
        }
      } catch {
        return notConfigured()
      }
      try {
        return await handler(request)
      } finally {
        await settle(dispose, context)
      }
    },
  }
}

/**
 * Runs the composition's cleanup after the handler is done. Under a Worker the cleanup is handed to
 * `waitUntil` so the response is not held back; elsewhere it is awaited. A throwing or rejecting
 * cleanup is swallowed: the caller has its answer and the error text is never sent.
 */
async function settle(
  dispose: SimHostWorkerPorts['dispose'],
  context: SimHostWorkerContext | undefined
): Promise<void> {
  if (!dispose) return
  const run = (async () => dispose())().catch(() => undefined)
  if (context) context.waitUntil(run)
  else await run
}

export default createSimHostWorker()
