import { createFileRoute } from '@tanstack/solid-router'

import { DesktopAuthComplete } from '../../../../components/desktop-auth-complete'

export const Route = createFileRoute('/auth/desktop/complete')({
  head: () => ({ meta: [{ title: 'Sign-in complete | Adea' }] }),
  component: DesktopAuthCompletePage,
})

function DesktopAuthCompletePage() {
  return (
    <main class="auth-shell">
      <section class="auth-panel" aria-labelledby="desktop-auth-complete-title">
        <DesktopAuthComplete />
      </section>
    </main>
  )
}
