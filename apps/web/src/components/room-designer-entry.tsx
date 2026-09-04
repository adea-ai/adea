'use client'

import dynamic from 'next/dynamic'
import { useRef, useState } from 'react'
import { Button } from '@agent-hq/ui/components/ui/button'

const RoomDesignerScene = dynamic(
  () => import('@agent-hq/room-designer-scene').then(({ RoomDesignerScene: Scene }) => Scene),
  { ssr: false }
)

export function RoomDesignerEntry({
  initialCharacter,
  initialScene,
  onClose,
}: Readonly<{
  initialCharacter: string
  initialScene: 'home' | 'work'
  onClose: () => void
}>) {
  const saveRef = useRef<(() => Promise<boolean>) | null>(null)
  const [dirty, setDirty] = useState(false)
  const [pendingClose, setPendingClose] = useState(false)
  const requestClose = () => {
    if (dirty) {
      setPendingClose(true)
      return
    }
    onClose()
  }
  const discard = () => {
    setPendingClose(false)
    onClose()
  }
  const saveAndClose = async () => {
    const saved = await saveRef.current?.()
    if (saved === false) return
    setPendingClose(false)
    onClose()
  }

  return (
    <main className="workspace-shell">
      <div className="workspace-scene-viewport">
        <RoomDesignerScene
          initialCharacter={initialCharacter}
          initialScene={initialScene}
          onClose={requestClose}
          saveRef={saveRef}
          onDirtyChange={setDirty}
        />
        {pendingClose ? (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 p-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="room-designer-save-dialog-title"
              className="w-full max-w-sm rounded-xl border border-border bg-background p-5 text-foreground shadow-2xl"
            >
              <h2 id="room-designer-save-dialog-title" className="text-base font-semibold">
                Save room changes?
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                You have unsaved room edits. Save them before closing?
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setPendingClose(false)}>
                  Keep editing
                </Button>
                <Button type="button" variant="destructive" onClick={discard}>
                  Discard
                </Button>
                <Button type="button" onClick={() => void saveAndClose()}>
                  Save &amp; close
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  )
}
