"use client";

import { useState } from "react";
import { Check, ChevronDown, ChevronUp, UserRound } from "lucide-react";
import { soundController } from "@agent-hq/audio";
import { cn } from "#lib/utils";
import { Button } from "#components/ui/button";

export type CharacterOption = {
  id: string;
  label: string;
  iconUrl?: string;
};

export type CharacterSelectorProps = {
  options: readonly CharacterOption[];
  value: string;
  onValueChange: (value: string) => void;
  /** Number of characters shown before the "show more" toggle. */
  maxVisible?: number;
};

export function CharacterSelector({
  options,
  value,
  onValueChange,
  maxVisible = 6,
}: CharacterSelectorProps) {
  const [expanded, setExpanded] = useState(
    () =>
      options.length <= maxVisible ||
      !options.slice(0, maxVisible).some((option) => option.id === value),
  );
  const hiddenCount = options.length - maxVisible;
  const visibleOptions = expanded ? options : options.slice(0, maxVisible);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Character">
        {visibleOptions.map((option) => {
          const selected = option.id === value;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                soundController.playSfx("uiClick");
                onValueChange(option.id);
              }}
              className={cn(
                "flex min-h-16 items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors",
                "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                selected
                  ? "border-primary bg-accent text-accent-foreground"
                  : "border-border bg-background",
              )}
            >
              <span
                className={cn(
                  "relative flex size-8 items-center justify-center overflow-hidden rounded-lg bg-muted",
                  selected && "bg-primary text-primary-foreground",
                )}
              >
                {option.iconUrl ? (
                  <img
                    src={option.iconUrl}
                    alt=""
                    className="size-full object-contain"
                    draggable={false}
                  />
                ) : (
                  <UserRound className="size-4" aria-hidden="true" />
                )}
                {selected && (
                  <span className="absolute inset-0 flex items-center justify-center bg-primary/75 text-primary-foreground">
                    <Check className="size-4" aria-hidden="true" />
                  </span>
                )}
              </span>
              <span className="font-medium">{option.label}</span>
            </button>
          );
        })}
      </div>
      {hiddenCount > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            soundController.playSfx("uiClick");
            setExpanded((current) => !current);
          }}
          aria-expanded={expanded}
          className="w-full"
        >
          {expanded ? (
            <>
              <ChevronUp className="size-4" aria-hidden="true" />
              Show fewer
            </>
          ) : (
            <>
              <ChevronDown className="size-4" aria-hidden="true" />
              Show all characters ({options.length})
            </>
          )}
        </Button>
      )}
    </div>
  );
}
