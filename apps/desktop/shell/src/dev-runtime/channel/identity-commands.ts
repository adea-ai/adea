// The Dev Runtime scope command family (`desktop_identity_*`), composed in the
// shell entry rather than the `commands.ts` registry because it needs the
// identity authority and the channel gateway. Every command rides the signed
// legacy invoke path of the trusted window's channel, so the renderer can
// never assert a scope: the shell verifies the presented credential before
// any binding or selection exists.
//
// A call that changes the active scope revokes every channel — including the
// caller's own. The bridge cannot re-read the one-time launch bootstrap the
// document load injected, so the reply to that authenticated call carries a
// fresh single-use bootstrap (`rehandshake`) the bridge consumes in its
// closure to open a channel under the new scope. Nothing else can obtain it:
// the request was already proven with the revoked channel's secret from the
// trusted origin.
import type { BridgeResult } from '../../commands'
import { ChannelRejection } from './authority'
import type {
  DesktopIdentityAuthority,
  DesktopSessionCredential,
  Scope,
  WorkspaceMembershipCredential,
} from './identity'

export const IDENTITY_COMMANDS = [
  'desktop_identity_bind',
  'desktop_identity_scope',
  'desktop_identity_select_workspace',
  'desktop_identity_unbind',
] as const

export type IdentityCommand = (typeof IDENTITY_COMMANDS)[number]

export type IdentityCommandSurface = Readonly<{
  handles(cmd: string): cmd is IdentityCommand
  invoke(cmd: IdentityCommand, args?: Record<string, unknown>): Promise<BridgeResult>
}>

/** Typed refusals keep their Dev error code at the front of the bridge error
 *  string (`<code>: <message>`), so the client can branch without parsing
 *  prose. */
function refusal(error: unknown): BridgeResult {
  if (error instanceof ChannelRejection) {
    return { ok: false, error: `${error.code}: ${error.message}` }
  }
  return {
    ok: false,
    error: error instanceof Error ? error.message : 'identity command failed',
  }
}

export function createIdentityCommandSurface(input: {
  identity: DesktopIdentityAuthority
  /** Mints the next single-use launch bootstrap (the gateway's). */
  issueRehandshake: () => string
}): IdentityCommandSurface {
  const { identity } = input
  // Bumped by every effective scope change; a call that observes a bump
  // revoked the caller's channel and must hand the bridge a way back in.
  let scopeEpoch = 0
  identity.onBindingChanged(() => {
    scopeEpoch += 1
  })

  const handlers: Record<IdentityCommand, (args?: Record<string, unknown>) => unknown> = {
    desktop_identity_bind: (args) => {
      const session = args?.session as DesktopSessionCredential | undefined
      const claimed = args?.claimed as Scope | undefined
      if (!session || !claimed) throw new Error('identity bind requires session and claimed scope')
      return identity.bind({ session, claimed })
    },
    // The device-local identity means this always answers: a signed-out
    // shell projects its guest scope, so the Dev View works with no account.
    desktop_identity_scope: () => identity.currentScope(),
    desktop_identity_select_workspace: (args) =>
      identity.selectWorkspace({
        workspaceId: args?.workspaceId as string,
        credential: args?.credential as WorkspaceMembershipCredential,
      }),
    desktop_identity_unbind: () => {
      identity.unbind('owner sign-out')
      return null
    },
  }

  return {
    handles(cmd): cmd is IdentityCommand {
      return (IDENTITY_COMMANDS as readonly string[]).includes(cmd)
    },
    async invoke(cmd, args) {
      const before = scopeEpoch
      try {
        const value = (await handlers[cmd](args)) ?? null
        return scopeEpoch === before
          ? { ok: true, value }
          : { ok: true, value, rehandshake: input.issueRehandshake() }
      } catch (error) {
        return refusal(error)
      }
    },
  }
}
