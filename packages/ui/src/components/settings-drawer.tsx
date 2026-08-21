"use client";

import type { ReactNode } from "react";
import { Settings } from "lucide-react";
import { soundController } from "@agent-hq/audio";
import { Button } from "#components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "#components/ui/drawer";
import { CharacterSelector, type CharacterOption } from "./character-selector";
import { ThemeToggle } from "./theme-toggle";

export type SettingsDrawerProps = {
  characterOptions: readonly CharacterOption[];
  character: string;
  onCharacterChange: (character: string) => void;
  children?: ReactNode;
};

export function SettingsDrawer({
  characterOptions,
  character,
  onCharacterChange,
  children,
}: SettingsDrawerProps) {
  return (
    <div className="fixed right-4 top-4 z-40">
      <Drawer swipeDirection="right">
        <DrawerTrigger
          render={
            <Button
              variant="outline"
              size="icon-lg"
              aria-label="Open settings"
              onClick={() => soundController.playSfx("uiClick")}
            />
          }
        >
          <Settings className="size-5" aria-hidden="true" />
        </DrawerTrigger>
        <DrawerContent className="w-[min(24rem,90vw)]">
          <DrawerHeader className="border-b px-5 pb-4 pt-5 text-left">
            <div className="relative">
              <DrawerTitle className="pr-14">World settings</DrawerTitle>
              <ThemeToggle className="absolute right-0 top-1/2 -translate-y-1/2" />
            </div>
          </DrawerHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
            <section className="space-y-3" aria-labelledby="character-setting-title">
              <div>
                <h2 id="character-setting-title" className="text-sm font-semibold">
                  Character
                </h2>
                <p className="text-sm text-muted-foreground">
                  Select the character for this scene.
                </p>
              </div>
              <CharacterSelector
                options={characterOptions}
                value={character}
                onValueChange={onCharacterChange}
              />
            </section>
            {children}
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
