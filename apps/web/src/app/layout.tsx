import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { SoundProvider } from '@agent-hq/audio'
import { AgentHqQueryProvider } from '@agent-hq/data/provider'
import { ThemeProvider } from '@agent-hq/ui/components/theme-provider'
import './globals.css'

export const metadata: Metadata = {
  title: 'Agent HQ',
  description: 'Agent HQ room headquarters',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#11161d' },
  ],
}

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
  )
}
