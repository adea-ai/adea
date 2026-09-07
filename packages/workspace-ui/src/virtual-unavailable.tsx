'use client'

import { Button } from '@adea-ai/ui/components/ui/button'

export function VirtualUnavailable({
  sceneLabel,
  onOpenChat,
}: Readonly<{ sceneLabel?: string; onOpenChat?: () => void }>) {
  return (
    <main className="workspace-shell">
      <div className="workspace-scene-viewport">
        <div
          className="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center"
          role="status"
          aria-label="Virtual view unavailable"
        >
          <h1 className="text-xl font-semibold">Virtual view lives in Agent Sim</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            {sceneLabel ? `The ${sceneLabel} scene is` : 'The spatial sim is'} part of the private
            Agent Sim engine, which is not included in this build. Chat, tasks, and the rest of the
            workspace work as usual.
          </p>
          {onOpenChat ? (
            <Button type="button" onClick={onOpenChat}>
              Back to chat
            </Button>
          ) : null}
        </div>
      </div>
    </main>
  )
}
