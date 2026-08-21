// Interior props for the HQ room designer. Asset URLs are normalized to the
// same category folders used by the designer menu.

import type {
  InteriorPropAsset,
  InteriorPropCategory,
  InteriorPropConfig,
  PropManifest,
} from "./prop-types";

function categoryAssetUrl(assetFolder: string, fileName: string): string {
  return `/assets/models/${assetFolder}/${fileName}`;
}

// Helper to build an InteriorPropAsset from minimal authoring data.
function prop(
  id: string,
  label: string,
  assetUrl: string,
  category: InteriorPropCategory,
  defaultScale: number,
  footprint: readonly [number, number],
  frontYaw: number,
  extra?: Partial<InteriorPropConfig>,
  assetFolder?: string,
): InteriorPropAsset {
  return {
    id,
    label,
    assetUrl: categoryAssetUrl(assetFolder ?? category, assetUrl),
    category,
    defaultScale,
    footprint,
    frontYaw,
    ...extra,
  } as InteriorPropAsset;
}

const FACING_YAW = Math.PI;

// --- Furniture (Cute Furniture pack) ----------------------------------------
const furnitureProps: InteriorPropAsset[] = [
  // Bedroom
  prop("models-bed-02", "Bed", "Bed_02.glb", "bedroom", 1.25, [255, 270], 0),
  prop("models-bed-07", "Bed (Platform)", "Bed_07.glb", "bedroom", 1.25, [180, 285], 0),

  // Seating
  prop(
    "models-armchair-02",
    "Armchair",
    "Armchair_02.glb",
    "seating",
    1.25,
    [135, 105],
    FACING_YAW,
  ),
  prop(
    "models-armchair-18",
    "Armchair (Lounge)",
    "Armchair_18.glb",
    "seating",
    1.25,
    [135, 120],
    FACING_YAW,
  ),
  prop("models-chair-17", "Chair", "Chair_17.glb", "seating", 1.25, [60, 60], FACING_YAW),
  prop(
    "models-chair-pc-04",
    "PC Chair",
    "Chair_PC_04.glb",
    "seating",
    1.25,
    [105, 105],
    FACING_YAW,
  ),
  prop("models-couch-08", "Couch", "Couch_08.glb", "seating", 1.25, [285, 105], FACING_YAW),
  prop(
    "models-couch-11",
    "Couch (Sectional)",
    "Couch_11.glb",
    "seating",
    1.25,
    [210, 105],
    FACING_YAW,
  ),

  // Tables (surfaceHeight enables placeableOnTop items to stack on them)
  prop(
    "models-coffee-table-03",
    "Coffee Table",
    "Coffee_Table_03.glb",
    "tables",
    1.25,
    [105, 105],
    0,
    { surfaceHeight: 53 },
  ),
  prop(
    "models-kitchen-table-09",
    "Kitchen Table",
    "Kitchen_Table_09.glb",
    "tables",
    1.25,
    [210, 105],
    0,
    { surfaceHeight: 94 },
  ),
  prop("models-work-table-06", "Work Table", "Work_Table_06.glb", "tables", 1.25, [165, 105], 0, {
    surfaceHeight: 95,
  }),
  prop(
    "models-kitchen-d-01",
    "Kitchen Counter",
    "Kitchen_D_01.glb",
    "tables",
    1.25,
    [120, 90],
    FACING_YAW,
    { surfaceHeight: 106 },
  ),
  prop(
    "models-kitchen-d-06",
    "Kitchen Counter (Corner)",
    "Kitchen_D_06.glb",
    "tables",
    1.25,
    [120, 120],
    FACING_YAW,
    { surfaceHeight: 94 },
  ),
  prop(
    "models-kitchen-d-08",
    "Kitchen Cabinet",
    "Kitchen_D_08.glb",
    "storage",
    1.25,
    [90, 45],
    FACING_YAW,
    { placementSurface: "wall", wallMountHeight: 130 },
  ),
  prop(
    "models-kitchen-d-09",
    "Kitchen Cabinet (Narrow)",
    "Kitchen_D_09.glb",
    "storage",
    1.25,
    [120, 45],
    FACING_YAW,
    { placementSurface: "wall", wallMountHeight: 130 },
  ),
  prop(
    "models-kitchen-d-10",
    "Kitchen Cabinet (Wide)",
    "Kitchen_D_10.glb",
    "storage",
    1.25,
    [120, 45],
    FACING_YAW,
    { placementSurface: "wall", wallMountHeight: 130 },
  ),

  // Storage
  prop("models-closet-01", "Closet", "Closet_01.glb", "storage", 1.25, [120, 75], FACING_YAW),
  prop(
    "models-closet-02",
    "Closet (Sliding)",
    "Closet_02.glb",
    "storage",
    1.25,
    [105, 60],
    FACING_YAW,
  ),
  prop("models-nightstand-02", "Nightstand", "Nightstand_02.glb", "storage", 1.25, [75, 90], 0, {
    surfaceHeight: 72,
  }),
  prop("models-fridge-01", "Fridge", "Fridge_01.glb", "storage", 1.25, [135, 75], 0),

  // Lighting
  prop("models-light-05", "Floor Lamp", "Light_05.glb", "lighting", 1.25, [60, 60], 0),

  // Plants
  prop("models-plants-05", "Plant (Tall)", "Plants_05.glb", "plants", 1.25, [30, 30], 0, {
    blocksRugOverlap: true,
  }),
  prop("models-plants-15", "Plant (Bushy)", "Plants_15.glb", "plants", 1.25, [75, 45], 0, {
    blocksRugOverlap: true,
  }),
  prop("models-plants-19", "Plant (Small)", "Plants_19.glb", "plants", 1.25, [165, 135], 0, {
    blocksRugOverlap: true,
  }),

  // Wall decor
  prop("models-picture-08", "Picture", "Picture_08.glb", "wall-decor", 1.25, [90, 15], FACING_YAW, {
    placementSurface: "wall",
    wallMountHeight: 120,
  }),
  prop(
    "models-picture-17",
    "Picture (Landscape)",
    "Picture_17.glb",
    "wall-decor",
    1.25,
    [90, 15],
    FACING_YAW,
    { placementSurface: "wall", wallMountHeight: 120 },
  ),
  prop(
    "models-picture-21",
    "Picture (Abstract)",
    "Picture_21.glb",
    "wall-decor",
    1.25,
    [90, 15],
    FACING_YAW,
    { placementSurface: "wall", wallMountHeight: 120 },
  ),

  // Electronics (small items that can sit on tables/counters)
  prop(
    "models-computer-01",
    "Computer",
    "Computer_01.glb",
    "electronics",
    1.25,
    [90, 30],
    FACING_YAW,
    { placeableOnTop: true },
  ),
  prop(
    "models-game-console-01",
    "Game Console",
    "GameConsole_01.glb",
    "electronics",
    1.25,
    [30, 30],
    FACING_YAW,
    { placeableOnTop: true },
  ),
  prop(
    "models-microwave-01",
    "Microwave",
    "Microwave_01.glb",
    "electronics",
    1.25,
    [75, 45],
    FACING_YAW,
    { placeableOnTop: true },
  ),
  prop("models-mixer-08", "Mixer", "Mixer_08.glb", "electronics", 1.25, [30, 45], FACING_YAW, {
    placeableOnTop: true,
  }),

  // Other
  prop("models-bath-03", "Bathtub", "Bath_03.glb", "other", 1.25, [225, 105], 0),
  prop("models-toilet-03", "Toilet", "Toilet_03.glb", "other", 1.25, [60, 90], 0),
  prop("models-wash-basin-07", "Wash Basin", "Wash_Basin_07.glb", "other", 1.25, [90, 60], 0),
  prop("models-toothbrush-01", "Toothbrush", "Toothbrush_01.glb", "other", 1.25, [15, 30], 0, {
    placeableOnTop: true,
  }),
  prop("models-toothpaste-01", "Toothpaste", "Toothpaste_01.glb", "other", 1.25, [45, 15], 0, {
    placeableOnTop: true,
  }),
  prop("models-utensils-01", "Utensils", "Utensils_01.glb", "other", 1.25, [60, 15], 0, {
    placeableOnTop: true,
  }),
  prop(
    "models-cutting-board-02",
    "Cutting Board",
    "Cutting_board_02.glb",
    "other",
    1.25,
    [45, 60],
    0,
    { placeableOnTop: true },
  ),
  prop("models-book-03", "Book", "Book_03.glb", "other", 1.25, [90, 30], 0, {
    placeableOnTop: true,
  }),
  prop("models-book-08", "Book (Stack)", "Book_08.glb", "other", 1.25, [45, 45], 0, {
    placeableOnTop: true,
  }),
  prop("models-paper-01", "Paper", "Paper_01.glb", "other", 1.25, [45, 45], 0, {
    placeableOnTop: true,
  }),
  prop("models-paper-02", "Paper (Stack)", "Paper_02.glb", "other", 1.25, [30, 45], 0, {
    placeableOnTop: true,
  }),
  prop("models-clock-03", "Clock", "Clock_03.glb", "other", 1.25, [90, 60], 0, {
    placeableOnTop: true,
  }),
  prop("models-toy-02", "Toy (Robot)", "Toy_02.glb", "other", 1.25, [30, 30], 0, {
    placeableOnTop: true,
  }),
  prop("models-toy-03", "Toy (Block)", "Toy_03.glb", "other", 1.25, [45, 45], 0, {
    placeableOnTop: true,
  }),
  prop("models-guitar-01", "Guitar", "Guitar_01.glb", "other", 1.25, [60, 120], 0, {
    placeableOnTop: true,
  }),
  prop(
    "models-exercise-bike-01",
    "Exercise Bike",
    "ExerciseBike_01.glb",
    "other",
    1.25,
    [120, 75],
    FACING_YAW,
  ),
];

