import { AgentHqQueryProvider } from '@adea-ai/data/provider'
import { createFileRoute } from '@tanstack/solid-router'

import { AcceptInvitation } from '../../components/accept-invitation'

export const Route = createFileRoute('/invite')({
  head: () => ({
    meta: [
      { title: 'Join a workspace | Adea' },
      // The page handles a credential-bearing link; keep it out of indexes.
      { content: 'noindex', name: 'robots' },
    ],
  }),
  component: InvitePage,
})

function InvitePage() {
  return (
    <main class="auth-shell">
      <section class="auth-panel" aria-labelledby="accept-invitation-title">
        <AgentHqQueryProvider>
          <AcceptInvitation />
        </AgentHqQueryProvider>
      </section>
    </main>
  )
}
