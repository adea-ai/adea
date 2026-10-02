import '../../src/start/globals.css'
import { render } from 'solid-js/web'
import { WorkspaceSettingsDialog } from '@adea-ai/workspace-ui/workspace-settings'
import type { WorkspaceSummary } from '@adea-ai/types'

const workspace: WorkspaceSummary = {
  id: 'workspace-settings-e2e',
  name: 'Settings harness',
  scene: 'work',
  updatedAt: '2026-10-02T00:00:00.000Z',
} as WorkspaceSummary

/**
 * Mounts the settings dialog with no application providers above it —
 * deliberately: the harness pins the dialog's contract that every section
 * renders standalone. The deep link (#settings/<section>) the dialog reads on
 * open decides the active tab, so the spec opens this page straight onto the
 * section it exercises.
 */
function Harness() {
  return (
    <WorkspaceSettingsDialog
      open
      accountAuthenticated={false}
      accountLabel="Guest"
      agents={[]}
      busy={false}
      onClose={() => undefined}
      onOpenAgents={() => undefined}
      onSignIn={() => undefined}
      onSignOut={() => undefined}
      workspace={workspace}
    />
  )
}

render(() => <Harness />, document.querySelector('#harness-root')!)
