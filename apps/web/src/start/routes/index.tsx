import { ClientOnly, createFileRoute } from '@tanstack/react-router'
import { createServerOnlyFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'

import lazyComponent from '../../components/lazy-component'
import { isDesktopRuntime } from '../../lib/desktop-bridge'
import { ENTRY_ACCESS_HEADER } from '../http-policy.mjs'

function Loading() {
  return (
    <main className="conventional-workspace conventional-workspace--loading" aria-busy="true">
      <p>Opening workspace…</p>
    </main>
  )
}

const WorkspaceMount = lazyComponent(() => import('../workspace-mount').then((m) => m.default), {
  loading: Loading,
  ssr: false,
})

function EarlyAccessNotice() {
  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="early-access-title">
        <p className="auth-eyebrow">Adea</p>
        <h1 className="auth-title" id="early-access-title">
          Adea is in early access
        </h1>
        <p className="auth-introduction" role="status">
          Please reach out on github if you&apos;d like to contribute.
        </p>
        <a
          className="browser-auth-submit browser-auth-open-app"
          href="https://github.com/adea-ai/adea"
          target="_blank"
          rel="noreferrer"
        >
          Adea on GitHub
        </a>
      </section>
    </main>
  )
}

/**
 * Runs only during the server render. The worker entry already applied the
 * account allowlist for this document and forwarded the decision on an
 * internal header; a denied account keeps the original early-access document
 * instead of an invented authorization UX. In-app client navigations were
 * admitted with the document and therefore render the workspace.
 *
 * The desktop shell serves this same route from loopback and authenticates
 * through the desktop principal instead of the browser allowlist, so the
 * server-only check is skipped there.
 */
const readEntryAccess = createServerOnlyFn(() => {
  const value = getRequestHeader(ENTRY_ACCESS_HEADER)
  return value === 'denied' ? 'denied' : 'allowed'
})

export const Route = createFileRoute('/')({
  loader: () => {
    if (isDesktopRuntime()) return { denied: false }
    return readEntryAccess() === 'denied' ? { denied: true } : { denied: false }
  },
  component: WorkspaceRoute,
})

function WorkspaceRoute() {
  const { denied } = Route.useLoaderData()
  if (denied) return <EarlyAccessNotice />
  return (
    <ClientOnly fallback={<Loading />}>
      <WorkspaceMount />
    </ClientOnly>
  )
}
