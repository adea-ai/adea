'use client'

import dynamic from 'next/dynamic'
import { Suspense } from 'react'
import { hqHomeManifest, hqWorkManifest } from '@agent-hq/hq-scenes'
import type { HqSceneId } from '@agent-hq/app-core'

const HqRoomScene = dynamic(
  () => import('@agent-hq/hq-scenes/runtime').then(({ HqRoomScene: Scene }) => Scene),
  { ssr: false }
)

function SceneLoading() {
  return (
    <main className="workspace-shell conventional-workspace--loading" aria-busy="true">
      <p>Opening room designer…</p>
    </main>
  )
}

export function RoomDesignerEntry({
  initialCharacter,
  initialScene,
}: Readonly<{ initialCharacter: string; initialScene: HqSceneId }>) {
  const manifest = initialScene === 'work' ? hqWorkManifest : hqHomeManifest

  return (
    <main className="workspace-shell">
      <div className="workspace-scene-viewport">
        <Suspense fallback={<SceneLoading />}>
          <HqRoomScene
            initialCharacter={initialCharacter}
            manifest={manifest}
            cameraViewMode="orthographic"
            showAccountDrawer={false}
          />
        </Suspense>
      </div>
    </main>
  )
}
