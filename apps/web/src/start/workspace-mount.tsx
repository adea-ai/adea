import { SoundProvider } from '@adea-ai/audio'
import { AgentHqQueryProvider } from '@adea-ai/data/provider'
import { ThemeProvider } from '@adea-ai/app-ui/components/theme-provider'
import { installTooltipFocusGate } from '@adea-ai/app-ui/lib/tooltip-focus-gate'
import { hqSceneFromSearchParams } from '@adea-ai/app-core'
import {
  configurableCharacterId,
  isPlausibleCharacterId,
  readSceneStartPosition,
} from '@adea-ai/spatial'
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
  // Tooltips open on real hover or keyboard-intent focus only; autofocus from
  // dialogs, sheets, and focus restoration must never pop one (the gate
  // documents the full story). Idempotent, so the once-per-mount client
  // component can call it directly.
  installTooltipFocusGate()
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
