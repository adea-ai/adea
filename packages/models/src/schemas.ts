import { z } from "zod";
import { isModelsCharacterId, isModelsCustomCharacterId, modelsCharacterIds } from "./characters";

export const modelsCharacterIdSchema = z.enum(modelsCharacterIds);

export const modelsCustomCharacterIdSchema = z.string().refine(isModelsCustomCharacterId, {
  message: "Unknown custom model character id",
});

export const modelsCharacterSelectionSchema = z.string().refine(
  (value) => isModelsCharacterId(value) || isModelsCustomCharacterId(value),
  { message: "Unknown model character id" },
);

export const modelsInteriorPropAssetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  assetUrl: z.string().min(1),
  category: z.enum([
    "drinks",
    "food",
    "plants",
    "wall-decor",
    "tables",
    "seating",
    "bedroom",
    "storage",
    "lighting",
    "electronics",
    "casino",
    "other",
  ]),
  defaultScale: z.number().positive(),
  footprint: z.tuple([z.number().positive(), z.number().positive()]),
  placementSurface: z.enum(["floor", "wall"]).optional(),
  wallMountHeight: z.number().optional(),
  footprintShape: z.enum(["rectangle", "circle"]).optional(),
  floorLift: z.number().optional(),
  allowItemsOnTop: z.boolean().optional(),
  canOverlapFurniture: z.boolean().optional(),
  blocksRugOverlap: z.boolean().optional(),
  surfaceHeight: z.number().optional(),
  placeableOnTop: z.boolean().optional(),
  frontYaw: z.number(),
});

export const modelsInteriorPropCatalogSchema = z.array(modelsInteriorPropAssetSchema);

export type ValidatedModelsCharacterId = z.infer<typeof modelsCharacterIdSchema>;
export type ValidatedModelsInteriorPropAsset = z.infer<typeof modelsInteriorPropAssetSchema>;
