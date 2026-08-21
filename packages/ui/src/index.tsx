import type { ReactNode } from "react";

export { Button, buttonVariants } from "./components/ui/button";
export { Switch } from "./components/ui/switch";
export { RadioGroup, RadioGroupItem } from "./components/ui/radio-group";
export { ThemeToggle } from "./components/theme-toggle";
export { ThemeProvider } from "./components/theme-provider";
export { FullscreenButton } from "./components/fullscreen-button";
export {
  GameTouchControls,
  type GameTouchAction,
  type GameTouchLayout,
} from "./components/game-touch-controls";
export { GameShell, type GameShellProps } from "./components/game-shell";
export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerSwipeHandle,
  DrawerTitle,
  DrawerTrigger,
} from "./components/ui/drawer";
export {
  CharacterSelector,
  type CharacterOption,
  type CharacterSelectorProps,
} from "./components/character-selector";
export { MapSelector, type MapSelectorProps } from "./components/map-selector";
export { gameMapOptions, sceneMapOptions, type SceneMapOption } from "./lib/scene-maps";
export { SettingsDrawer, type SettingsDrawerProps } from "./components/settings-drawer";
export { OnScreenControls } from "./components/on-screen-controls";
export { SceneSettings, type SceneSettingsProps } from "./components/scene-settings";
export { Card, CardContent } from "./components/ui/card";
export {
  PropCatalog,
  defaultPropCatalogCategories,
  getSharedLoader,
  type PropCatalogCategory,
  type PropCatalogItem,
  type PropCatalogProps,
} from "./components/prop-catalog";
export { cn } from "./lib/utils";

export function SceneLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href}>{children}</a>;
}
