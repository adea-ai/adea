export { SceneWrapper, type SceneWrapperProps } from "./scene-wrapper";
export type { CharacterDesignerSceneProps } from "./character-designer-scene";
// CharacterDesigner is loaded by SceneWrapper only when enabled. Keep its
// public types available without pulling its implementation into consumers.
export type { CharacterDesignerProps, CharacterDesignerValue } from "./character-designer";
// RoomDesigner and SceneEditor are loaded by SceneWrapper only when enabled.
// Keep their public types available without pulling their implementation into
// every consumer of the shell entry point.
export type {
  RoomDesignerAsset,
  RoomDesignerPlacement,
  RoomDesignerProps,
  RoomDesignerRect,
} from "./room-designer";
export type { PropCollidersProps } from "./prop-colliders";
export { Portals, type PortalLink, type PortalsProps } from "./portals";
export {
  appRouteHref,
  encodeSceneStartPosition,
  portalNavigationHref,
  readSceneStartPosition,
  type PortalNavigation,
  type SceneApp,
} from "./scene-spawn";
