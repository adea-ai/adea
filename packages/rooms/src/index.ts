/** Fully authored room assets exported from the latest Blender source files. */

const roomRoot = '/assets/models'
const roomCounts = [28, 28, 28, 28, 28, 24, 24] as const

export const roomAssets = [
  { id: 'global-assets', label: 'Global Assets', assetUrl: `${roomRoot}/global_assets.glb` },
  ...roomCounts.flatMap((count, interiorIndex) => {
    const interiorNumber = interiorIndex + 1
    return Array.from({ length: count }, (_, roomIndex) => {
      const roomNumber = roomIndex + 1
      return {
        id: `interior-${interiorNumber}-room-${roomNumber}`,
        label: `Interior ${interiorNumber} / Room ${roomNumber.toString().padStart(2, '0')}`,
        assetUrl: `${roomRoot}/interior-${interiorNumber}/room_${roomNumber}.glb`,
      }
    })
  }),
] as const

export type RoomId = (typeof roomAssets)[number]['id']
export type RoomAsset = (typeof roomAssets)[number]
