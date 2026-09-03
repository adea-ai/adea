'use client'

import { interiorPropAssets } from '@agent-hq/interior'
import { RoomDesigner, type RoomDesignerProps } from './room-designer'

export type RoomDesignerSceneProps = Omit<RoomDesignerProps, 'catalog'>

/**
 * HQ's room-designer entrypoint. The complete interior catalog is resolved
 * only when this dynamically imported scene is opened.
 */
export function RoomDesignerScene(props: RoomDesignerSceneProps) {
  return <RoomDesigner {...props} catalog={interiorPropAssets} />
}
