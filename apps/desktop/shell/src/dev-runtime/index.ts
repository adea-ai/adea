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
import { join } from 'node:path'

import {
  devOperationDefinitions,
  type DevError,
  type DevOperation,
} from '../../../../../packages/types/src/dev-runtime'
import type { ComponentManifest } from '../supervision/component-manifest'
import { createRecordStore } from '../supervision/records'
import { createProcessAdapter } from '../supervision/process-adapter'
import {
  createSupervisor,
  type Supervisor,
  type SupervisionAdapter,
} from '../supervision/supervisor'
import type { ChannelAuthority } from './channel/authority'
import type { ChannelGateway } from './channel/server'
import type { DesktopIdentityAuthority } from './channel/identity'
import type { OwnerApprovalVerifier } from './authority'
import type { AuthorityAudit } from './audit'
import { createProjectGrantAuthority, type ProjectGrantAuthority } from './grants'
import { createRootBookmarkAuthority, type RootBookmarkAuthority } from './roots'
import type { SupervisionRecord } from '../supervision/records'
import { registerBrowserDeviceRuntime, type BrowserDeviceRuntime } from './browser/register'
import type { AdeaOwnedService } from './browser/navigation-policy'
import { registerComputerUseRuntime, type ComputerUseRuntime } from './computeruse/register'
import type { ComputerUseEngine } from './computeruse/engine'
import type { MacPermissionService } from '../desktop-permissions'
import {
  registerProjectSessionRuntime,
  type ProjectSessionRuntime,
} from './project-session/register'
import { registerHarnessRuntime, type HarnessRuntimeRegistration } from './harness/register'
import type { AcpLaneDriver } from './harness/acp-lane'
import type { ManagedPiDriver } from './harness/managed-pi-driver'
import { registerTerminalRuntime, type TerminalRuntimeRegistration } from './terminal/register'
import type { SidecarClient } from './terminal/sidecar/client'
import { registerResourcesRuntime, type ResourcesSupervisionView } from './resources/register'
import type { ResourceSample } from './resources/metrics'
import {
  createCleanupPolicyAuthority,
  type CleanupFacts,
  type CleanupPolicyAuthority,
} from './resources/policy'
import { createProcessSampler } from './resources/sample-processes'
import { createRetainedDataProjection } from './resources/retained-data'
import {
  createCleanupWorktreeFacts,
  type OwnedResourceRef,
} from './resources/cleanup-facts'
import {
  createHarnessUsageAdapter,
  createTerminalUsageAdapter,
  createTypedUnavailableUsageAdapter,
} from './usage/on-device'
import { RUN_TERMINAL_STATES } from './harness/status'
import { createUsageService, type UsageService } from './usage/service'
import type { RetainedDataRecord } from '../../../../../packages/types/src/dev-runtime'
import { registerWorktreeRuntime } from './worktrees/register'
import type { WorktreeService } from './worktrees/service'
import { registerProjectScanRuntime } from './projects/register'
import { registerRepoRuntime } from './repos/register'
import { registerFilesRuntime } from './files/register'
import { registerGitRuntime } from './git/register'
import { registerGithubRuntime, type GhRunner, type GithubRepoContext } from './github/register'
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
  computerUse: ComputerUseRuntime
  /** Present only when a verified scope exists at composition time. */
  projectSession?: ProjectSessionRuntime
  /** Present only when a verified scope exists at composition time. */
  repos?: ReturnType<typeof registerRepoRuntime>
  /** Present only when a verified scope exists at composition time. */
  harness?: HarnessRuntimeRegistration
  worktrees: ReturnType<typeof registerWorktreeRuntime>
  /** Present only when a verified scope exists at composition time (#399). */
  files?: ReturnType<typeof registerFilesRuntime>
  /** Present only when a verified scope exists at composition time (#399). */
  git?: ReturnType<typeof registerGitRuntime>
  /** Present only when a verified scope exists at composition time (#423). */
  github?: ReturnType<typeof registerGithubRuntime>
  terminal?: TerminalRuntimeRegistration
  /** Present only when a verified scope exists at composition time. */
  resources?: ReturnType<typeof registerResourcesRuntime>
  /** Present only when the component manifest was composed in (#424): the
   *  held supervision engine other slices register their processes with. */
  supervision?: Supervisor
  /** The durable launch/exit journal the held engine appends to (#424). */
  supervisionRecords?: { list(): readonly SupervisionRecord[] }
  /** Present only when a verified scope exists at composition time. */
  cleanupPolicies?: CleanupPolicyAuthority
  usage?: UsageService
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
  /** Deterministic environments inject the vault's key store; production
   *  omits it and the vault uses the OS credential store. */
  credentialStore?: import('./vault').VaultKeyStore
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
  /** Overrides the managed Pi driver (#31; tests inject scripted archives). */
  managedPi?: ManagedPiDriver
  /**
   * #31: overrides the DEFAULT managed Pi driver's archive source chain
   * (tests script bundled/cache/network sources without replacing the
   * driver). Ignored when `managedPi` is injected.
   */
  managedPiArchiveResolver?: (version: string) => Promise<Uint8Array | null>
  /**
   * #31: the fire-and-forget managed-Pi boot warm. When true, the composition
   * starts ONE best-effort `ensureInstalled` after the harness register is
   * up (single-flight inside the driver dedupes it with any explicit install
   * command): on a clean supported desktop the managed Pi becomes ready with
   * no manual step, and every failure mode — no source, network refused,
   * checksum mismatch, version drift — is recorded as the driver's typed
   * durable failure state while the shell boots unaffected. The warm never
   * runs for an injected driver (a scripted test driver must never fetch),
   * and the shell must never await it.
   */
  managedPiAutoInstall?: boolean
  /** Overrides the ACP lane driver (#32; tests inject scripted handshakes). */
  acpDriver?: AcpLaneDriver
  /** Overrides the #471 permission service for the computer-use lanes (#472). */
  macPermissions?: MacPermissionService
  /** Overrides the computer-use input engine (#472; tests inject scripted ones). */
  computerUseEngine?: ComputerUseEngine
  /** Samples OS metrics for the supervised PIDs (bounded, pull-based).
   *  #424: absent composes the real fixed-argv `ps` sampler. */
  sampleProcesses?: (
    pids: readonly number[]
  ) => Promise<readonly ResourceSample[]> | readonly ResourceSample[]
  /** #424: the bundled component manifest. When present the composition
   *  constructs and holds the M10 supervision engine over its durable
   *  journal and binds the resources surface to it: listings prove from the
   *  journal joined against the engine's live snapshot, and stop delegates
   *  to the engine's public stop (identity re-proven before any signal).
   *  Without it (and without a scripted `supervision` override) resource
   *  listings stay truthful-empty and process stop fails closed. */
  componentManifest?: ComponentManifest
  /** #424: overrides the supervision process adapter (tests script one;
   *  production defaults to the fixed-argv host adapter). Requires
   *  `componentManifest`. */
  supervisionAdapter?: SupervisionAdapter
  /** #424: overrides the supervision journal directory (defaults to
   *  `<dataDir>/dev-runtime/supervision`). Requires `componentManifest`. */
  supervisionRecordsDir?: string
  /** #424: narrow read-only view of the supervision engine (snapshot plus
   *  the public stop API). Overrides the engine the composition constructs
   *  from `componentManifest` (tests script one). Without either, resource
   *  listings stay truthful-empty and process stop fails closed with
   *  `capability_unavailable`. */
  supervision?: ResourcesSupervisionView
  /** #424: the durable journal inventory entries are proven from. Overrides
   *  the journal of the constructed engine (tests script one). */
  supervisionRecords?: { list(): readonly SupervisionRecord[] }
  /** #424: retained-data breakdown source (terminal/checkpoint/templates).
   *  Absent composes the real read-only projection over the local stores. */
  retainedData?: () => readonly RetainedDataRecord[]
  /** #424: usage adapter cache; absent composes the real service over the
   *  on-device adapters (harness session counts and wall-clock durations from
   *  the durable run history, terminal durable-history bytes from the sealed
   *  checkpoint segments) plus typed-unavailable rows for file-stream bytes
   *  and provider-billed usage. */
  usage?: UsageService
  /** #424: live worktree facts for cleanup-policy evaluation; absence fails
   *  the evaluation closed (never satisfied). Absent composes the real
   *  read-only adapter over the worktree service when one is composed. */
  cleanupWorktreeFacts?: (worktreeId: string) => CleanupFacts | undefined
  /** #423: scripted gh transport (tests inject one; production spawns `gh`). */
  runGh?: GhRunner
  /** #399 residue: overrides the git status watcher's production seams
   *  (tests script them; production uses recursive `fs.watch` plus the
   *  `setTimeout` scheduler, and an unwatchable platform degrades — typed
   *  `mode: 'degraded'`, never a crash). One refresh gate is shared by every
   *  watcher this host constructs. */
  gitStatusWatcher?: {
    openWatcher?: import('./git/status-watcher').OpenWatcher
    schedule?: import('./git/status-watcher').Scheduler
    gate?: ReturnType<typeof import('./git/status-watcher').createRefreshGate>
  }
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
    // Deterministic environments (Linux CI, tests) inject a scripted store;
    // production omits it and the vault uses the OS credential store.
    ...(input.credentialStore ? { credentialStore: input.credentialStore } : {}),
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
        // Import resolves the authorized root fail-closed through the roots
        // authority: unknown, revoked, drifted, or replaced bookmarks refuse
        // before any project record exists.
        resolveImportRoot: (rootBookmarkId) => {
          const bookmark = roots.validate({ scope: input.scope!, bookmarkId: rootBookmarkId })
          return { canonicalRoot: bookmark.canonicalRoot }
        },
      })
    : undefined

  // The monorepo scan provider rides the same authorized-root gate: scan
  // recommendations are previews bound to a bookmark, never free-form paths.
  if (input.scope) {
    registerProjectScanRuntime({
      authority: input.authority,
      scope: input.scope,
      resolveScanRoot: (rootBookmarkId) => {
        const bookmark = roots.validate({ scope: input.scope!, bookmarkId: rootBookmarkId })
        return { canonicalRoot: bookmark.canonicalRoot }
      },
    })
  }

  // The repository registry (#398): adopt/authorize/inspect/refresh over the
  // project register's import-minted bindings. Every proof revalidates the
  // authorized bookmark through the roots authority; the vault seam resolves
  // credential references without exposing secret material; git reads run
  // through the bounded argv-only runner.
  const repos = input.scope
    ? registerRepoRuntime({
        authority: input.authority,
        dataDir: input.dataDir,
        scope: input.scope,
        validateRootBookmark: (rootBookmarkId) => {
          const bookmark = roots.validate({ scope: input.scope!, bookmarkId: rootBookmarkId })
          return { canonicalRoot: bookmark.canonicalRoot }
        },
        resolveCredentialRef: (credentialRefId) => {
          const credential = vault.get({ scope: input.scope!, credentialRefId })
          return { id: credential.id, host: credential.host, state: credential.state }
        },
        findRepoBindings: (repoId) => projectSession?.findRepoBindings(repoId) ?? [],
      })
    : undefined

  // #400 residue: the terminal runtime composes before the harness runtime so
  // the launch transaction can deliver initial prompts through its guarded
  // input-authority seam (PTY-backed launches only; ACP lanes deliver through
  // their own adapter).
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

  let harness: HarnessRuntimeRegistration | undefined
  // The shell event bus fans out to the host publisher AND the harness
  // event-log ingester, so the canonical stream carries the register's
  // session lifecycle facts alongside the harness run facts.
  const publish = (event: string, payload: unknown): void => {
    input.publish?.(event, payload)
    harness?.ingestSessionPublish(event, payload)
  }
  harness = input.scope
    ? registerHarnessRuntime({
        authority: input.authority,
        dataDir: input.dataDir,
        scope: input.scope,
        resolveSession: (runtimeSessionId) => projectSession?.getSession(runtimeSessionId),
        persistSession: (session) => projectSession?.upsertSession(session),
        publish,
        ...(input.gateway ? { gateway: input.gateway } : {}),
        ...(input.managedPi ? { managedPi: input.managedPi } : {}),
        ...(input.managedPiArchiveResolver
          ? { managedPiArchiveResolver: input.managedPiArchiveResolver }
          : {}),
        ...(input.acpDriver ? { acpDriver: input.acpDriver } : {}),
        ...(terminal ? { deliverPrompt: terminal.deliverPrompt } : {}),
        ...(terminal
          ? {
              spawnHarnessTerminal: terminal.spawnHarnessTerminal,
              observeTerminalExit: terminal.onTerminalExited,
            }
          : {}),
      })
    : undefined
  // #31 consumer zero-config: the opted-in boot warm never breaks the boot —
  // it is fire-and-forget, its every failure mode is a typed durable driver
  // state, and it is skipped entirely for a scripted (injected) driver.
  if (harness && input.managedPiAutoInstall === true && !input.managedPi) {
    void harness.managedPi.ensureInstalled().catch(() => undefined)
  }

  const browserDevices = registerBrowserDeviceRuntime({
    authority: input.authority,
    ...(input.gateway ? { gateway: input.gateway } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.runLsof ? { runLsof: input.runLsof } : {}),
    ...(input.resolveDns ? { resolveDns: input.resolveDns } : {}),
    ...(input.ownedServices ? { ownedServices: input.ownedServices } : {}),
  })

  // #472 computer-use lanes: session-scoped grants whose consent gate
  // consumes the #471 permission substrate. The default input engine is the
  // real fixed-argv host tooling; tests inject a scripted engine.
  const computerUse = registerComputerUseRuntime({
    authority: input.authority,
    ...(input.gateway ? { gateway: input.gateway } : {}),
    ...(input.macPermissions ? { macPermissions: input.macPermissions } : {}),
    ...(input.computerUseEngine ? { engine: input.computerUseEngine } : {}),
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

  // Files/search + local git (#399): the providers consume the worktree
  // service's canonical roots through the same narrow resolution seam the
  // terminal uses; without a verified scope (or a worktree context) the
  // operations stay typed-unavailable through the composition fallback.
  const files = input.scope
    ? registerFilesRuntime({
        authority: input.authority,
        scope: input.scope,
        // The bulk file-bytes-v1 stream registers on the gateway when the
        // shell composed one; without it those operations stay
        // typed-unavailable through the composition fallback.
        ...(input.gateway ? { gateway: input.gateway } : {}),
        resolveWorktree: (worktreeId) => {
          const record = worktreeService?.getWorktree(input.scope!, worktreeId)
          if (!record) return undefined
          return {
            canonicalRoot: record.canonicalRoot,
            rootIdentity: record.rootIdentity,
            generation: record.generation,
            lifecycle: record.lifecycle,
          }
        },
      })
    : undefined
  const git = input.scope
    ? registerGitRuntime({
        authority: input.authority,
        scope: input.scope,
        resolveWorktree: (worktreeId) => {
          const record = worktreeService?.getWorktree(input.scope!, worktreeId)
          if (!record) return undefined
          return {
            canonicalRoot: record.canonicalRoot,
            rootIdentity: record.rootIdentity,
            generation: record.generation,
            lifecycle: record.lifecycle,
          }
        },
        // Watcher-driven status invalidation (#399 residue): one bounded
        // watcher per ready worktree is constructed inside the registrar
        // against the worktree service's live records; its lifecycle events
        // ride the shell event bus (`git.statusInvalidated`), secret-free.
        ...(input.gitStatusWatcher
          ? {
              watcher: {
                ...(input.gitStatusWatcher.openWatcher
                  ? { openWatcher: input.gitStatusWatcher.openWatcher }
                  : {}),
                ...(input.gitStatusWatcher.schedule
                  ? { schedule: input.gitStatusWatcher.schedule }
                  : {}),
                ...(input.gitStatusWatcher.gate ? { gate: input.gitStatusWatcher.gate } : {}),
              },
            }
          : {}),
        ...(input.publish
          ? { onWatcherEvent: (event) => input.publish?.('git.statusInvalidated', event) }
          : {}),
      })
    : undefined

  // GitHub remote source control (#423): the remote layer on the local git
  // lane. Repositories resolve through the worktree service's registered
  // records (their canonical roots are the only push roots), worktrees stay
  // generation-fenced, and gh is reached through the bounded runner seam —
  // without a verified scope the operations stay typed-unavailable through
  // the composition fallback.
  // oxlint-disable-next-line no-shadow -- parameter intentionally overrides the optional outer service for the fallback seam
  const registeredRepos = (worktreeService?: WorktreeService) => (): readonly GithubRepoContext[] =>
    (worktreeService?.listRepos(input.scope!) ?? []).map((repo) => ({
      repoId: repo.id,
      canonicalRoot: repo.canonicalRoot,
      ...(repo.remote !== undefined ? { remote: repo.remote } : {}),
      ...(repo.defaultBranch !== undefined ? { defaultBranch: repo.defaultBranch } : {}),
    }))
  const github = input.scope
    ? registerGithubRuntime({
        authority: input.authority,
        scope: input.scope,
        resolveRepo: (repoId) =>
          registeredRepos(worktreeService)().find((repo) => repo.repoId === repoId),
        listRepos: registeredRepos(worktreeService),
        resolveWorktree: (worktreeId) => {
          const record = worktreeService?.getWorktree(input.scope!, worktreeId)
          if (!record) return undefined
          return {
            canonicalRoot: record.canonicalRoot,
            rootIdentity: record.rootIdentity,
            generation: record.generation,
            lifecycle: record.lifecycle,
            repoId: record.repoId,
          }
        },
        ...(input.runGh ? { runGh: input.runGh } : {}),
      })
    : undefined

  // #424: when the component manifest is composed in, the composition
  // constructs and holds the M10 supervision engine over its durable journal
  // (launch/exit records under the data dir). The engine starts nothing on
  // its own — it is deterministic over its adapter seam, and the resources
  // surface consumes it read-only: the snapshot, the journal, and the public
  // stop API (which re-proves launch identity before any signal, TM-004).
  // Without a manifest nothing is constructed and the resources surface
  // keeps its truthful-empty contract.
  let supervisor: Supervisor | undefined
  let supervisionJournal: { list(): readonly SupervisionRecord[] } | undefined
  if (input.componentManifest && input.scope) {
    const records = createRecordStore(
      input.supervisionRecordsDir ?? join(input.dataDir, 'dev-runtime', 'supervision')
    )
    supervisor = createSupervisor({
      manifest: input.componentManifest,
      adapter: input.supervisionAdapter ?? createProcessAdapter({}),
      records,
    })
    supervisionJournal = records
  }

  // #424 runtime resources, usage, activity, and safe cleanup. The listing
  // providers compose the #422 port inventory and the supervision view
  // read-only; the destructive stop path re-checks the envelope
  // resource binding, the live generation, and the plan digest, and then
  // delegates the side effect to the supervision engine's public API.
  let resources: ReturnType<typeof registerResourcesRuntime> | undefined
  let cleanupPolicies: CleanupPolicyAuthority | undefined
  let usage = input.usage
  if (input.scope) {
    // The real seams: the constructed engine (a scripted view overrides it),
    // the bounded `ps` sampler, the read-only retained-data projection over
    // the local stores, and the read-only cleanup facts from the composed
    // worktree service. Every default is truthful: failures of a source
    // leave that source absent, never fabricated.
    const supervisionView = input.supervision ?? supervisor
    const supervisionRecords = input.supervisionRecords ?? supervisionJournal
    const sampleProcesses = input.sampleProcesses ?? createProcessSampler()
    const retainedData =
      input.retainedData ??
      createRetainedDataProjection({
        scope: input.scope,
        runtimeRoot: input.runtimeRoot,
        screenshots: browserDevices.screenshots,
        templateRecordsPath: join(
          input.dataDir,
          'dev-runtime',
          'worktrees',
          'templates',
          'records.json'
        ),
      })
    const worktreeFacts = (() => {
      if (input.cleanupWorktreeFacts) return input.cleanupWorktreeFacts
      if (!worktreeService) return undefined
      // #424: the two provable cleanup facts the read-only adapter gained.
      // `pr_merged` cites the merge service's durable journal and verifies the
      // recorded ref state; `active_owned_resources` counts the live
      // owned-resource census built from the registries this composition
      // already holds (terminal census, harness run history, browser lane
      // registry, joined through the project-session records). A census or
      // journal failure leaves the fact absent — every cleanup predicate over
      // an absent fact fails closed.
      const liveLaneStates: ReadonlySet<string> = new Set([
        'provisioning',
        'ready',
        'navigating',
        'suspended',
        'recovering',
      ])
      const ownedResourceCensus = async (): Promise<readonly OwnedResourceRef[]> => {
        const resources: OwnedResourceRef[] = []
        // Running terminals by the terminal registrar's live census. A
        // sidecar failure THROWS (a census that cannot observe cannot prove
        // absence), which the facts adapter turns into fail-closed absence.
        if (terminal?.census) {
          for (const entry of await terminal.census()) {
            resources.push({
              id: entry.terminalId,
              kind: 'terminal',
              worktreeId: entry.worktreeId,
              generation: entry.generation,
            })
          }
        }
        // Active harness runs (durable run history), joined to their worktree
        // through the runtime-session record. Terminal-state runs are not
        // attached; `unknown` is a holding state and still counts.
        if (harness && projectSession) {
          for (const run of harness.history.list()) {
            if (RUN_TERMINAL_STATES.includes(run.state)) continue
            const session = projectSession.getSession(run.runtimeSessionId)
            if (!session) continue
            resources.push({
              id: run.id,
              kind: 'harness',
              worktreeId: session.worktreeId,
              generation: session.generation,
            })
          }
        }
        // Active browser lanes (the lane registry's live records), joined to
        // their worktree the same way. Closed/closing/crashed lanes hold
        // nothing.
        for (const lane of browserDevices.lanes.list({}).items) {
          if (!liveLaneStates.has(lane.state)) continue
          if (
            lane.scope.accountId !== input.scope!.accountId ||
            lane.scope.workspaceId !== input.scope!.workspaceId ||
            lane.scope.runtimeNodeId !== input.scope!.runtimeNodeId
          )
            continue
          const session = projectSession?.getSession(lane.runtimeSessionId)
          if (!session) continue
          resources.push({
            id: lane.id,
            kind: 'browser',
            worktreeId: session.worktreeId,
            generation: lane.generation,
          })
        }
        return resources
      }
      return createCleanupWorktreeFacts({
        worktrees: worktreeService,
        scope: input.scope,
        mergeRecordsPath: join(input.dataDir, 'dev-runtime', 'worktrees', 'merge-records.json'),
        census: ownedResourceCensus,
      })
    })()
    cleanupPolicies = createCleanupPolicyAuthority({
      authority: input.authority,
      dataDir: input.dataDir,
      scope: input.scope,
      approvalVerifier: input.approvalVerifier,
      ...(worktreeFacts ? { worktreeFacts } : {}),
    })
    // #424: the usage surface serves the on-device facts the durable records
    // prove (harness session counts and wall-clock durations, terminal
    // durable-history bytes) plus typed-unavailable rows for everything no
    // provable source exists yet: file-stream bytes (the relay keeps sessions
    // in memory only) and provider-billed usage (no reviewed endpoint and no
    // vault credential — the handoff stays open until terms review lands).
    const usageAdapters = [
      ...(harness?.history ? [createHarnessUsageAdapter({ runs: harness.history })] : []),
      createTerminalUsageAdapter({ runtimeRoot: input.runtimeRoot }),
      createTypedUnavailableUsageAdapter({
        provider: 'device:file-stream',
        source: 'harness_protocol',
        reason:
          'the stream relay keeps its sessions in memory only; file-stream usage needs a durable transfer journal, which does not exist yet',
      }),
      ...(['codex', 'claude'] as const).map((provider) =>
        createTypedUnavailableUsageAdapter({
          provider,
          reason: `no reviewed ${provider} usage endpoint exists; provider-billed usage needs a terms-reviewed fixed endpoint and a vault credential`,
        })
      ),
    ]
    usage = usage ?? createUsageService({ adapters: usageAdapters })
    resources = registerResourcesRuntime({
      authority: input.authority,
      scope: input.scope,
      ports: browserDevices.ports,
      ...(supervisionView ? { supervision: supervisionView } : {}),
      ...(supervisionRecords ? { supervisionRecords } : {}),
      retainedData,
      usage,
      sampleProcesses,
    })
  }

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
    computerUse,
    ...(projectSession ? { projectSession } : {}),
    ...(repos ? { repos } : {}),
    ...(harness ? { harness } : {}),
    worktrees: worktrees ?? { commands: [] as DevOperation[], registeredCommands: 0 },
    ...(files ? { files } : {}),
    ...(git ? { git } : {}),
    ...(github ? { github } : {}),
    ...(terminal ? { terminal } : {}),
    ...(resources ? { resources } : {}),
    ...(supervisor ? { supervision: supervisor } : {}),
    ...(supervisionJournal ? { supervisionRecords: supervisionJournal } : {}),
    ...(cleanupPolicies ? { cleanupPolicies } : {}),
    ...(usage ? { usage } : {}),
    registration: Object.freeze({
      matrix: Object.freeze(matrix),
      providers: Object.freeze(providers),
      typedUnavailable: Object.freeze(typedUnavailable),
      unavailableReason: Object.freeze(Object.fromEntries(unavailableReasons)),
    }),
  }
}
