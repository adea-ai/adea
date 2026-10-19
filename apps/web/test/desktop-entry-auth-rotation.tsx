import '../src/start/globals.css'
import { render } from 'solid-js/web'
import type { WorkspaceShellProps } from '../src/components/workspace-shell'
import {
  recordEntryMount,
  rotationBridge,
  rotationControls,
} from './desktop-entry-auth-rotation-state'

window.__adeaDesktop = rotationBridge
window.desktopEntryAuthRotation = rotationControls

// Import only after installing the shell double, so production module setup
// observes the same bridge used by its scope selector and runtime adapter.
const { DesktopWorkspaceEntry } = await import('../src/components/desktop-workspace-entry')
render(() => {
  recordEntryMount()
  return <DesktopWorkspaceEntry virtual={false} virtualProps={{} as WorkspaceShellProps} />
}, document.getElementById('root')!)
