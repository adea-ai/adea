import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/solid-router'
import { HydrationScript } from 'solid-js/web'
import type { JSX } from 'solid-js'
import { ThemeScript } from '@adea-ai/app-ui/components/theme-provider'
import { TextLink } from '@adea-ai/ui/components/ui/text-link'
import '../globals.css'

/**
 * The workspace search contract. Values keep their URLSearchParams string
 * semantics (see `search-codec.mjs`); unknown keys pass through untouched so
 * deep links survive a view or scene switch.
 */
export type WorkspaceSearch = {
  app?: 'kanban' | 'source-control' | 'library'
  channel?: string
  characterDesigner?: string
  /** Development-only ChatView visual fixture selector (#536 evidence lane). */
  chatE2e?: string
  chatState?: string
  /**
   * The account-wide directory surface (M11.03): `agents` shows the global
   * Agents directory, `inbox` the global conversation inbox. Present, the
   * surface replaces the workspace view; the results never scope to the
   * selected workspace.
   */
  directory?: 'agents' | 'inbox'
  /** Dev View deep links: deterministic project/session selection. */
  devProject?: string
  devSession?: string
  message?: string
  roomDesigner?: string
  scene?: 'home' | 'work'
  spawn?: string
  task?: string
  thread?: string
  view?: 'chat' | 'dev' | 'virtual'
  workspace?: string
}

/** The router-level fallbacks share the entry surfaces' standard treatment —
 * the centred auth-shell panel with the app eyebrow, the display headline and
 * the inline link action — instead of bare unstyled document flow. */
function RootStatePage(props: {
  alert?: boolean
  eyebrow: string
  title: string
  detail: string
  actionLabel: string
}) {
  return (
    <main class="auth-shell">
      <section
        class="auth-panel"
        role={props.alert ? 'alert' : undefined}
        aria-labelledby="root-state-title"
      >
        <p class="auth-eyebrow">{props.eyebrow}</p>
        <h1 class="auth-title" id="root-state-title">
          {props.title}
        </h1>
        <p class="auth-introduction">{props.detail}</p>
        <TextLink href="/">{props.actionLabel}</TextLink>
      </section>
    </main>
  )
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
        content: 'A durable workspace for Projects, Agents, Tasks, and conversations',
      },
      { name: 'robots', content: 'noindex, nofollow, noarchive' },
      { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#ffffff' },
      { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#11161d' },
    ],
  }),
  component: () => <Outlet />,
  shellComponent: Document,
  notFoundComponent: () => (
    <RootStatePage
      eyebrow="Adea"
      title="Page not found"
      detail="This address doesn't match a workspace page. Open Adea and continue from your workspace."
      actionLabel="Open Adea"
    />
  ),
  errorComponent: () => (
    <RootStatePage
      alert
      eyebrow="Adea"
      title="Unable to open Adea"
      detail="Something interrupted the app before it could open. Reload, or try again from the start."
      actionLabel="Try again"
    />
  ),
})

function Document(props: { children: JSX.Element }) {
  return (
    <html lang="en">
      <head>
        {/* Solid hydration bookkeeping; without it the client cannot hydrate. */}
        <HydrationScript />
        <HeadContent />
        <ThemeScript />
        <script
          // Router hydration normalization restores the server-side URL and
          // drops the boot-time fragment (hashes never reach the server). The
          // desktop-auth complete page consumes that fragment post-hydration,
          // so it must be captured here, at first script execution.
          innerHTML={`window.__ADEA_INITIAL_HASH__ ??= window.location.hash`}
        />
      </head>
      <body>
        {props.children}
        <Scripts />
      </body>
    </html>
  )
}
