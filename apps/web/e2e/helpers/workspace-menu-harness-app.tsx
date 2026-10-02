import '../../src/start/globals.css'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { AccountMenu } from '../../../../packages/workspace-ui/src/account-menu'

function Harness() {
  const [action, setAction] = createSignal('')
  return (
    <>
      {/* The rail footer pins the account trigger near the bottom of a narrow
          rail column; the menu opens up-and-right from there and needs both
          the same room and the same column width. */}
      <div class="w-14">
        <div class="h-96" />
        <AccountMenu
          authenticated
          platform="desktop"
          onOpenAbout={() => setAction('about')}
          onOpenSettings={() => setAction('settings')}
          onOpenUpdates={() => setAction('updates')}
          onSignIn={() => setAction('sign-in')}
          onSignOut={() => setAction('sign-out')}
        />
      </div>
      <output aria-label="Selected action">{action()}</output>
    </>
  )
}
render(() => <Harness />, document.querySelector('#harness-root')!)
