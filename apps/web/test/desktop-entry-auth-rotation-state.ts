import type { DesktopSession } from '@adea-ai/auth/desktop'
import type { WorkspaceSummary } from '@adea-ai/types'
import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'
import type { NativeSessionInventoryDiagnosticService } from '@adea-ai/workspace-ui/platform'
import type { DesktopShell } from '../src/lib/desktop-bridge'

const observedAt = '2026-10-15T00:00:00.000Z'
const fixtureOptions = new URLSearchParams(window.location.search)
export const rotationScope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
export const rotationWorkspace: WorkspaceSummary = {
  id: rotationScope.workspaceId,
  name: 'Same workspace',
  accent: null,
  logo: { kind: 'monogram' },
  scene: 'home',
  sortOrder: 0,
  updatedAt: observedAt,
  version: 1,
}
export const rotationSessions: readonly DesktopSession[] = ['a', 'b'].map((suffix) => ({
  credential: `synthetic-fixture-credential-${suffix}`,
  expiresAt: '2099-01-01T00:00:00.000Z',
  sessionId: `fixture-session-${
    ['principal', 'same-session'].includes(fixtureOptions.get('rotation') ?? '') ? 'a' : suffix
  }`,
}))

const listeners = new Map<string, Set<(payload: unknown) => void>>()
const providerSerials = new WeakMap<NativeSessionInventoryDiagnosticService, number>()
let nextProviderSerial = 0
let currentProvider: NativeSessionInventoryDiagnosticService | undefined
let originalProvider: NativeSessionInventoryDiagnosticService | undefined
let queuedCallback: string | null = null
let entryMounts = 0
let inventoryReads = 0
let scopeProjections = 0
let selectionRequests = 0
let releaseSelection: (() => void) | undefined
let holdInventoryRead = false
let releaseRead: (() => void) | undefined
let inventoryReplies = 0
const bootstrapSessionIds: string[] = []
const bootstrapPrincipalIds: string[] = []
const selectedSessionIds: string[] = []
const workspaceIds: string[] = []
const unexpectedOperations: string[] = []

export function unexpectedOperation(operation: string): never {
  unexpectedOperations.push(operation)
  throw new Error(`Unexpected auth-rotation fixture operation: ${operation}`)
}

export function recordBootstrap(session: DesktopSession | undefined) {
  if (!session) unexpectedOperation('bootstrap without an authenticated session')
  bootstrapSessionIds.push(session.sessionId)
  bootstrapPrincipalIds.push(rotationPrincipal(session))
  workspaceIds.push(rotationWorkspace.id)
}

export function rotationPrincipal(session: DesktopSession | undefined): string {
  return fixtureOptions.get('rotation') === 'principal' &&
    session?.credential === rotationSessions[1]!.credential
    ? 'fixture-user-b'
    : 'fixture-user-a'
}

export function observeProvider(provider: NativeSessionInventoryDiagnosticService | undefined) {
  currentProvider = provider
  originalProvider ??= provider
  if (provider && !providerSerials.has(provider)) {
    nextProviderSerial += 1
    providerSerials.set(provider, nextProviderSerial)
  }
}

export function recordEntryMount() {
  entryMounts += 1
}

