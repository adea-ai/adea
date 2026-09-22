import type {
  DevErrorCode,
  HarnessPreference,
  ManagedPiStatus,
  Scope,
} from '@adea-ai/types/dev-runtime'

import { buildDevCommand } from '../../browser/command'
import type { DevRuntimeService } from '../../platform'
import { executeChatCommand } from '../model/commands'
import type { ChatConversationModel } from '../model'

export type FirstRunIdentity = 'choice' | 'loading' | 'guest' | 'signed_in' | 'auth_required'
export type FirstRunModelAccess = 'unknown' | 'none' | 'byok' | 'provisioned' | 'free-tier'
export type FirstRunManagedPi = Readonly<{
  state: 'absent' | 'resolving' | 'installing' | 'ready' | 'failed'
  code?: DevErrorCode
  /** Diagnostic detail stays in the host; never render it in onboarding. */
  detail?: string
}>
export type FirstRunFacts = Readonly<{
  identity: FirstRunIdentity
  managedPi: FirstRunManagedPi
  modelAccess: FirstRunModelAccess
  projectReady: boolean
  agentProfileReady: boolean
}>
export type FirstRunActionKind =
  | 'guest'
  | 'sign_in'
  | 'retry_install'
  | 'update_app'
  | 'retry_access'
  | 'add_project'
  | 'set_up_agent'
  | 'start'
export type FirstRunAction = Readonly<{ kind: FirstRunActionKind; label: string }>
export type FirstRunProjection = Readonly<{
  stage: 'identity' | 'managed_pi' | 'model_access' | 'project' | 'agent' | 'compose'
  heading: string
  message: string
  installStatus: string
  actions: readonly FirstRunAction[]
  busy: boolean
}>

const action = (kind: FirstRunActionKind, label: string): FirstRunAction => ({ kind, label })

function managedPiInstallStatus(managedPi: FirstRunManagedPi): string {
  switch (managedPi.state) {
    case 'ready':
      return 'Your agent is ready.'
    case 'resolving':
      return 'Preparing your agent installation…'
    case 'installing':
      return 'Your agent is installing in the background…'
    case 'failed':
      return 'Your agent needs attention.'
    case 'absent':
      return 'Your agent is not installed yet.'
  }
}

/** One primary recovery action per blocking state. The typed host diagnostic is
 * deliberately reduced to safe, human-readable copy. */
export function projectFirstRun(facts: FirstRunFacts): FirstRunProjection {
  const installStatus = managedPiInstallStatus(facts.managedPi)
  const projection = (
    stage: FirstRunProjection['stage'],
    heading: string,
    message: string,
    actions: readonly FirstRunAction[],
    busy = false
  ): FirstRunProjection => ({ stage, heading, message, installStatus, actions, busy })

  if (facts.identity === 'loading')
    return projection(
      'identity',
      'Opening your workspace',
      'Checking your account or guest access.',
      [],
      true
    )
  if (facts.identity === 'choice')
    return projection(
      'identity',
      'Start with Adea',
      'Continue as a guest or sign in to save your work.',
      [action('guest', 'Continue as guest'), action('sign_in', 'Sign in')]
    )
  if (facts.identity === 'auth_required')
    return projection(
      'identity',
      'Sign in to continue',
      'Your workspace needs an account session.',
      [action('sign_in', 'Sign in')]
    )

  // CP #552 grants no model entitlement to guest credentials. A stale or
  // malformed entitlement projection must never let a guest launch anyway.
  if (facts.identity === 'guest')
    return projection(
      'model_access',
      'Sign in to start a conversation',
      'Your guest workspace is ready. Sign in to use the included model access.',
      [action('sign_in', 'Sign in for model access')]
    )

  if (facts.modelAccess === 'none')
    return projection(
      'model_access',
      'Model access is needed',
      'Model access is not available for this workspace yet.',
      [action('retry_access', 'Check model access')]
    )
  if (facts.modelAccess === 'unknown')
    return projection(
      'model_access',
      'Checking model access',
      'Checking what is available for this workspace.',
      [],
      true
    )

  if (facts.managedPi.state === 'absent')
    return projection('managed_pi', 'Preparing your agent', 'Install the managed agent to start.', [
      action('retry_install', 'Install agent'),
    ])
  if (facts.managedPi.state === 'resolving' || facts.managedPi.state === 'installing')
    return projection('managed_pi', 'Preparing your agent', installStatus, [], true)
  if (facts.managedPi.state === 'failed') {
    const updateRequired =
      facts.managedPi.code === 'incompatible' ||
      facts.managedPi.code === 'corrupt_state' ||
      facts.managedPi.code === 'capability_unavailable' ||
      facts.managedPi.code === 'limit_exceeded'
    return projection(
      'managed_pi',
      'Your agent needs attention',
      updateRequired
        ? 'This app version cannot install the managed agent. Update Adea and try again.'
        : 'The managed agent could not install. You can try again.',
      [
        updateRequired
          ? action('update_app', 'Check for app update')
          : action('retry_install', 'Try installation again'),
      ]
    )
  }

  if (!facts.projectReady)
    return projection(
      'project',
      'Choose your workspace',
      'Add a project for your first conversation.',
      [action('add_project', 'Add a project')]
    )
  if (!facts.agentProfileReady)
    return projection('agent', 'Agent setup needs attention', 'Set up an agent profile to start.', [
      action('set_up_agent', 'Open agent setup'),
    ])
  return projection(
    'compose',
    'Start a conversation',
    'Tell your agent what you would like to do.',
    [action('start', 'Start conversation')]
  )
}

