import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SoundProvider } from "@adea/audio";
import { AgentHqQueryProvider } from "@adea/data/provider";
import { ThemeProvider } from "@adea/ui/components/theme-provider";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent HQ",
  description: "Agent HQ room headquarters",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#11161d" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <ThemeProvider>
          <NuqsAdapter>
            <AgentHqQueryProvider>
              <SoundProvider>{children}</SoundProvider>
            </AgentHqQueryProvider>
          </NuqsAdapter>
        </ThemeProvider>
      </body>
    </html>
  );
}
