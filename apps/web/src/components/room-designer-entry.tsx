'use client'

import { VirtualUnavailable } from '@adea-ai/workspace-ui'

export function RoomDesignerEntry({
  initialCharacter: _initialCharacter,
  initialScene,
  onClose,
}: Readonly<{
  initialCharacter: string
  initialScene: 'home' | 'work'
  onClose: () => void
}>) {
  return (
    <VirtualUnavailable
      sceneLabel={initialScene === 'work' ? 'Work room designer' : 'Home room designer'}
      onOpenChat={onClose}
    />
  )
}
