import '../../src/start/globals.css'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'

import { AccountDrawer } from '../../../../packages/ui/src/components/account-drawer'
import { ThemeProvider } from '../../../../packages/ui/src/components/theme-provider'

function Harness() {
  const [authenticated, setAuthenticated] = createSignal(false)
  const [action, setAction] = createSignal('')

  return (
    <ThemeProvider>
      <div id="account-trigger-target" />
      <AccountDrawer
        accountLabel={authenticated() ? 'Adea owner' : 'Sign in'}
        authenticated={authenticated()}
        triggerTargetId="account-trigger-target"
        onSignIn={() => {
          setAction('sign-in')
          setAuthenticated(true)
        }}
        onSignOut={() => {
          setAction('sign-out')
          setAuthenticated(false)
        }}
      />
      <output aria-label="Selected action">{action()}</output>
    </ThemeProvider>
  )
}

render(() => <Harness />, document.querySelector('#harness-root')!)