export const rotationBridge: DesktopShell = {
  async invoke(command, args) {
    switch (command) {
      case 'desktop_auth_take_callback': {
        const callback = queuedCallback
        queuedCallback = null
        return callback
      }
      case 'desktop_identity_select_workspace': {
        const credential = args?.credential as
          | { kind?: string; session?: DesktopSession }
          | undefined
        if (
          args?.workspaceId !== rotationWorkspace.id ||
          credential?.kind !== 'desktop' ||
          !rotationSessions.some((session) => session.sessionId === credential.session?.sessionId)
        ) {
          return unexpectedOperation('invalid workspace selection')
        }
        selectionRequests += 1
        if (selectionRequests === 2) {
          if (fixtureOptions.get('admission') === 'refused')
            throw new Error('unauthorized: fixture refuses renewed workspace selection')
          if (fixtureOptions.get('admission') === 'held') {
            await new Promise<void>((resolve) => {
              releaseSelection = resolve
            })
            releaseSelection = undefined
          }
        }
        selectedSessionIds.push(credential.session!.sessionId)
        return { scope: { ...rotationScope }, kind: 'device' }
      }
      case 'desktop_identity_scope':
        scopeProjections += 1
        return { ...rotationScope }
      case 'local_content_authorize_workspace':
        if (args?.workspaceId !== rotationWorkspace.id)
          return unexpectedOperation('authorize another workspace')
        return undefined
      case 'desktop_identity_workspace_cleanup_pending':
        return []
      case 'adea_app_version':
        return '0.0.0-fixture'
      case 'desktop_update_status':
        // Production catches an unavailable updater; no updater is constructed.
        throw new Error('fixture updater unavailable')
      case 'desktop_preferences_load':
        return {}
      case 'desktop_preferences_save':
        return undefined
      default:
        return unexpectedOperation(command)
    }
  },
  async listen(event, listener) {
    const handlers = listeners.get(event) ?? new Set<(payload: unknown) => void>()
    handlers.add(listener)
    listeners.set(event, handlers)
    return () => {
      handlers.delete(listener)
    }
  },
  async devExecute(rawCommand) {
    const command = rawCommand as DevCommand
    if (command.operation === 'dev.summary.workspaces') {
      return {
        schemaVersion: 1,
        requestId: command.requestId,
        operation: command.operation,
        ok: false,
        error: {
          code: 'capability_unavailable',
          retryable: false,
          message: 'fixture summary absent',
        },
      } satisfies DevReply
    }
    if (command.operation !== 'dev.session.list') return unexpectedOperation(command.operation)
    if (
      command.scope.accountId !== rotationScope.accountId ||
      command.scope.workspaceId !== rotationScope.workspaceId ||
      command.scope.runtimeNodeId !== rotationScope.runtimeNodeId
    )
      return unexpectedOperation('inventory scope mismatch')
    inventoryReads += 1
    if (holdInventoryRead) {
      holdInventoryRead = false
      await new Promise<void>((resolve) => {
        releaseRead = resolve
      })
      releaseRead = undefined
    }
    inventoryReplies += 1
    return {
      schemaVersion: 1,
      requestId: command.requestId,
      operation: command.operation,
      ok: true,
      value: {
        items: [
          {
            id: '00000000-0000-4000-8000-000000000040',
            scope: { ...rotationScope },
            archived: false,
            generation: 1,
            lifecycle: 'ready',
            version: 1,
            projectId: '00000000-0000-4000-8000-000000000020',
            worktreeId: '00000000-0000-4000-8000-000000000050',
            repoId: '00000000-0000-4000-8000-000000000030',
            projection: 'structured',
          },
        ],
        observedAt,
      },
      observedAt,
    } satisfies DevReply
  },
}

export const rotationControls = {
  holdNextInventoryRead() {
    if (holdInventoryRead || releaseRead) return unexpectedOperation('inventory already held')
    holdInventoryRead = true
  },
  releaseInventoryRead() {
    if (!releaseRead) return unexpectedOperation('no held inventory read')
    releaseRead()
  },
  releaseWorkspaceSelection() {
    if (!releaseSelection) return unexpectedOperation('no held workspace selection')
    releaseSelection()
  },
  captureOriginalProvider() {
    if (!originalProvider) return unexpectedOperation('capture before original provider exists')
    // Retain the actual first composed provider solely to prove that its old
    // authorization fence still refuses after a fresh provider is admitted.
    return originalProvider.capture({ workspaceId: rotationWorkspace.id })
  },
  rotateSession() {
    const handlers = listeners.get('desktop-auth-callback-ready')
    if (!handlers?.size || queuedCallback || bootstrapSessionIds.length !== 1)
      return unexpectedOperation('rotation before initial bootstrap or repeated rotation')
    queuedCallback = 'adea://auth/callback?code=fixture-code&state=fixture-state'
    // Deliver the shell event to the production receiveCallback closure.
    // Never touch Entry signals, its mounting key, or its service objects.
    for (const handler of handlers) handler({ payload: null })
  },
  report() {
    return {
      // Counts root rendering only; an inner workspace remount is a valid repair.
      entryMounts,
      bootstrapCount: bootstrapSessionIds.length,
      bootstrapSessionIds: [...bootstrapSessionIds],
      bootstrapPrincipalIds: [...bootstrapPrincipalIds],
      selectionRequests,
      scopeSelections: selectedSessionIds.length,
      selectedSessionIds: [...selectedSessionIds],
      scopeProjections,
      workspaceIds: [...workspaceIds],
      providerSerial: currentProvider ? (providerSerials.get(currentProvider) ?? 0) : 0,
      bindingAvailable: currentProvider?.scopeIdentity() !== undefined,
      inventoryReads,
      inventoryReplies,
      heldInventoryRead: releaseRead !== undefined,
      heldWorkspaceSelection: releaseSelection !== undefined,
      unexpectedOperations: [...unexpectedOperations],
    }
  },
}

declare global {
  interface Window {
    desktopEntryAuthRotation: typeof rotationControls
  }
}