// --- Food & Drinks (Food pack) ----------------------------------------------
const drinkFiles = [
  "coffee_005",
  "tea_003",
  "soda_002",
  "bottle_002",
  "can_009",
  "glass_001",
  "glass_004",
  "glass_005",
  "glass_008",
  "cup_003",
];

const foodFiles = [
  "avocado_001",
  "avocado_003",
  "bar_001",
  "bowl_001",
  "burger_001",
  "cheesecake_001",
  "chili_002",
  "chips_008",
  "cookie_006",
  "cookie_011",
  "cookie_012",
  "croissant_001",
  "donut_002",
  "egg_001",
  "egg_002",
  "egg_003",
  "egg_004",
  "fish_004",
  "fork_001",
  "ice_cream_001",
  "ice_cream_003",
  "mushroom_002",
  "mushroom_004",
  "mushroom_006",
  "onion_001",
  "onion_003",
  "pastry_002",
  "pepper_003",
  "plate_001",
  "plate_007",
  "sandwich_001",
  "sandwich_002",
  "sandwich_003",
  "sasuage_003",
  "shrimp_001",
  "shrimp_002",
  "watermelon_001",
  "watermelon_002",
  "watermelon_003",
  "yogurt_002",
];

function foodLabel(filename: string): string {
  return filename
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s\d+$/, "");
}

