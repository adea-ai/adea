"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps, ReactElement, ReactNode } from "react";

// Bun 1.4 can resolve next-themes against a separate React type instance. The
// runtime component is compatible, but TypeScript then drops `children` from
// its JSX props. Keep the shared provider's public contract stable by
// normalizing the third-party component's props at this boundary.
type CompatibleNextThemesProviderProps = ComponentProps<typeof NextThemesProvider> & {
  children?: ReactNode;
};

const CompatibleNextThemesProvider = NextThemesProvider as unknown as (
  props: CompatibleNextThemesProviderProps,
) => ReactElement;

/** Shared theme provider used by each Next app in the workspace. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <CompatibleNextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
    </CompatibleNextThemesProvider>
  );
}
