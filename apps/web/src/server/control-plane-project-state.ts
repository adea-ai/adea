import { createHash, randomBytes } from 'node:crypto'

import {
  CONTROL_PLANE_SERVICE_PRINCIPAL_ID,
  controlPlaneCredential,
  controlPlaneCredentialMode,
  type ControlPlaneScopeIds,
} from './control-plane-credential'

/**
 * Control Plane project-state initialization (ADR 0013).
 *
 * Creating an Adea project initializes revision 0 of its Control Plane project
 * state, so a cloud execution for that project can validate. The call runs
 * after the project row has committed and never fails or delays project
 * creation: the route schedules it after the response, it has a short
 * timeout, and every failure is logged and swallowed.
 *
 * The idempotency key is fixed per project (`project-state-init:<prj_>`), so
 * any retry replays the original initialization. Both a fresh or replayed
 * `200` and `409 PROJECT_STATE_ALREADY_INITIALIZED` mean the state exists.
 *
 * A deployment without a signing key has no Control Plane credential, so the
 * call is skipped with a debug line.
 *
 * `ensureControlPlaneProjectState` is the lazy path: any future
 * project-scoped Control Plane call (validate, accept, executions) awaits it
 * first, so a project whose post-create initialization failed or predates
 * this change is initialized on first use. A success is remembered per
 * isolate, so the ensure path costs one round trip per project per isolate.
 *
 * No `server-only` marker: Bun-run unit tests import this module directly,
 * and the compiled client-boundary guard keeps `src/server` out of browsers.
 */

export const PROJECT_STATE_INITIALIZE_PATH = '/v1/project-states/initialize'
/** Short: this runs after the response and must not hold the isolate. */
export const PROJECT_STATE_INITIALIZE_TIMEOUT_MS = 5000

const contractVersion = { major: 2, minor: 0 } as const
/** sha256 of the canonical empty payload `{}` the contract requires. */
const EMPTY_PAYLOAD_HASH = createHash('sha256').update('{}').digest('hex')

export type ProjectStateInitializationOutcome =
  | 'initialized'
  | 'already-initialized'
  | 'skipped'
  | 'failed'

type Environment = Readonly<Record<string, string | undefined>>

export type ProjectStateInitializationDependencies = Readonly<{
  environment?: Environment
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
  log?: (level: 'debug' | 'warn', entry: Readonly<Record<string, unknown>>) => void
}>

const initializedProjects = new Set<string>()

/** Test seam: forgets which projects this isolate has seen initialized. */
export function resetInitializedProjectsForTests(): void {
  initializedProjects.clear()
}

export function projectStateIdempotencyKey(controlPlaneProjectId: string): string {
  return `project-state-init:${controlPlaneProjectId}`
}

/**
 * Initializes the Control Plane project state for one mapped project. Never
 * throws; the outcome is for logs and tests.
 */
export async function initializeControlPlaneProjectState(
  resolveScope: () => Promise<ControlPlaneScopeIds | null>,
  dependencies: ProjectStateInitializationDependencies = {}
): Promise<ProjectStateInitializationOutcome> {
  const environment = dependencies.environment ?? process.env
  const log = dependencies.log ?? defaultLog
  if (controlPlaneCredentialMode(environment) !== 'scoped') {
    log('debug', {
      event: 'control_plane.project_state.initialize_skipped',
      reason: 'unconfigured',
    })
    return 'skipped'
  }
  let projectId: string | undefined
  try {
    const credential = await controlPlaneCredential(
      { resolveScope, scopes: ['project-state:initialize'] },
      environment,
      dependencies.now?.()
    )
    projectId = credential.projectId
    if (!projectId) {
      log('warn', { event: 'control_plane.project_state.initialize_failed', reason: 'unmapped' })
      return 'failed'
    }
    if (initializedProjects.has(projectId)) return 'already-initialized'
    const origin = controlPlaneUrl(environment)
    if (!origin) {
      log('warn', {
        event: 'control_plane.project_state.initialize_failed',
        projectId,
        reason: 'unconfigured',
      })
      return 'failed'
    }
    const requestId = identifier('req')
    const response = await (dependencies.fetch ?? fetch)(origin, {
      body: JSON.stringify({
        caller: { servicePrincipalId: CONTROL_PLANE_SERVICE_PRINCIPAL_ID },
        commandId: identifier('cmd'),
        contractVersion,
        correlation: { traceId: identifier('trc') },
        idempotencyKey: projectStateIdempotencyKey(projectId),
        issuedAt: new Date(dependencies.now?.() ?? Date.now()).toISOString(),
        operation: 'project-state.initialize',
        payload: {},
        payloadHash: EMPTY_PAYLOAD_HASH,
        projectId,
        requestId,
        workspaceId: credential.workspaceId,
      }),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credential.token}`,
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      },
      method: 'POST',
      signal: AbortSignal.timeout(dependencies.timeoutMs ?? PROJECT_STATE_INITIALIZE_TIMEOUT_MS),
    })
    if (response.ok) {
      initializedProjects.add(projectId)
      return 'initialized'
    }
    const code = await errorCode(response)
    if (response.status === 409 && code === 'PROJECT_STATE_ALREADY_INITIALIZED') {
      initializedProjects.add(projectId)
      return 'already-initialized'
    }
    log('warn', {
      event: 'control_plane.project_state.initialize_failed',
      projectId,
      requestId,
      status: response.status,
      ...(code ? { code } : {}),
    })
    return 'failed'
  } catch (error) {
    // Never the credential or the error body: only what an operator needs to
    // tell a timeout from a misconfigured signer.
    log('warn', {
      event: 'control_plane.project_state.initialize_failed',
      ...(projectId ? { projectId } : {}),
      reason:
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? 'timeout'
          : error instanceof Error && error.name === 'ControlPlaneCredentialError'
            ? 'credential'
            : 'unavailable',
    })
    return 'failed'
  }
}

/**
 * The lazy path for project-scoped Control Plane calls: resolves once the
 * project's state exists. Callers treat `failed` as the Control Plane being
 * unavailable for that project.
 */
export async function ensureControlPlaneProjectState(
  resolveScope: () => Promise<ControlPlaneScopeIds | null>,
  dependencies: ProjectStateInitializationDependencies = {}
): Promise<ProjectStateInitializationOutcome> {
  return initializeControlPlaneProjectState(resolveScope, dependencies)
}

function controlPlaneUrl(environment: Environment): URL | undefined {
  const origin = environment.CONTROL_PLANE_ORIGIN?.trim()
  if (!origin) return undefined
  try {
    const url = new URL(PROJECT_STATE_INITIALIZE_PATH, origin.endsWith('/') ? origin : `${origin}/`)
    if (url.protocol !== 'https:' && environment.NODE_ENV === 'production') return undefined
    return url
  } catch {
    return undefined
  }
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown }; code?: unknown }
    const code = body?.error?.code ?? body?.code
    return typeof code === 'string' && /^[A-Z0-9_]{1,96}$/u.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

function identifier(prefix: 'cmd' | 'req' | 'trc'): string {
  return `${prefix}_${randomBytes(13).toString('hex').toUpperCase()}`
}

function defaultLog(level: 'debug' | 'warn', entry: Readonly<Record<string, unknown>>): void {
  const line = JSON.stringify(entry)
  if (level === 'debug') console.debug(line)
  else console.warn(line)
}
