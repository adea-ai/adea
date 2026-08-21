"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { soundController } from "@agent-hq/audio";
import { useTheme } from "next-themes";
import { cn } from "#lib/utils";

/**
 * Compact sun/moon theme selector. Wired to the next-themes provider so the
 * choice persists across the app (localStorage) and applies to every scene.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  // next-themes resolves the saved/system theme after mount. Use the stable
  // light presentation for both SSR and the first client render so the
  // aria/class attributes cannot mismatch during hydration.
  const isDark = mounted && theme === "dark";

  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full border border-input bg-background p-0.5",
        className,
      )}
      role="radiogroup"
      aria-label="Theme"
    >
      <button
        type="button"
        role="radio"
        aria-checked={!isDark}
        aria-label="Light theme"
        onClick={() => {
          soundController.playSfx("uiClick");
          setTheme("light");
        }}
        className={cn(
          "inline-flex size-6 items-center justify-center rounded-full transition-colors",
          !isDark
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Sun className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={isDark}
        aria-label="Dark theme"
        onClick={() => {
          soundController.playSfx("uiClick");
          setTheme("dark");
        }}
        className={cn(
          "inline-flex size-6 items-center justify-center rounded-full transition-colors",
          isDark
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Moon className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
