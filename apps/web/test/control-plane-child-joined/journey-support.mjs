// Shared setup for the lead-to-child journey proofs (#1173): the harness started against the pinned
// CP revision, Adea's driver as separate OS processes, and canonical Adea reads for assertions.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { startHarness, pin, root } from './harness.mjs'
import { verifyInstalledPackages } from './installed-packages.mjs'
import { installedLeadSdkPort } from '../../src/server/lead-turn-sdk-port.ts'

const requireDb = createRequire(new URL('../../../../packages/db/package.json', import.meta.url))
const { eq, and } = await import(requireDb.resolve('drizzle-orm'))

/**
 * Adea's lockfile (sdk 1.18.0, contracts 1.21.1) trails CP main (sdk 1.18.1, contracts 1.21.3) in
 * exactly these files, each pinned to the reviewed installed and built content (sha256). The CP
 * changes are #1149/#1150 (graph digest compatibility) and a behavior-preserving rewrite of
 * `canonicalJsonStringify`:
 * - `graphs.js`: one added line, `digestVersion: z.literal('canonical-json-v1').optional()`;
 *   `graphs.d.ts`, `control-api.d.ts`, sdk `operations.d.ts` and the OpenAPI JSON carry the same
 *   optional field as types or documentation; the `.map` files are source maps.
 * - `canonical-json.js`: loop-based serialization of the same canonical form. It is evaluated when
 *   `@adea-ai/contracts` loads and is used by runtime-sdk modules, not by Adea's lead operations
 *   (Adea hashes payloads with its own `canonicalJson`). `journey-drift.test.mjs` runs the
 *   installed and the built implementation side by side and requires identical output.
 * runtime-sdk, which holds the lead contract, is byte-identical. The lead operations never carry a
 * graph digest. A published SDK/contracts release plus an Adea bump would remove this table.
 */
export const declaredDrift = {
  '@adea-ai/contracts': {
    'dist/canonical-json.d.ts.map': {
      installed: 'd257ab44bf4729f10754ce78425d1efb720590346e1b7dd32f99303f71d7b847',
      built: '1b5055800caea02be72ec18518694ff580828d510678b17e3da221839aecc296',
    },
    'dist/canonical-json.js': {
      installed: 'ce5ba8bf89991a1ae29d8b74c57757aa0ea73dd2e4360c3cca81d7911becb2a2',
      built: '6bffa314b7467e0ba74230e0326a62c0a51468940c1934b0dfe77862c93e21fe',
    },
    'dist/canonical-json.js.map': {
      installed: '1551f0171f7656eb92ae8523c3e4c66efaba40a28a16f7fd423ecd98e9ba3ecc',
      built: '6f36e0d4e421cc699d3c9589e7cd2977db91fc1ccba8e18de37a72215de83f13',
    },
    'dist/control-api.d.ts': {
      installed: '6f5c80a812ee6a35d6dd854bc92238dbb405b730efacb3e499a722e66c73ac01',
      built: 'c3482632ead29a664b571f7337a45fb9faadfc7657658a4ef68e7cb22abd2f12',
    },
    'dist/control-api.d.ts.map': {
      installed: 'ac16db58edc08a44b70bc3f9917b262103dc47dfe65b8a6da839b35b5c6a823f',
      built: '2aaa8d129fc60bedbd7667f693cdc440be6e46f4d14089c42968736ec40a1d66',
    },
    'dist/graphs.d.ts': {
      installed: '7b7ae64cebe73a52db8981977440d3f68eac2399c81e2d38e69f9b1797797808',
      built: '7044786dbf9a2e689317059139f649b04783309f341d3808ff8519d69ecc6e44',
    },
    'dist/graphs.d.ts.map': {
      installed: '2b32e88642efff2723a6252de1261e6ff7ff674dcd8fc3665a95365f13d750fc',
      built: 'bb579dc24a83983a0d5c223a1fb7ed775a6f6e8c04241c26c9240374bf905f13',
    },
    'dist/graphs.js': {
      installed: '4561ed18b083358dbd9dd3e4300a48bef92107389c4563e9fd90c2bfedee81c5',
      built: '980d36c3f4b3d53af7913c0acfeaba63baec3513a3b974a889464d8dc5b0b9cc',
    },
    'dist/graphs.js.map': {
      installed: 'b8ce56fa0b85501a22da1daf17c08088071026c955a611efe33b5a61cb45ed3f',
      built: 'b983feab4677113ac575bafc2078e20ada6c880a75ffa7e30d5409ad5f86090a',
    },
  },
  '@adea-ai/sdk': {
    'dist/operations.d.ts': {
      installed: '4cff485e33e7339e8828074d2be13be8119bce5efcc852eb25737e30cd8f8f0a',
      built: '56613da4d134d60f4ddf17507dacfda7ef9ccf1101fbfaeea49554a8315e8eee',
    },
    'dist/operations.d.ts.map': {
      installed: 'f5cab99ff469d60643aaa94b9a4fd77c8589aeb9ba86f9eb2231d0be82b02c25',
      built: '35e5056f7b2f7d5e240d698814ba859f2b89409f938bfc6325622e907aebb166',
    },
    'openapi/control-plane.v3.json': {
      installed: '92d0594c2dec72cffd47575aaf78c89a10d5ff399b8a8b8c3499d8338ed353a5',
      built: '0f86a1280c4449a3e8d68e102dec3a0cd9acfaff95847664212274013f8aa785',
    },
  },
}

/** Package and source identity, before any database connection is opened. */
export const verifyJourneyPackages = (manifestPath) =>
  verifyInstalledPackages({
    manifestPath,
    expectedHead: pin.revision,
    cpRoot: root,
    port: installedLeadSdkPort,
    installKind: 'registry-declared-drift',
    declaredDrift,
  })

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

  /**
   * Waits for the terminal accounting receipt: CP's retained child cost state is `settled` and its
   * delegation record is `completed`. CP settles on its own recovery interval, so the usage ledger
   * is only comparable once this receipt exists; each poll runs CP's idempotent progress scan.
   */
  const accounted = () =>
    waitFor(
      async () => {
        await control('scan')
        return control('evidence')
      },
      (e) => e.costState === 'settled' && e.delegations[0]?.state === 'completed',
      'terminal accounting receipt',
      60000
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
    accounted,
    stop: () => harness.stop(),
  }
}
