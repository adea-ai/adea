import type { ArtifactSummary } from '@adea-ai/types'
import { FileText, X } from 'lucide-solid'
import { Show } from 'solid-js'
import { Button } from '@adea-ai/ui/components/ui/button'

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
        <Button type="button" aria-label="Dismiss Artifact details" onClick={() => props.dismiss()}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div class="conventional-artifact-detail__body">
        <FileText aria-hidden="true" />
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
    </section>
  )
}
