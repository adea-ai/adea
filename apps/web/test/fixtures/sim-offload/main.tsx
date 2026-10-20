import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { Button } from '@adea-ai/ui/components/ui/button'
import { createApiClient } from '@adea-ai/api-client'
import { workspaceStore } from '@adea-ai/state'
import { HostedSimEntry } from '../../../src/components/hosted-sim-entry'

const query = new URLSearchParams(window.location.search)
workspaceStore.getState().setSelectedWorkspaceId(query.get('workspace') ?? 'workspace-one')
const requested = query.get('surface')
const surface =
  requested === 'room-designer' || requested === 'character-designer' ? requested : 'hq'
const api = createApiClient({ getTemporaryCredential: () => 'local-acceptance-fixture' })
function App() {
  const [view, setView] = createSignal('sim')
  return (
    <>
      <nav>
        <Button onClick={() => setView('chat')}>Chat</Button>
        <Button onClick={() => setView('dev')}>Dev</Button>
        <Button onClick={() => setView('sim')}>Sim</Button>
      </nav>
      <Show
        when={view() === 'sim'}
        fallback={<main>{view() === 'chat' ? 'Chat stays available' : 'Dev stays available'}</main>}
      >
        <HostedSimEntry
          client={api}
          surface={surface}
          scene="work"
          onClose={() => setView('chat')}
        />
      </Show>
    </>
  )
}
render(() => <App />, document.getElementById('app')!)
