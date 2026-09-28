import '../../src/start/globals.css'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { AccountMenu } from '../../../../packages/workspace-ui/src/account-menu'

function Harness() {
  const [action, setAction] = createSignal('')
  return (
    <>
      <AccountMenu
        authenticated
        platform="desktop"
        onOpenAbout={() => setAction('about')}
        onOpenSettings={() => setAction('settings')}
        onOpenUpdates={() => setAction('updates')}
        onSignIn={() => setAction('sign-in')}
        onSignOut={() => setAction('sign-out')}
      />
      <output aria-label="Selected action">{action()}</output>
    </>
  )
}
render(() => <Harness />, document.querySelector('#harness-root')!)
