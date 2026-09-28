// Dynamic DevCommand construction for lazy panes. The eager workspace shell
// imports the metadata-bound core directly to avoid retaining this full map.
import type { DevCommand, DevOperation } from '@adea-ai/types/dev-runtime'
import { devOperationMetadata } from '@adea-ai/types/dev-runtime-metadata'

import {
  buildDevCommandFromMetadata,
  type DevCommandBuildContext,
  type DevCommandBuildFields,
} from './command-core'

export type BuildDevCommandInput = DevCommandBuildFields & {
  operation: DevOperation
}

export function buildDevCommand(
  input: BuildDevCommandInput,
  context: DevCommandBuildContext = {}
): DevCommand {
  const { operation, ...fields } = input
  return buildDevCommandFromMetadata(
    { operation, ...devOperationMetadata[operation] },
    fields,
    context
  )
}
