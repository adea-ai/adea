'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import type { WorkspaceView } from '@agent-hq/workspace-ui'
import type { WorkspaceShellProps } from './workspace-shell'

const ConventionalWorkspace = dynamic(
  () =>
    import('./conventional-workspace-entry').then(
      ({ ConventionalWorkspaceEntry }) => ConventionalWorkspaceEntry
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
  const [view, setView] = useState<WorkspaceView>(spatial ? 'virtual' : 'chat')
  const changeView = (nextView: WorkspaceView) => {
    setView(nextView)
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set('view', nextView === 'virtual' ? 'spatial' : 'chat')
    window.history.replaceState(null, '', nextUrl)
  }
  return view === 'virtual' ? (
    <SpatialWorkspace {...spatialProps} onWorkspaceViewChange={changeView} workspaceView={view} />
  ) : (
    <ConventionalWorkspace onViewChange={changeView} />
  )
}
