// Ending runtime terminals from the Dev View. Loaded on first use (it ships
// with the terminal pane chunk) so the terminate command builder and selected
// terminal resolution stay out of the Dev View shell.
import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'
import { devOperationMetadataFor_dev_terminal_terminate } from '@adea-ai/types/dev-runtime-operation-metadata'

import { buildDevCommandFromMetadata } from '../browser/command-core'
import { resolveSelectedTerminal } from './selected-terminal'

/**
 * End one runtime terminal instance: revalidate the exact record (the
 * terminate command binds its generation), then issue the privileged
 * `dev.terminal.terminate` with an explicit confirmation id. Resolves false
 * without issuing anything when the record can no longer be verified.
 */
export async function terminateSessionTerminal(options: {
  execute: (command: DevCommand) => Promise<DevReply>
  scope: Scope
  runtimeSessionId: string
  worktreeId: string
  terminalId: string
}): Promise<boolean> {
  const resolved = await resolveSelectedTerminal({
    execute: options.execute,
    scope: options.scope,
    selection: {
      runtimeSessionId: options.runtimeSessionId,
      worktreeId: options.worktreeId,
      terminalId: options.terminalId,
    },
  })
  if (resolved.status !== 'ready') return false
  const terminal = resolved.terminal
  const command = buildDevCommandFromMetadata(devOperationMetadataFor_dev_terminal_terminate, {
    scope: options.scope,
    body: {
      terminalId: terminal.id,
      expectedGeneration: terminal.generation,
      confirmationId: `close-${terminal.id}-${terminal.generation}`,
    },
    resource: { kind: 'terminal', id: terminal.id, generation: terminal.generation },
  })
  try {
    const reply = await options.execute(command)
    return reply.ok
  } catch {
    return false
  }
}
