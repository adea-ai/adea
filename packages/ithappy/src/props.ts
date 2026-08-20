// ithappy props for the HQ room designer.
//
// Exports ithappy furniture, food & drinks, casino assets, and foliage as
// InteriorPropAsset entries compatible with the HQ room designer catalog.
// Each entry includes a category, default scale, footprint, and frontYaw so
// the designer can place them on the 12-unit interior grid alongside the
// existing World props.

export type InteriorPropCategory =
  | "bedroom"
  | "seating"
  | "tables"
  | "storage"
  | "lighting"
  | "plants"
  | "wall-decor"
  | "electronics"
  | "other"
  | "drinks"
  | "food";

export type InteriorPropConfig = {
  surfaceHeight?: number;
  placementSurface?: "floor" | "wall";
  wallMountHeight?: number;
  placeableOnTop?: boolean;
  floorLift?: number;
  allowItemsOnTop?: boolean;
  canOverlapFurniture?: boolean;
  blocksRugOverlap?: boolean;
  footprintShape?: "rectangle" | "circle";
};

export type InteriorPropAsset = InteriorPropConfig & {
  id: string;
  label: string;
  assetUrl: string;
  category: InteriorPropCategory;
  defaultScale: number;
  footprint: readonly [number, number];
  frontYaw: number;
};

export type PropManifest = {
  id: string;
  label: string;
  assetUrl: string;
};

