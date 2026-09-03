"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { Button } from "@agent-hq/ui/components/ui/button";
import { OnScreenControls } from "@agent-hq/ui/components/on-screen-controls";
import { SceneSettings } from "@agent-hq/ui/components/scene-settings";
import { Spinner } from "@agent-hq/ui/components/ui/spinner";
import type { CharacterOption } from "@agent-hq/ui/components/character-selector";
import type {
  CameraBounds,
  CameraViewMode,
  CharacterScale,
  CollisionExclusionArea,
  PlayerVisibilityGroup,
  SceneDebugApi,
  SceneEnvironmentConfig,
  SceneMaterialOverride,
  SceneVisualSetup,
  SceneVisualUpdate,
  SceneWaterVolume,
  StaticColliderConfig,
} from "@agent-hq/scene-runtime";
import type { SceneManifest, SceneStartPosition } from "@agent-hq/asset-manifests";
import type { CharacterConfiguration, CharacterPartOption } from "@agent-hq/characters";
import { Portals, type PortalLink } from "./portals";
import { PropColliders } from "./prop-colliders";
import type { RoomDesignerAsset, RoomDesignerRect } from "./room-designer";

const SceneHost = dynamic(
  () => import("@agent-hq/scene-runtime").then((module) => module.SceneHost),
  { ssr: false },
);

const SceneEditor = dynamic(() => import("./scene-editor").then((module) => module.SceneEditor), {
  ssr: false,
});
const RoomDesigner = dynamic(
  () => import("./room-designer").then((module) => module.RoomDesigner),
  { ssr: false },
);
const CharacterDesignerScene = dynamic(
  () =>
    import("@agent-hq/character-designer-scene").then(
      (module) => module.CharacterDesignerScene,
    ),
  { ssr: false },
);
const EMPTY_LOCKED_OBJECT_PREFIXES: readonly string[] = [];

function DevelopmentSceneEditor({
  manifest,
  debugApiRef,
  cameraViewMode,
  selectionMode,
  lockedObjectPrefixes,
  enabled,
}: {
  manifest: SceneManifest;
  debugApiRef: MutableRefObject<SceneDebugApi | null>;
  cameraViewMode: CameraViewMode;
  selectionMode: "objects" | "zones";
  lockedObjectPrefixes: readonly string[];
  enabled: boolean;
}) {
  return enabled && cameraViewMode === "perspective" && SceneEditor ? (
    <SceneEditor
      manifest={manifest}
      debugApiRef={debugApiRef}
      cameraViewMode={cameraViewMode}
      selectionMode={selectionMode}
      lockedObjectPrefixes={lockedObjectPrefixes}
    />
  ) : null;
}

