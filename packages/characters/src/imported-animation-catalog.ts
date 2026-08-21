/** Optional animation slices supplied by a deployment-specific character pack. */
export type ImportedAnimationSlice = {
  firstFrame: number;
  lastFrame: number;
  fps: number;
  loop: boolean;
};

export const importedCharacterAnimationUrls: Record<string, string> = {};
export const importedCharacterAnimationSlices: Record<string, ImportedAnimationSlice> = {};