const furnitureRoot = "/assets/ithappy/furniture";
const foodRoot = "/assets/ithappy/food";
const casinoRoot = "/assets/ithappy/casino";
const foliageRoot = "/assets/ithappy/foliage";

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
): InteriorPropAsset {
  return {
    id,
    label,
    assetUrl,
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
  prop("ithappy-bed-02", "Bed", `${furnitureRoot}/Bed_02.glb`, "bedroom", 1.25, [255, 270], 0),
  prop(
    "ithappy-bed-07",
    "Bed (Platform)",
    `${furnitureRoot}/Bed_07.glb`,
    "bedroom",
    1.25,
    [180, 285],
    0,
  ),

  // Seating
  prop(
    "ithappy-armchair-02",
    "Armchair",
    `${furnitureRoot}/Armchair_02.glb`,
    "seating",
    1.25,
    [135, 105],
    FACING_YAW,
  ),
  prop(
    "ithappy-armchair-18",
    "Armchair (Lounge)",
    `${furnitureRoot}/Armchair_18.glb`,
    "seating",
    1.25,
    [135, 120],
    FACING_YAW,
  ),
  prop(
    "ithappy-chair-17",
    "Chair",
    `${furnitureRoot}/Chair_17.glb`,
    "seating",
    1.25,
    [60, 60],
    FACING_YAW,
  ),
  prop(
    "ithappy-chair-pc-04",
    "PC Chair",
    `${furnitureRoot}/Chair_PC_04.glb`,
    "seating",
    1.25,
    [105, 105],
    FACING_YAW,
  ),
  prop(
    "ithappy-couch-08",
    "Couch",
    `${furnitureRoot}/Couch_08.glb`,
    "seating",
    1.25,
    [285, 105],
    FACING_YAW,
  ),
  prop(
    "ithappy-couch-11",
    "Couch (Sectional)",
    `${furnitureRoot}/Couch_11.glb`,
    "seating",
    1.25,
    [210, 105],
    FACING_YAW,
  ),

  // Tables (surfaceHeight enables placeableOnTop items to stack on them)
  prop(
    "ithappy-coffee-table-03",
    "Coffee Table",
    `${furnitureRoot}/Coffee_Table_03.glb`,
    "tables",
    1.25,
    [105, 105],
    0,
    { surfaceHeight: 53 },
  ),
  prop(
    "ithappy-kitchen-table-09",
    "Kitchen Table",
    `${furnitureRoot}/Kitchen_Table_09.glb`,
    "tables",
    1.25,
    [210, 105],
    0,
    { surfaceHeight: 94 },
  ),
  prop(
    "ithappy-work-table-06",
    "Work Table",
    `${furnitureRoot}/Work_Table_06.glb`,
    "tables",
    1.25,
    [165, 105],
    0,
    { surfaceHeight: 95 },
  ),
  prop(
    "ithappy-kitchen-d-01",
    "Kitchen Counter",
    `${furnitureRoot}/Kitchen_D_01.glb`,
    "tables",
    1.25,
    [120, 90],
    FACING_YAW,
    { surfaceHeight: 106 },
  ),
  prop(
    "ithappy-kitchen-d-06",
    "Kitchen Counter (Corner)",
    `${furnitureRoot}/Kitchen_D_06.glb`,
    "tables",
    1.25,
    [120, 120],
    FACING_YAW,
    { surfaceHeight: 94 },
  ),
  prop(
    "ithappy-kitchen-d-08",
    "Kitchen Cabinet",
    `${furnitureRoot}/Kitchen_D_08.glb`,
    "storage",
    1.25,
    [90, 45],
    FACING_YAW,
    { placementSurface: "wall", wallMountHeight: 130 },
  ),
  prop(
    "ithappy-kitchen-d-09",
    "Kitchen Cabinet (Narrow)",
    `${furnitureRoot}/Kitchen_D_09.glb`,
    "storage",
    1.25,
    [120, 45],
    FACING_YAW,
    { placementSurface: "wall", wallMountHeight: 130 },
  ),
  prop(
    "ithappy-kitchen-d-10",
    "Kitchen Cabinet (Wide)",
    `${furnitureRoot}/Kitchen_D_10.glb`,
    "storage",
    1.25,
    [120, 45],
    FACING_YAW,
    { placementSurface: "wall", wallMountHeight: 130 },
  ),

  // Storage
  prop(
    "ithappy-closet-01",
    "Closet",
    `${furnitureRoot}/Closet_01.glb`,
    "storage",
    1.25,
    [120, 75],
    FACING_YAW,
  ),
  prop(
    "ithappy-closet-02",
    "Closet (Sliding)",
    `${furnitureRoot}/Closet_02.glb`,
    "storage",
    1.25,
    [105, 60],
    FACING_YAW,
  ),
  prop(
    "ithappy-nightstand-02",
    "Nightstand",
    `${furnitureRoot}/Nightstand_02.glb`,
    "storage",
    1.25,
    [75, 90],
    0,
    { surfaceHeight: 72 },
  ),
  prop(
    "ithappy-fridge-01",
    "Fridge",
    `${furnitureRoot}/Fridge_01.glb`,
    "storage",
    1.25,
    [135, 75],
    0,
  ),

  // Lighting
  prop(
    "ithappy-light-05",
    "Floor Lamp",
    `${furnitureRoot}/Light_05.glb`,
    "lighting",
    1.25,
    [60, 60],
    0,
  ),

  // Plants
  prop(
    "ithappy-plants-05",
    "Plant (Tall)",
    `${furnitureRoot}/Plants_05.glb`,
    "plants",
    1.25,
    [30, 30],
    0,
    { blocksRugOverlap: true },
  ),
  prop(
    "ithappy-plants-15",
    "Plant (Bushy)",
    `${furnitureRoot}/Plants_15.glb`,
    "plants",
    1.25,
    [75, 45],
    0,
    { blocksRugOverlap: true },
  ),
  prop(
    "ithappy-plants-19",
    "Plant (Small)",
    `${furnitureRoot}/Plants_19.glb`,
    "plants",
    1.25,
    [165, 135],
    0,
    { blocksRugOverlap: true },
  ),

  // Wall decor
  prop(
    "ithappy-picture-08",
    "Picture",
    `${furnitureRoot}/Picture_08.glb`,
    "wall-decor",
    1.25,
    [90, 15],
    FACING_YAW,
    { placementSurface: "wall", wallMountHeight: 120 },
  ),
  prop(
    "ithappy-picture-17",
    "Picture (Landscape)",
    `${furnitureRoot}/Picture_17.glb`,
    "wall-decor",
    1.25,
    [90, 15],
    FACING_YAW,
    { placementSurface: "wall", wallMountHeight: 120 },
  ),
  prop(
    "ithappy-picture-21",
    "Picture (Abstract)",
    `${furnitureRoot}/Picture_21.glb`,
    "wall-decor",
    1.25,
    [90, 15],
    FACING_YAW,
    { placementSurface: "wall", wallMountHeight: 120 },
  ),

  // Electronics (small items that can sit on tables/counters)
  prop(
    "ithappy-computer-01",
    "Computer",
    `${furnitureRoot}/Computer_01.glb`,
    "electronics",
    1.25,
    [90, 30],
    FACING_YAW,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-game-console-01",
    "Game Console",
    `${furnitureRoot}/GameConsole_01.glb`,
    "electronics",
    1.25,
    [30, 30],
    FACING_YAW,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-microwave-01",
    "Microwave",
    `${furnitureRoot}/Microwave_01.glb`,
    "electronics",
    1.25,
    [75, 45],
    FACING_YAW,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-mixer-08",
    "Mixer",
    `${furnitureRoot}/Mixer_08.glb`,
    "electronics",
    1.25,
    [30, 45],
    FACING_YAW,
    { placeableOnTop: true },
  ),

  // Other
  prop("ithappy-bath-03", "Bathtub", `${furnitureRoot}/Bath_03.glb`, "other", 1.25, [225, 105], 0),
  prop("ithappy-toilet-03", "Toilet", `${furnitureRoot}/Toilet_03.glb`, "other", 1.25, [60, 90], 0),
  prop(
    "ithappy-wash-basin-07",
    "Wash Basin",
    `${furnitureRoot}/Wash_Basin_07.glb`,
    "other",
    1.25,
    [90, 60],
    0,
  ),
  prop(
    "ithappy-toothbrush-01",
    "Toothbrush",
    `${furnitureRoot}/Toothbrush_01.glb`,
    "other",
    1.25,
    [15, 30],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-toothpaste-01",
    "Toothpaste",
    `${furnitureRoot}/Toothpaste_01.glb`,
    "other",
    1.25,
    [45, 15],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-utensils-01",
    "Utensils",
    `${furnitureRoot}/Utensils_01.glb`,
    "other",
    1.25,
    [60, 15],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-cutting-board-02",
    "Cutting Board",
    `${furnitureRoot}/Cutting_board_02.glb`,
    "other",
    1.25,
    [45, 60],
    0,
    { placeableOnTop: true },
  ),
  prop("ithappy-book-03", "Book", `${furnitureRoot}/Book_03.glb`, "other", 1.25, [90, 30], 0, {
    placeableOnTop: true,
  }),
  prop(
    "ithappy-book-08",
    "Book (Stack)",
    `${furnitureRoot}/Book_08.glb`,
    "other",
    1.25,
    [45, 45],
    0,
    { placeableOnTop: true },
  ),
  prop("ithappy-paper-01", "Paper", `${furnitureRoot}/Paper_01.glb`, "other", 1.25, [45, 45], 0, {
    placeableOnTop: true,
  }),
  prop(
    "ithappy-paper-02",
    "Paper (Stack)",
    `${furnitureRoot}/Paper_02.glb`,
    "other",
    1.25,
    [30, 45],
    0,
    { placeableOnTop: true },
  ),
  prop("ithappy-clock-03", "Clock", `${furnitureRoot}/Clock_03.glb`, "other", 1.25, [90, 60], 0, {
    placeableOnTop: true,
  }),
  prop("ithappy-toy-02", "Toy (Robot)", `${furnitureRoot}/Toy_02.glb`, "other", 1.25, [30, 30], 0, {
    placeableOnTop: true,
  }),
  prop("ithappy-toy-03", "Toy (Block)", `${furnitureRoot}/Toy_03.glb`, "other", 1.25, [45, 45], 0, {
    placeableOnTop: true,
  }),
  prop(
    "ithappy-guitar-01",
    "Guitar",
    `${furnitureRoot}/Guitar_01.glb`,
    "other",
    1.25,
    [60, 120],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-exercise-bike-01",
    "Exercise Bike",
    `${furnitureRoot}/ExerciseBike_01.glb`,
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
    prop(`ithappy-${f}`, foodLabel(f), `${foodRoot}/${f}.glb`, "drinks", 1.0, [24, 24], 0, {
      placeableOnTop: true,
    }),
  ),
  // Food
  ...foodFiles.map((f) =>
    prop(`ithappy-${f}`, foodLabel(f), `${foodRoot}/${f}.glb`, "food", 1.0, [24, 24], 0, {
      placeableOnTop: true,
    }),
  ),
];

// --- Casino assets (Casino pack) --------------------------------------------
const casinoProps: InteriorPropAsset[] = [
  // Gaming tables
  prop(
    "ithappy-casino-table-01",
    "Casino Table",
    `${casinoRoot}/Table_01.glb`,
    "tables",
    1.0,
    [108, 108],
    0,
    { surfaceHeight: 85 },
  ),
  prop(
    "ithappy-casino-table-06",
    "Casino Table (Large)",
    `${casinoRoot}/Table_06.glb`,
    "tables",
    1.0,
    [276, 156],
    0,
    { surfaceHeight: 80 },
  ),
  prop(
    "ithappy-casino-tablecloth-01",
    "Tablecloth",
    `${casinoRoot}/Tablecloth_01.glb`,
    "tables",
    1.0,
    [108, 108],
    0,
  ),

  // Slot machines
  prop(
    "ithappy-slot-machine-01",
    "Slot Machine",
    `${casinoRoot}/Slot_Machine_01.glb`,
    "electronics",
    1.0,
    [96, 96],
    FACING_YAW,
  ),
  prop(
    "ithappy-slot-machine-02",
    "Slot Machine (Alt)",
    `${casinoRoot}/Slot_Machine_02.glb`,
    "electronics",
    1.0,
    [96, 96],
    FACING_YAW,
  ),
  prop(
    "ithappy-slot-machine-aquarium",
    "Slot Machine Aquarium",
    `${casinoRoot}/Slot_Machine_Aquarium_01.glb`,
    "electronics",
    1.0,
    [96, 96],
    FACING_YAW,
  ),

  // Seating
  prop(
    "ithappy-casino-armchair-02",
    "Casino Armchair",
    `${casinoRoot}/Armchair_02.glb`,
    "seating",
    1.0,
    [108, 96],
    FACING_YAW,
  ),
  prop(
    "ithappy-casino-chair-06",
    "Casino Chair",
    `${casinoRoot}/Chair_06.glb`,
    "seating",
    1.0,
    [72, 84],
    FACING_YAW,
  ),
  prop(
    "ithappy-casino-chair-office",
    "Office Chair",
    `${casinoRoot}/Chair_Office_01.glb`,
    "seating",
    1.0,
    [72, 72],
    FACING_YAW,
  ),
  prop(
    "ithappy-casino-couch-05",
    "Casino Couch",
    `${casinoRoot}/Couch_05.glb`,
    "seating",
    1.0,
    [180, 96],
    FACING_YAW,
  ),

  // ATMs & cash machines
  prop(
    "ithappy-casino-atm-01",
    "ATM",
    `${casinoRoot}/ATM_01.glb`,
    "storage",
    1.0,
    [84, 108],
    FACING_YAW,
  ),
  prop(
    "ithappy-casino-atm-03",
    "ATM (Wall)",
    `${casinoRoot}/ATM_03.glb`,
    "storage",
    1.0,
    [72, 72],
    FACING_YAW,
  ),
  prop(
    "ithappy-casino-cash-machine",
    "Cash Machine",
    `${casinoRoot}/Cash_Machine_01.glb`,
    "storage",
    1.0,
    [48, 48],
    0,
  ),
  prop(
    "ithappy-casino-safebox",
    "Safe Box",
    `${casinoRoot}/SafeBox_01.glb`,
    "storage",
    1.0,
    [96, 96],
    FACING_YAW,
  ),

  // Money & valuables
  prop(
    "ithappy-casino-cash-01",
    "Cash Stack",
    `${casinoRoot}/Cash_01.glb`,
    "other",
    1.0,
    [12, 36],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-casino-cash-02",
    "Cash Stack (Banded)",
    `${casinoRoot}/Cash_02.glb`,
    "other",
    1.0,
    [12, 24],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-casino-cash-07",
    "Cash Stack (Fan)",
    `${casinoRoot}/Cash_07.glb`,
    "other",
    1.0,
    [24, 36],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-casino-cash-10",
    "Cash Stack (Scattered)",
    `${casinoRoot}/Cash_10.glb`,
    "other",
    1.0,
    [24, 36],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-casino-cash-11",
    "Cash Stack (Thick)",
    `${casinoRoot}/Cash_11.glb`,
    "other",
    1.0,
    [12, 12],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-casino-gold-ingot-01",
    "Gold Ingot",
    `${casinoRoot}/Gold_Ingot_01.glb`,
    "other",
    1.0,
    [24, 48],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-casino-gold-ingot-02",
    "Gold Ingot (Stack)",
    `${casinoRoot}/Gold_Ingot_02.glb`,
    "other",
    1.0,
    [12, 24],
    0,
    { placeableOnTop: true },
  ),

  // Playing cards
  prop(
    "ithappy-casino-card-39",
    "Playing Card",
    `${casinoRoot}/Card_39.glb`,
    "other",
    1.0,
    [12, 24],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-casino-card-44",
    "Playing Card (Heart)",
    `${casinoRoot}/Card_44.glb`,
    "other",
    1.0,
    [12, 24],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-casino-card-48",
    "Playing Card (Diamond)",
    `${casinoRoot}/Card_48.glb`,
    "other",
    1.0,
    [12, 24],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-casino-card-53",
    "Playing Card (Spade)",
    `${casinoRoot}/Card_53.glb`,
    "other",
    1.0,
    [12, 24],
    0,
    { placeableOnTop: true },
  ),

  // Decorative
  prop(
    "ithappy-casino-column-17",
    "Column",
    `${casinoRoot}/Column_17.glb`,
    "other",
    1.0,
    [252, 252],
    0,
  ),
  prop("ithappy-casino-fence-07", "Fence", `${casinoRoot}/Fence_07.glb`, "other", 1.0, [48, 48], 0),
  prop(
    "ithappy-casino-fence-08",
    "Fence (Wall Short)",
    `${casinoRoot}/Fence_08.glb`,
    "wall-decor",
    1.0,
    [84, 36],
    0,
    { placementSurface: "wall", wallMountHeight: 48 },
  ),
  prop(
    "ithappy-casino-fence-09",
    "Fence (Wall Long)",
    `${casinoRoot}/Fence_09.glb`,
    "wall-decor",
    1.0,
    [168, 36],
    0,
    { placementSurface: "wall", wallMountHeight: 48 },
  ),
  prop(
    "ithappy-casino-floor-01",
    "Casino Floor",
    `${casinoRoot}/Floor_01.glb`,
    "other",
    1.0,
    [600, 600],
    0,
    { floorLift: 3, allowItemsOnTop: true, canOverlapFurniture: true, blocksRugOverlap: true },
  ),
  prop(
    "ithappy-casino-flower-03",
    "Casino Flower",
    `${casinoRoot}/Flower_03.glb`,
    "plants",
    1.0,
    [180, 180],
    0,
    { blocksRugOverlap: true },
  ),
  prop(
    "ithappy-casino-fruits-01",
    "Fruits Bowl",
    `${casinoRoot}/Fruits_01.glb`,
    "food",
    1.0,
    [48, 48],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-casino-lamp-05",
    "Casino Floor Lamp",
    `${casinoRoot}/Lamp_05.glb`,
    "lighting",
    1.0,
    [84, 84],
    0,
  ),
  prop(
    "ithappy-casino-neon-sign",
    "Neon Sign",
    `${casinoRoot}/Neon_Sign_01.glb`,
    "wall-decor",
    1.0,
    [96, 12],
    FACING_YAW,
    { placementSurface: "wall", wallMountHeight: 96 },
  ),
  prop(
    "ithappy-casino-screens",
    "Casino Screens",
    `${casinoRoot}/Screens_01.glb`,
    "electronics",
    1.0,
    [408, 408],
    FACING_YAW,
  ),
  prop(
    "ithappy-casino-book-01",
    "Casino Book",
    `${casinoRoot}/Book_01.glb`,
    "other",
    1.0,
    [36, 48],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-casino-keyboard",
    "Keyboard",
    `${casinoRoot}/Keyboard_01.glb`,
    "electronics",
    1.0,
    [60, 24],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-casino-monitor",
    "Monitor",
    `${casinoRoot}/Monitor_02.glb`,
    "electronics",
    1.0,
    [72, 24],
    0,
    { placeableOnTop: true },
  ),
  prop(
    "ithappy-casino-mouse",
    "Mouse",
    `${casinoRoot}/Mouse_01.glb`,
    "electronics",
    1.0,
    [12, 24],
    0,
    { placeableOnTop: true },
  ),
];

// --- Foliage (Cartoon City pack) --------------------------------------------
const foliageProps: InteriorPropAsset[] = [
  prop("ithappy-bush-06", "Bush", `${foliageRoot}/Bush_06.glb`, "plants", 1.0, [168, 168], 0, {
    blocksRugOverlap: true,
  }),
  prop(
    "ithappy-bush-07",
    "Bush (Round)",
    `${foliageRoot}/Bush_07.glb`,
    "plants",
    1.0,
    [168, 168],
    0,
    { blocksRugOverlap: true },
  ),
  prop(
    "ithappy-bush-10",
    "Bush (Wide)",
    `${foliageRoot}/Bush_10.glb`,
    "plants",
    1.0,
    [204, 108],
    0,
    { blocksRugOverlap: true },
  ),
  prop("ithappy-palm-03", "Palm Tree", `${foliageRoot}/Palm_03.glb`, "plants", 1.0, [60, 60], 0, {
    blocksRugOverlap: true,
  }),
];

export const ithappyInteriorPropAssets: readonly InteriorPropAsset[] = [
  ...furnitureProps,
  ...foodProps,
  ...casinoProps,
  ...foliageProps,
];

// Also export as PropManifest[] for the sync script and runtime loader.
export const ithappyPropAssets: readonly PropManifest[] = ithappyInteriorPropAssets.map((a) => ({
  id: a.id,
  label: a.label,
  assetUrl: a.assetUrl,
}));
