import '../../src/start/globals.css'
import { render } from 'solid-js/web'
import { WorkspaceEmpty } from '../../src/components/workspace-empty'

let calls = 0
const root = document.querySelector('#harness-root')!
render(
  () => (
    <WorkspaceEmpty
      onCreate={async (name) => {
        calls += 1
        root.setAttribute('data-create-calls', String(calls))
        if (root.hasAttribute('data-create-failure') && calls === 1)
          throw new Error('Fixture create failed')
        if (root.hasAttribute('data-create-delayed'))
          await new Promise<void>((resolve) =>
            window.addEventListener('fixture:create-complete', () => resolve(), { once: true })
          )
        root.setAttribute('data-created-name', name)
      }}
    />
  ),
  root
)
