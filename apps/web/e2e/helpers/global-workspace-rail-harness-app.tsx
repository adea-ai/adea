import '../../src/start/globals.css'
import type { WorkspaceSummary } from '@adea-ai/types'
import { createSignal, onCleanup, onMount } from 'solid-js'
import { render } from 'solid-js/web'
import { GlobalWorkspaceRail } from '../../../../packages/workspace-ui/src/global-workspace-rail'
import type { WorkspaceAppId } from '../../../../packages/workspace-ui/src/workspace-apps'
import { Button } from '@adea-ai/ui/components/ui/button'

const timestamp = '2026-09-27T00:00:00.000Z'
const work: WorkspaceSummary = {
  id: 'workspace-work',
  name: 'Work',
  scene: 'work',
  accent: null,
  logo: { kind: 'monogram' as const },
  sortOrder: 0,
  version: 1,
  updatedAt: timestamp,
}

function Harness() {
  const [view, setView] = createSignal<WorkspaceAppId>('virtual')
  const [libraryActive, setLibraryActive] = createSignal(false)
  const [searchRequests, setSearchRequests] = createSignal(0)
  const [chatSearchRequests, setChatSearchRequests] = createSignal(0)

  onMount(() => {
    // Captures the harness's view, library, and chat-search signals.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
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
      <Button onClick={() => setMode('virtual')}>Use Virtual view</Button>
      <Button onClick={() => setMode('chat')}>Use Chat view</Button>
      <Button onClick={() => setMode('dev')}>Use Dev view</Button>
      <Button onClick={() => setMode('chat', true)}>Use App Library</Button>
      <GlobalWorkspaceRail
        account={{
          authenticated: false,
          label: 'Sign in',
          onSignIn: () => {},
          onSignOut: () => {},
          onOpenFeedback: () => {},
          platform: 'web',
        }}
        activeWorkspace={work}
        views={['virtual', 'chat', 'dev']}
        onOpenAbout={() => {}}
        onOpenPlugins={() => {}}
        onOpenAppLibrary={() => setMode('chat', true)}
        libraryActive={libraryActive()}
        onOpenSearch={() => setSearchRequests((count) => count + 1)}
        onOpenSettings={() => {}}
        onViewChange={(next) => setMode(next)}
        view={view()}
      />
      <output aria-label="Global search requests">{searchRequests()}</output>
      <output aria-label="Chat search requests">{chatSearchRequests()}</output>
    </>
  )
}

render(() => <Harness />, document.querySelector('#harness-root')!)
