import { SoundProvider } from '@adea-ai/audio'
import { AgentHqQueryProvider } from '@adea-ai/data/provider'
import { ThemeProvider } from '@adea-ai/app-ui/components/theme-provider'
import { hqSceneFromSearchParams } from '@adea-ai/app-core'
import {
  configurableCharacterId,
  isPlausibleCharacterId,
  readSceneStartPosition,
} from '@adea-ai/spatial-protocol'
import { WorkspaceEntry } from '../components/workspace-entry'
import { parseWorkspaceSearch } from './search-codec.mjs'
import { workspaceSelection } from './workspace-selection.mjs'

/**
 * Mounted only inside ClientOnly. Search state is owned by the Start router
 * (see `search-codec.mjs`); this browser-only subtree reads the initial
 * selection once and provides the app-level providers.
 * Auth documents are served by the same Start host at /auth/*.
 */
export default function WorkspaceMount() {
  const params = parseWorkspaceSearch(window.location.search)
  const selection = workspaceSelection(params)
  const initial = {
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
  return (
    <ThemeProvider>
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
    </ThemeProvider>
  )
}
