import '../../src/start/globals.css'
import { Button } from '@adea-ai/ui/components/ui/button'
import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'

import { AppLibraryPage } from '../../../../packages/workspace-ui/src/app-library-page'
import {
  defaultRailPreferences,
  type RailPreferencesV1,
} from '../../../../packages/workspace-ui/src/rail-preferences'
import {
  setWorkspaceAppEnabled,
  type WorkspaceAppId,
} from '../../../../packages/workspace-ui/src/workspace-apps'
import {
  appLibraryNavigationForPreferenceChange,
  appLibraryNavigationForRecovery,
  appLibraryNavigationForRequestedView,
  type AppLibraryNavigation,
} from '../../src/lib/app-library-navigation'

// The App Library page and the navigation rules are the real modules. The shell that owns them is
// reduced to the signals below: no router, no workspace store and no native surface is involved.
function Harness() {
  const [preferences, setPreferences] = createSignal<RailPreferencesV1>(defaultRailPreferences)
  const [destination, setDestination] = createSignal<WorkspaceAppId>('chat')
  const [libraryOpen, setLibraryOpen] = createSignal(true)
  const [history, setHistory] = createSignal<WorkspaceAppId[]>([])

  const apply = (navigation: AppLibraryNavigation) => {
    if (navigation.kind === 'stay') return
    if (navigation.kind === 'open-library') {
      setLibraryOpen(true)
      return
    }
    setDestination(navigation.appId)
    setLibraryOpen(false)
    if (!navigation.replace) setHistory((current) => [...current, navigation.appId])
  }

  const setEnabled = (id: WorkspaceAppId, enabled: boolean) => {
    const next = setWorkspaceAppEnabled(preferences(), id, enabled)
    setPreferences(next)
    apply(
      appLibraryNavigationForPreferenceChange({
        preferences: next,
        requestedAppId: destination(),
        libraryOpen: libraryOpen(),
      })
    )
  }

  const open = (id: WorkspaceAppId) => {
    const navigation = appLibraryNavigationForRequestedView({
      preferences: preferences(),
      requestedAppId: id,
    })
    if (navigation.kind === 'open-library') return apply(navigation)
    apply({ kind: 'open-app', appId: id, replace: false })
  }

  const requestSourceControl = () =>
    apply(
      appLibraryNavigationForRequestedView({
        preferences: preferences(),
        requestedAppId: 'source-control',
      })
    )

  const reset = () => {
    setPreferences(defaultRailPreferences)
    apply(
      appLibraryNavigationForRecovery({
        preferences: defaultRailPreferences,
        requestedAppId: destination(),
        libraryOpen: libraryOpen(),
      })
    )
  }

  return (
    <>
      <Button type="button" onClick={() => setLibraryOpen(true)}>
        Show App Library
      </Button>
      <Button type="button" onClick={requestSourceControl}>
        Request Source control
      </Button>
      <Show when={libraryOpen()}>
        <AppLibraryPage
          focusSearchRequest={0}
          focusSearchRequestHandled={0}
          onFocusSearchRequestHandled={() => undefined}
          preferences={preferences()}
          onReorder={() => ''}
          onSetEnabled={setEnabled}
          onOpen={open}
          onReset={reset}
        />
      </Show>
      <output data-testid="destination">{destination()}</output>
      <output data-testid="library-open">{libraryOpen() ? 'yes' : 'no'}</output>
      <output data-testid="history">{history().join(',')}</output>
    </>
  )
}

render(() => <Harness />, document.getElementById('harness-root')!)
