// Device workspace scope selection (ADR 0011; docs/specs/desktop-auth.md).
// Before Dev mounts for a cloud workspace, the client asks the shell to select
// that workspace's Dev scope with the credential that proves membership: the
// signed-in desktop session or the guest's temporary workspace credential. The
// shell verifies membership against the cloud (or, offline, an unexpired
// cached verification by the same credential) and refuses fail-closed; the
// client never asserts a scope. A refusal never throws here: it resolves to a
// typed result so Chat and the rest of the workspace keep working while Dev
// reports itself unavailable for that workspace.
import type { DesktopSession } from '@adea-ai/auth/desktop'
import type { Scope } from '@adea-ai/types/dev-runtime'

import { invoke as bridgeInvoke } from './desktop-bridge'

export type DevScopeCredential =
  | Readonly<{ kind: 'desktop'; session: DesktopSession }>
  | Readonly<{ kind: 'temporary'; credential: string }>

export type DevScopeSelection =
  | Readonly<{
      ok: true
      workspaceId: string
      scope: Scope
      kind: 'guest' | 'device' | 'cloud'
    }>
  | Readonly<{ ok: false; workspaceId: string; code: string; message: string }>

/** The desktop credential that proves workspace membership, preferring the
 *  signed-in session over a guest credential. */
export function devScopeCredential(
  session: DesktopSession | undefined,
  temporaryCredential: string | null | undefined
): DevScopeCredential | undefined {
  if (session) return { kind: 'desktop', session }
  if (temporaryCredential) return { kind: 'temporary', credential: temporaryCredential }
  return undefined
}

/** The shell prefixes typed refusals with their Dev error code. */
function refusalOf(workspaceId: string, error: unknown): DevScopeSelection {
  const message = error instanceof Error ? error.message : 'workspace scope selection failed'
  const code = /^([a-z_]+): /.exec(message)?.[1] ?? 'unavailable'
  return { ok: false, workspaceId, code, message }
}

export type DesktopDevScopeSelector = Readonly<{
  /** Always asks the shell (a switch, a bootstrap, a credential change). */
  select(workspaceId: string, credential?: DevScopeCredential): Promise<DevScopeSelection>
  /** The latest selection when it is for this workspace; otherwise selects.
   *  Dev mounts await this so every path into a workspace — including a
   *  store switch that bypassed `select` — runs under its verified scope. */
  ensure(workspaceId: string): Promise<DevScopeSelection>
}>

export function createDesktopDevScopeSelector(options: {
  credential: () => DevScopeCredential | undefined
  invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
}): DesktopDevScopeSelector {
  const invoke = options.invoke ?? bridgeInvoke
  let latest: { workspaceId: string; selection: Promise<DevScopeSelection> } | undefined

  function select(workspaceId: string, credential = options.credential()) {
    const selection: Promise<DevScopeSelection> = credential
      ? invoke<{ scope: Scope; kind: 'guest' | 'device' | 'cloud' }>(
          'desktop_identity_select_workspace',
          { workspaceId, credential }
        ).then(
          (value) =>
            value.scope.workspaceId === workspaceId
              ? { ok: true as const, workspaceId, scope: value.scope, kind: value.kind }
              : {
                  ok: false as const,
                  workspaceId,
                  code: 'identity_mismatch',
                  message: 'the shell selected a different workspace scope',
                },
          (error: unknown) => refusalOf(workspaceId, error)
        )
      : Promise.resolve({
          ok: false as const,
          workspaceId,
          code: 'unauthenticated',
          message: 'no desktop credential is available to prove workspace membership',
        })
    latest = { workspaceId, selection }
    return selection
  }

  return {
    select,
    ensure(workspaceId) {
      if (latest?.workspaceId === workspaceId) return latest.selection
      return select(workspaceId)
    },
  }
}
