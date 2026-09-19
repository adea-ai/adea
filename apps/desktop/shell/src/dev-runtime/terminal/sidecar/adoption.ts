// Sidecar adoption (issue #396): on startup the shell authenticates and
// adopts a healthy compatible sidecar. The version handshake chooses
// exactly one of `adopt`, `drain_upgrade` (compatible migration; current
// sessions are retained until detached), or `sidecar_incompatible` with
// user remediation — there is no PID/port adoption fallback (Dev Runtime
// spec, "Sidecar adoption"; supervision engine M10 #185 owns the verdict
// through `evaluateAdoption`).
import { randomBytes } from 'node:crypto'

import { readEndpointFile, type SidecarEndpoint } from './endpoint-file'
import { connectSidecarClient, type SidecarClient } from './client'
import type { ByteDuplex, SidecarProtocol, SidecarScope } from './protocol'

export type AdoptionDecision = 'adopt' | 'drain_upgrade' | 'incompatible'

export type SidecarAdoptionResult =
  | {
      ok: true
      decision: 'adopt'
      client: SidecarClient
      endpoint: SidecarEndpoint
    }
  | {
      ok: true
      decision: 'drain_upgrade'
      client: SidecarClient
      endpoint: SidecarEndpoint
    }
  | {
      ok: false
      decision: 'incompatible'
      code:
        | 'sidecar_incompatible'
        | 'identity_mismatch'
        | 'channel_unauthenticated'
        | 'replay_rejected'
        | 'unavailable'
      message: string
    }

export type AdoptSidecarOptions = {
  dataDir: string
  scope: SidecarScope
  /** Expected executable identity of the bundled sidecar artifact. */
  expectedExecutableIdentity: string
  /** The M10 supervision verdict provider (component manifest compatibility). */
  evaluateAdoption: (protocol: SidecarProtocol) => AdoptionDecision
  /** Connects a duplex to the endpoint's socket path. */
  connect: (socketPath: string) => Promise<ByteDuplex>
  /** Starts the sidecar when no live endpoint file exists; production uses the supervisor. */
  startSidecar?: () => Promise<void>
  /** Waits for the endpoint file to appear after a start. */
  waitForEndpoint?: (attempts: number) => Promise<SidecarEndpoint | null>
  nonce?: string
}

export async function adoptSidecar(options: AdoptSidecarOptions): Promise<SidecarAdoptionResult> {
  let endpoint = readEndpointFile(options.dataDir)
  if (!endpoint && options.startSidecar) {
    await options.startSidecar()
    endpoint =
      options.waitForEndpoint !== undefined
        ? await options.waitForEndpoint(50)
        : await defaultWaitForEndpoint(options.dataDir)
  }
  if (!endpoint) {
    return {
      ok: false,
      decision: 'incompatible',
      code: 'unavailable',
      message: 'no sidecar endpoint file appeared; the detached terminal sidecar did not start',
    }
  }
  // The endpoint credential is the only attach authority. An endpoint whose
  // executable identity is not the expected bundled artifact is refused
  // before any protocol traffic (TM: replaced-executable adoption).
  if (endpoint.executableIdentity !== options.expectedExecutableIdentity) {
    return {
      ok: false,
      decision: 'incompatible',
      code: 'identity_mismatch',
      message: 'sidecar executable identity does not match the expected bundled artifact',
    }
  }
  const verdict = options.evaluateAdoption(endpoint.protocol)
  if (verdict === 'incompatible') {
    return {
      ok: false,
      decision: 'incompatible',
      code: 'sidecar_incompatible',
      message: `sidecar protocol ${endpoint.protocol.name}@${endpoint.protocol.major}.${endpoint.protocol.minor} is incompatible with this app build`,
    }
  }
  let duplex: ByteDuplex
  try {
    duplex = await options.connect(endpoint.socketPath)
  } catch (cause) {
    return {
      ok: false,
      decision: 'incompatible',
      code: 'unavailable',
      message: `could not reach the sidecar endpoint: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
  const connected = await connectSidecarClient({
    duplex,
    scope: options.scope,
    credential: endpoint.credential,
    nonce: options.nonce ?? randomBytes(16).toString('hex'),
  })
  if (!connected.ok) {
    const knownCodes = [
      'channel_unauthenticated',
      'replay_rejected',
      'sidecar_incompatible',
    ] as const
    const code =
      knownCodes.find((candidate) => candidate === connected.code) ?? 'channel_unauthenticated'
    return {
      ok: false,
      decision: 'incompatible',
      code,
      message: connected.message,
    }
  }
  return { ok: true, decision: verdict, client: connected.client, endpoint }
}

async function defaultWaitForEndpoint(
  dataDir: string,
  attempts = 50
): Promise<SidecarEndpoint | null> {
  for (let index = 0; index < attempts; index += 1) {
    const endpoint = readEndpointFile(dataDir)
    if (endpoint) return endpoint
    await Bun.sleep(100)
  }
  return null
}
