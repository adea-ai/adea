// TEST ONLY: Adea's side of the lead-to-child journey (#1173) as its own OS process. Each run builds
// Adea's real lead product from nothing but PostgreSQL and the CP control API address (no state is
// carried between runs), performs one operation through the installed SDK, prints one RESULT line
// and exits. A fault named in JOURNEY_FAULT SIGKILLs this process at one boundary, so the next run
// is a genuine process restart that can recover only from what was durably committed.
import { and, eq } from 'drizzle-orm'
import { createDatabase, workspaceMemberships } from '@adea-ai/db'
import { createConfiguredLeadTurnDependencies } from '../../src/server/lead-turn-composition'
import { createLeadTurnProduct } from '../../src/server/lead-turn-product'
import type { LeadRuntimeAdapter } from '../../src/server/lead-turn-runtime'

const config = JSON.parse(process.env.JOURNEY_CONFIG ?? 'null')
const command = process.argv[2]
const fault = process.env.JOURNEY_FAULT ?? ''
if (!config || !command || !process.env.DATABASE_URL) throw new Error('JOURNEY_DRIVER_INPUT')

const die = (): never => {
  process.kill(process.pid, 'SIGKILL')
  throw new Error('UNREACHABLE_AFTER_SIGKILL')
}
// The product reports only a bounded reason code; the thrown error's name and message go to
// stderr (never into assertions' expected values) so a failed run explains itself.
const report = <T extends (...args: never[]) => Promise<unknown>>(name: string, call: T): T =>
  (async (...args: Parameters<T>) => {
    try {
      return await call(...args)
    } catch (error) {
      console.error(`ADAPTER_ERROR ${name} ${String((error as Error)?.message).slice(0, 300)}`)
      throw error
    }
  }) as T
const connection = createDatabase(process.env.DATABASE_URL)
try {
  const dependencies = await createConfiguredLeadTurnDependencies({
    environment: {
      NODE_ENV: 'test',
      PI_DURABLE_LEAD_ENABLED: 'true',
      PI_DURABLE_LEAD_TARGET: JSON.stringify(config.hostMetadata.target),
      CONTROL_PLANE_ORIGIN: config.hostMetadata.baseUrl,
      CONTROL_PLANE_SIGNING_KEY: JSON.stringify(config.signing.privateJwk),
      CONTROL_PLANE_SIGNING_KEY_ID: config.signing.keyId,
      CONTROL_PLANE_SIGNING_ISSUER: config.signing.issuer,
    },
    resolveControlPlaneScope: async () => ({ workspaceId: config.workspaceId }),
  })
  const base = dependencies.adapter as LeadRuntimeAdapter
  if (!base) throw new Error('JOURNEY_ADAPTER_UNAVAILABLE')
  const real = { ...base } as LeadRuntimeAdapter
  for (const name of ['prepare', 'lookup', 'dispatch', 'status', 'progress', 'cancel'] as const)
    if (base[name])
      (real as Record<string, unknown>)[name] = report(name, base[name]!.bind(base) as never)
  if (base.assertPublicationCurrent)
    real.assertPublicationCurrent = report(
      'assertPublicationCurrent',
      base.assertPublicationCurrent.bind(base)
    )
  // Faults wrap only the call that crosses a process boundary, after the real call returned.
  const adapter: LeadRuntimeAdapter = {
    ...real,
    ...(real.prepare
      ? {
          prepare: async (authority) => {
            const value = await real.prepare!(authority)
            if (fault === 'prepare-ack-lost') die()
            return value
          },
        }
      : {}),
    dispatch: async (authority, key, prepared) => {
      const value = await real.dispatch(authority, key, prepared)
      // CP accepted and started the lead; Adea has not yet stored the binding.
      if (fault === 'dispatch-ack-lost') die()
      return value
    },
    status: async (authority, dispatchId) => {
      const value = await real.status(authority, dispatchId)
      // CP accepted and started the child while this read was in flight; the observation never
      // reaches this process's store. The test holds the child's provider send so the read really
      // happens with the acceptance in flight.
      if (fault === 'child-acceptance-lost') die()
      const state = (value as { state?: string } | undefined)?.state
      // The terminal receipt reached this process but nothing was stored.
      if (fault === 'terminal-receipt-lost' && state === 'completed') die()
      // The audience is revoked after the terminal result was read and before it is published.
      if (fault === 'revoke-audience-before-publication' && state === 'completed')
        await connection.db
          .delete(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, config.adeaWorkspaceId),
              eq(workspaceMemberships.userId, config.userId)
            )
          )
      return value
    },
    ...(real.assertPublicationCurrent
      ? {
          assertPublicationCurrent: async (input) => {
            await real.assertPublicationCurrent!(input)
            // Inside the publication transaction: after every canonical lock and the CP
            // authority read, before the message is written or committed.
            if (fault === 'publication-in-transaction') die()
          },
        }
      : {}),
  }
  const product = createLeadTurnProduct(connection.db, { ...dependencies, adapter })
  const scope = {
    workspaceId: config.adeaWorkspaceId,
    intentId: config.intentId,
    userId: config.userId,
  }
  let result: unknown
  if (command === 'snapshot') result = await product.snapshot(scope)
  else if (command === 'prepare') result = await product.prepare(scope)
  else if (command === 'dispatch') result = await product.dispatch(scope)
  else if (command === 'status') result = await product.status(scope)
  else if (command === 'progress') result = await product.progress(scope, config.cursor ?? 0)
  else if (command === 'cancel') result = await product.cancel(scope)
  else throw new Error(`JOURNEY_COMMAND:${command}`)
  // The operation committed; the reply is lost when the process is killed here.
  if (fault === 'reply-lost') die()
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`)
} finally {
  await connection.close().catch(() => {})
}
