// The Dev Runtime host composition root: registers every production provider
// the shipped shell can serve onto the M10 channel authority, and fills every
// remaining registry operation with a typed-unavailable provider so no
// operation is ever "unknown" or falsely successful. The returned matrix is
// the acceptance evidence: each operation is either a reachable provider or a
// documented host-capability result (spec: every registered operation has a
// reachable production provider or an explicitly documented host capability
// result).
//
// Ownership: browser/device internals (#422), terminal internals (#396),
// worktree internals (#397), and supervision (#185) are other slices' code —
// this file only composes their existing registration seams.
import {
  devOperationDefinitions,
  type DevError,
  type DevOperation,
} from '../../../../../packages/types/src/dev-runtime'
import type { ChannelAuthority } from './channel/authority'
import type { ChannelGateway } from './channel/server'
import type { DesktopIdentityAuthority } from './channel/identity'
import type { OwnerApprovalVerifier } from './authority'
import type { AuthorityAudit } from './audit'
import { createProjectGrantAuthority, type ProjectGrantAuthority } from './grants'
import { createRootBookmarkAuthority, type RootBookmarkAuthority } from './roots'
import { registerBrowserDeviceRuntime, type BrowserDeviceRuntime } from './browser/register'
import type { AdeaOwnedService } from './browser/navigation-policy'
import {
  registerProjectSessionRuntime,
  type ProjectSessionRuntime,
} from './project-session/register'
import { registerTerminalRuntime, type TerminalRuntimeRegistration } from './terminal/register'
import type { SidecarClient } from './terminal/sidecar/client'
import { registerWorktreeRuntime } from './worktrees/register'
import type { WorktreeService } from './worktrees/service'
import { createCredentialVault, type CredentialVault } from './vault'

export type DevProviderKind = 'provider' | 'typed_unavailable'

export type DevRuntimeHostRegistration = Readonly<{
  /** operation → how the shipped shell serves it. */
  matrix: Readonly<Record<DevOperation, DevProviderKind>>
  providers: readonly DevOperation[]
  typedUnavailable: readonly DevOperation[]
  unavailableReason: Readonly<Record<string, string>>
}>

export type DevRuntimeHost = Readonly<{
  roots: RootBookmarkAuthority
  vault: CredentialVault
  grants: ProjectGrantAuthority
  browserDevices: BrowserDeviceRuntime
  /** Present only when a verified scope exists at composition time. */
  projectSession?: ProjectSessionRuntime
  worktrees: ReturnType<typeof registerWorktreeRuntime>
  terminal?: TerminalRuntimeRegistration
  registration: DevRuntimeHostRegistration
}>

