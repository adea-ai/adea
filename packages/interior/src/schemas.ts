import { z } from "zod";

export const interiorPropAssetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  assetUrl: z.string().min(1),
  category: z.enum([
    "food-and-drinks",
    "plants",
    "wall-decor",
    "tables",
    "seating",
    "bedroom",
    "storage",
    "lighting",
    "electronics",
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

export const interiorPropCatalogSchema = z.array(interiorPropAssetSchema);

export type ValidatedInteriorPropAsset = z.infer<typeof interiorPropAssetSchema>;
