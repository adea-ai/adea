'use client'

import dynamic from 'next/dynamic'
import type { WorkspaceShellProps } from './workspace-shell'

const ConventionalWorkspace = dynamic(
  () =>
    import('./conventional-workspace/conventional-workspace-shell').then(
      ({ ConventionalWorkspaceShell }) => ConventionalWorkspaceShell
    ),
  { loading: () => <WorkspaceEntryLoading /> }
)

const SpatialWorkspace = dynamic(
  () => import('./workspace-shell').then(({ WorkspaceShell }) => WorkspaceShell),
  { loading: () => <WorkspaceEntryLoading /> }
)

function WorkspaceEntryLoading() {
  return (
    <main className="conventional-workspace conventional-workspace--loading" aria-busy="true">
      <p>Opening workspace…</p>
    </main>
  )
}

export function WorkspaceEntry({
  spatial,
  spatialProps,
}: Readonly<{ spatial: boolean; spatialProps: WorkspaceShellProps }>) {
  return spatial ? <SpatialWorkspace {...spatialProps} /> : <ConventionalWorkspace />
}
