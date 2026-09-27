// Terminal runtime registration (issue #396): wires the detached sidecar's
// terminal operations onto the M10 command/channel registry. Everything here
// runs behind the M10 gate — envelope, capability set, replay, and expiry
// checks have passed before a handler runs; this module re-checks the
// resource/generation/scope bindings it owns and fails closed.
import { randomUUID } from 'node:crypto'

import type {
  DevCommand,
  DevError,
  DevOperation,
  Scope,
  ShellProfile,
  TerminalCheckpoint,
  TerminalRecord,
  TerminalSearchMatch,
  TerminalState,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import type { ChannelAuthority, ChannelIdentity } from '../channel/authority'
import type { ChannelGateway, StreamProvider } from '../channel/server'
import type { SidecarClient } from './sidecar/client'
import type { ByteFrameMeta } from './sidecar/protocol'
import { TERMINAL_LIMITS } from './limits'
import { installWrapper, parseShellKind, type ShellKind } from './shell-integration'
import { createInputAuthority, fencedWrite, type InputFence } from './input-authority'

const LIFECYCLE_TO_STATE: Record<string, TerminalState> = {
  creating: 'creating',
  running: 'running',
  detached: 'detached',
  terminating: 'terminating',
  exited: 'exited',
}

const HEALTHS = new Set(['healthy', 'degraded', 'replay_required', 'faulted'])

/** Sidecar result codes that map 1:1 onto the Dev error contract. */
const ERROR_CODES = new Set([
  'not_found',
  'invalid_state',
  'stale_generation',
  'backpressure',
  'limit_exceeded',
  'sequence_gap',
  'spawn_failed',
  'unsupported_capability',
  'identity_mismatch',
  'timeout',
  'sidecar_incompatible',
  'channel_unauthenticated',
  'replay_rejected',
  'unavailable',
  'checkpoint_corrupt',
  'path_escape',
])

export type TerminalRegistryEntry = {
  scope: Scope
  runtimeSessionId: string
  worktreeId: string
  generation: number
  processRecordId: string
  sidecarId: string
}

export type RegisterTerminalRuntimeInput = {
  authority: ChannelAuthority
  gateway: ChannelGateway
  /** The adopted sidecar client (sidecar/adoption). */
  sidecar: SidecarClient
  /** The local device lane's scope; the shell IS the runtime node here. */
  scope: Scope
  /** Owner-only runtime root for content-addressed wrapper installation. */
  runtimeRoot: string
  /**
   * Worktree root resolution. #397 owns the worktree service; until its
   * registry is bound, create fails closed rather than guessing a cwd.
   */
  resolveWorktreeRoot: (worktreeId: string) => string | null
  now?: () => number
  /** Test seam for the normative 15s read-stream heartbeat scheduler. */
  scheduleHeartbeat?: (tick: () => void, intervalMs: number) => () => void
}

export type TerminalRuntimeRegistration = {
  readonly commands: readonly DevOperation[]
  /**
   * #400 residue: guarded prompt delivery into a runtime session's PTY.
   * Acquires the terminal's input authority as the `prompt_delivery` source
   * (the TerminalInputAuthority single-writer contract), writes the prompt
   * through the fenced chunk writer, and releases. Never a raw sidecar write:
   * an in-flight user writer loses ownership atomically and its later chunks
   * are rejected before reaching the PTY.
   */
  deliverPrompt(input: { runtimeSessionId: string; prompt: string }): Promise<
    | {
        ok: true
        terminalId: string
        terminalGeneration: number
        chunks: number
        bytes: number
      }
    | { ok: false; code: DevError['code']; message: string }
  >
  /** Detaches every stream; PTY sessions and their history live on. */
  dispose(): void
  /**
   * #400 residue: harness-in-PTY spawn. Spawns a HOST-RESOLVED harness
   * executable (never renderer-supplied argv) as the PTY child of a new
   * terminal bound to the runtime session — the same sidecar spawn path
   * `dev.terminal.create` uses — registers it like any terminal, and binds
   * the caller to the terminal id/generation. The process the run lives in
   * is therefore observable through the terminal runtime and its exit is
   * OBSERVED through the sidecar (`onTerminalExited`), never assumed and
   * never signalled from outside the terminal runtime's ownership.
   */
  spawnHarnessTerminal(request: {
    runtimeSessionId: string
    worktreeId: string
    /** The host-resolved harness executable identity (absolute argv[0]). */
    shell: string
    cols?: number
    rows?: number
  }): Promise<
    | { ok: true; terminalId: string; terminalGeneration: number }
    | { ok: false; code: DevError['code']; message: string }
  >
  /**
   * #400 residue: subscribes to sidecar-OBSERVED terminal terminations (the
   * exited notice carries the observed exit code, or null when the process
   * ended by signal — a signal is never treated as an exit status). Returns
   * the unsubscribe function.
   */
  onTerminalExited(
    cb: (notice: { terminalId: string; generation: number; exitCode: number | null }) => void
  ): () => void
  /**
   * #424 read-only live census: the sidecar's live terminal snapshots joined
   * with this registrar's worktree bindings. One entry per attached terminal
   * whose observed lifecycle is not `exited` (a still-terminating terminal is
   * counted — the safe direction for cleanup facts). A sidecar failure THROWS
   * the typed sidecar error rather than resolving empty: a census that cannot
   * observe cannot prove absence, and the cleanup-facts consumer fails closed
   * on the throw (a silent empty census would undercount running terminals).
   */
  census(): Promise<readonly TerminalCensusEntry[]>
}

/** One census entry: the registrar's binding for a live terminal, cited by
 *  terminal id (the provenance unit the #424 cleanup facts use). */
export type TerminalCensusEntry = {
  terminalId: string
  runtimeSessionId: string
  worktreeId: string
  generation: number
  state: TerminalState
}

function devError(code: DevError['code'], message: string, retryable = false): DevError {
  return { code, retryable, message }
}

function sidecarFailure(code: string, message: string): DevError {
  return devError(
    ERROR_CODES.has(code) ? (code as DevError['code']) : 'invalid_state',
    message,
    code === 'timeout' || code === 'backpressure'
  )
}

type SidecarSnapshot = {
  terminalId: string
  lifecycle: string
  health: string
  nextSeq: string
  generation: number
  subscriberCount: number
}

const canonicalTerminalSequence = /^(0|[1-9][0-9]*)$/
const TERMINAL_SEQUENCE_MAX = (1n << 64n) - 1n

export function registerTerminalRuntime(
  input: RegisterTerminalRuntimeInput
): TerminalRuntimeRegistration {
  const now = input.now ?? Date.now
  const scheduleHeartbeat =
    input.scheduleHeartbeat ??
    ((tick: () => void, intervalMs: number) => {
      const timer = setInterval(tick, intervalMs)
      return () => clearInterval(timer)
    })
  const registry = new Map<string, TerminalRegistryEntry>()
  const inputAuthorities = new Map<string, ReturnType<typeof createInputAuthority>>()
  type ReadSession = {
    terminalId: string
    subscriberId: string
    session: Parameters<StreamProvider>[0]
    generation: number
    throughSequence: string
    outstandingBytes: number
    heartbeatProbeInFlight: boolean
    stopHeartbeat?: () => void
  }
  const readSessions = new Map<string, ReadSession>()
  const writeSessions = new Map<
    string,
    {
      terminalId: string
      generation: number
      session: Parameters<StreamProvider>[0]
      fence?: InputFence
    }
  >()
  /** #400: fan-out for sidecar-observed terminal terminations. The sidecar
   * client allows one onExited handler, so the register owns it and fans out
   * to every subscriber. */
  const exitObservers = new Set<
    (notice: { terminalId: string; generation: number; exitCode: number | null }) => void
  >()

  function stopReadSession(
    state: ReadSession,
    options: {
      close?: { code: Parameters<ReadSession['session']['close']>[0]; reason: string }
      detach?: boolean
      error?: DevError
    } = {}
  ): void {
    if (readSessions.get(state.subscriberId) !== state) return
    readSessions.delete(state.subscriberId)
    state.stopHeartbeat?.()
    state.stopHeartbeat = undefined
    if (options.error) {
      try {
        state.session.send({ type: 'error', error: options.error })
      } catch {
        /* the stream may already be gone */
      }
    }
    if (options.close) {
      try {
        state.session.close(options.close.code, options.close.reason)
      } catch {
        /* the stream may already be gone */
      }
    }
    if (options.detach !== false && !input.sidecar.isClosed()) {
      void input.sidecar.detach(state.terminalId, state.subscriberId).catch(() => undefined)
    }
  }

  function lastThroughSequence(nextSequence: string): string | null {
    if (!canonicalTerminalSequence.test(nextSequence)) return null
    const next = BigInt(nextSequence)
    if (next > TERMINAL_SEQUENCE_MAX) return null
    // The initial empty stream has cursor zero. The terminal protocol keeps
    // that anchor (rather than inventing a signed -1 uint64 sentinel).
    return (next === 0n ? 0n : next - 1n).toString()
  }

  function startReadHeartbeat(state: ReadSession): boolean {
    try {
      state.stopHeartbeat = scheduleHeartbeat(() => {
        if (readSessions.get(state.subscriberId) !== state) return
        if (input.sidecar.isClosed()) {
          stopReadSession(state, {
            close: { code: 'normal', reason: 'terminal sidecar disconnected' },
            error: devError('unavailable', 'terminal sidecar disconnected'),
            detach: false,
          })
          return
        }
        const entry = registry.get(state.terminalId)
        if (!entry || entry.generation !== state.generation) {
          stopReadSession(state, {
            close: { code: 'stale_generation', reason: 'terminal generation changed' },
            error: devError('stale_generation', 'terminal generation changed'),
          })
          return
        }
        if (state.heartbeatProbeInFlight) return
        state.heartbeatProbeInFlight = true
        void input.sidecar
          .list()
          .then((listed) => {
            state.heartbeatProbeInFlight = false
            if (readSessions.get(state.subscriberId) !== state) return
            if (!listed.ok) {
              const error = sidecarFailure(listed.code, listed.message)
              stopReadSession(state, {
                close: { code: 'normal', reason: 'terminal heartbeat probe failed' },
                error,
              })
              return
            }
            if (!Array.isArray(listed.value.terminals)) {
              stopReadSession(state, {
                close: { code: 'incompatible', reason: 'terminal list response is invalid' },
                error: devError('invalid_state', 'terminal list response is invalid'),
              })
              return
            }
            const matches = listed.value.terminals.filter(
              (snapshot): snapshot is SidecarSnapshot =>
                typeof snapshot === 'object' &&
                snapshot !== null &&
                'terminalId' in snapshot &&
                snapshot.terminalId === state.terminalId
            )
            if (matches.length !== 1 || matches[0]!.generation !== state.generation) {
              stopReadSession(state, {
                close: { code: 'stale_generation', reason: 'terminal snapshot changed' },
                error: devError('stale_generation', 'terminal snapshot changed'),
              })
              return
            }
            if (typeof matches[0]!.nextSeq !== 'string') {
              stopReadSession(state, {
                close: { code: 'incompatible', reason: 'terminal snapshot cursor is invalid' },
                error: devError('sequence_gap', 'terminal snapshot cursor is invalid'),
              })
              return
            }
            const throughSequence = lastThroughSequence(matches[0]!.nextSeq)
            if (throughSequence === null) {
              stopReadSession(state, {
                close: { code: 'incompatible', reason: 'terminal snapshot cursor is invalid' },
                error: devError('sequence_gap', 'terminal snapshot cursor is invalid'),
              })
              return
            }
            if (BigInt(throughSequence) > BigInt(state.throughSequence)) {
              state.throughSequence = throughSequence
            }
            try {
              state.session.send({
                type: 'heartbeat',
                observedAt: new Date(now()).toISOString(),
                throughSequence: state.throughSequence,
              })
            } catch {
              stopReadSession(state, {
                close: { code: 'normal', reason: 'terminal read stream is no longer writable' },
              })
            }
          })
          .catch(() => {
            state.heartbeatProbeInFlight = false
            if (readSessions.get(state.subscriberId) !== state) return
            stopReadSession(state, {
              close: { code: 'normal', reason: 'terminal heartbeat probe failed' },
              error: devError('timeout', 'terminal heartbeat probe failed', true),
            })
          })
      }, TERMINAL_LIMITS.heartbeatIntervalMs)
      return true
    } catch {
      return false
    }
  }

  async function snapshotFor(terminalId: string): Promise<SidecarSnapshot | null> {
    const listed = await input.sidecar.list()
    if (!listed.ok) throw sidecarFailure(listed.code, listed.message)
    return (
      (listed.value.terminals as SidecarSnapshot[]).find(
        (entry) => entry.terminalId === terminalId
      ) ?? null
    )
  }

  function requireEntry(command: DevCommand): TerminalRegistryEntry {
    const resource = command.resource
    if (!resource)
      throw devError('identity_mismatch', 'operation requires a terminal resource binding')
    const entry = registry.get(resource.id)
    if (!entry) throw devError('not_found', 'terminal is not registered on this runtime node')
    if (resource.kind !== 'terminal')
      throw devError('identity_mismatch', 'resource kind must be terminal')
    if (resource.generation !== entry.generation) {
      throw devError('stale_generation', 'resource generation does not match the terminal record')
    }
    if (
      entry.scope.accountId !== command.scope.accountId ||
      entry.scope.workspaceId !== command.scope.workspaceId ||
      entry.scope.runtimeNodeId !== command.scope.runtimeNodeId
    ) {
      throw devError('identity_mismatch', 'terminal belongs to another scope')
    }
    return entry
  }

  function recordFor(
    terminalId: string,
    entry: TerminalRegistryEntry,
    snapshot: SidecarSnapshot
  ): TerminalRecord {
    return {
      id: terminalId,
      scope: entry.scope,
      runtimeSessionId: entry.runtimeSessionId,
      worktreeId: entry.worktreeId,
      sidecarId: entry.sidecarId,
      processRecordId: entry.processRecordId,
      state: LIFECYCLE_TO_STATE[snapshot.lifecycle] ?? 'creating',
      health: HEALTHS.has(snapshot.health)
        ? (snapshot.health as TerminalRecord['health'])
        : 'degraded',
      lastSeq: snapshot.nextSeq,
      generation: entry.generation,
    }
  }

  async function recordAfterMutation(command: DevCommand): Promise<TerminalRecord> {
    const entry = requireEntry(command)
    const snapshot = await snapshotFor(command.resource!.id)
    if (!snapshot) {
      // Exited terminals leave the live map; the record stays queryable in a
      // truthful exited state (spec state machine: … → exited).
      return {
        id: command.resource!.id,
        scope: entry.scope,
        runtimeSessionId: entry.runtimeSessionId,
        worktreeId: entry.worktreeId,
        sidecarId: entry.sidecarId,
        processRecordId: entry.processRecordId,
        state: 'exited',
        health: 'healthy',
        lastSeq: '0',
        generation: entry.generation,
      }
    }
    return recordFor(command.resource!.id, entry, snapshot)
  }

  function builtinShellProfiles(): ShellProfile[] {
    const candidates: Array<{ id: string; label: string; path: string; shellKind: ShellKind }> = [
      {
        id: '00000000-0000-4000-8000-00000000d001',
        label: 'zsh',
        path: '/bin/zsh',
        shellKind: 'zsh',
      },
      {
        id: '00000000-0000-4000-8000-00000000d002',
        label: 'bash',
        path: '/bin/bash',
        shellKind: 'bash',
      },
      {
        id: '00000000-0000-4000-8000-00000000d003',
        label: 'fish',
        path: '/usr/local/bin/fish',
        shellKind: 'fish',
      },
    ]
    const envAllowlist = ['HOME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER', 'LANG']
    const profiles: ShellProfile[] = []
    for (const candidate of candidates) {
      if (parseShellKind(candidate.path) !== candidate.shellKind) continue
      try {
        // Wrappers are content-addressed and idempotent; installing here
        // keeps the advertised profile tied to a real installed wrapper.
        installWrapper({
          runtimeRoot: input.runtimeRoot,
          shellKind: candidate.shellKind,
          features: ['markers', 'cwd', 'history'],
        })
      } catch {
        continue
      }
      profiles.push({
        id: candidate.id,
        scope: input.scope,
        label: candidate.label,
        argv: [candidate.path, '-l'],
        envAllowlistKeys: envAllowlist,
        builtin: true,
        version: 1,
      })
    }
    return profiles
  }

  const handlers: Partial<
    Record<DevOperation, (command: DevCommand, identity?: ChannelIdentity) => Promise<unknown>>
  > = {
    'dev.terminal.shellProfiles': async () => ({
      items: builtinShellProfiles(),
      observedAt: new Date(now()).toISOString(),
    }),

    'dev.terminal.create': async (command) => {
      const body = devOperationDecoders['dev.terminal.create'].request(command.body)
      if (command.resource !== undefined) {
        throw devError('identity_mismatch', 'dev.terminal.create carries no resource binding')
      }
      if (
        command.scope.accountId !== input.scope.accountId ||
        command.scope.workspaceId !== input.scope.workspaceId ||
        command.scope.runtimeNodeId !== input.scope.runtimeNodeId
      ) {
        throw devError(
          'workspace_unavailable',
          'terminal creation is bound to the local runtime node'
        )
      }
      const worktreeId = body.worktreeId as string
      const cwd = input.resolveWorktreeRoot(worktreeId)
      if (cwd === null) {
        throw devError('not_found', 'worktree root is not authorized on this runtime node')
      }
      const profiles = builtinShellProfiles()
      const shellPath = profiles[0]?.argv[0]
      if (!shellPath)
        throw devError('unsupported_capability', 'no builtin shell is available on this host')
      const terminalId = randomUUID()
      const created = await input.sidecar.create({
        terminalId,
        generation: 1,
        cols: body.cols as number,
        rows: body.rows as number,
        cwd,
        shell: shellPath,
        args: ['-l'],
      })
      if (!created.ok) throw sidecarFailure(created.code, created.message)
      const entry: TerminalRegistryEntry = {
        scope: command.scope,
        runtimeSessionId: body.runtimeSessionId as string,
        worktreeId,
        generation: 1,
        processRecordId: randomUUID(),
        sidecarId: input.sidecar.welcome.pidStartIdentity,
      }
      registry.set(terminalId, entry)
      inputAuthorities.set(terminalId, createInputAuthority(terminalId))
      const snapshot = await snapshotFor(terminalId)
      return recordFor(
        terminalId,
        entry,
        snapshot ?? {
          terminalId,
          lifecycle: 'running',
          health: 'healthy',
          nextSeq: '0',
          generation: 1,
          subscriberCount: 0,
        }
      )
    },

    'dev.terminal.list': async (command) => {
      const body = devOperationDecoders['dev.terminal.list'].request(command.body)
      const listed = await input.sidecar.list()
      if (!listed.ok) throw sidecarFailure(listed.code, listed.message)
      const terminals = (listed.value.terminals as SidecarSnapshot[])
        .map((snapshot) => {
          const entry = registry.get(snapshot.terminalId)
          // Terminals adopted from a prior app process are rebound by the
          // session registry slice; they are not advertised until then.
          if (!entry) return null
          return recordFor(snapshot.terminalId, entry, snapshot)
        })
        .filter((record): record is TerminalRecord => record !== null)
        .filter((record) => {
          if (
            typeof body.runtimeSessionId === 'string' &&
            record.runtimeSessionId !== body.runtimeSessionId
          )
            return false
          if (typeof body.worktreeId === 'string' && record.worktreeId !== body.worktreeId)
            return false
          if (typeof body.state === 'string' && record.state !== body.state) return false
          return true
        })
      return { items: terminals, observedAt: new Date(now()).toISOString() }
    },

    'dev.terminal.attach': async (command, identity) => {
      const entry = requireEntry(command)
      const body = devOperationDecoders['dev.terminal.attach'].request(command.body)
      if (body.terminalId !== command.resource!.id) {
        throw devError('identity_mismatch', 'body terminalId does not match the resource binding')
      }
      const grant = input.authority.mintStreamGrant({
        identity: identity!,
        protocol: 'terminal-bytes-v1',
        scope: command.scope,
        resource: { kind: 'terminal', id: body.terminalId as string, generation: entry.generation },
        direction: 'read',
        fromSequence: (body.fromSequence as string | undefined) ?? '0',
      })
      return grant
    },

    'dev.terminal.input': async (command, identity) => {
      const entry = requireEntry(command)
      const body = devOperationDecoders['dev.terminal.input'].request(command.body)
      if (body.terminalId !== command.resource!.id) {
        throw devError('identity_mismatch', 'body terminalId does not match the resource binding')
      }
      const grant = input.authority.mintStreamGrant({
        identity: identity!,
        protocol: 'terminal-bytes-v1',
        scope: command.scope,
        resource: { kind: 'terminal', id: body.terminalId as string, generation: entry.generation },
        direction: 'write',
        fromSequence: (body.fromSequence as string | undefined) ?? '0',
      })
      return grant
    },

    'dev.terminal.detach': async (command) => recordAfterMutation(command),
    'dev.terminal.resize': async (command) => {
      const body = devOperationDecoders['dev.terminal.resize'].request(command.body)
      requireEntry(command)
      const result = await input.sidecar.resize(
        body.terminalId as string,
        body.cols as number,
        body.rows as number
      )
      if (!result.ok) throw sidecarFailure(result.code, result.message)
      return recordAfterMutation(command)
    },
    'dev.terminal.signal': async (command) => {
      const body = devOperationDecoders['dev.terminal.signal'].request(command.body)
      requireEntry(command)
      const signalMap = { interrupt: 'SIGINT', terminate: 'SIGTERM', kill: 'SIGKILL' } as const
      const result = await input.sidecar.signal(
        body.terminalId as string,
        signalMap[body.signal as keyof typeof signalMap]
      )
      if (!result.ok) throw sidecarFailure(result.code, result.message)
      return recordAfterMutation(command)
    },
    'dev.terminal.terminate': async (command) => {
      const body = devOperationDecoders['dev.terminal.terminate'].request(command.body)
      requireEntry(command)
      if (typeof body.confirmationId !== 'string' || body.confirmationId.length < 6) {
        throw devError('invalid_state', 'terminate requires an explicit confirmation id')
      }
      const result = await input.sidecar.terminate(body.terminalId as string)
      if (!result.ok) throw sidecarFailure(result.code, result.message)
      return recordAfterMutation(command)
    },
    'dev.terminal.checkpoint': async (command) => {
      const entry = requireEntry(command)
      const body = devOperationDecoders['dev.terminal.checkpoint'].request(command.body)
      if (body.terminalId !== command.resource!.id) {
        throw devError('identity_mismatch', 'body terminalId does not match the resource binding')
      }
      const result = await input.sidecar.checkpoint(body.terminalId as string)
      if (!result.ok) throw sidecarFailure(result.code, result.message)
      const footer = result.value.checkpoint as {
        fromSeq: string
        toSeq: string
        byteLength: number
        segmentSha256: string
        createdAt: string
      } | null
      const snapshot = await snapshotFor(body.terminalId as string)
      const checkpoint: TerminalCheckpoint = {
        id: randomUUID(),
        terminalId: body.terminalId as string,
        generation: entry.generation,
        throughSequence: footer?.toSeq ?? snapshot?.nextSeq ?? '0',
        segmentSha256: footer?.segmentSha256 ?? '0'.repeat(64),
        byteLength: String(footer?.byteLength ?? 0),
        createdAt: footer?.createdAt ?? new Date(now()).toISOString(),
      }
      // An empty flush has no segment; a zero digest marks that truthfully
      // instead of fabricating one.
      return checkpoint
    },
    'dev.terminal.search': async (command) => {
      const entry = requireEntry(command)
      const body = devOperationDecoders['dev.terminal.search'].request(command.body)
      if (body.terminalId !== command.resource!.id) {
        throw devError('identity_mismatch', 'body terminalId does not match the resource binding')
      }
      const result = await input.sidecar.search(
        body.terminalId as string,
        body.query as string,
        (body.limit as number | undefined) ?? 100
      )
      if (!result.ok) throw sidecarFailure(result.code, result.message)
      const matches: TerminalSearchMatch[] = (
        result.value.matches as Array<{ seq: string; byteOffset: string; preview: string }>
      ).map((match) => ({
        terminalId: body.terminalId as string,
        generation: entry.generation,
        sequence: match.seq,
        byteOffset: match.byteOffset,
        preview: match.preview,
      }))
      return { items: matches, observedAt: new Date(now()).toISOString() }
    },
    'dev.terminal.historyDelete': async (command) => {
      const body = devOperationDecoders['dev.terminal.historyDelete'].request(command.body)
      requireEntry(command)
      if (typeof body.confirmationId !== 'string' || body.confirmationId.length < 6) {
        throw devError('invalid_state', 'history deletion requires an explicit confirmation id')
      }
      const result = await input.sidecar.deleteHistory(body.terminalId as string)
      if (!result.ok) throw sidecarFailure(result.code, result.message)
      return recordAfterMutation(command)
    },
  }

  // ── terminal-bytes-v1 stream provider ────────────────────────────────────

  function registerStreamProvider(): void {
    input.gateway.registerStreamHandler('terminal-bytes-v1', (session) => {
      const grant = session.grant
      if (grant.resource.kind !== 'terminal') {
        session.close('incompatible', 'terminal streams bind terminal resources')
        return
      }
      if (grant.direction === 'read') {
        const terminalId = grant.resource.id
        const subscriberId = grant.grantId
        const entry = registry.get(terminalId)
        if (!entry || entry.generation !== grant.resource.generation) {
          const error = entry
            ? devError('stale_generation', 'read grant generation is stale')
            : devError('not_found', 'terminal is not registered on this runtime node')
          session.send({ type: 'error', error })
          session.close(entry ? 'stale_generation' : 'incompatible', error.message)
          return
        }
        const state: ReadSession = {
          terminalId,
          subscriberId,
          session,
          generation: grant.resource.generation,
          throughSequence: '0',
          outstandingBytes: 0,
          heartbeatProbeInFlight: false,
        }
        readSessions.set(subscriberId, state)
        session.onClose = () => {
          if (readSessions.get(subscriberId) !== state) return
          readSessions.delete(subscriberId)
          state.stopHeartbeat?.()
          state.stopHeartbeat = undefined
          if (!input.sidecar.isClosed()) {
            void input.sidecar.detach(terminalId, subscriberId).catch(() => undefined)
          }
        }
        void input.sidecar
          .attach({ terminalId, subscriberId, sinceSeq: grant.fromSequence })
          .then((attached) => {
            if (readSessions.get(subscriberId) !== state) return
            if (!attached.ok) {
              stopReadSession(state, {
                error: sidecarFailure(attached.code, attached.message),
                close: { code: 'incompatible', reason: attached.message },
              })
              return
            }
            if (attached.value.resyncRequired) {
              try {
                session.send({
                  type: 'resync',
                  reason: 'checkpoint_required',
                  checkpointSequence: attached.value.checkpointSequence,
                })
              } catch {
                /* the stream may already be gone */
              }
              stopReadSession(state, {
                close: { code: 'backpressure', reason: 'coverage begins at the checkpoint anchor' },
              })
              return
            }
            const current = registry.get(terminalId)
            if (!current || current.generation !== state.generation) {
              stopReadSession(state, {
                error: devError('stale_generation', 'terminal generation changed during attach'),
                close: {
                  code: 'stale_generation',
                  reason: 'terminal generation changed during attach',
                },
              })
              return
            }
            const attachedThroughSequence = lastThroughSequence(attached.value.nextSeq)
            if (attachedThroughSequence === null) {
              stopReadSession(state, {
                error: devError('sequence_gap', 'terminal attach returned an invalid cursor'),
                close: {
                  code: 'incompatible',
                  reason: 'terminal attach returned an invalid cursor',
                },
              })
              return
            }
            if (BigInt(attachedThroughSequence) > BigInt(state.throughSequence)) {
              state.throughSequence = attachedThroughSequence
            }
            if (!startReadHeartbeat(state)) {
              stopReadSession(state, {
                error: devError('timeout', 'terminal heartbeat could not be scheduled', true),
                close: { code: 'normal', reason: 'terminal heartbeat could not be scheduled' },
              })
            }
          })
          .catch(() => {
            stopReadSession(state, {
              error: devError('timeout', 'terminal attach failed', true),
              close: { code: 'normal', reason: 'attach failed' },
            })
          })
        session.onFrame = (frame) => {
          if (frame.type !== 'ack') {
            stopReadSession(state, {
              close: { code: 'incompatible', reason: 'read streams accept only ack frames' },
              error: devError('unsupported_version', 'read streams accept only ack frames'),
            })
            return
          }
          void input.sidecar
            .acknowledge(terminalId, subscriberId, frame.availableCreditBytes)
            .catch(() => {
              if (readSessions.get(subscriberId) === state) {
                stopReadSession(state, {
                  error: devError('timeout', 'terminal acknowledgement failed', true),
                  close: { code: 'normal', reason: 'terminal acknowledgement failed' },
                })
              }
            })
          state.outstandingBytes = Math.max(0, state.outstandingBytes - frame.availableCreditBytes)
        }
        return
      }
      // Write direction: input frames carry generation-stamped chunks; the
      // grant binding is the write authority for this stream.
      const terminalId = grant.resource.id
      const entry = registry.get(terminalId)
      if (!entry) {
        // An unregistered (or since-deregistered) terminal grants no write
        // authority here even if the sidecar still holds a session.
        session.send({
          type: 'error',
          error: devError('not_found', 'terminal is not registered on this runtime node'),
        })
        session.close('incompatible', 'terminal is not registered')
        return
      }
      if (grant.resource.generation !== entry.generation) {
        session.send({
          type: 'error',
          error: devError('stale_generation', 'grant generation is stale'),
        })
        session.close('stale_generation', 'input generation is stale')
        return
      }
      const authority =
        inputAuthorities.get(terminalId) ??
        (() => {
          const created = createInputAuthority(terminalId)
          inputAuthorities.set(terminalId, created)
          return created
        })()
      const writeState: {
        terminalId: string
        generation: number
        session: typeof session
        fence?: InputFence
      } = { terminalId, generation: grant.resource.generation, session }
      writeSessions.set(grant.grantId, writeState)
      // The stream grant becomes the terminal's current input owner. A later
      // grant atomically replaces this fence; every chunk from the old writer
      // is rejected before reaching the PTY.
      const admitted = authority.admit('terminal_user', grant.resource.generation)
      if (!admitted.ok) {
        session.close('stale_generation', admitted.message)
        writeSessions.delete(grant.grantId)
        return
      }
      writeState.fence = admitted.fence
      session.onFrame = (frame) => {
        if (frame.type !== 'input') {
          session.close('incompatible', 'write streams accept only input frames')
          return
        }
        if (frame.generation !== grant.resource.generation) {
          session.close('stale_generation', 'input frame generation is stale')
          writeSessions.delete(grant.grantId)
          return
        }
        if (!writeState.fence || !authority.admitChunk(writeState.fence).ok) {
          session.close('stale_generation', 'input writer no longer owns the terminal')
          writeSessions.delete(grant.grantId)
          return
        }
        void input.sidecar
          .writeInput(terminalId, frame.bytes)
          .then((written) => {
            if (!written.ok) {
              session.send({ type: 'error', error: sidecarFailure(written.code, written.message) })
            }
          })
          .catch(() => {
            session.close('normal', 'input path failed')
            writeSessions.delete(grant.grantId)
          })
      }
      session.onClose = () => {
        writeSessions.delete(grant.grantId)
        if (writeState.fence) authority.releaseFence(writeState.fence)
      }
    })

    input.sidecar.setEvents({
      onDataFrame: (meta: ByteFrameMeta, bytes) => {
        if (meta.kind !== 'terminal.data' || !meta.subscriberId) return
        const state = readSessions.get(meta.subscriberId)
        if (!state) return
        const entry = registry.get(state.terminalId)
        if (
          meta.terminalId !== state.terminalId ||
          meta.generation !== state.generation ||
          !entry ||
          entry.generation !== state.generation
        ) {
          stopReadSession(state, {
            error: devError('stale_generation', 'terminal output identity changed'),
            close: { code: 'stale_generation', reason: 'terminal output identity changed' },
          })
          return
        }
        if (!canonicalTerminalSequence.test(meta.seq) || BigInt(meta.seq) > TERMINAL_SEQUENCE_MAX) {
          stopReadSession(state, {
            error: devError('sequence_gap', 'terminal output sequence is invalid'),
            close: { code: 'incompatible', reason: 'terminal output sequence is invalid' },
          })
          return
        }
        if (BigInt(meta.seq) > BigInt(state.throughSequence)) {
          state.throughSequence = meta.seq
        }
        state.outstandingBytes += meta.byteLength
        try {
          state.session.send({ type: 'data', sequence: meta.seq, bytes })
        } catch {
          stopReadSession(state, { detach: true })
        }
      },
      onResync: (notice) => {
        const state = readSessions.get(notice.subscriberId)
        if (!state) return
        try {
          state.session.send({
            type: 'resync',
            reason: 'checkpoint_required',
            checkpointSequence: notice.checkpointSequence,
          })
        } catch {
          /* socket already gone */
        }
        stopReadSession(state, {
          close: { code: 'backpressure', reason: 'subscriber fell behind the high-water mark' },
        })
      },
      onExited: (notice) => {
        for (const state of readSessions.values()) {
          if (state.terminalId !== notice.terminalId) continue
          stopReadSession(state, { close: { code: 'normal', reason: 'terminal exited' } })
        }
        // #400: the sidecar OBSERVED this termination — fan it out so bound
        // consumers (harness-in-PTY runs) derive status from an observed
        // fact, never an assumed one.
        for (const observer of exitObservers) {
          try {
            observer(notice)
          } catch {
            /* an observer's failure never breaks the terminal runtime */
          }
        }
      },
      onClose: () => {
        for (const state of readSessions.values()) {
          stopReadSession(state, {
            close: { code: 'normal', reason: 'terminal sidecar disconnected' },
            error: devError('unavailable', 'terminal sidecar disconnected'),
            detach: false,
          })
        }
        for (const [grantId, state] of writeSessions) {
          try {
            state.session.send({
              type: 'error',
              error: devError('unavailable', 'terminal sidecar disconnected'),
            })
          } catch {
            /* the stream may already be gone */
          }
          try {
            state.session.close('normal', 'terminal sidecar disconnected')
          } catch {
            /* the stream may already be gone */
          }
          writeSessions.delete(grantId)
          if (state.fence) {
            inputAuthorities.get(state.terminalId)?.releaseFence(state.fence)
          }
        }
      },
    })
  }

  for (const [operation, handler] of Object.entries(handlers)) {
    input.authority.registerCommandProvider(operation as DevOperation, handler)
  }
  registerStreamProvider()

  // ── #400 residue: guarded prompt delivery (launch → PTY input) ───────────
  //
  // The launch transaction delivers the initial prompt through the strongest
  // supported channel; for PTY-backed launches that is this guarded write
  // path. Delivery is fenced exactly like a client write stream — one
  // `prompt_delivery` owner, per-chunk re-admission, explicit release — so a
  // prompt cannot interleave with a user's paste or cross an ownership
  // change. It is bounded to ONE submit (the verbatim prompt plus a single
  // Enter terminator); reconcile/retry stays a caller decision, never an
  // automatic re-delivery (spec: a timeout/ambiguous acknowledgement does
  // not retry prompt delivery blindly).

  const PROMPT_CHUNK_BYTES = 1024

  async function deliverPrompt(request: { runtimeSessionId: string; prompt: string }): Promise<
    | {
        ok: true
        terminalId: string
        terminalGeneration: number
        chunks: number
        bytes: number
      }
    | { ok: false; code: DevError['code']; message: string }
  > {
    // The session's newest registered terminal is the delivery target; an
    // absent or non-live terminal is a typed non-delivery, never a silent
    // skip and never a fabricated write.
    let target: { terminalId: string; entry: TerminalRegistryEntry } | undefined
    for (const [terminalId, entry] of registry) {
      if (entry.runtimeSessionId === request.runtimeSessionId) target = { terminalId, entry }
    }
    if (!target) {
      return {
        ok: false,
        code: 'not_found',
        message: 'no terminal is attached to this runtime session',
      }
    }
    const snapshot = await snapshotFor(target.terminalId)
    if (!snapshot || snapshot.lifecycle !== 'running') {
      return {
        ok: false,
        code: 'invalid_state',
        message: 'the runtime session terminal is not live',
      }
    }
    const authority =
      inputAuthorities.get(target.terminalId) ??
      (() => {
        const created = createInputAuthority(target.terminalId)
        inputAuthorities.set(target.terminalId, created)
        return created
      })()
    // Acquisition: an equal-generation takeover is the designed ownership
    // transfer. The authority keeps generations monotonic while the source
    // discriminates user typing, chat sends, and this automated delivery, so
    // the audit trail names the writer.
    const admitted = authority.admit('prompt_delivery', target.entry.generation)
    if (!admitted.ok) {
      return { ok: false, code: admitted.code, message: admitted.message }
    }
    const fence = admitted.fence
    const payload = new TextEncoder().encode(
      request.prompt.endsWith('\n') ? request.prompt : `${request.prompt}\n`
    )
    const chunks: Uint8Array[] = []
    for (let offset = 0; offset < payload.byteLength; offset += PROMPT_CHUNK_BYTES) {
      chunks.push(
        payload.subarray(offset, Math.min(offset + PROMPT_CHUNK_BYTES, payload.byteLength))
      )
    }
    const writes: Promise<unknown>[] = []
    let writeError: { code: string; message: string } | undefined
    try {
      const fenced = fencedWrite(authority, fence, chunks, (chunk) => {
        writes.push(
          input.sidecar.writeInput(target.terminalId, chunk).then((written) => {
            if (!written.ok && !writeError) {
              writeError = { code: written.code, message: written.message }
            }
          })
        )
      })
      // Byte order is preserved by the sidecar duplex; the awaits only collect
      // the correlated write results.
      for (const pending of writes) await pending
      if (writeError) {
        const mapped = sidecarFailure(writeError.code, writeError.message)
        return { ok: false, code: mapped.code, message: mapped.message }
      }
      if (fenced.stopped) {
        return {
          ok: false,
          code: 'stale_generation',
          message: 'prompt delivery lost the terminal input ownership mid-write',
        }
      }
      return {
        ok: true,
        terminalId: target.terminalId,
        terminalGeneration: target.entry.generation,
        chunks: fenced.written,
        bytes: payload.byteLength,
      }
    } finally {
      // Release only while the fence is still current; a taken-over fence
      // stays with its new owner.
      authority.releaseFence(fence)
    }
  }

  // ── #400 residue: harness-in-PTY spawn ───────────────────────────────────
  //
  // A harness launch with the `attachTerminal` intent spawns the harness
  // executable as the PTY child of a NEW terminal bound to the runtime
  // session. The spawn reuses exactly the `dev.terminal.create` patterns —
  // worktree-resolved cwd, sidecar.create, registry + input-authority
  // registration — so the harness process is a first-class terminal process:
  // observable through the terminal runtime, writable through the guarded
  // input authority, and its exit OBSERVED through the sidecar's exited
  // notice. The argv[0] is the host-resolved installation executable
  // identity; this seam never accepts renderer-supplied argv.

  async function spawnHarnessTerminal(request: {
    runtimeSessionId: string
    worktreeId: string
    shell: string
    cols?: number
    rows?: number
  }): Promise<
    | { ok: true; terminalId: string; terminalGeneration: number }
    | { ok: false; code: DevError['code']; message: string }
  > {
    if (request.shell.length === 0 || request.shell.includes('\0')) {
      return { ok: false, code: 'identity_mismatch', message: 'harness executable is unresolved' }
    }
    const cwd = input.resolveWorktreeRoot(request.worktreeId)
    if (cwd === null) {
      return {
        ok: false,
        code: 'not_found',
        message: 'worktree root is not authorized on this runtime node',
      }
    }
    const cols = request.cols ?? 80
    const rows = request.rows ?? 24
    const terminalId = randomUUID()
    const created = await input.sidecar.create({
      terminalId,
      generation: 1,
      cols,
      rows,
      cwd,
      shell: request.shell,
      args: [],
    })
    if (!created.ok) {
      const failure = sidecarFailure(created.code, created.message)
      return { ok: false, code: failure.code, message: failure.message }
    }
    const entry: TerminalRegistryEntry = {
      scope: input.scope,
      runtimeSessionId: request.runtimeSessionId,
      worktreeId: request.worktreeId,
      generation: 1,
      processRecordId: randomUUID(),
      sidecarId: input.sidecar.welcome.pidStartIdentity,
    }
    registry.set(terminalId, entry)
    inputAuthorities.set(terminalId, createInputAuthority(terminalId))
    return { ok: true, terminalId, terminalGeneration: entry.generation }
  }

  function onTerminalExited(
    cb: (notice: { terminalId: string; generation: number; exitCode: number | null }) => void
  ): () => void {
    exitObservers.add(cb)
    return () => {
      exitObservers.delete(cb)
    }
  }

  async function census(): Promise<readonly TerminalCensusEntry[]> {
    const listed = await input.sidecar.list()
    if (!listed.ok) throw sidecarFailure(listed.code, listed.message)
    const entries: TerminalCensusEntry[] = []
    for (const snapshot of listed.value.terminals as SidecarSnapshot[]) {
      const entry = registry.get(snapshot.terminalId)
      // Terminals adopted from a prior app process are rebound by the
      // session registry slice; they are not advertised until then.
      if (!entry) continue
      const state = LIFECYCLE_TO_STATE[snapshot.lifecycle] ?? 'creating'
      if (state === 'exited') continue
      entries.push({
        terminalId: snapshot.terminalId,
        runtimeSessionId: entry.runtimeSessionId,
        worktreeId: entry.worktreeId,
        generation: entry.generation,
        state,
      })
    }
    return entries
  }

  return {
    commands: Object.keys(handlers) as DevOperation[],
    deliverPrompt,
    spawnHarnessTerminal,
    onTerminalExited,
    census,
    dispose() {
      for (const state of readSessions.values()) {
        stopReadSession(state, {
          close: { code: 'normal', reason: 'terminal runtime detached' },
        })
      }
      for (const [grantId, state] of writeSessions) {
        try {
          state.session.close('normal', 'terminal runtime detached')
        } catch {
          /* socket already gone */
        }
        writeSessions.delete(grantId)
        if (state.fence) {
          inputAuthorities.get(state.terminalId)?.releaseFence(state.fence)
        }
      }
    },
  }
}
