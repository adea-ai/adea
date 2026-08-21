"use client";

import { type ReactNode } from "react";
import { MusicToggle, SfxToggle } from "@agent-hq/audio";
import type { CharacterOption } from "./character-selector";
import { SettingsDrawer } from "./settings-drawer";
import { MapSelector } from "./map-selector";
import { gameMapOptions, sceneMapOptions, type SceneMapOption } from "#lib/scene-maps";
import { Switch } from "#components/ui/switch";
import { Camera, Grid3X3 } from "lucide-react";
import { Button } from "#components/ui/button";

export type SceneSettingsProps = {
  characterOptions: readonly CharacterOption[];
  character: string;
  onCharacterChange: (character: string) => void;
  sceneId?: string;
  /** Whether the in-scene info/controls panel is visible (SceneHost showHud). */
  showHud: boolean;
  onShowHudChange: (value: boolean) => void;
  cameraViewMode: "perspective" | "orthographic";
  onCameraViewModeChange: (value: "perspective" | "orthographic") => void;
  allowCameraViewModeChange?: boolean;
  /** Development-only scene transform editor toggle. */
  sceneEditorEnabled?: boolean;
  onSceneEditorChange?: (value: boolean) => void;
  /** Top-down room layout and interior prop designer toggle. */
  roomDesignerEnabled?: boolean;
  onRoomDesignerChange?: (value: boolean) => void;
  mapOptions?: readonly SceneMapOption[];
  /** Show the global mini-game links in the scene drawer. */
  showGames?: boolean;
  children?: ReactNode;
};

/**
 * Global scene settings: the world settings drawer (map switcher, character
 * selector and scene info panel toggle. Every scene uses this single
 * component so no scene can drift and lose the character picker.
 */
export function SceneSettings({
  characterOptions,
  character,
  onCharacterChange,
  sceneId,
  showHud,
  onShowHudChange,
  cameraViewMode,
  onCameraViewModeChange,
  allowCameraViewModeChange = true,
  sceneEditorEnabled,
  onSceneEditorChange,
  roomDesignerEnabled,
  onRoomDesignerChange,
  mapOptions = sceneMapOptions,
  showGames = true,
  children,
}: SceneSettingsProps) {
  return (
    <>
      <SettingsDrawer
        characterOptions={characterOptions}
        character={character}
        onCharacterChange={onCharacterChange}
      >
        {sceneId ? (
          <section className="space-y-3 border-t pt-5" aria-labelledby="map-setting-title">
            <div>
              <h2 id="map-setting-title" className="text-sm font-semibold">
                Map
              </h2>
              <p className="text-sm text-muted-foreground">Transport to another scene.</p>
            </div>
            <MapSelector options={mapOptions} currentId={sceneId} />
          </section>
        ) : null}
        {sceneId && showGames ? (
          <section className="space-y-3 border-t pt-5" aria-labelledby="game-setting-title">
            <div>
              <h2 id="game-setting-title" className="text-sm font-semibold">
                Games
              </h2>
              <p className="text-sm text-muted-foreground">Play a mini-game.</p>
            </div>
            <MapSelector options={gameMapOptions} currentId={sceneId} />
          </section>
        ) : null}
        {allowCameraViewModeChange ? (
          <section className="space-y-3 border-t pt-5" aria-labelledby="camera-setting-title">
            <div>
              <div>
                <h2 id="camera-setting-title" className="text-sm font-semibold">
                  Camera
                </h2>
                <p className="text-sm text-muted-foreground">
                  Switch between{" "}
                  {cameraViewMode === "perspective" ? "third-person" : "angled top-down"} views.
                </p>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="Camera view">
                <button
                  type="button"
                  aria-pressed={cameraViewMode === "perspective"}
                  onClick={() => onCameraViewModeChange("perspective")}
                  className={`flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${cameraViewMode === "perspective" ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-muted"}`}
                >
                  <Camera className="size-4" /> Perspective
                </button>
                <button
                  type="button"
                  aria-pressed={cameraViewMode === "orthographic"}
                  onClick={() => onCameraViewModeChange("orthographic")}
                  className={`flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${cameraViewMode === "orthographic" ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-muted"}`}
                >
                  <Grid3X3 className="size-4" /> Top-down
                </button>
              </div>
            </div>
          </section>
        ) : null}
        <section className="space-y-3 border-t pt-5" aria-labelledby="sound-setting-title">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 id="sound-setting-title" className="text-sm font-semibold">
                Music
              </h2>
              <p className="text-sm text-muted-foreground">Mute the soundtrack.</p>
            </div>
            <MusicToggle />
          </div>
        </section>
        <section className="space-y-3 border-t pt-5" aria-labelledby="sfx-setting-title">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 id="sfx-setting-title" className="text-sm font-semibold">
                Sound effects
              </h2>
              <p className="text-sm text-muted-foreground">Mute jumps, hits, and UI cues.</p>
            </div>
            <SfxToggle />
          </div>
        </section>
        <section className="space-y-3 border-t pt-5" aria-labelledby="hud-setting-title">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 id="hud-setting-title" className="text-sm font-semibold">
                Scene info &amp; controls
              </h2>
              <p className="text-sm text-muted-foreground">
                Show the position readout and key hints.
              </p>
            </div>
            <Switch
              checked={showHud}
              onCheckedChange={onShowHudChange}
              aria-labelledby="hud-setting-title"
            />
          </div>
        </section>
        {sceneEditorEnabled != null && onSceneEditorChange && cameraViewMode === "perspective" ? (
          <section className="space-y-3 border-t pt-5" aria-labelledby="editor-setting-title">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 id="editor-setting-title" className="text-sm font-semibold">
                  Scene editor
                </h2>
                <p className="text-sm text-muted-foreground">
                  Move, rotate, and scale catalog placements.
                </p>
              </div>
              <Switch
                checked={sceneEditorEnabled}
                onCheckedChange={onSceneEditorChange}
                aria-labelledby="editor-setting-title"
              />
            </div>
          </section>
        ) : null}
        {children}
      </SettingsDrawer>
      {roomDesignerEnabled != null && onRoomDesignerChange && cameraViewMode === "orthographic" ? (
        <div className="fixed right-4 top-16 z-40">
          <Button
            type="button"
            variant={roomDesignerEnabled ? "default" : "outline"}
            size="icon-lg"
            aria-label={roomDesignerEnabled ? "Close room designer" : "Open room designer"}
            title={roomDesignerEnabled ? "Close room designer" : "Open room designer"}
            aria-pressed={roomDesignerEnabled}
            onClick={() => onRoomDesignerChange(!roomDesignerEnabled)}
          >
            <Grid3X3 className="size-5" aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </>
  );
}
