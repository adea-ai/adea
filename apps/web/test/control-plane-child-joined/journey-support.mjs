// Shared setup for the lead-to-child journey proofs (#1173): the harness started against the pinned
// CP candidate, Adea's driver as separate OS processes, and canonical Adea reads for assertions.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { startHarness } from './harness.mjs'

const requireDb = createRequire(new URL('../../../../packages/db/package.json', import.meta.url))
const { eq, and } = await import(requireDb.resolve('drizzle-orm'))

export const finalText = 'Delegated one bounded child; its receipt is recorded.\n'
export const childText = 'Bounded child evidence.'
const driverPath = join(import.meta.dirname, 'journey-driver.ts')

async function waitFor(read, predicate, label, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    last = await read()
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`JOURNEY_WAIT_TIMEOUT:${label}:${JSON.stringify(last)?.slice(0, 600)}`)
}

/** Reads until two reads 1.5 s apart agree: eventual settlement has finished, nothing is pending. */
async function settled(read, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs
  let last = JSON.stringify(await read())
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const value = await read()
    const text = JSON.stringify(value)
    if (text === last) return value
    last = text
  }
  throw new Error('JOURNEY_SETTLE_TIMEOUT')
}

export async function startJourney(title) {
  const harness = await startHarness({
    allowanceSource: 'profile',
    controlApi: true,
    title,
    hostEntry: 'host-journey.mjs',
  })
  const { db: adea, connection, control } = harness
  const config = {
    adeaWorkspaceId: harness.workspace.id,
    workspaceId: harness.workspaceId,
    intentId: harness.intentId,
    userId: harness.owner.principal.userId,
    hostMetadata: harness.hostMetadata,
    signing: harness.signing,
  }

  /** One Adea operation in its own process. `fault` SIGKILLs it at the named boundary. */
  async function driver(command, { fault = '', cursor = 0 } = {}) {
    const child = Bun.spawn([process.execPath, '--conditions=react-server', driverPath, command], {
      env: {
        ...process.env,
        JOURNEY_CONFIG: JSON.stringify({ ...config, cursor }),
        JOURNEY_FAULT: fault,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('RESULT '))
    return {
      killed: child.signalCode === 'SIGKILL',
      signal: child.signalCode,
      exitCode,
      result: line ? JSON.parse(line.slice('RESULT '.length)) : undefined,
      // Bounded diagnostics only: never forwarded to assertions' messages beyond a failure.
      stderr: stderr.slice(0, 2000),
    }
  }

  const channelMessages = () =>
    connection.db.select().from(adea.messages).where(eq(adea.messages.channelId, harness.topic.id))
  const runtimeRow = async () =>
    (
      await connection.db
        .select()
        .from(adea.leadTurnRuntime)
        .where(eq(adea.leadTurnRuntime.intentId, harness.intentId))
    )[0]
  const intents = () =>
    connection.db
      .select()
      .from(adea.leadTurnIntents)
      .where(eq(adea.leadTurnIntents.workspaceId, harness.workspace.id))
  const publishedMessages = async () =>
    (await channelMessages()).filter((message) =>
      message.idempotencyKey.startsWith(`lead-result:${harness.intentId}`)
    )
  const revokeAudience = () =>
    connection.db
      .delete(adea.workspaceMemberships)
      .where(
        and(
          eq(adea.workspaceMemberships.workspaceId, harness.workspace.id),
          eq(adea.workspaceMemberships.userId, harness.owner.principal.userId)
        )
      )

  return {
    harness,
    adea,
    connection,
    control,
    config,
    driver,
    channelMessages,
    runtimeRow,
    intents,
    publishedMessages,
    revokeAudience,
    waitFor,
    settled,
    stop: () => harness.stop(),
  }
}
