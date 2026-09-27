import '../../src/start/globals.css'
import type { WorkspaceSummary } from '@adea-ai/types'
import { createSignal, onCleanup, onMount } from 'solid-js'
import { render } from 'solid-js/web'
import { GlobalWorkspaceRail } from '../../../../packages/workspace-ui/src/global-workspace-rail'
import type { WorkspaceAppId } from '../../../../packages/workspace-ui/src/workspace-apps'

const timestamp = '2026-09-27T00:00:00.000Z'
const work: WorkspaceSummary = {
  id: 'workspace-work',
  name: 'Work',
  scene: 'work',
  updatedAt: timestamp,
}
const home: WorkspaceSummary = {
  id: 'workspace-home',
  name: 'Home',
  scene: 'home',
  updatedAt: timestamp,
}

function Harness() {
  const [activeWorkspace, setActiveWorkspace] = createSignal(work)
  const [view, setView] = createSignal<WorkspaceAppId>('virtual')
  const [libraryActive, setLibraryActive] = createSignal(false)
  const [searchRequests, setSearchRequests] = createSignal(0)
  const [chatSearchRequests, setChatSearchRequests] = createSignal(0)

  onMount(() => {
    const standaloneChatShortcut = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'k' &&
        view() === 'chat' &&
        !libraryActive()
      ) {
        event.preventDefault()
        setChatSearchRequests((count) => count + 1)
      }
    }
    window.addEventListener('keydown', standaloneChatShortcut)
    onCleanup(() => window.removeEventListener('keydown', standaloneChatShortcut))
  })

  const setMode = (nextView: WorkspaceAppId, inLibrary = false) => {
    setView(nextView)
    setLibraryActive(inLibrary)
  }

  return (
    <>
      <button onClick={() => setMode('virtual')}>Use Virtual view</button>
      <button onClick={() => setMode('chat')}>Use Chat view</button>
      <button onClick={() => setMode('dev')}>Use Dev view</button>
      <button onClick={() => setMode('chat', true)}>Use App Library</button>
      <GlobalWorkspaceRail
        account={{
          authenticated: false,
          label: 'Sign in',
          onSignIn: () => {},
          onSignOut: () => {},
          platform: 'web',
        }}
        activeWorkspace={activeWorkspace()}
        views={['virtual', 'chat', 'dev']}
        onOpenNotifications={() => {}}
        onOpenAbout={() => {}}
        onOpenPlugins={() => {}}
        onOpenAppLibrary={() => setMode('chat', true)}
        libraryActive={libraryActive()}
        onOpenSearch={() => setSearchRequests((count) => count + 1)}
        onOpenSettings={() => {}}
        onWorkspaceChange={setActiveWorkspace}
        onViewChange={(next) => setMode(next)}
        view={view()}
        workspaces={[work, home]}
      />
      <output aria-label="Selected workspace">{activeWorkspace().id}</output>
      <output aria-label="Global search requests">{searchRequests()}</output>
      <output aria-label="Chat search requests">{chatSearchRequests()}</output>
    </>
  )
}

render(() => <Harness />, document.querySelector('#harness-root')!)
