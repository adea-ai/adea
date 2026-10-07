import '../../src/start/globals.css'
import { render } from 'solid-js/web'

import { DesktopStartSurface } from '../../src/components/desktop-workspace-entry'

// The desktop entry's offline start surface: the state with both the filled
// retry action and the outline sign-in action rendered side by side.
render(
  () => (
    <DesktopStartSurface
      busy={false}
      message="Adea could not reach the workspace service. Your local credentials are safe."
      onRetry={() => undefined}
      onSignIn={() => undefined}
      showSignIn
      status="offline"
    />
  ),
  document.querySelector('#harness-root')!
)
