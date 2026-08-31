/** Fully authored room and combined interior scenes reserved for later integration. */

const roomRoot = "/assets/models/rooms";

export const roomAssets = [
  { id: "interior-1", label: "Interior 1", assetUrl: `${roomRoot}/Interior_1.glb` },
  { id: "interior-2", label: "Interior 2", assetUrl: `${roomRoot}/Interior_2.glb` },
  { id: "interior-3", label: "Interior 3", assetUrl: `${roomRoot}/Interior_3.glb` },
  { id: "interior-4", label: "Interior 4", assetUrl: `${roomRoot}/Interior_4.glb` },
  { id: "interior-5", label: "Interior 5", assetUrl: `${roomRoot}/Interior_5.glb` },
  { id: "interior-6", label: "Interior 6", assetUrl: `${roomRoot}/Interior_6.glb` },
  { id: "interior-7", label: "Interior 7", assetUrl: `${roomRoot}/Interior_7.glb` },
  { id: "one-file-assets", label: "One-file Assets", assetUrl: `${roomRoot}/One_file_assets.glb` },
  ...Array.from({ length: 28 }, (_, index) => {
    const number = index + 1;
    return {
      id: `room-${number}`,
      label: `Room ${number}`,
      assetUrl: `${roomRoot}/room_${number}.glb`,
    };
  }),
] as const;

export type RoomId = (typeof roomAssets)[number]["id"];
export type RoomAsset = (typeof roomAssets)[number];
