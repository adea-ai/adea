// Owner-only endpoint file for the terminal sidecar (issue #396). It carries
// protocol version, executable identity, PID/start identity, endpoint
// credential, and socket path. Written atomically with owner-only modes;
// a PID or port file alone grants nothing — every attach re-authenticates
// with the credential and a fresh nonce (Dev Runtime spec, "Sidecar
// adoption").
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ENDPOINT_SCHEMA_VERSION, type SidecarProtocol } from './protocol'

export type SidecarEndpoint = Readonly<{
  schemaVersion: typeof ENDPOINT_SCHEMA_VERSION
  protocol: SidecarProtocol
  sidecarVersion: string
  executableIdentity: string
  pid: number
  pidStartIdentity: string
  /** base64url 256-bit credential; the only attach authority. */
  credential: string
  socketPath: string
  createdAt: string
}>

export function endpointFilePath(dataDir: string): string {
  return join(dataDir, 'dev-runtime', 'terminal-sidecar', 'endpoint.json')
}

export function readEndpointFile(dataDir: string): SidecarEndpoint | null {
  const path = endpointFilePath(dataDir)
  let raw: string
  try {
    raw = new TextDecoder().decode(readFileSync(path))
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const endpoint = parsed as Record<string, unknown>
  if (
    endpoint.schemaVersion !== ENDPOINT_SCHEMA_VERSION ||
    typeof endpoint.credential !== 'string' ||
    typeof endpoint.socketPath !== 'string' ||
    typeof endpoint.pid !== 'number' ||
    typeof endpoint.pidStartIdentity !== 'string' ||
    typeof endpoint.executableIdentity !== 'string' ||
    typeof endpoint.sidecarVersion !== 'string' ||
    typeof endpoint.protocol !== 'object' ||
    endpoint.protocol === null
  ) {
    return null
  }
  const protocol = endpoint.protocol as Record<string, unknown>
  if (
    typeof protocol.name !== 'string' ||
    typeof protocol.major !== 'number' ||
    typeof protocol.minor !== 'number'
  ) {
    return null
  }
  return {
    schemaVersion: ENDPOINT_SCHEMA_VERSION,
    protocol: { name: protocol.name, major: protocol.major, minor: protocol.minor },
    sidecarVersion: endpoint.sidecarVersion,
    executableIdentity: endpoint.executableIdentity,
    pid: endpoint.pid,
    pidStartIdentity: endpoint.pidStartIdentity,
    credential: endpoint.credential,
    socketPath: endpoint.socketPath,
    createdAt: typeof endpoint.createdAt === 'string' ? endpoint.createdAt : '',
  }
}

export function writeEndpointFile(dataDir: string, endpoint: SidecarEndpoint): void {
  const dir = join(dataDir, 'dev-runtime', 'terminal-sidecar')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = endpointFilePath(dataDir)
  const temporary = join(dir, `.${randomUUID()}.tmp`)
  writeFileSync(temporary, JSON.stringify(endpoint, null, 2), { mode: 0o600 })
  renameSync(temporary, path)
  // Owner-only is load-bearing; some filesystems ignore create modes.
  if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600)
}
