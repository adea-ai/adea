'use client'

import dynamic from 'next/dynamic'
import type { WorkspaceShellProps } from './workspace-shell'

const WorkspaceNavigationEntry = dynamic(
  () => import('./workspace-navigation-entry').then(({ WorkspaceNavigationEntry: Entry }) => Entry),
  { loading: () => <WorkspaceEntryLoading /> }
)

const CharacterDesignerEntry = dynamic(
  () => import('./character-designer-entry').then(({ CharacterDesignerEntry: Entry }) => Entry),
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
  characterDesigner,
  roomDesigner,
}: Readonly<{
  spatial: boolean
  spatialProps: WorkspaceShellProps
  /** Cold-mount the character designer URL without loading the normal workspace shell. */
  characterDesigner?: boolean
  /** Mount the dedicated room designer scene beside global workspace navigation. */
  roomDesigner?: boolean
}>) {
  if (characterDesigner) {
    return <CharacterDesignerEntry initialCharacter={spatialProps.initialCharacter} />
  }
  return (
    <WorkspaceNavigationEntry
      roomDesigner={roomDesigner}
      spatial={spatial}
      spatialProps={spatialProps}
    />
  )
}
