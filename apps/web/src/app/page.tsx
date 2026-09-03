import type { Metadata } from 'next'
import { hqSceneFromSearchParams } from '@agent-hq/app-core'
import {
  configurableCharacterId,
  isCharacterId,
  isCustomCharacterId,
} from '@agent-hq/characters/runtime'
import { readSceneStartPosition } from '@agent-hq/scene-shell/scene-spawn'
import { WorkspaceEntry } from '../components/workspace-entry'

export const metadata: Metadata = {
  title: 'Agent HQ',
  description: 'A durable workspace for Rooms, Agents, Tasks, and conversations',
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{
    camera?: string | string[]
    character?: string | string[]
    scene?: string | string[]
    spawn?: string | string[]
    view?: string | string[]
  }>
}) {
  const params = await searchParams
  const requestedCharacter = Array.isArray(params.character)
    ? params.character[0]
    : params.character
  const isValidCharacter =
    isCharacterId(requestedCharacter) || isCustomCharacterId(requestedCharacter)
  const cameraParam = Array.isArray(params.camera) ? params.camera[0] : params.camera
  const view = Array.isArray(params.view) ? params.view[0] : params.view

  return (
    <WorkspaceEntry
      spatial={view === 'spatial'}
      spatialProps={{
        initialScene: hqSceneFromSearchParams(params),
        initialCharacter: isValidCharacter ? requestedCharacter! : configurableCharacterId,
        startPosition: readSceneStartPosition(params.spawn),
        cameraViewMode:
          cameraParam === 'perspective' || cameraParam === 'orthographic' ? cameraParam : undefined,
      }}
    />
  )
}
