// Read the host's shell profiles: the shells it can start with Adea's shell
// integration. A failed read yields an empty list, never a guessed one, so the
// toolbar offers only shells the host confirmed.
import type { DevCommand, DevReply, Scope, ShellProfile } from '@adea-ai/types/dev-runtime'
import { devOperationMetadataFor_dev_terminal_shellProfiles } from '@adea-ai/types/dev-runtime-operation-metadata'

import { buildDevCommandFromMetadata } from '../browser/command-core'

export async function listShellProfiles(options: {
  execute: (command: DevCommand) => Promise<DevReply>
  scope: Scope
  signal?: AbortSignal
}): Promise<readonly ShellProfile[]> {
  if (options.signal?.aborted) return []
  try {
    const reply = await options.execute(
      buildDevCommandFromMetadata(devOperationMetadataFor_dev_terminal_shellProfiles, {
        scope: options.scope,
        body: { limit: 100 },
      })
    )
    if (options.signal?.aborted || !reply.ok) return []
    const page = reply.value as { items?: readonly ShellProfile[] }
    return Array.isArray(page.items) ? page.items : []
  } catch {
    return []
  }
}
