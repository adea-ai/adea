// Workspace connections client bridge (ADR 0012).
//
// Adapts the authenticated Dev Runtime command path to the settings pane's
// `WorkspaceConnectionsService`. Every command is built against the runtime's
// own authoritative scope (the active workspace's device scope) and every
// success value passes the strict provider-owned decoders before it reaches
// the view; a value that fails strict decode fails closed as `corrupt_state`.
// Only ids and labels cross this boundary — the runtime never serves secret
// material and this module never asks for it.
import { buildDevCommand } from '@adea-ai/dev-view/browser'
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import type {
  CredentialRef,
  DevError,
  DevOperation,
  HarnessAccountProfile,
  WorkspaceConnections,
} from '@adea-ai/types/dev-runtime'
import {
  decodeCredentialRef,
  decodeHarnessAccountProfile,
  decodeWorkspaceConnections,
} from '@adea-ai/types/dev-runtime-registry-dto'
import type { WorkspaceConnectionsService } from '@adea-ai/workspace-ui/platform'

/** Bounded page walk: a device vault and profile store are small by design. */
const MAX_PAGES = 10

type ConnectionsError = Readonly<{ code: DevError['code']; message: string }>

function unavailable(message: string): ConnectionsError {
  return { code: 'capability_unavailable', message }
}

function strict<T>(decode: (value: unknown) => T, value: unknown): T {
  try {
    return decode(value)
  } catch {
    throw {
      code: 'corrupt_state',
      message: 'workspace connections failed strict decoding',
    } satisfies ConnectionsError
  }
}

async function pages<T>(
  read: (cursor: string | undefined) => Promise<unknown>,
  decodeItem: (value: unknown) => T
): Promise<T[]> {
  const items: T[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const value = (await read(cursor)) as { items?: unknown; nextCursor?: unknown }
    if (!value || !Array.isArray(value.items))
      throw { code: 'corrupt_state', message: 'listing failed strict decoding' }
    for (const item of value.items) items.push(strict(decodeItem, item))
    if (typeof value.nextCursor !== 'string') return items
    cursor = value.nextCursor
  }
  return items
}

export function createDesktopWorkspaceConnectionsService(
  runtime: DevRuntimeService
): WorkspaceConnectionsService {
  async function execute(
    operation: DevOperation,
    body: Readonly<Record<string, unknown>>
  ): Promise<unknown> {
    await runtime.ready?.catch(() => undefined)
    const scope = runtime.preferenceScope?.()
    if (runtime.state().status !== 'ready' || !scope)
      throw unavailable('the desktop runtime is not connected for this workspace')
    const reply = await runtime.execute(buildDevCommand({ operation, scope, body }))
    if (!reply.ok) throw reply.error
    return reply.value
  }

  const readConnections = async (): Promise<WorkspaceConnections> =>
    strict(decodeWorkspaceConnections, await execute('dev.connections.get', {}))

  return Object.freeze({
    async load() {
      const [connections, profiles, credentialRefs] = await Promise.all([
        readConnections(),
        pages<HarnessAccountProfile>(
          (cursor) =>
            execute('dev.harness.accountProfiles.list', cursor === undefined ? {} : { cursor }),
          decodeHarnessAccountProfile
        ),
        pages<CredentialRef>(
          (cursor) => execute('dev.repo.credentialRefs', cursor === undefined ? {} : { cursor }),
          decodeCredentialRef
        ),
      ])
      return { connections, profiles, credentialRefs }
    },
    async setGitHosting(input) {
      return strict(
        decodeWorkspaceConnections,
        await execute('dev.connections.setGitHosting', {
          host: input.host,
          credentialRefId: input.credentialRefId,
          expectedVersion: input.expectedVersion,
        })
      )
    },
    async setHarnessAccount(input) {
      return strict(
        decodeWorkspaceConnections,
        await execute('dev.connections.setHarnessAccount', {
          harnessId: input.harnessId,
          profileId: input.profileId,
          expectedVersion: input.expectedVersion,
        })
      )
    },
    async createAccountProfile(input) {
      return strict(
        decodeHarnessAccountProfile,
        await execute('dev.harness.accountProfiles.create', {
          harnessId: input.harnessId,
          label: input.label,
          credentialRefId: input.credentialRefId,
        })
      )
    },
  })
}