export type CreateDevRuntimeHostInput = {
  authority: ChannelAuthority
  /** Full-duplex gateway for stream protocols (terminal/browser/device). */
  gateway?: ChannelGateway
  dataDir: string
  /** The verified local-lane scope; commands outside it fail at the gate. */
  scope: { accountId: string; workspaceId: string; runtimeNodeId: string } | undefined
  identity: DesktopIdentityAuthority
  /** Required: durable single-use owner-approval authority (M10 #34). */
  approvalVerifier: OwnerApprovalVerifier
  audit?: AuthorityAudit
  /** Owner-only runtime root for content-addressed terminal wrappers. */
  runtimeRoot: string
  /** Adopted terminal sidecar; without it terminal stays typed-unavailable. */
  sidecar?: SidecarClient
  runLsof?: () => Promise<string>
  resolveDns?: (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>
  ownedServices?: () => readonly AdeaOwnedService[]
  publish?: (event: string, payload: unknown) => void
  /** Test seams: inject constructed subsystems instead of production ones. */
  worktreeService?: WorktreeService
}

export function createDevRuntimeHost(input: CreateDevRuntimeHostInput): DevRuntimeHost {
  if (!input.approvalVerifier) {
    throw new Error('the Dev Runtime host requires an owner approval verifier')
  }
  if (!input.identity) {
    throw new Error('the Dev Runtime host requires the desktop identity authority')
  }

  // M10 #34 grant authorities. A missing verifier fails construction, so the
  // shell can never boot into a state where owner consent is structural only.
  const roots = createRootBookmarkAuthority({
    dataDir: input.dataDir,
    ...(input.audit ? { audit: input.audit } : {}),
    approvalVerifier: input.approvalVerifier,
  })
  const vault = createCredentialVault({
    dataDir: input.dataDir,
    ...(input.audit ? { audit: input.audit } : {}),
    approvalVerifier: input.approvalVerifier,
  })
  const grants = createProjectGrantAuthority({
    dataDir: input.dataDir,
    roots,
    vault,
    ...(input.audit ? { audit: input.audit } : {}),
    approvalVerifier: input.approvalVerifier,
  })

  // The capability snapshot is the channel's own probe operation: it reports
  // grants for the verified scope truthfully.
  input.authority.registerCommandProvider('dev.capability.snapshot', (command, identity) =>
    input.authority.capabilitySnapshot(command.scope, identity)
  )

  const worktreeService = input.worktreeService
  const projectSession = input.scope
    ? registerProjectSessionRuntime({
        authority: input.authority,
        dataDir: input.dataDir,
        scope: input.scope,
        ...(input.publish ? { publish: input.publish } : {}),
        validateSessionCreation: (body) => {
          const worktree = worktreeService
            ? worktreeService.getWorktree(input.scope!, body.worktreeId)
            : undefined
          if (!worktree) {
            throw {
              code: 'not_found',
              retryable: false,
              message: 'session creation requires a registered worktree on this runtime node',
            } satisfies DevError
          }
        },
      })
    : undefined

  const browserDevices = registerBrowserDeviceRuntime({
    authority: input.authority,
    ...(input.gateway ? { gateway: input.gateway } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.runLsof ? { runLsof: input.runLsof } : {}),
    ...(input.resolveDns ? { resolveDns: input.resolveDns } : {}),
    ...(input.ownedServices ? { ownedServices: input.ownedServices } : {}),
  })

  const worktrees = input.scope
    ? registerWorktreeRuntime({
        authority: input.authority,
        dataDir: input.dataDir,
        scope: input.scope,
        runtimeNodeId: input.scope.runtimeNodeId,
        roots,
        vault,
        ...(worktreeService ? { service: worktreeService } : {}),
      })
    : undefined

  const terminal =
    input.sidecar && input.scope && input.gateway
      ? registerTerminalRuntime({
          authority: input.authority,
          gateway: input.gateway,
          sidecar: input.sidecar,
          scope: input.scope,
          runtimeRoot: input.runtimeRoot,
          resolveWorktreeRoot: (worktreeId) =>
            worktreeService?.getWorktree(input.scope!, worktreeId)?.canonicalRoot ?? null,
        })
      : undefined

  // Everything without a reachable provider gets an explicit typed refusal,
  // so a registered-but-unimplemented operation can never masquerade as
  // success or as an unknown command.
  // A re-bind (workspace/account switch) or unbind (sign-out) revokes every
  // channel minted under the previous binding: reconnects fail closed and
  // must complete a fresh trusted handshake.
  input.identity.onBindingChanged(() => {
    input.authority.revokeAllChannels()
  })

  const unavailableReasons = new Map<string, string>()
  const registeredAtComposition = new Set<DevOperation>(input.authority.registeredOperations())
  for (const operation of Object.keys(devOperationDefinitions) as DevOperation[]) {
    if (registeredAtComposition.has(operation)) continue
    unavailableReasons.set(operation, 'no host adapter is available for this operation')
    input.authority.registerCommandProvider(operation, () => {
      throw {
        code: 'capability_unavailable',
        retryable: true,
        message: `no host adapter is available for ${operation}`,
        observedAt: new Date().toISOString(),
      } satisfies DevError
    })
  }

  const providers = (Object.keys(devOperationDefinitions) as DevOperation[]).filter(
    (operation) => !unavailableReasons.has(operation)
  )
  const typedUnavailable = (Object.keys(devOperationDefinitions) as DevOperation[]).filter(
    (operation) => unavailableReasons.has(operation)
  )
  const matrix = Object.fromEntries(
    (Object.keys(devOperationDefinitions) as DevOperation[]).map((operation) => [
      operation,
      unavailableReasons.has(operation) ? ('typed_unavailable' as const) : ('provider' as const),
    ])
  ) as Record<DevOperation, DevProviderKind>

  return {
    roots,
    vault,
    grants,
    browserDevices,
    ...(projectSession ? { projectSession } : {}),
    worktrees: worktrees ?? { commands: [] as DevOperation[], registeredCommands: 0 },
    ...(terminal ? { terminal } : {}),
    registration: Object.freeze({
      matrix: Object.freeze(matrix),
      providers: Object.freeze(providers),
      typedUnavailable: Object.freeze(typedUnavailable),
      unavailableReason: Object.freeze(Object.fromEntries(unavailableReasons)),
    }),
  }
}
