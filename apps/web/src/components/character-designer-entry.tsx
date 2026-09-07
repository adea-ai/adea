'use client'

import { VirtualUnavailable } from '@adea-ai/workspace-ui'

export function CharacterDesignerEntry({
  initialCharacter: _initialCharacter,
}: Readonly<{ initialCharacter: string }>) {
  return <VirtualUnavailable sceneLabel="Character designer" />
}
