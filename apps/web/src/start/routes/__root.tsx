import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import '../globals.css'

export const Route = createRootRoute({
  head: () => ({
    links: [{ rel: 'icon', type: 'image/svg+xml', href: '/icon.svg' }],
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: 'Adea' },
      {
        name: 'description',
        content: 'A durable workspace for Rooms, Agents, Tasks, and conversations',
      },
      { name: 'robots', content: 'noindex, nofollow, noarchive' },
      { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#ffffff' },
      { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#11161d' },
    ],
  }),
  component: () => <Outlet />,
  shellComponent: Document,
  notFoundComponent: () => (
    <main>
      <h1>Page not found</h1>
      <a href="/">Open Adea</a>
    </main>
  ),
  errorComponent: () => (
    <main role="alert">
      <h1>Unable to open Adea</h1>
      <a href="/">Try again</a>
    </main>
  ),
})

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body suppressHydrationWarning>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