export type FirstRunConversation = Readonly<{ runtimeSessionId: string }>
export type FirstRunCreateRequest = Readonly<{ prompt: string; idempotencyKey: string }>
export type FirstRunControllerPort = Readonly<{
  createConversation(request: FirstRunCreateRequest): Promise<FirstRunConversation>
  randomId?: () => string
}>

/** A transport error must not produce a second session. Reuse the same key for
 * the same prompt until the owner explicitly begins a different attempt. */
export function createFirstRunController(port: FirstRunControllerPort) {
  let attempt: FirstRunCreateRequest | undefined
  let result: FirstRunConversation | undefined
  return {
    async start(prompt: string, facts: FirstRunFacts): Promise<FirstRunConversation> {
      if (projectFirstRun(facts).stage !== 'compose')
        throw new Error('First-run setup is not ready to start a conversation.')
      const trimmed = prompt.trim()
      if (!trimmed) throw new Error('Enter a message to start your conversation.')
      if (attempt && attempt.prompt !== trimmed)
        throw new Error(
          'Finish or reset the current retry before starting a different conversation.'
        )
      attempt ??= {
        prompt: trimmed,
        idempotencyKey: (port.randomId ?? (() => crypto.randomUUID()))(),
      }
      result ??= await port.createConversation(attempt)
      return result
    },
    resetAttempt(): void {
      attempt = undefined
      result = undefined
    },
  }
}

export type FirstRunLaunchContext = Readonly<{
  projectId: string
  repoId: string
  worktreeId: string
  agentProfileId: string
  agentProfileVersion: number
}>

function managedPiStatusForOnboarding(status: ManagedPiStatus): FirstRunManagedPi {
  return {
    state: status.state,
    ...(status.lastErrorCode !== undefined ? { code: status.lastErrorCode } : {}),
    ...(status.lastError !== undefined ? { detail: status.lastError } : {}),
  }
}

/** Host command adapter. Onboarding never selects a harness or model: the
 * existing root-default policy and staged launch transaction own that choice. */
export function createFirstRunRuntimePort(
  runtime: Pick<DevRuntimeService, 'execute'>,
  scope: Scope,
  model: Pick<ChatConversationModel, 'create'>,
  context: FirstRunLaunchContext
) {
  const execute = async <T>(
    operation:
      | 'dev.harness.managedPiStatus'
      | 'dev.harness.managedPiInstall'
      | 'dev.harness.preferenceReset',
    body: Record<string, unknown> = {}
  ): Promise<T> =>
    executeChatCommand<T>(runtime as DevRuntimeService, buildDevCommand({ operation, scope, body }))
  return {
    async readManagedPi(): Promise<FirstRunManagedPi> {
      return managedPiStatusForOnboarding(
        await execute<ManagedPiStatus>('dev.harness.managedPiStatus')
      )
    },
    async installManagedPi(): Promise<FirstRunManagedPi> {
      return managedPiStatusForOnboarding(
        await execute<ManagedPiStatus>('dev.harness.managedPiInstall')
      )
    },
    async resetToManagedDefault(): Promise<readonly HarnessPreference[]> {
      const page = await execute<{ items: readonly HarnessPreference[] }>(
        'dev.harness.preferenceReset'
      )
      return page.items
    },
    async createConversation(request: FirstRunCreateRequest): Promise<FirstRunConversation> {
      return model.create({
        ...context,
        initialPrompt: request.prompt,
        idempotencyKey: request.idempotencyKey,
      })
    },
  }
}