export type SceneWrapperProps = {
  manifest: SceneManifest;
  /** Size the scene to a containing application shell rather than the full window. */
  viewportMode?: "window" | "container";
  /** Optional URL-provided arrival position, overriding the manifest start. */
  startPosition?: SceneStartPosition;
  character: string;
  onCharacterChange: (character: string) => void;
  characterOptions: readonly CharacterOption[];
  characterConfiguration?: CharacterConfiguration;
  onCharacterConfigurationChange?: (configuration: CharacterConfiguration) => void;
  onCharacterConfigurationReset?: () => void;
  onCharacterSave?: (value: {
    character: string;
    configuration?: CharacterConfiguration;
  }) => void | boolean | Promise<void | boolean>;
  characterPartOptions?: readonly CharacterPartOption[];
  characterScale?: CharacterScale;
  /** Uniform authored-world scale applied to visuals, physics, navigation, and camera framing. */
  sceneScale?: number;
  /** Multiplier for keyboard/click movement in the active camera mode. */
  movementSpeedFactor?: number;
  /** Enable point-and-click movement for scenes with a top-down map. */
  enableClickNavigation?: boolean;
  /** Optional walkable map bounds for click navigation, expressed in world units. */
  clickNavigationBounds?: { xMin: number; xMax: number; zMin: number; zMax: number };
  /** World-space scale for the click destination ring. Defaults to 1. */
  clickNavigationIndicatorScale?: number;
  /** Keep the camera inside a scene's authored map envelope. */
  cameraBounds?: CameraBounds;
  /** In orthographic mode, make this scene click-only and hide touch controls. */
  orthographicClickOnly?: boolean;
  /** Capture normal-view wheel and trackpad gestures for camera zoom. */
  cameraWheelZoomEnabled?: boolean;
  /** Optional movement multiplier used only by orthographic click navigation. */
  orthographicMovementSpeedFactor?: number;
  /** Scene-specific orthographic framing; defaults preserve existing views. */
  orthographicHalfHeight?: number;
  /** Scene-specific orthographic pitch in radians; defaults preserve existing views. */
  orthographicPitch?: number;
  /** Initial authored-world pan applied only to the orthographic camera target. */
  orthographicPan?: { x: number; z: number };
  /** Override the perspective camera follow distance for scenes with a
   *  miniature environment scale so the character and room are both visible. */
  perspectiveCameraDistance?: number;
  /** Explicit water volumes for authored pools whose meshes are not flat sheets. */
  waterVolumes?: readonly SceneWaterVolume[];
  cameraViewMode?: CameraViewMode;
  /** Notify the host shell when the imperative runtime changes camera mode. */
  onCameraViewModeChange?: (viewMode: CameraViewMode) => void;
  /** Hide the projection switch for scenes with a fixed camera. */
  allowCameraViewModeChange?: boolean;
  /** Explicitly register the scene editor for apps that need it outside the shared dev default. */
  sceneEditorAvailable?: boolean;
  /** Select whole streamed zones instead of individual meshes in the editor. */
  sceneEditorSelectionMode?: "objects" | "zones";
  /** Optional structural object prefixes that remain locked in the editor. */
  sceneEditorLockedObjectPrefixes?: readonly string[];
  /** Defer nonessential character animation and facial assets until playable. */
  deferCharacterDetails?: boolean;
  /** Whether deferred character details should be fetched automatically. */
  loadDeferredCharacterDetails?: boolean;
  characterGroundOffset?: number;
  /** Keep every loaded zone collision active for room-based maps. */
  keepZoneCollisionsActive?: boolean;
  staticColliders?: readonly StaticColliderConfig[];
  collisionIncludePatterns?: readonly RegExp[];
  staticFieldCollisionPatterns?: readonly RegExp[];
  /** Whether additional visual fields should also participate in physics. */
  collideAdditionalVisualLayers?: boolean;
  collisionExclusionAreas?: readonly CollisionExclusionArea[];
  coplanarMaterialMeshNames?: readonly string[];
  materialOverrides?: readonly SceneMaterialOverride[];
  playerVisibilityGroups?: readonly PlayerVisibilityGroup[];
  environment?: SceneEnvironmentConfig;
  visualSetup?: SceneVisualSetup;
  visualUpdate?: SceneVisualUpdate;
  portals?: readonly PortalLink[];
  enableSceneEditor?: boolean;
  /** DOM target for the account drawer trigger in an app shell toolbar. */
  accountTargetId?: string;
  accountLabel?: string;
  accountAuthenticated?: boolean;
  accountBusy?: boolean;
  accountMusicControl?: ReactNode;
  onAccountSignIn?: () => void;
  onAccountSignOut?: () => void;
  showAccountDrawer?: boolean;
  /** DOM target for the compact camera controls in an app shell toolbar. */
  cameraTargetId?: string;
  /** DOM target for the shared room designer trigger when an app supplies a shell toolbar. */
  roomDesignerTargetId?: string;
  /** DOM target for the standalone character designer trigger. */
  characterDesignerTargetId?: string;
  /** DOM target for the development scene editor trigger when an app supplies a shell toolbar. */
  sceneEditorTargetId?: string;
  /** Register the standalone character designer for apps with character parts. */
  characterDesignerAvailable?: boolean;
  enableCharacterDesigner?: boolean;
  /** Register the top-down room designer for apps with authored room maps. */
  roomDesignerAvailable?: boolean;
  enableRoomDesigner?: boolean;
  roomDesignerSceneScale?: number;
  roomDesignerGroundY?: number;
  roomDesignerGridSize?: number;
  roomDesignerMapBounds?: RoomDesignerRect;
  roomDesignerRegions?: readonly RoomDesignerRect[];
  roomDesignerBlockedRects?: readonly RoomDesignerRect[];
  roomDesignerDoorwayRects?: readonly RoomDesignerRect[];
  roomDesignerCatalog?: readonly RoomDesignerAsset[];
  roomDesignerNormalOrthographicHalfHeight?: number;
  roomDesignerDesignOrthographicHalfHeight?: number;
  roomDesignerBackdropColor?: number;
  roomDesignerBackdropPadding?: number;
  /** Authored position to use while the designer is open. */
  roomDesignerPlayerPosition?: { x: number; z: number };
  /** Enable physics colliders for room designer props. In orthographic mode,
   *  lightweight box colliders are built from footprints; in perspective mode,
   *  trimesh colliders are built from the visual mesh geometry. */
  enablePropColliders?: boolean;
  /** Increments when the room designer saves a new layout, so prop colliders
   *  can be rebuilt from the updated props.json. */
  propCollidersVersion?: number;
  /** Called when the scene's debug API becomes available (initial mount and
   *  after each scene recreation, e.g. character switch). Lets callers hook
   *  into the physics world for custom collision queries. */
  onDebugApiReady?: (api: SceneDebugApi) => void;
};

