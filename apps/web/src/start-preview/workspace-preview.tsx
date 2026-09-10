import { useState } from 'react'
import { SoundProvider } from '@adea-ai/audio'
import { AgentHqQueryProvider } from '@adea-ai/data/provider'
import { ThemeProvider } from '@adea-ai/ui/components/theme-provider'
import { hqSceneFromSearchParams } from '@adea-ai/app-core'
import {
  configurableCharacterId,
  isPlausibleCharacterId,
  readSceneStartPosition,
} from '@adea-ai/spatial-protocol'
import { NuqsAdapter } from 'nuqs/adapters/react'
import { WorkspaceEntry } from '../components/workspace-entry'
import { parseWorkspaceSearch } from './search-codec.mjs'
import { workspaceSelection } from './workspace-selection.mjs'

/**
 * Mounted only inside ClientOnly. The documented TanStack nuqs adapter does
 * not cover Start; use the React SPA adapter inside this browser-only subtree.
 * Auth documents navigate normally through the same-origin legacy gateway.
 */
export default function WorkspacePreview() {
  const [initial] = useState(() => {
    const params = parseWorkspaceSearch(window.location.search)
    const selection = workspaceSelection(params)
    return {
      ...selection,
      virtualProps: {
        initialScene: hqSceneFromSearchParams(params),
        initialCharacter: isPlausibleCharacterId(selection.character)
          ? selection.character!
          : configurableCharacterId,
        startPosition: readSceneStartPosition(params.spawn),
        cameraViewMode: selection.cameraViewMode,
      },
    }
  })
  return (
    <ThemeProvider>
      <NuqsAdapter>
        <AgentHqQueryProvider>
          <SoundProvider>
            <WorkspaceEntry
              virtual={initial.virtual}
              virtualProps={initial.virtualProps}
              characterDesigner={initial.characterDesigner}
              roomDesigner={initial.roomDesigner}
            />
          </SoundProvider>
        </AgentHqQueryProvider>
      </NuqsAdapter>
    </ThemeProvider>
  )
}
