import {
  devOperationDecoders,
  type DevCommand,
  type DevOperation,
  type RuntimeSession,
  type Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import type { ChatAttachmentUpload } from '../../../../../../packages/types/src/dev-runtime-attachments'
import { sameScope } from '../authority'
import type { ChannelAuthority } from '../channel/authority'
import type { SessionEventLog } from '../harness/events'
import { AttachmentError, createChatAttachmentStore, type AttachmentBinding } from './store'

export function registerChatAttachmentRuntime(input: {
  authority: ChannelAuthority
  dataDir: string
  scope: Scope
  resolveSession(id: string): RuntimeSession | undefined
  events: SessionEventLog
  readKey?: () => Uint8Array | undefined
}) {
  function assertBinding(binding: AttachmentBinding): RuntimeSession {
    const session = input.resolveSession(binding.runtimeSessionId)
    if (!session || !sameScope(session.scope, input.scope)) throw new AttachmentError('not_found')
    if (session.generation !== binding.generation) throw new AttachmentError('stale_generation')
    return session
  }
  const store = createChatAttachmentStore({
    dataDir: input.dataDir,
    scope: input.scope,
    events: input.events,
    assertBinding,
    ...(input.readKey ? { readKey: input.readKey } : {}),
  })
  const commands = [
    'dev.session.attachmentUpload',
    'dev.session.attachmentOpen',
    'dev.session.attachmentRemove',
  ] as const
  for (const operation of commands) {
    input.authority.registerCommandProvider(operation, (command: DevCommand) => {
      if (!sameScope(command.scope, input.scope)) throw new AttachmentError('channel_unauthorized')
      const body = devOperationDecoders[operation].request(command.body)
      const binding = {
        runtimeSessionId: body.runtimeSessionId as string,
        generation: body.expectedGeneration as number,
      }
      const resource = command.resource
      if (
        !resource ||
        resource.kind !== 'runtime_session' ||
        resource.id !== binding.runtimeSessionId
      )
        throw new AttachmentError('identity_mismatch')
      if (resource.generation !== binding.generation) throw new AttachmentError('stale_generation')
      const session = assertBinding(binding)
      if (operation === 'dev.session.attachmentUpload') {
        if (session.archived) throw new AttachmentError('invalid_state')
        return store.upload(
          binding,
          body.upload as ChatAttachmentUpload,
          command.idempotencyKey ?? ''
        )
      }
      if (operation === 'dev.session.attachmentOpen')
        return store.open(binding, body.attachmentId as string)
      return store.remove(binding, body.attachmentId as string)
    })
  }
  return Object.freeze({ commands: [...commands] as DevOperation[], store })
}
