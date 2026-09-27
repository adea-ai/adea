import '../../src/start/globals.css'
import { render } from 'solid-js/web'
import { WorkspaceSkeleton } from '../../../../packages/workspace-ui/src/workspace-states'
render(
  () => <WorkspaceSkeleton label="Loading messages" />,
  document.querySelector('#harness-root')!
)
