import type { ArtifactSummary } from '@adea-ai/types'
import { FileText, X } from 'lucide-solid'
import { Show } from 'solid-js'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Card, CardContent } from '@adea-ai/ui/components/ui/card'

export function ArtifactDetail(props: {
  artifact: ArtifactSummary
  dismiss: () => void
  openTask: (taskId: string) => void
}) {
  return (
    <section class="conventional-artifact-detail" aria-labelledby="artifact-title">
      <header class="conventional-surface-header">
        <div>
          <span>Artifact</span>
          <h1 id="artifact-title">{props.artifact.filename}</h1>
        </div>
        <ActionButton
          type="button"
          aria-label="Dismiss Artifact details"
          tooltip="Dismiss Artifact details"
          variant="ghost"
          size="icon-sm"
          onClick={() => props.dismiss()}
        >
          <X aria-hidden="true" />
        </ActionButton>
      </header>
      <Card class="mx-auto my-8 w-full max-w-2xl">
        <CardContent>
          <div class="grid gap-3">
            <FileText aria-hidden="true" class="size-8 text-primary" />
            <p>{props.artifact.mediaType}</p>
            <p>{props.artifact.availability}</p>
            <p>{props.artifact.sizeBytes.toLocaleString()} bytes</p>
            <Show when={props.artifact.taskId}>
              {(taskId) => (
                <Button type="button" onClick={() => props.openTask(taskId())}>
                  Open linked Task
                </Button>
              )}
            </Show>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
