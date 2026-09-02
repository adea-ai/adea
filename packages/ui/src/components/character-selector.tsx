"use client";

import { useState } from "react";
import { Check, ChevronDown, ChevronUp, UserRound } from "lucide-react";
import { cn } from "#lib/utils";
import { Button } from "#components/ui/button";
import type {
  CharacterConfiguration,
  CharacterConfigurationSlot,
  CharacterPartOption,
} from "@agent-hq/characters";

const configurableSlots: readonly CharacterConfigurationSlot[] = [
  "body",
  "ears",
  "face",
  "hair",
  "hat",
  "top",
  "bottom",
  "shoes",
  "socks",
  "glasses",
  "gloves",
  "accessory",
  "costume",
];

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

export type CharacterCustomizerProps = {
  value: CharacterConfiguration;
  options: readonly CharacterPartOption[];
  onValueChange: (value: CharacterConfiguration) => void;
};

const slotLabels: Record<CharacterConfigurationSlot, string> = {
  body: "Body",
  ears: "Ears",
  face: "Face",
  hair: "Hair",
  hat: "Hat",
  top: "Top",
  bottom: "Bottom",
  shoes: "Shoes",
  socks: "Socks",
  glasses: "Glasses",
  gloves: "Gloves",
  accessory: "Accessory",
  costume: "Costume",
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
            <Button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              variant={selected ? "secondary" : "outline"}
              onClick={() => onValueChange(option.id)}
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
            </Button>
          );
        })}
      </div>
      {hiddenCount > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((current) => !current)}
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

export function CharacterCustomizer({ value, options, onValueChange }: CharacterCustomizerProps) {
  return (
    <details className="rounded-xl border border-border bg-muted/20 px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        Customize appearance
      </summary>
      <div className="mt-3 grid gap-3">
        {configurableSlots.map((slot) => {
          const slotOptions = options.filter((option) => option.slot === slot);
          const selected = value[slot];
          return (
            <label key={slot} className="grid gap-1 text-sm">
              <span className="font-medium">{slotLabels[slot]}</span>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                value={selected ?? ""}
                onChange={(event) =>
                  onValueChange({
                    ...value,
                    [slot]: event.currentTarget.value || null,
                  } as CharacterConfiguration)
                }
              >
                {slot !== "body" ? <option value="">None</option> : null}
                {slotOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    </details>
  );
}
