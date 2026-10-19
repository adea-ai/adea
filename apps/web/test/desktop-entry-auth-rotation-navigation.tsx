import { createEffect } from 'solid-js'
import type { WorkspaceSummary } from '@adea-ai/types'
import type { WorkspacePlatformServices } from '@adea-ai/workspace-ui/platform'
import { NativeSessionInventoryDiagnostic } from '../../../packages/workspace-ui/src/native-session-inventory-diagnostic'
import { observeProvider } from './desktop-entry-auth-rotation-state'

// Replace only the unrelated navigation tree. Providers are constructed by the
// real DesktopWorkspace component and read through reactive props on every use.
export function WorkspaceNavigation(props: {
  activeWorkspace: WorkspaceSummary
  services: WorkspacePlatformServices
}) {
  createEffect(() => observeProvider(props.services.nativeSessionInventoryDiagnostics))
  return (
    <NativeSessionInventoryDiagnostic
      diagnostics={props.services.nativeSessionInventoryDiagnostics}
      workspaceId={props.activeWorkspace.id}
    />
  )
}

export function createDeferredPluginsProvider() {
  return Object.freeze({})
}
