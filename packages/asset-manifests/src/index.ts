export type SceneKind = "world" | "minigame";

export type SceneAvailability = "ready" | "planned";

export type SceneZone = {
  id: string;
  assetUrl: string;
  /** Optional collision layer that follows this visual zone. */
  collisionAssetUrl?: string;
  /** Additional visual layers that load and unload with this zone. */
  assetUrls?: readonly string[];
  /** Exact-triangle field colliders that load and unload with this zone. */
  collisionAssetUrls?: readonly string[];
  /** Whether scene-level ambient traffic should be active in this zone. */
  ambientTraffic?: boolean;
  /** Whether scene-level flyers/helicopters should be active in this zone. */
  ambientFlyers?: boolean;
  preload?: boolean;
  /** Load the zone automatically when the player enters this radius. */
  preloadDistance?: number;
  /** Optional transform for a model authored in local building space. */
  transform?: {
    position?: readonly [number, number, number];
    quaternion?: readonly [number, number, number, number];
    scale?: readonly [number, number, number];
  };
};

export type SceneStartPosition = {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
  /** Keep an authored start height instead of snapping to the first ray hit. */
  snapToGround?: boolean;
};

export type StaticFieldAssetUrls = {
  foliage?: string;
  vehicles?: string;
  buildings?: string;
  props?: string;
};

export type SceneManifest = {
  id: string;
  label: string;
  kind: SceneKind;
  availability?: SceneAvailability;
  entryAssetUrl: string;
  /** Optional id for making the initially loaded asset unloadable as a zone. */
  entryZoneId?: string;
  /** Keep the entry collision layer active while visual zones transition. */
  preserveEntryCollision?: boolean;
  collisionAssetUrl?: string;
  /** Additional collision layers kept active for multi-level scenes. */
  additionalCollisionAssetUrls?: readonly string[];
  additionalAssetUrls?: readonly string[];
  zones?: SceneZone[];
  startPosition?: SceneStartPosition;
  /** Build-generated instanced fields for static scenes (preferred over runtime manifests). */
  staticFieldAssetUrls?: StaticFieldAssetUrls;
  /** Render-free exact-triangle companions for the generated static fields. */
  staticFieldCollisionAssetUrls?: StaticFieldAssetUrls;
  /** Optional foliage placement manifest (instanced from the foliage catalog at runtime). */
  foliageManifestUrl?: string;
  /** Optional static-vehicle placement manifest (instanced from the vehicle catalog at runtime). */
  vehiclesManifestUrl?: string;
  /** Optional buildings placement manifest (repeated blocks instanced from the buildings catalog at runtime). */
  buildingsManifestUrl?: string;
  /** Optional props placement manifest (instanced from the props catalog at runtime). */
  propsManifestUrl?: string;
  /** Public URL for persisted authored-object editor overrides. */
  editorOverridesUrl?: string;
  /** Optional repository-relative source path for persisted overrides. */
  editorOverridesSourcePath?: string;
  /** Optional repository-relative public copy path for persisted overrides. */
  editorOverridesPublicPath?: string;
};