const DEFAULT_CHARACTER_SCALE: CharacterScale = {
  height: 1.35,
  radius: 0.18,
  modelScale: 0.3,
};

/**
 * Standard scene shell shared by every 3D scene: SceneHost, on-screen touch
 * controls, teleport booths, walk-in portals, and compact toolbar controls.
 * Each scene supplies its manifest + character plumbing; everything else is
 * uniform so no scene can drift and lose core controls.
 */
export function SceneWrapper({
  manifest,
  viewportMode = "window",
  startPosition,
  character,
  onCharacterChange,
  characterOptions,
  characterConfiguration,
  onCharacterConfigurationChange,
  onCharacterConfigurationReset,
  onCharacterSave,
  characterPartOptions,
  characterScale = DEFAULT_CHARACTER_SCALE,
  sceneScale = 1,
  movementSpeedFactor = 1,
  enableClickNavigation = false,
  clickNavigationBounds,
  clickNavigationIndicatorScale,
  cameraBounds,
  orthographicClickOnly = false,
  cameraWheelZoomEnabled = true,
  orthographicMovementSpeedFactor,
  orthographicHalfHeight,
  orthographicPitch,
  orthographicPan,
  perspectiveCameraDistance,
  waterVolumes,
  cameraViewMode = "perspective",
  onCameraViewModeChange: onCameraViewModeChangeProp,
  allowCameraViewModeChange = true,
  sceneEditorAvailable = process.env.NODE_ENV === "development",
  sceneEditorSelectionMode = "objects",
  sceneEditorLockedObjectPrefixes = EMPTY_LOCKED_OBJECT_PREFIXES,
  deferCharacterDetails,
  loadDeferredCharacterDetails,
  characterGroundOffset,
  keepZoneCollisionsActive = false,
  staticColliders,
  collisionIncludePatterns,
  staticFieldCollisionPatterns,
  collideAdditionalVisualLayers,
  collisionExclusionAreas,
  coplanarMaterialMeshNames,
  materialOverrides,
  playerVisibilityGroups,
  environment,
  visualSetup,
  visualUpdate,
  portals,
  enableSceneEditor = true,
  accountTargetId,
  accountLabel,
  accountAuthenticated,
  accountBusy,
  accountMusicControl,
  onAccountSignIn,
  onAccountSignOut,
  showAccountDrawer,
  cameraTargetId,
  roomDesignerTargetId,
  characterDesignerTargetId,
  sceneEditorTargetId,
  characterDesignerAvailable = false,
  enableCharacterDesigner = false,
  roomDesignerAvailable = false,
  enableRoomDesigner = false,
  roomDesignerSceneScale = sceneScale,
  roomDesignerGroundY = 0,
  roomDesignerGridSize = 100,
  roomDesignerMapBounds,
  roomDesignerRegions = [],
  roomDesignerBlockedRects = [],
  roomDesignerDoorwayRects = [],
  roomDesignerCatalog = [],
  roomDesignerNormalOrthographicHalfHeight = orthographicHalfHeight ?? 720,
  roomDesignerDesignOrthographicHalfHeight = roomDesignerNormalOrthographicHalfHeight * 1.16,
  roomDesignerBackdropColor,
  roomDesignerBackdropPadding = 360,
  roomDesignerPlayerPosition,
  enablePropColliders = false,
  propCollidersVersion = 0,
  onDebugApiReady,
}: SceneWrapperProps) {
  const canUseSceneEditor = enableSceneEditor && sceneEditorAvailable;
  const [lazyCharacterPartOptions, setLazyCharacterPartOptions] = useState<
    readonly CharacterPartOption[]
  >([]);
  const effectiveCharacterPartOptions = characterPartOptions ?? lazyCharacterPartOptions;
  const canUseCharacterDesigner =
    enableCharacterDesigner &&
    characterDesignerAvailable &&
    Boolean(onCharacterConfigurationChange);
  const canUseRoomDesigner =
    enableRoomDesigner && roomDesignerAvailable && Boolean(roomDesignerMapBounds);
  const debugApiRef = useRef<SceneDebugApi | null>(null);
  // Allow the camera view mode to be persisted via the `camera` query param
  // so navigating to a scene link or refreshing preserves the user's choice.
  const queryCameraViewMode =
    typeof window !== "undefined"
      ? (new URLSearchParams(window.location.search).get("camera") as CameraViewMode | null)
      : null;
  const effectiveCameraViewMode: CameraViewMode = queryCameraViewMode ?? cameraViewMode;
  const cameraViewModeRef = useRef<CameraViewMode>(effectiveCameraViewMode);
  const [activeCameraViewMode, setActiveCameraViewMode] =
    useState<CameraViewMode>(effectiveCameraViewMode);
  const [sceneReady, setSceneReady] = useState(false);
  const handleSceneLoadingStart = useCallback(() => setSceneReady(false), []);
  const handleSceneReady = useCallback(() => setSceneReady(true), []);

  useEffect(() => {
    setSceneReady(false);
  }, [manifest.id]);

  useEffect(() => {
    if (queryCameraViewMode || cameraViewModeRef.current === cameraViewMode) return;
    cameraViewModeRef.current = cameraViewMode;
    setActiveCameraViewMode(cameraViewMode);
    debugApiRef.current?.setCameraViewMode(cameraViewMode);
  }, [cameraViewMode, queryCameraViewMode]);

  const [sceneEditorEnabled, setSceneEditorEnabled] = useState(false);
  const [characterDesignerEnabled, setCharacterDesignerEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    const value = new URLSearchParams(window.location.search).get("characterDesigner");
    return value !== null && value !== "0";
  });
  const [characterDesignerHasEdits, setCharacterDesignerHasEdits] = useState(false);
  const [pendingCharacterDesignerClose, setPendingCharacterDesignerClose] = useState<{
    href?: string;
  } | null>(null);
  const characterDesignerSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const characterDesignerNavigationAllowedRef = useRef(false);
  const [roomDesignerEnabled, setRoomDesignerEnabled] = useState(false);
  const [roomDesignerHasEdits, setRoomDesignerHasEdits] = useState(false);
  const [pendingRoomDesignerClose, setPendingRoomDesignerClose] = useState<{
    href?: string;
    cameraViewMode?: CameraViewMode;
  } | null>(null);
  const roomDesignerSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  // Bump prop colliders version when the room designer's dirty flag clears
  // after a save (hasEdits goes true→false while the designer is open).
  const prevHasEditsRef = useRef(false);
  const [internalPropCollidersVersion, setInternalPropCollidersVersion] = useState(0);
  useEffect(() => {
    if (prevHasEditsRef.current && !roomDesignerHasEdits && roomDesignerEnabled) {
      setInternalPropCollidersVersion((v) => v + 1);
    }
    prevHasEditsRef.current = roomDesignerHasEdits;
  }, [roomDesignerHasEdits, roomDesignerEnabled]);
  const [sceneVersion, setSceneVersion] = useState(0);
  const handleDebugApiReady = useCallback(
    (api: SceneDebugApi) => {
      onDebugApiReady?.(api);
      if (enablePropColliders || canUseRoomDesigner) {
        setSceneVersion((version) => version + 1);
      }
    },
    [canUseRoomDesigner, enablePropColliders, onDebugApiReady],
  );

  useEffect(() => {
    if (!canUseSceneEditor) return;
    const value = new URLSearchParams(window.location.search).get("sceneEditor");
    // The editor is opt-in. A missing query parameter must never cover the
    // scene unless the explicit query parameter opts in.
    setSceneEditorEnabled(value !== null && value !== "0");
  }, [canUseSceneEditor]);

  useEffect(() => {
    if (!canUseCharacterDesigner) return;
    const value = new URLSearchParams(window.location.search).get("characterDesigner");
    setCharacterDesignerEnabled(value !== null && value !== "0");
  }, [canUseCharacterDesigner]);

  useEffect(() => {
    if (!canUseCharacterDesigner || !characterDesignerEnabled || characterPartOptions) return;
    let cancelled = false;
    void import("@agent-hq/characters").then(({ characterPartCatalog }) => {
      if (!cancelled) setLazyCharacterPartOptions(characterPartCatalog);
    });
    return () => {
      cancelled = true;
    };
  }, [canUseCharacterDesigner, characterDesignerEnabled, characterPartOptions]);

  useEffect(() => {
    if (!canUseRoomDesigner) return;
    const value = new URLSearchParams(window.location.search).get("roomDesigner");
    setRoomDesignerEnabled(value !== null && value !== "0");
  }, [canUseRoomDesigner]);

  const applyCharacterDesignerChange = (enabled: boolean) => {
    setCharacterDesignerEnabled(enabled);
    const nextUrl = new URL(window.location.href);
    if (enabled) nextUrl.searchParams.set("characterDesigner", "");
    else nextUrl.searchParams.set("characterDesigner", "0");
    window.history.replaceState(null, "", nextUrl);
  };

  const applyRoomDesignerChange = (enabled: boolean) => {
    setRoomDesignerEnabled(enabled);
    const nextUrl = new URL(window.location.href);
    if (enabled) nextUrl.searchParams.set("roomDesigner", "");
    else nextUrl.searchParams.set("roomDesigner", "0");
    window.history.replaceState(null, "", nextUrl);
  };

  const applySceneEditorChange = (enabled: boolean) => {
    setSceneEditorEnabled(enabled);
    const nextUrl = new URL(window.location.href);
    if (enabled) nextUrl.searchParams.set("sceneEditor", "");
    else nextUrl.searchParams.set("sceneEditor", "0");
    window.history.replaceState(null, "", nextUrl);
  };

  const requestRoomDesignerClose = (
    request: { href?: string; cameraViewMode?: CameraViewMode } = {},
  ) => {
    if (roomDesignerHasEdits) {
      setPendingRoomDesignerClose(request);
      return;
    }
    if (request.cameraViewMode) {
      setActiveCameraViewMode(request.cameraViewMode);
      cameraViewModeRef.current = request.cameraViewMode;
      debugApiRef.current?.setCameraViewMode(request.cameraViewMode);
      onCameraViewModeChangeProp?.(request.cameraViewMode);
      applyRoomDesignerChange(false);
    } else if (request.href) {
      window.location.assign(request.href);
    } else {
      applyRoomDesignerChange(false);
    }
  };

  const requestCharacterDesignerClose = (options: { skipPrompt?: boolean } = {}) => {
    if (!options.skipPrompt && characterDesignerHasEdits) {
      setPendingCharacterDesignerClose({});
      return;
    }
    applyCharacterDesignerChange(false);
  };

  const onCharacterDesignerChange = (enabled: boolean) => {
    if (!enabled) {
      requestCharacterDesignerClose();
      return;
    }
    if (roomDesignerEnabled) {
      if (roomDesignerHasEdits) {
        requestRoomDesignerClose();
        return;
      }
      applyRoomDesignerChange(false);
    }
    applyCharacterDesignerChange(true);
  };

  const onRoomDesignerChange = (enabled: boolean) => {
    if (!enabled) {
      requestRoomDesignerClose();
      return;
    }
    if (characterDesignerEnabled) {
      if (characterDesignerHasEdits) {
        requestCharacterDesignerClose();
        return;
      }
      applyCharacterDesignerChange(false);
    }
    applyRoomDesignerChange(true);
  };

  useEffect(() => {
    if (!pendingCharacterDesignerClose) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPendingCharacterDesignerClose(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pendingCharacterDesignerClose]);

  useEffect(() => {
    if (!characterDesignerEnabled || !characterDesignerHasEdits) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (characterDesignerNavigationAllowedRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        target.closest('[data-character-designer-modal], [aria-label="Character designer"]')
      )
        return;
      const link = target.closest("a");
      if (!link || !link.href || link.target === "_blank" || link.href === window.location.href)
        return;
      event.preventDefault();
      event.stopPropagation();
      setPendingCharacterDesignerClose({ href: link.href });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onDocumentClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onDocumentClick, true);
    };
  }, [characterDesignerEnabled, characterDesignerHasEdits]);

  useEffect(() => {
    if (!roomDesignerEnabled || !roomDesignerHasEdits) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        target.closest('[data-room-designer-modal], [aria-label="Room designer"]')
      )
        return;
      const link = target.closest("a");
      if (!link || !link.href || link.target === "_blank" || link.href === window.location.href)
        return;
      event.preventDefault();
      event.stopPropagation();
      setPendingRoomDesignerClose({ href: link.href });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onDocumentClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onDocumentClick, true);
    };
  }, [roomDesignerEnabled, roomDesignerHasEdits]);

  useEffect(() => {
    if (!enableClickNavigation || !canUseRoomDesigner) return;
    const navigationEnabled = !(roomDesignerEnabled && activeCameraViewMode === "orthographic");
    let frame = 0;
    const apply = () => {
      const api = debugApiRef.current;
      if (api) {
        api.setClickNavigationEnabled(navigationEnabled);
        return;
      }
      frame = requestAnimationFrame(apply);
    };
    apply();
    return () => cancelAnimationFrame(frame);
  }, [activeCameraViewMode, canUseRoomDesigner, enableClickNavigation, roomDesignerEnabled]);

  const onCameraViewModeChange = (nextViewMode: CameraViewMode) => {
    if (nextViewMode !== "orthographic" && roomDesignerEnabled) {
      requestRoomDesignerClose({ cameraViewMode: nextViewMode });
      if (roomDesignerHasEdits) return;
    }
    setActiveCameraViewMode(nextViewMode);
    cameraViewModeRef.current = nextViewMode;
    debugApiRef.current?.setCameraViewMode(nextViewMode);
    // Persist the camera view mode in the URL so it survives refresh and
    // scene-to-scene navigation via shared links.
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("camera", nextViewMode);
    window.history.replaceState(null, "", nextUrl);
    onCameraViewModeChangeProp?.(nextViewMode);
  };

  const zoomIn = useCallback(() => {
    if (roomDesignerEnabled) return;
    if (activeCameraViewMode === "perspective") {
      debugApiRef.current?.adjustPerspectiveZoom(0.15);
    } else {
      debugApiRef.current?.adjustOrthographicZoom(0.15);
    }
  }, [activeCameraViewMode, roomDesignerEnabled]);
  const zoomOut = useCallback(() => {
    if (roomDesignerEnabled) return;
    if (activeCameraViewMode === "perspective") {
      debugApiRef.current?.adjustPerspectiveZoom(-0.15);
    } else {
      debugApiRef.current?.adjustOrthographicZoom(-0.15);
    }
  }, [activeCameraViewMode, roomDesignerEnabled]);

  const characterDesignerIsActive = canUseCharacterDesigner && characterDesignerEnabled;
  const showNormalZoomControls = !roomDesignerEnabled;
  const showOnScreenControls =
    !orthographicClickOnly || activeCameraViewMode !== "orthographic" || showNormalZoomControls;

  return (
    <>
      {!characterDesignerIsActive ? (
      <SceneHost
        label={manifest.label}
        viewportMode={viewportMode}
        characterId={character}
        characterConfiguration={characterConfiguration}
        assetUrl={manifest.entryAssetUrl}
        entryZoneId={manifest.entryZoneId}
        preserveEntryCollision={manifest.preserveEntryCollision}
        keepZoneCollisionsActive={keepZoneCollisionsActive}
        collisionAssetUrl={manifest.collisionAssetUrl}
        additionalCollisionAssetUrls={manifest.additionalCollisionAssetUrls}
        additionalAssetUrls={manifest.additionalAssetUrls}
        zones={manifest.zones}
        startPosition={startPosition ?? manifest.startPosition}
        characterScale={characterScale}
        sceneScale={sceneScale}
        movementSpeedFactor={movementSpeedFactor}
        // Keep the SceneHost mounted while Room Designer toggles. The shared
        // runtime receives the designer's navigation mode through its debug
        // API below instead of tearing down the whole scene.
        enableClickNavigation={enableClickNavigation}
        clickNavigationBounds={clickNavigationBounds}
        clickNavigationIndicatorScale={clickNavigationIndicatorScale}
        cameraBounds={cameraBounds}
        orthographicClickOnly={orthographicClickOnly}
        cameraWheelZoomEnabled={cameraWheelZoomEnabled && !roomDesignerEnabled}
        orthographicMovementSpeedFactor={orthographicMovementSpeedFactor}
        orthographicHalfHeight={orthographicHalfHeight}
        orthographicPitch={orthographicPitch}
        orthographicPan={orthographicPan}
        perspectiveCameraDistance={perspectiveCameraDistance}
        waterVolumes={waterVolumes}
        initialCameraViewMode={effectiveCameraViewMode}
        cameraViewModeRef={cameraViewModeRef}
        deferCharacterDetails={deferCharacterDetails}
        loadDeferredCharacterDetails={loadDeferredCharacterDetails}
        characterGroundOffset={characterGroundOffset}
        debugApiRef={debugApiRef}
        onDebugApiReady={handleDebugApiReady}
        staticColliders={staticColliders}
        collisionIncludePatterns={collisionIncludePatterns}
        staticFieldCollisionPatterns={staticFieldCollisionPatterns}
        collideAdditionalVisualLayers={collideAdditionalVisualLayers}
        collisionExclusionAreas={collisionExclusionAreas}
        coplanarMaterialMeshNames={coplanarMaterialMeshNames}
        materialOverrides={materialOverrides}
        playerVisibilityGroups={playerVisibilityGroups}
        environment={environment}
        editorOverridesUrl={
          manifest.editorOverridesUrl ?? `/assets/worlds/${manifest.id}/editor-overrides.json`
        }
        visualSetup={visualSetup}
        visualUpdate={visualUpdate}
        staticFieldAssetUrls={manifest.staticFieldAssetUrls}
        staticFieldCollisionAssetUrls={manifest.staticFieldCollisionAssetUrls}
        foliageManifestUrl={manifest.foliageManifestUrl}
        propsManifestUrl={manifest.propsManifestUrl}
        onLoadingStart={handleSceneLoadingStart}
        onReady={handleSceneReady}
      />
      ) : (
        <CharacterDesignerScene
          key={character}
          character={character}
          characterOptions={characterOptions}
          characterConfiguration={characterConfiguration}
          characterPartOptions={effectiveCharacterPartOptions}
          onCharacterChange={onCharacterChange}
          onCharacterConfigurationChange={onCharacterConfigurationChange!}
          onCharacterConfigurationReset={onCharacterConfigurationReset}
          onSave={onCharacterSave}
          onClose={requestCharacterDesignerClose}
          saveRef={characterDesignerSaveRef}
          onDirtyChange={setCharacterDesignerHasEdits}
        />
      )}
      {!characterDesignerIsActive && !sceneReady ? (
        <div
          className="pointer-events-none fixed inset-0 z-10 flex items-center justify-center"
          data-scene-loading
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2 rounded-lg border border-border bg-background/90 px-3 py-2 text-xs text-foreground shadow-lg backdrop-blur-sm">
            <Spinner className="size-4 text-primary" aria-hidden="true" />
            <span>Loading {manifest.label}</span>
          </div>
        </div>
      ) : null}
      {!characterDesignerIsActive && showOnScreenControls ? (
        <OnScreenControls
          onZoomIn={showNormalZoomControls ? zoomIn : undefined}
          onZoomOut={showNormalZoomControls ? zoomOut : undefined}
          showMovementControls={!orthographicClickOnly || activeCameraViewMode !== "orthographic"}
          showJumpControl={!orthographicClickOnly || activeCameraViewMode !== "orthographic"}
        />
      ) : null}
      {!characterDesignerIsActive && canUseSceneEditor ? (
        <DevelopmentSceneEditor
          manifest={manifest}
          debugApiRef={debugApiRef}
          cameraViewMode={activeCameraViewMode}
          selectionMode={sceneEditorSelectionMode}
          lockedObjectPrefixes={sceneEditorLockedObjectPrefixes}
          enabled={sceneEditorEnabled}
        />
      ) : null}
      {!characterDesignerIsActive && canUseRoomDesigner && roomDesignerMapBounds ? (
        <RoomDesigner
          manifest={manifest}
          debugApiRef={debugApiRef}
          enabled={roomDesignerEnabled && activeCameraViewMode === "orthographic"}
          sceneScale={roomDesignerSceneScale}
          groundY={roomDesignerGroundY}
          gridSize={roomDesignerGridSize}
          mapBounds={roomDesignerMapBounds}
          regions={roomDesignerRegions}
          blockedRects={roomDesignerBlockedRects}
          doorwayRects={roomDesignerDoorwayRects}
          catalog={roomDesignerCatalog}
          normalOrthographicHalfHeight={roomDesignerNormalOrthographicHalfHeight}
          designOrthographicHalfHeight={roomDesignerDesignOrthographicHalfHeight}
          designBackdropColor={roomDesignerBackdropColor}
          designBackdropPadding={roomDesignerBackdropPadding}
          playerPosition={roomDesignerPlayerPosition}
          sceneVersion={sceneVersion}
          onClose={() => onRoomDesignerChange(false)}
          saveRef={roomDesignerSaveRef}
          onDirtyChange={setRoomDesignerHasEdits}
        />
      ) : null}
      {!characterDesignerIsActive && enablePropColliders && roomDesignerCatalog.length > 0 ? (
        <PropColliders
          debugApiRef={debugApiRef}
          sceneId={manifest.id}
          catalog={roomDesignerCatalog}
          sceneScale={roomDesignerSceneScale ?? 1}
          groundY={roomDesignerGroundY ?? 0}
          cameraViewMode={activeCameraViewMode}
          sceneVersion={sceneVersion}
          propsVersion={propCollidersVersion + internalPropCollidersVersion}
        />
      ) : null}
      {!characterDesignerIsActive && portals ? (
        <Portals debugApiRef={debugApiRef} links={portals} />
      ) : null}
      <SceneSettings
        cameraViewMode={activeCameraViewMode}
        onCameraViewModeChange={onCameraViewModeChange}
        allowCameraViewModeChange={!characterDesignerIsActive && allowCameraViewModeChange}
        characterDesignerEnabled={
          characterDesignerIsActive
            ? undefined
            : canUseCharacterDesigner
              ? characterDesignerEnabled
              : undefined
        }
        onCharacterDesignerChange={
          characterDesignerIsActive
            ? undefined
            : canUseCharacterDesigner
              ? onCharacterDesignerChange
              : undefined
        }
        characterDesignerTargetId={characterDesignerTargetId}
        roomDesignerEnabled={
          !characterDesignerIsActive && canUseRoomDesigner && activeCameraViewMode === "orthographic"
            ? roomDesignerEnabled
            : undefined
        }
        onRoomDesignerChange={
          !characterDesignerIsActive && canUseRoomDesigner && activeCameraViewMode === "orthographic"
            ? onRoomDesignerChange
            : undefined
        }
        sceneEditorEnabled={
          !characterDesignerIsActive && canUseSceneEditor ? sceneEditorEnabled : undefined
        }
        onSceneEditorChange={
          !characterDesignerIsActive && canUseSceneEditor ? applySceneEditorChange : undefined
        }
        accountTargetId={accountTargetId}
        accountLabel={accountLabel}
        accountAuthenticated={accountAuthenticated}
        accountBusy={accountBusy}
        accountMusicControl={accountMusicControl}
        onAccountSignIn={onAccountSignIn}
        onAccountSignOut={onAccountSignOut}
        showAccountDrawer={showAccountDrawer}
        cameraTargetId={cameraTargetId}
        roomDesignerTargetId={roomDesignerTargetId}
        sceneEditorTargetId={sceneEditorTargetId}
      />
      {pendingCharacterDesignerClose ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 p-4"
          data-character-designer-modal
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="character-designer-save-dialog-title"
            className="w-full max-w-sm rounded-xl border border-border bg-background p-5 text-foreground shadow-2xl"
          >
            <h2 id="character-designer-save-dialog-title" className="text-base font-semibold">
              Save character changes?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              You have unsaved character edits. Save them before closing or leaving?
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setPendingCharacterDesignerClose(null)}
              >
                Keep editing
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  const request = pendingCharacterDesignerClose;
                  setPendingCharacterDesignerClose(null);
                  applyCharacterDesignerChange(false);
                  if (request?.href) {
                    characterDesignerNavigationAllowedRef.current = true;
                    window.location.assign(request.href);
                  }
                }}
              >
                Discard
              </Button>
              <Button
                type="button"
                className="bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400"
                onClick={async () => {
                  const saved = await characterDesignerSaveRef.current?.();
                  if (saved === false) return;
                  const request = pendingCharacterDesignerClose;
                  setPendingCharacterDesignerClose(null);
                  applyCharacterDesignerChange(false);
                  if (request?.href) {
                    characterDesignerNavigationAllowedRef.current = true;
                    window.location.assign(request.href);
                  }
                }}
              >
                Save &amp; continue
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {pendingRoomDesignerClose ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/35 p-4"
          data-room-designer-modal
        >
          <div className="w-full max-w-sm rounded-xl border border-border bg-background p-5 text-foreground shadow-2xl">
            <h2 className="text-base font-semibold">Save room changes?</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              You have unsaved room edits. Save them before closing or leaving?
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setPendingRoomDesignerClose(null)}
              >
                Keep editing
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  const request = pendingRoomDesignerClose;
                  setPendingRoomDesignerClose(null);
                  if (request.href) window.location.assign(request.href);
                  else if (request.cameraViewMode) {
                    setActiveCameraViewMode(request.cameraViewMode);
                    cameraViewModeRef.current = request.cameraViewMode;
                    debugApiRef.current?.setCameraViewMode(request.cameraViewMode);
                    onCameraViewModeChangeProp?.(request.cameraViewMode);
                    applyRoomDesignerChange(false);
                  } else applyRoomDesignerChange(false);
                }}
              >
                Discard
              </Button>
              <Button
                type="button"
                className="bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400"
                onClick={async () => {
                  const request = pendingRoomDesignerClose;
                  const saved = await roomDesignerSaveRef.current?.();
                  if (saved === false) return;
                  setPendingRoomDesignerClose(null);
                  if (request.href) window.location.assign(request.href);
                  else if (request.cameraViewMode) {
                    setActiveCameraViewMode(request.cameraViewMode);
                    cameraViewModeRef.current = request.cameraViewMode;
                    debugApiRef.current?.setCameraViewMode(request.cameraViewMode);
                    onCameraViewModeChangeProp?.(request.cameraViewMode);
                    applyRoomDesignerChange(false);
                  } else applyRoomDesignerChange(false);
                }}
              >
                Save &amp; continue
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
