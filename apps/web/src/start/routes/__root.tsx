import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/solid-router'
import type { JSX } from 'solid-js'
import { ThemeScript } from '@adea-ai/ui/components/theme-provider'
import '../globals.css'

/**
 * The workspace search contract. Values keep their URLSearchParams string
 * semantics (see `search-codec.mjs`); unknown keys pass through untouched so
 * deep links survive a view or scene switch.
 */
export type WorkspaceSearch = {
  channel?: string
  message?: string
  roomDesigner?: string
  scene?: 'home' | 'work'
  spawn?: string
  task?: string
  thread?: string
  view?: 'chat' | 'virtual'
  workspace?: string
}

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>): WorkspaceSearch => search as WorkspaceSearch,
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

function Document(props: { children: JSX.Element }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <ThemeScript />
      </head>
      <body>
        {props.children}
        <Scripts />
      </body>
    </html>
  )
}
