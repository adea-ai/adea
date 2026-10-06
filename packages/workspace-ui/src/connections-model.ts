// Pure view model for Workspace settings › Connections (ADR 0012).
//
// Every row is derived from the authoritative snapshot the desktop runtime
// serves (bindings, reusable account profiles, vault credential references —
// ids and labels only). Nothing here invents a binding: an absent binding is
// the device default, and the copy says so.
import type {
  CredentialRef,
  HarnessAccountFamily,
  HarnessAccountProfile,
} from '@adea-ai/types/dev-runtime'

import type { WorkspaceConnectionsSnapshot } from './platform'

/** The select value meaning "no workspace binding — use the device default". */
export const DEVICE_DEFAULT_VALUE = ''
export const DEVICE_DEFAULT_LABEL = 'Use device default'

/** Git hosts every workspace offers even before a credential exists. */
const DEFAULT_GIT_HOSTS = ['github.com'] as const
/** Provider API hosts belong to harness accounts, never to git hosting. */
const PROVIDER_HOSTS: ReadonlySet<string> = new Set(['api.anthropic.com', 'api.openai.com'])

export type ConnectionOption = Readonly<{ value: string; label: string; disabled?: boolean }>

export type GitHostingRow = Readonly<{
  host: string
  value: string
  options: readonly ConnectionOption[]
  detail: string
}>

export type HarnessAccountRow = Readonly<{
  harnessId: HarnessAccountFamily
  displayName: string
  value: string
  options: readonly ConnectionOption[]
  /** Vault references an "Add account…" profile may name for this harness. */
  accountCredentials: readonly ConnectionOption[]
  detail: string
}>

function usable(ref: CredentialRef): boolean {
  return ref.state === 'ready' && ref.kind !== 'ssh_key'
}

/** The bound value is always present as an option, so a binding to a
 *  reference that became unusable renders truthfully instead of vanishing. */
function withBound(
  options: ConnectionOption[],
  boundId: string | undefined,
  boundLabel: (id: string) => string
): ConnectionOption[] {
  if (boundId === undefined || options.some((option) => option.value === boundId)) return options
  return [...options, { value: boundId, label: boundLabel(boundId), disabled: true }]
}

function refLabel(refs: readonly CredentialRef[], id: string): string {
  const ref = refs.find((entry) => entry.id === id)
  return ref ? `${ref.label} (${ref.state})` : 'Unavailable credential'
}

export function gitHostingRows(snapshot: WorkspaceConnectionsSnapshot): GitHostingRow[] {
  const { connections, credentialRefs } = snapshot
  const accountHosts = new Set(
    connections.availableHarnesses.flatMap((harness) => harness.accountHosts)
  )
  const hosts = new Set<string>(DEFAULT_GIT_HOSTS)
  for (const binding of connections.gitHosting) hosts.add(binding.host)
  for (const ref of credentialRefs) {
    const host = ref.host.toLowerCase()
    if (ref.kind !== 'ssh_key' && !PROVIDER_HOSTS.has(host) && !accountHosts.has(host))
      hosts.add(host)
  }
  return [...hosts].toSorted().map((host) => {
    const bound = connections.gitHosting.find((binding) => binding.host === host)
    const options = withBound(
      [
        { value: DEVICE_DEFAULT_VALUE, label: DEVICE_DEFAULT_LABEL },
        ...credentialRefs
          .filter((ref) => ref.host.toLowerCase() === host && usable(ref))
          .map((ref) => ({ value: ref.id, label: ref.label })),
      ],
      bound?.credentialRefId,
      (id) => refLabel(credentialRefs, id)
    )
    const boundRef = bound
      ? credentialRefs.find((ref) => ref.id === bound.credentialRefId)
      : undefined
    return {
      host,
      value: bound?.credentialRefId ?? DEVICE_DEFAULT_VALUE,
      options,
      detail: bound
        ? `Clone, fetch, push, and pull requests in this workspace use ${boundRef?.label ?? 'the bound credential'}.`
        : 'Uses this device’s own git credentials (device default).',
    }
  })
}

export function harnessAccountRows(snapshot: WorkspaceConnectionsSnapshot): HarnessAccountRow[] {
  const { connections, profiles, credentialRefs } = snapshot
  return connections.availableHarnesses.map((harness) => {
    const bound = connections.harnessAccounts.find(
      (binding) => binding.harnessId === harness.harnessId
    )
    const own = profiles.filter((profile) => profile.harnessId === harness.harnessId)
    const options = withBound(
      [
        { value: DEVICE_DEFAULT_VALUE, label: DEVICE_DEFAULT_LABEL },
        ...own.map((profile) => ({ value: profile.id, label: profile.label })),
      ],
      bound?.profileId,
      () => 'Unavailable account'
    )
    const boundProfile: HarnessAccountProfile | undefined = bound
      ? own.find((profile) => profile.id === bound.profileId)
      : undefined
    return {
      harnessId: harness.harnessId,
      displayName: harness.displayName,
      value: bound?.profileId ?? DEVICE_DEFAULT_VALUE,
      options,
      accountCredentials: credentialRefs
        .filter((ref) => harness.accountHosts.includes(ref.host.toLowerCase()) && usable(ref))
        .map((ref) => ({ value: ref.id, label: `${ref.label} · ${ref.host}` })),
      detail: bound
        ? `${harness.displayName} launches in this workspace with ${boundProfile?.label ?? 'the bound account'}.`
        : `${harness.displayName} uses this device’s own sign-in (device default).`,
    }
  })
}

const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'capability_unavailable',
  'unavailable',
  'workspace_unavailable',
  'runtime_node_unavailable',
  'channel_unauthenticated',
])

export function errorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'unavailable'
}

/** True when the error means the Dev Runtime cannot serve connections here. */
export function isConnectionsUnavailable(error: unknown): boolean {
  return UNAVAILABLE_CODES.has(errorCode(error))
}

/** One sentence for a refused connection change; never echoes a secret. */
export function connectionsNotice(action: string, error: unknown): string {
  switch (errorCode(error)) {
    case 'stale_version':
      return `${action} was not saved: connections changed elsewhere. The latest state is shown.`
    case 'identity_mismatch':
      return `${action} was refused: that credential belongs to another host or harness.`
    case 'incompatible':
      return `${action} was refused: SSH keys cannot be used here.`
    case 'invalid_state':
      return `${action} was refused: the credential or account is not ready.`
    case 'not_found':
      return `${action} was refused: the credential or account no longer exists.`
    case 'name_collision':
      return `${action} was refused: an account with that name already exists.`
    default:
      return isConnectionsUnavailable(error)
        ? `${action} is unavailable: the desktop runtime is not connected.`
        : `${action} failed. Try again.`
  }
}

export const CONNECTIONS_UNAVAILABLE_TEXT =
  'Connections are device-local and managed by Adea Desktop. Open this workspace in the desktop app to bind git hosting credentials and harness accounts.'
