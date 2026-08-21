import { z } from "zod";

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

export type ValidatedModelsInteriorPropAsset = z.infer<typeof modelsInteriorPropAssetSchema>;
