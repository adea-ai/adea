import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SoundProvider } from "@agent-hq/audio";
import { AgentHqQueryProvider } from "@agent-hq/data/provider";
import { ThemeProvider } from "@agent-hq/ui";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent HQ",
  description: "Agent HQ room headquarters",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <ThemeProvider>
          <AgentHqQueryProvider>
            <SoundProvider>{children}</SoundProvider>
          </AgentHqQueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
