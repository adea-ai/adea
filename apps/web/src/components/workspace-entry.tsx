import lazyComponent from './lazy-component'
import type { WorkspaceShellProps } from './workspace-shell'

// Warm the chunks the mounted lane is about to need. Without this, the boot
// path is a waterfall: the navigation chunk finishes, renders, mounts, and only
// then starts fetching the view chunk underneath it. The specifiers match the
// lazy boundaries inside workspace-navigation exactly, so the module map
// deduplicates the work — firing now just lets the view chunk download in
// parallel instead of a render cycle later.
if (typeof window !== 'undefined') {
  const params = new URLSearchParams(window.location.search)
  void import('./workspace-navigation-entry')
  const view = params.get('view')
  const roomDesigner = params.get('roomDesigner')
  // The dev view keeps its single dynamic boundary in workspace-navigation
  // (scripts/dev-view-boundary.test.ts), so it is not warmed here.
  if (view === 'virtual' || (roomDesigner !== null && roomDesigner !== '0')) {
    void import('./workspace-shell')
    if (roomDesigner !== null && roomDesigner !== '0') void import('./room-designer-entry')
  } else if (view !== 'dev') {
    void import('./conventional-workspace-entry')
  }
}

// The workspace entry stays a deferred chunk: a failed import surfaces as the
// route's recoverable error component (pinned by start/browser/entry.e2e.ts).
const WorkspaceNavigationEntry = lazyComponent(
  () => import('./workspace-navigation-entry').then(({ WorkspaceNavigationEntry: Entry }) => Entry),
  { loading: () => <WorkspaceEntryLoading /> }
)

const CharacterDesignerEntry = lazyComponent(
  () => import('./character-designer-entry').then(({ CharacterDesignerEntry: Entry }) => Entry),
  { loading: () => <WorkspaceEntryLoading /> }
)

function WorkspaceEntryLoading() {
  return (
    <main class="conventional-workspace conventional-workspace--loading" aria-busy="true">
      <p>Opening workspace…</p>
    </main>
  )
}

export function WorkspaceEntry({
  virtual,
  virtualProps,
  characterDesigner,
  roomDesigner,
}: Readonly<{
  virtual: boolean
  virtualProps: WorkspaceShellProps
  /** Cold-mount the character designer URL without loading the normal workspace shell. */
  characterDesigner?: boolean
  /** Mount the dedicated room designer scene beside global workspace navigation. */
  roomDesigner?: boolean
}>) {
  if (characterDesigner) {
    return <CharacterDesignerEntry initialCharacter={virtualProps.initialCharacter} />
  }
  return (
    <WorkspaceNavigationEntry
      roomDesigner={roomDesigner}
      virtual={virtual}
      virtualProps={virtualProps}
    />
  )
}
