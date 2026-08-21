"use client";

import { useRef } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { soundController } from "@agent-hq/audio";
import { cn } from "#lib/utils";
import { Button } from "#components/ui/button";
import type { SceneMapOption } from "#lib/scene-maps";

export type MapSelectorProps = {
  options: readonly SceneMapOption[];
  currentId: string;
  /** Override each card's destination, e.g. to carry the character query
   * param through a teleport navigation. Defaults to option.href. */
  hrefFor?: (option: SceneMapOption) => string;
  /** When provided, card clicks are intercepted and routed through this
   * callback instead of following the link (used to run a teleport
   * transition before navigating). */
  onNavigate?: (option: SceneMapOption) => void;
};

/**
 * Horizontal scroll-snap carousel of map cards. The current scene is marked
 * with a ring and a check badge; every other card links straight to its route
 * so players can jump between scenes from the settings drawer.
 */
export function MapSelector({ options, currentId, hrefFor, onNavigate }: MapSelectorProps) {
  const trackRef = useRef<HTMLDivElement>(null);

  const scrollByCard = (direction: 1 | -1) => {
    const track = trackRef.current;
    if (!track) return;
    const firstCard = track.querySelector<HTMLElement>("[data-map-card]");
    const step = firstCard ? firstCard.offsetWidth + 12 : track.clientWidth * 0.8;
    track.scrollBy({ left: direction * step, behavior: "smooth" });
  };

  return (
    <div>
      <div
        ref={trackRef}
        className="flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {options.map((option) => {
          const selected = option.id === currentId;
          return (
            <a
              key={option.id}
              data-map-card
              href={hrefFor ? hrefFor(option) : option.href}
              aria-current={selected ? "page" : undefined}
              onClick={
                onNavigate
                  ? (event) => {
                      event.preventDefault();
                      soundController.playSfx("uiClick");
                      onNavigate(option);
                    }
                  : () => soundController.playSfx("uiClick")
              }
              className={cn(
                "group relative w-40 shrink-0 snap-start overflow-hidden rounded-xl border bg-background text-left transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                selected
                  ? "border-primary ring-2 ring-primary/30"
                  : "border-border hover:bg-accent",
              )}
            >
              <span className="relative block aspect-[16/10] w-full overflow-hidden bg-muted">
                {option.imageUrl ? (
                  <img
                    src={option.imageUrl}
                    alt=""
                    className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
                    draggable={false}
                    loading="lazy"
                  />
                ) : (
                  <span
                    className="flex size-full items-center justify-center bg-gradient-to-br from-primary/30 via-muted to-accent text-2xl font-semibold text-foreground/70"
                    aria-hidden="true"
                  >
                    {option.label.slice(0, 1)}
                  </span>
                )}
                <span
                  className="absolute inset-0 bg-gradient-to-t from-black/45 to-transparent"
                  aria-hidden="true"
                />
                {selected && (
                  <span className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="size-3" aria-hidden="true" />
                  </span>
                )}
              </span>
              <span className="flex items-center gap-2 px-2.5 py-2">
                <span className="truncate text-sm font-medium">{option.label}</span>
              </span>
            </a>
          );
        })}
      </div>
      <div className="mt-1 flex justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Previous map"
          onClick={() => {
            soundController.playSfx("uiClick");
            scrollByCard(-1);
          }}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Next map"
          onClick={() => {
            soundController.playSfx("uiClick");
            scrollByCard(1);
          }}
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
