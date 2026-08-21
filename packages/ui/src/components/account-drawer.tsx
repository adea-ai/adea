"use client";

import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { Button } from "#components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "#components/ui/drawer";
import { CharacterSelector, type CharacterOption } from "./character-selector";

export type AccountDrawerProps = {
  characterOptions: readonly CharacterOption[];
  character: string;
  onCharacterChange: (character: string) => void;
  triggerTargetId?: string;
};

export function AccountDrawer({
  characterOptions,
  character,
  onCharacterChange,
  triggerTargetId,
}: AccountDrawerProps) {
  const [triggerTarget, setTriggerTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setTriggerTarget(triggerTargetId ? document.getElementById(triggerTargetId) : null);
  }, [triggerTargetId]);

  const trigger = (
    <DrawerTrigger
      render={
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Open account drawer"
          aria-haspopup="dialog"
        />
      }
    >
      <UserRound aria-hidden="true" />
    </DrawerTrigger>
  );

  return (
    <Drawer swipeDirection="right">
      {triggerTarget ? (
        createPortal(trigger, triggerTarget)
      ) : (
        <div className="fixed right-4 top-4 z-40">{trigger}</div>
      )}
      <DrawerContent className="w-[min(24rem,90vw)]">
        <DrawerHeader className="border-b px-5 pb-4 pt-5 text-left">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <UserRound className="size-5" aria-hidden="true" />
            </span>
            <div>
              <DrawerTitle>Account</DrawerTitle>
              <DrawerDescription>Guest operator · workspace access online</DrawerDescription>
            </div>
          </div>
        </DrawerHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
          <section className="space-y-3" aria-labelledby="account-character-title">
            <div>
              <h2 id="account-character-title" className="text-sm font-semibold">
                Character
              </h2>
              <p className="text-sm text-muted-foreground">Choose the character for this scene.</p>
            </div>
            <CharacterSelector
              options={characterOptions}
              value={character}
              onValueChange={onCharacterChange}
            />
          </section>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
