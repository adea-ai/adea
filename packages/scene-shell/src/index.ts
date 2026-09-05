export { SceneWrapper, type SceneWrapperProps } from "./scene-wrapper";
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
