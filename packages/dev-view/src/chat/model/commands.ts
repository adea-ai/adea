import type {
  DevCommand,
  DevError,
  DevOperation,
  RuntimeEvent,
  RuntimeSession,
  Scope,
} from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService } from '../../platform'
import { buildDevCommand } from '../../browser/command'

import type { ChatInputTransport, ConversationCreateInput } from './types'

export class ChatRuntimeError extends Error {
  readonly code: DevError['code']
  readonly retryable: boolean

  constructor(error: DevError) {
    super(error.message)
    this.name = 'ChatRuntimeError'
    this.code = error.code
    this.retryable = error.retryable
  }
}

export const CHAT_INPUT_SOURCE = 'chat_user' as const

export function makeChatUserInput(input: {
  runtimeSessionId: string
  generation: number
  text: string
  now?: () => Date
}): Parameters<ChatInputTransport>[0] {
  const text = input.text.trim()
  if (text.length === 0)
    throw new ChatRuntimeError({
      code: 'invalid_state',
      retryable: false,
      message: 'Chat input cannot be empty.',
    })
  return {
    runtimeSessionId: input.runtimeSessionId,
    generation: input.generation,
    source: CHAT_INPUT_SOURCE,
    text,
    sentAt: (input.now ?? (() => new Date()))().toISOString(),
  }
}

export function buildConversationCommand<K extends DevOperation>(input: {
  operation: K
  scope: Scope
  body: Record<string, unknown>
  resource?: { kind: string; id: string; generation: number }
  idempotencyKey?: string
  now?: () => Date
  randomId?: () => string
}): DevCommand<K> {
  return buildDevCommand(
    {
      operation: input.operation,
      scope: input.scope,
      body: input.body,
      ...(input.resource !== undefined ? { resource: input.resource } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    },
    {
      ...(input.now !== undefined ? { now: input.now } : {}),
      ...(input.randomId !== undefined ? { randomId: input.randomId } : {}),
    }
  ) as DevCommand<K>
}

export async function executeChatCommand<T>(
  service: DevRuntimeService,
  command: DevCommand
): Promise<T> {
  const reply = await service.execute(command)
  if (!reply.ok) throw new ChatRuntimeError(reply.error)
  return reply.value as T
}

export function sessionResource(session: RuntimeSession): {
  kind: string
  id: string
  generation: number
} {
  return { kind: 'runtime_session', id: session.id, generation: session.generation }
}

export function createBody(input: ConversationCreateInput): Record<string, unknown> {
  return {
    projectId: input.projectId,
    repoId: input.repoId,
    worktreeId: input.worktreeId,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.agentProfileId !== undefined ? { agentProfileId: input.agentProfileId } : {}),
    ...(input.agentProfileVersion !== undefined
      ? { agentProfileVersion: input.agentProfileVersion }
      : {}),
  }
}

export function launchBody(
  session: RuntimeSession,
  input: ConversationCreateInput
): Record<string, unknown> {
  if (input.agentProfileId === undefined || input.agentProfileVersion === undefined)
    throw new ChatRuntimeError({
      code: 'invalid_state',
      retryable: false,
      message: 'An agent profile is required to launch a conversation.',
    })
  return {
    runtimeSessionId: session.id,
    expectedGeneration: session.generation,
    agentProfileId: input.agentProfileId,
    agentProfileVersion: input.agentProfileVersion,
    ...(input.harnessInstallationId !== undefined
      ? { harnessInstallationId: input.harnessInstallationId }
      : {}),
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
    ...(input.attachTerminal !== undefined ? { attachTerminal: input.attachTerminal } : {}),
  }
}

export function eventSourceForStream(options?: {
  source?: RuntimeEvent['source']
}): RuntimeEvent['source'] {
  return options?.source ?? 'host'
}
