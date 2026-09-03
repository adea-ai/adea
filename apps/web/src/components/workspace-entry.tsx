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

const RoomDesignerEntry = dynamic(
  () => import('./room-designer-entry').then(({ RoomDesignerEntry: Entry }) => Entry),
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
  /** Cold-mount a designer URL without loading the normal workspace shell. */
  characterDesigner?: boolean
  roomDesigner?: boolean
}>) {
  if (characterDesigner) {
    return <CharacterDesignerEntry initialCharacter={spatialProps.initialCharacter} />
  }
  if (roomDesigner) {
    return (
      <RoomDesignerEntry
        initialCharacter={spatialProps.initialCharacter}
        initialScene={spatialProps.initialScene}
      />
    )
  }

  return <WorkspaceNavigationEntry spatial={spatial} spatialProps={spatialProps} />
}