const foodProps: InteriorPropAsset[] = [
  // Drinks
  ...drinkFiles.map((f) =>
    prop(
      `models-${f}`,
      foodLabel(f),
      `${f}.glb`,
      "food-and-drinks",
      1.0,
      [24, 24],
      0,
      {
        placeableOnTop: true,
      },
      "drinks",
    ),
  ),
  // Food
  ...foodFiles.map((f) =>
    prop(
      `models-${f}`,
      foodLabel(f),
      `${f}.glb`,
      "food-and-drinks",
      1.0,
      [24, 24],
      0,
      {
        placeableOnTop: true,
      },
      "food",
    ),
  ),
];

// --- Casino assets (Casino pack) --------------------------------------------
const casinoProps: InteriorPropAsset[] = [
  // Gaming tables
  prop("models-casino-table-01", "Casino Table", "Table_01.glb", "tables", 1.0, [108, 108], 0, {
    surfaceHeight: 85,
  }),
  prop(
    "models-casino-table-06",
    "Casino Table (Large)",
    "Table_06.glb",
    "tables",
    1.0,
    [276, 156],
    0,
    { surfaceHeight: 80 },
  ),
  prop(
    "models-casino-tablecloth-01",
    "Tablecloth",
    "Tablecloth_01.glb",
    "tables",
    1.0,
    [108, 108],
    0,
  ),

  // Slot machines
  prop(
    "models-slot-machine-01",
    "Slot Machine",
    "Slot_Machine_01.glb",
    "electronics",
    1.0,
    [96, 96],
    FACING_YAW,
  ),
  prop(
    "models-slot-machine-02",
    "Slot Machine (Alt)",
    "Slot_Machine_02.glb",
    "electronics",
    1.0,
    [96, 96],
    FACING_YAW,
  ),
  prop(
    "models-slot-machine-aquarium",
    "Slot Machine Aquarium",
    "Slot_Machine_Aquarium_01.glb",
    "electronics",
    1.0,
    [96, 96],
    FACING_YAW,
  ),

  // Seating
  prop(
    "models-casino-armchair-02",
    "Casino Armchair",
    "casino-Armchair_02.glb",
    "seating",
    1.0,
    [108, 96],
    FACING_YAW,
  ),
  prop(
    "models-casino-chair-06",
    "Casino Chair",
    "Chair_06.glb",
    "seating",
    1.0,
    [72, 84],
    FACING_YAW,
  ),
  prop(
    "models-casino-chair-office",
    "Office Chair",
    "Chair_Office_01.glb",
    "seating",
    1.0,
    [72, 72],
    FACING_YAW,
  ),
  prop(
    "models-casino-couch-05",
    "Casino Couch",
    "Couch_05.glb",
    "seating",
    1.0,
    [180, 96],
    FACING_YAW,
  ),

  // ATMs & cash machines
  prop("models-casino-atm-01", "ATM", "ATM_01.glb", "storage", 1.0, [84, 108], FACING_YAW),
  prop("models-casino-atm-03", "ATM (Wall)", "ATM_03.glb", "storage", 1.0, [72, 72], FACING_YAW),
  prop(
    "models-casino-cash-machine",
    "Cash Machine",
    "Cash_Machine_01.glb",
    "storage",
    1.0,
    [48, 48],
    0,
  ),
  prop("models-casino-safebox", "Safe Box", "SafeBox_01.glb", "storage", 1.0, [96, 96], FACING_YAW),

  // Money & valuables
  prop("models-casino-cash-01", "Cash Stack", "Cash_01.glb", "other", 1.0, [12, 36], 0, {
    placeableOnTop: true,
  }),
  prop("models-casino-cash-02", "Cash Stack (Banded)", "Cash_02.glb", "other", 1.0, [12, 24], 0, {
    placeableOnTop: true,
  }),
  prop("models-casino-cash-07", "Cash Stack (Fan)", "Cash_07.glb", "other", 1.0, [24, 36], 0, {
    placeableOnTop: true,
  }),
  prop(
    "models-casino-cash-10",
    "Cash Stack (Scattered)",
    "Cash_10.glb",
    "other",
    1.0,
    [24, 36],
    0,
    { placeableOnTop: true },
  ),
  prop("models-casino-cash-11", "Cash Stack (Thick)", "Cash_11.glb", "other", 1.0, [12, 12], 0, {
    placeableOnTop: true,
  }),
  prop(
    "models-casino-gold-ingot-01",
    "Gold Ingot",
    "Gold_Ingot_01.glb",
    "other",
    1.0,
    [24, 48],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "models-casino-gold-ingot-02",
    "Gold Ingot (Stack)",
    "Gold_Ingot_02.glb",
    "other",
    1.0,
    [12, 24],
    0,
    { placeableOnTop: true },
  ),

  // Playing cards
  prop("models-casino-card-39", "Playing Card", "Card_39.glb", "other", 1.0, [12, 24], 0, {
    placeableOnTop: true,
  }),
  prop("models-casino-card-44", "Playing Card (Heart)", "Card_44.glb", "other", 1.0, [12, 24], 0, {
    placeableOnTop: true,
  }),
  prop(
    "models-casino-card-48",
    "Playing Card (Diamond)",
    "Card_48.glb",
    "other",
    1.0,
    [12, 24],
    0,
    { placeableOnTop: true },
  ),
  prop("models-casino-card-53", "Playing Card (Spade)", "Card_53.glb", "other", 1.0, [12, 24], 0, {
    placeableOnTop: true,
  }),

  // Decorative
  prop("models-casino-column-17", "Column", "Column_17.glb", "other", 1.0, [252, 252], 0),
  prop("models-casino-floor-01", "Casino Floor", "Floor_01.glb", "other", 1.0, [600, 600], 0, {
    floorLift: 3,
    allowItemsOnTop: true,
    canOverlapFurniture: true,
    blocksRugOverlap: true,
  }),
  prop("models-casino-flower-03", "Casino Flower", "Flower_03.glb", "plants", 1.0, [180, 180], 0, {
    blocksRugOverlap: true,
  }),
  prop(
    "models-casino-fruits-01",
    "Fruits Bowl",
    "Fruits_01.glb",
    "food-and-drinks",
    1.0,
    [48, 48],
    0,
    { placeableOnTop: true },
    "food",
  ),
  prop("models-casino-lamp-05", "Casino Floor Lamp", "Lamp_05.glb", "lighting", 1.0, [84, 84], 0),
  prop(
    "models-casino-neon-sign",
    "Neon Sign",
    "Neon_Sign_01.glb",
    "wall-decor",
    1.0,
    [96, 12],
    FACING_YAW,
    { placementSurface: "wall", wallMountHeight: 96 },
  ),
  prop(
    "models-casino-screens",
    "Casino Screens",
    "Screens_01.glb",
    "electronics",
    1.0,
    [408, 408],
    FACING_YAW,
  ),
  prop("models-casino-book-01", "Casino Book", "Book_01.glb", "other", 1.0, [36, 48], 0, {
    placeableOnTop: true,
  }),
  prop("models-casino-keyboard", "Keyboard", "Keyboard_01.glb", "electronics", 1.0, [60, 24], 0, {
    placeableOnTop: true,
  }),
  prop("models-casino-monitor", "Monitor", "Monitor_02.glb", "electronics", 1.0, [72, 24], 0, {
    placeableOnTop: true,
  }),
  prop("models-casino-mouse", "Mouse", "Mouse_01.glb", "electronics", 1.0, [12, 24], 0, {
    placeableOnTop: true,
  }),
];

export const interiorPropAssets: readonly InteriorPropAsset[] = [
  ...furnitureProps,
  ...foodProps,
  ...casinoProps,
];

// Also export as PropManifest[] for the runtime field loader.
export const propAssets: readonly PropManifest[] = interiorPropAssets.map((a) => ({
  id: a.id,
  label: a.label,
  assetUrl: a.assetUrl,
}));
